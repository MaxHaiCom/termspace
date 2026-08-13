/**
 * tmux 会话续存（设计参考 ARCHITECTURE-NOTES.md §2）
 * - 专用 socket `termboard` + 自带 conf（不碰用户 ~/.tmux.conf）
 * - session 名 tb-<nodeId>，node id 即持久化键
 * - destroy-unattached off = 无客户端也活；只有显式 kill-session 才真结束
 * - PTY 直接 spawn tmux 客户端，`new-session -A -D`（有就接、没就建、踢旧客户端）
 */
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  assembleSpawnArgs,
  serverEnvKeysToScrub,
  TMUX_SOCKET as SOCKET,
  type IdentityEnvSpec
} from './tmux-args.ts'
import {
  descendantPids,
  descendantProvider,
  parseProcessLinks,
  parseProcessTable,
  type ProcessRow
} from './pane-process.ts'

export type { IdentityEnvSpec } from './tmux-args'

const conf = (scrollback: number): string => `# Termspace 托管 tmux 配置（自动生成，勿手改）
set -g status off
set -g mouse on
set -g history-limit ${Math.max(500, scrollback)}
set -g default-terminal "xterm-256color"
set -sg escape-time 10
set -g destroy-unattached off
setw -g aggressive-resize on
set -g set-clipboard on
set -as terminal-features ",*:clipboard"
`

let tmuxPath: string | null | undefined // undefined=未探测 null=没有
let confWritten = -1 // 已写入 conf 的 scrollback 值（变了要重写）
let scrubbed = false // 本次 app 运行是否已清过 server 全局环境

function confPath(): string {
  return path.join(app.getPath('userData'), 'tmux.conf')
}

export async function ensureTmux(scrollback = 8000): Promise<string | null> {
  if (tmuxPath === undefined) {
    tmuxPath =
      ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find(existsSync) ?? null
  }
  if (tmuxPath && confWritten !== scrollback) {
    await writeFile(confPath(), conf(scrollback))
    confWritten = scrollback
  }
  /* 每次 app 启动清一次。**放在这里而不是 whenReady**：没开 tmux 的用户根本不该
     被跑一串子进程，而这里是"确实要用 tmux"的唯一入口。没有 server 时
     show-environment 直接失败返回空串，不会把 server 起起来。 */
  if (tmuxPath && !scrubbed) {
    scrubbed = true
    const gone = await scrubServerEnv()
    if (gone.length) console.log(`[tmux] 清掉 server 全局环境残留：${gone.join(' ')}`)
  }
  return tmuxPath
}

export function sessionName(nodeId: string): string {
  return `tb-${nodeId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

function run(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    if (!tmuxPath) return resolve(false)
    execFile(tmuxPath, ['-L', SOCKET, ...args], { timeout: 5000 }, (err) => resolve(!err))
  })
}

/* tmux 的 -t 默认按前缀 + fnmatch 匹配，`tb-p1` 能命中 `tb-p11`，
   所以加 `=` 前缀强制精确匹配，否则删一个节点可能连坐杀掉另一个会话。

   注意两种目标不能混用：
   - has-session / kill-session 收 **session** 目标 → `=name` 正确
   - capture-pane 收 **pane** 目标 → 裸 `=name` 会报 "can't find pane"，
     必须写成 `=name:`（冒号表示该会话的当前窗口·活动 pane）。踩过一次，别改回去。 */
const target = (nodeId: string): string => `=${sessionName(nodeId)}`
const paneTarget = (nodeId: string): string => `=${sessionName(nodeId)}:`

export function hasSession(nodeId: string): Promise<boolean> {
  return run(['has-session', '-t', target(nodeId)])
}

/** `show-environment -g` 的原始输出；没有 server 时返回空串 */
function showGlobalEnv(): Promise<string> {
  return new Promise((resolve) => {
    if (!tmuxPath) return resolve('')
    execFile(
      tmuxPath,
      ['-L', SOCKET, 'show-environment', '-g'],
      { timeout: 5000 },
      (err, stdout) => resolve(err ? '' : stdout)
    )
  })
}

/**
 * 清掉 server 全局环境里那些「某一次进程身份」的残留，返回清掉的键。
 *
 * **为什么必须就地清、而不是靠 `tmuxClientEnv` 拦源头**：server 的全局环境是
 * **第一个客户端**的环境快照，此后活到 kill-server 为止都不再变。本机实测那份快照
 * 来自 2026-07-24 22:36 的一次 `npm run dev` 自检 —— 20 天里新建的每个终端都在继承它。
 * 拦源头只能保证**下一个** server 干净，救不了正在跑的这个，而唯一的替代修法
 * （kill-server）会把用户所有续存会话一起带走。
 *
 * 只影响**此后新建**的会话：已经起来的 pane 环境是它自己的，tmux 不会回溯改写。
 * 这是对的 —— 正在跑的活不该被脚下换环境。
 */
export async function scrubServerEnv(): Promise<string[]> {
  const keys = serverEnvKeysToScrub(await showGlobalEnv())
  for (const k of keys) await run(['set-environment', '-g', '-u', k])
  return keys
}

export function killSession(nodeId: string): Promise<boolean> {
  return run(['kill-session', '-t', target(nodeId)])
}

export interface SessionInfo {
  name: string
  attached: boolean
  /** 最近活动时间（unix 秒） */
  activity: number
}

/** 列出所有 tb- 会话及其活跃度（用于孤儿清理时判断能不能杀） */
export function listSessions(): Promise<SessionInfo[]> {
  return new Promise((resolve) => {
    if (!tmuxPath) return resolve([])
    execFile(
      tmuxPath,
      [
        '-L',
        SOCKET,
        'list-sessions',
        '-F',
        '#{session_name}\t#{session_attached}\t#{session_activity}'
      ],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve([]) // 无 server = 无会话
        resolve(
          stdout
            .split('\n')
            .map((line) => line.trim().split('\t'))
            .filter((f) => f[0]?.startsWith('tb-'))
            .map((f) => ({
              name: f[0],
              attached: Number(f[1] ?? 0) > 0,
              activity: Number(f[2] ?? 0)
            }))
        )
      }
    )
  })
}

/**
 * 杀掉不在存活节点集合里的孤儿会话，返回清理数量。
 *
 * 两道保险，因为误杀 = 用户正在跑的 agent 直接没了：
 * - attached 的绝不杀（有客户端连着 = 有人在用，哪怕它不在名单里）
 * - graceMs 内有活动的绝不杀（可能是崩溃前没来得及落盘的节点，留到下次启动再判）
 */
export async function reapOrphanSessions(
  liveNodeIds: Set<string>,
  graceMs = 10 * 60 * 1000
): Promise<number> {
  const live = new Set([...liveNodeIds].map(sessionName))
  const sessions = await listSessions()
  const cutoff = (Date.now() - graceMs) / 1000
  let n = 0
  for (const s of sessions) {
    if (live.has(s.name) || s.attached || s.activity > cutoff) continue
    await run(['kill-session', '-t', `=${s.name}`])
    n++
  }
  return n
}

/** cold-restore：抓某会话当前屏内容（机器重启后 tmux server 已死则返回空） */
export function capturePane(nodeId: string): Promise<string> {
  return new Promise((resolve) => {
    if (!tmuxPath) return resolve('')
    execFile(
      tmuxPath,
      ['-L', SOCKET, 'capture-pane', '-p', '-e', '-t', paneTarget(nodeId), '-S', '-800'],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : stdout)
    )
  })
}

/**
 * 该节点 pane 里此刻的前台进程名（`zsh` / `claude` / `codex` / `node`…）。
 * 拿不到返回空串 —— 调用方据此决定要不要 fail-closed。
 *
 * 派活前必须查这个：hook 上报是 **fail-open** 的（curl 失败就静默跳过），
 * agent 退出时那条 SessionEnd 一旦丢了，主进程会一直以为它还活着，
 * 下一次 `tb ask` 就把任务文本写进一个**普通 shell** —— 那等于直接执行任意命令。
 * 已实测复现：状态残留时 `rm -rf …\r` 真的被写进了 pty。
 */
export function paneCommand(nodeId: string): Promise<string> {
  return new Promise((resolve) => {
    if (!tmuxPath) return resolve('')
    execFile(
      tmuxPath,
      ['-L', SOCKET, 'display-message', '-p', '-t', paneTarget(nodeId), '#{pane_current_command}'],
      { timeout: 3000 },
      (err, stdout) => resolve(err ? '' : stdout.trim())
    )
  })
}

/**
 * pane_current_command 对 Node/Python 包装器会返回 node/Python/版本号，不能用于计数。
 * 这里以 pane PID 为根只看它的子孙，并且只把 provider 名返回渲染层，不返回 argv。
 */
export async function paneProcessProviders(nodeIds: string[]): Promise<Record<string, string>> {
  if (!tmuxPath || !nodeIds.length) return {}
  const panePids = await Promise.all(
    nodeIds.map(
      (id) =>
        new Promise<[string, number]>((resolve) => {
          execFile(
            tmuxPath!,
            ['-L', SOCKET, 'display-message', '-p', '-t', paneTarget(id), '#{pane_pid}'],
            { timeout: 3000 },
            (err, stdout) => resolve([id, err ? 0 : Number(stdout.trim())])
          )
        })
    )
  )
  // 全局只取 PID 关系；命令行只查询这些 pane 的子孙，避免读取无关进程 argv。
  const links = await new Promise<ReturnType<typeof parseProcessLinks>>((resolve) => {
    execFile('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 3000 }, (err, stdout) =>
      resolve(err ? [] : parseProcessLinks(stdout))
    )
  })
  const descendantIds = [...new Set(panePids.flatMap(([, pid]) => (pid ? descendantPids(pid, links) : [])))]
  const table =
    descendantIds.length === 0
      ? []
      : await new Promise<ProcessRow[]>((resolve) => {
          execFile(
            '/bin/ps',
            ['-p', descendantIds.join(','), '-o', 'pid=,ppid=,command='],
            { timeout: 3000, maxBuffer: 1024 * 1024 },
            (err, stdout) => resolve(err ? [] : parseProcessTable(stdout))
          )
        })
  const out: Record<string, string> = {}
  for (const [id, pid] of panePids) {
    const provider = pid ? descendantProvider(pid, table) : null
    if (provider) out[id] = provider
  }
  return out
}

/** 组装 PTY 程序与参数：tmux 可用 → tmux 客户端；否则纯 shell */
export function buildSpawnArgs(
  tmux: string | null,
  nodeId: string,
  shell: string,
  cwd: string,
  env: Record<string, string>,
  identity?: IdentityEnvSpec,
  secretFile?: string
): { file: string; args: string[] } {
  return assembleSpawnArgs(
    tmux,
    sessionName(nodeId),
    confPath(),
    shell,
    cwd,
    env,
    identity,
    secretFile
  )
}
