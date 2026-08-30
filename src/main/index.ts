import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell } from 'electron'
import { readFile, writeFile, rename, mkdir, unlink, readdir, stat } from 'node:fs/promises'
import { existsSync, appendFileSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import * as pty from 'node-pty'
import {
  startHookSystem,
  uninstallClaudeHooks,
  claudeHooksPresent,
  codexHooksPresent,
  type HookSystem,
  type PendingApproval
} from './hooks'
import { createContextTail, type ContextTail } from './context-tail'
import {
  listIdentities,
  upsertIdentity,
  renameIdentity,
  deleteIdentity,
  identityLoginStatus,
  identityStoreError,
  resolveIdentityEnv
} from './identity-store'
import { PROVIDERS } from '../shared/provider-manifest.ts'
import { listPresets, upsertPreset, deletePreset } from './preset-store'
import { startWorkerWatch, workerAction, resolveCdx, type WorkerWatch } from './worker-watch'
import { execFile } from 'node:child_process'
import {
  probeRepo,
  worktreeStatus,
  createWorktree,
  removeWorktree,
  diffSummary
} from './worktree.ts'
import { openInEditor, editorNames } from './open-in-editor'
import { toTemplate, fromTemplate, type LayoutTemplate } from './layout-template'
import { brokerRun } from './broker'
import { getBrokerTarget, setBrokerTarget, deleteBrokerTarget } from './broker-store'
import { createBrokerMutations, handleBroker } from './broker-handler'
import { sanitizeImportedWorkspace } from './workspace-import'
import {
  createLedger,
  sortForReview,
  withLedger as recordWithLedger,
  type Ledger,
  type LedgerMeta
} from './task-ledger'
import { startRemoteApi, type RemoteApi } from './remote'
import { startUpdater, type Updater } from './updater'
import {
  parsePeerTarget,
  peerAllowed,
  sshArgs,
  encodePeerAsk,
  encodePeerAgents,
  PEER_TIMEOUTS
} from './peer'
import { resolveBind } from './net-iface'
import { sliceScreen, type Screen } from './peek-text.ts'
import { createNotifier, sendTestNotification, type Notifier } from './notify.ts'
import { issueToken, loadTokens, revokeToken, toMeta } from './remote-tokens'

/** remote token 表的位置。IPC 和启动处共用一个来源，别两边各拼一次路径 */
const remoteTokenFile = (): string => path.join(app.getPath('userData'), 'remote-token')
import { startQuotaHub, type QuotaHub, type QuotaAccount } from './quota'
import { evaluate as evaluatePolicy, type PolicyVerdict } from './approval-policy'
import { getSettings, setSettings, type Settings } from './settings-store'
import { searchSkills, loadSkill, listSkills } from './skill-index'
import {
  delegate,
  noteTranscript,
  noteStatus,
  dropNode,
  isAgentSession,
  sanitizeTask,
  setDelegateFlightListener
} from './delegate'
import {
  ensureTmux,
  hasSession,
  killSession,
  buildSpawnArgs,
  reapOrphanSessions,
  capturePane,
  paneCommand,
  paneCwd,
  paneProcessProviders
} from './tmux'
import { identityValueIsSecret, shellQuote, tmuxClientEnv } from './tmux-args'
import { applyIdentityEnv, billingKind, type ResolvedEnv } from './identity-env'
import { discoverLowConfidenceAccounts, probeClaudeAccount } from './account-discovery'

// dev 下 app 名默认是 "Electron"，userData 会指向共享目录 → 显式隔离
app.setPath('userData', path.join(app.getPath('appData'), 'termboard'))

/* ── 单实例锁 ────────────────────────────────────────────────────────────────
   **必须在 setPath 之后、任何状态被读之前。** 上一行让 dev 和打包版指向同一个
   userData（这是有意的：换目录会让所有活着的 tmux 会话变孤儿）。代价是两个实例
   同时开的时候，它们共用的东西全是有状态的：

   - `workspace.json` —— 两边各自 500ms 防抖**整份覆盖**保存，后写的把先写的抹掉。
     这正是 CLAUDE.md 里那条最严重的后果（画布归零 + 随后 reap 把 tmux 会话全杀）。
   - tmux socket `termboard` —— 各自 reap 时会把对方的会话当成孤儿 kill 掉。
   - hook 端口 / 远程 API 端口 —— 第二个实例抢不到，功能静默残废。

   `npm run dev` 时打包版正开着就会走到这条路上。宁可让第二个实例退出并把
   已有窗口顶到前面，也不能让两份状态互相踩。 */
if (!app.requestSingleInstanceLock()) {
  /* **exit 不是 quit**：quit 要等 will-quit 走完，这中间 whenReady 会抢先触发并
     真的建出第二个窗口 —— 那个窗口一挂载就开始读 workspace、起防抖保存，
     踩踏已经发生了。这里没有任何自己的状态要清理，直接退。 */
  app.exit(0)
} else {
  app.on('second-instance', () => {
    if (!mainWin || mainWin.isDestroyed()) return
    if (mainWin.isMinimized()) mainWin.restore()
    mainWin.focus()
  })
}

/* ── 崩溃日志 ────────────────────────────────────────────────────────────────
   打包后 stdout 没有去处：主进程一崩，用户看到的是"图标弹一下就没了"，手上零线索。
   所以尽早挂上，写到 userData/crash.log，设置里给按钮打开。

   注意 uncaughtException 有个副作用：装了 handler 之后 Electron 就**不再退出**了。
   这里是刻意的 —— 终端节点全靠 tmux 续存，进程活着用户还能救；但状态可能已经不一致，
   所以要在界面上说出来，不能装没事发生。 */
const crashLogPath = (): string => path.join(app.getPath('userData'), 'crash.log')
let crashCount = 0

function logCrash(kind: string, err: unknown): void {
  crashCount++
  const stack = err instanceof Error ? (err.stack ?? err.message) : String(err)
  console.error(`[${kind}]`, err)
  try {
    // 同步写：异步的话进程真要退时可能来不及落盘
    appendFileSync(crashLogPath(), `\n[${new Date().toISOString()}] ${kind}\n${stack}\n`)
  } catch {
    // 日志都写不进去就算了 —— 绝不能在崩溃处理里再崩一次
  }
  sendToWin('app:crash', { kind, message: stack.split('\n')[0] ?? kind })
}

process.on('uncaughtException', (e) => logCrash('uncaughtException', e))
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e))

/* IPC 输入校验：nodeId 会被拼进文件路径、tmux 会话名、Map 键。各处虽都做了字符白名单
   替换，但在入口统一拒掉更省心，也挡住超长 id 把 Map 撑爆。画布真实 id 形如 t1/b2/g3/ctx-p1。 */
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const okId = (id: unknown): id is string => typeof id === 'string' && NODE_ID_RE.test(id)
/** 只认主窗口来的 IPC（webview guest 等其他 webContents 一律拒） */
const fromMainWin = (e: { sender: Electron.WebContents }): boolean =>
  !!mainWin && !mainWin.isDestroyed() && e.sender === mainWin.webContents
const PTY_WRITE_LIMIT = 256 * 1024


/** 本次运行是否已经问过 hook 写入同意（renderer:ready 会被 reload 反复触发） */
let askedConsent = false
/** whenReady 里才建得起来的额度账号同步器；identity handler 在模块级注册，只能靠这个引用 */
let syncQuotaAccountsRef: (() => Promise<void>) | null = null
let detectedPaneProviders = new Set<string>()
/** 远程端能否写入终端 / 批准工具调用。设置里改了要立刻生效，所以单独缓存 */
let remoteAllowInput = false
let remoteAllowApprove = false
/** 选了 tailscale 但没找到 100.x 地址，实际退回了回环。界面要如实说 */
let remoteFellBack = false
/** 远程 API 启动失败的原因。只进 console 的话，设置里只有一个"未启动"，用户无从下手 */
let remoteError = ''

const ptys = new Map<string, pty.IPty>()
/** 本次运行开过终端的工作目录。审批规则引擎据此判断 cwd 是否在管辖范围内 */
const spawnedRoots = new Set<string>()
let hookSystem: HookSystem | null = null
let contextTail: ContextTail | null = null
let workerWatch: WorkerWatch | null = null
let mainWin: BrowserWindow | null = null
let remoteApi: RemoteApi | null = null
let quotaHub: QuotaHub | null = null
/* 通知设置存一份在内存里：`createNotifier` 每次发之前现取，
   用户在设置面板改完要立刻生效（同 remoteAllowInput 那套） */
let notifyUrl = ''
let notifyLevel: 'attention' | 'all' = 'attention'
const notifier: Notifier = createNotifier({
  get: () => ({ url: notifyUrl, level: notifyLevel })
})

/**
 * 抓某终端屏幕文本（消息中心和远程 API 共用）。
 * `before` = 从尾部往前跳过多少行，手机端翻历史用（裁剪判据见 peek-text.ts）。
 */
async function peekScreen(id: string, lines: number, before = 0): Promise<Screen> {
  return sliceScreen(await capturePane(id), lines, before)
}

async function peekPane(id: string, lines: number): Promise<string> {
  return (await peekScreen(id, lines)).text
}
/**
 * 给审批卡片附上规则引擎的判定（桌面与手机端共用同一份）。
 *
 * 规则引擎只输出「转人工」或「建议拒绝」，**永远不会替用户批准** ——
 * 见 approval-policy.ts 的文件头，别在这里加一条"低风险自动放行"的捷径。
 * 它读的是完整 rawInput（只在主进程里流转），不是给 UI 看的 300 字截断摘要。
 */
function withVerdict(list: PendingApproval[]): (PendingApproval & { verdict?: PolicyVerdict })[] {
  return list.map((a) => {
    const full = hookSystem?.getApprovalFull(a.id)
    /* 拿不到完整输入时给兜底判定，不能返回"无判定"——
       UI 上「没有横幅」看起来跟「审过了没事」一模一样，故障方向全在危险那一侧 */
    if (!full) {
      return {
        ...a,
        verdict: {
          decision: 'require_human' as const,
          rule: 'unknown',
          reason: '读不到完整调用内容，无法判定'
        }
      }
    }
    return {
      ...a,
      verdict: evaluatePolicy({
        toolName: full.toolName,
        rawInput: full.rawInput,
        cwd: full.cwd,
        knownRoots: [...spawnedRoots],
        permissionMode: full.permissionMode
      })
    }
  })
}

/** 渲染层推来的画布 agent 摘要，供 tb agents / 派活用 */
let boardAgents: { id: string; title: string; provider?: string; status: string }[] = []
/** 画布上的授权连线：`source>target`。终端→终端 = 派活；终端→浏览器 = 允许驱动 */
let boardLinks = new Set<string>()
/** 上下文节点 → 终端 的连线（`ctx>term`）。`tb context` 靠它现算 */
let boardCtxLinks = new Set<string>()
/** 完整画布快照（布局 + 状态），远程 API 用；终端内容不在里面 */
let boardSnapshot: unknown = null

/**
 * 任务账本。**每一次派活都要留痕** —— 派活状态原来只是运行时投影，
 * app 一重启就没了，而"我离开一小时回来，哪些结果可信"正是多 agent 的真痛点。
 */
let ledger: Ledger | null = null

/** 主进程只绑定当前账本实例；可测试的记账控制流在 task-ledger.ts。 */
const withLedger = (meta: LedgerMeta, run: () => Promise<string>): Promise<string> =>
  recordWithLedger(
    ledger && {
      ...ledger,
      finish: async (id, patch) => {
        await ledger?.finish(id, patch)
        pushTasks()
      }
    },
    meta,
    run
  )

/**
 * 这个终端此刻落在哪个 worktree 分支上。
 *
 * **写进账本的关键上下文**：同一句"改好了"，在 main 上和在 feat/x 上
 * 是两件可信度完全不同的事。从画布快照里查（组 → worktree.branch）——
 * 主进程本来就有这份快照，不必再问 renderer。
 */
/** 节点标题。通知正文只配拿这个 —— 别把 cwd / 命令行拼进来，见 notify.ts 文件头 */
function titleOfNode(nodeId: string): string {
  const b = boardSnapshot as { nodes?: { id: string; title?: string }[] } | null
  return b?.nodes?.find((n) => n.id === nodeId)?.title ?? nodeId
}

function branchOfNode(nodeId: string): string | undefined {
  const b = boardSnapshot as { nodes?: { id: string; parentId?: string; worktree?: { branch?: string } }[] } | null
  const nodes = b?.nodes
  if (!nodes) return undefined
  const me = nodes.find((n) => n.id === nodeId)
  if (!me?.parentId) return undefined
  return nodes.find((n) => n.id === me.parentId)?.worktree?.branch
}

/** 账本变了就推给画布（卡片列表要跟着变） */
function pushTasks(): void {
  void ledger
    ?.list()
    .then((rows) => sendToWin('tasks:update', sortForReview(rows)))
    .catch(() => undefined)
}

/**
 * 起远程 API。抽出来是因为**设置里点掉总开关必须立刻断服务**，
 * 而"关掉再打开"就得能重新起来 —— 原来这段只在 app 启动时跑一次，
 * 于是取消勾选之后 server 还在监听、token 照样能用，一直到下次重启。
 *
 * 安全开关只允许往收紧的方向"延迟"：关是立即的，开可以慢。
 */
async function startRemote(bindMode: string, port: number): Promise<void> {
  remoteError = ''
  try {
    const bind = resolveBind(bindMode as 'loopback' | 'tailscale')
    remoteApi = await startRemoteApi({
      tokenFile: remoteTokenFile(),
      port,
      host: bind.host,
      // 打包后 mobile/ 在 asar 里（electron-builder.yml 的 files 收了它），fs 能直接读
      staticDir: path.join(app.getAppPath(), 'mobile'),
      allowInput: () => remoteAllowInput,
      allowApprove: () => remoteAllowApprove,
      getBoard: () => boardSnapshot,
      listApprovals: () => withVerdict(hookSystem?.listApprovals() ?? []),
      decideApproval: (id, allow) => hookSystem?.decideApproval(id, allow) ?? false,
      peek: (nodeId, lines, before) => peekScreen(nodeId, lines, before),
      writeInput: (nodeId, text) => {
        const p = ptys.get(nodeId)
        if (!p) return false
        p.write(text)
        return true
      }
    })
    remoteFellBack = bind.fellBack
    console.log(`远程 API 已启动：http://${remoteApi.host}:${remoteApi.port}`)
    if (bind.fellBack) {
      console.warn('远程绑定退回 127.0.0.1：没找到 Tailscale 地址（没登录/没启动？）')
    }
  } catch (err) {
    remoteError = String((err as { message?: string })?.message ?? err)
    console.error('远程 API 启动失败:', err)
  }
}

/** 立刻断掉远程服务。**先断再落盘** —— 写盘失败不能让服务继续活着 */
function stopRemote(): void {
  remoteApi?.dispose()
  remoteApi = null
  remoteFellBack = false
  remoteError = ''
}
ipcMain.on(
  'board:agents',
  (
    e,
    payload:
      | {
          agents?: typeof boardAgents
          links?: string[]
          ctxLinks?: string[]
          nodeIds?: string[]
          board?: unknown
        }
      | typeof boardAgents
  ) => {
    if (!fromMainWin(e)) return
    // 兼容旧形态（纯数组）
    const p = Array.isArray(payload) ? { agents: payload, links: [], nodeIds: [], board: null } : payload
    boardAgents = Array.isArray(p?.agents) ? p.agents : []
    if (p?.board) {
      boardSnapshot = p.board
      remoteApi?.push('board', p.board)
    }
    boardLinks = new Set(Array.isArray(p?.links) ? p.links.filter((s) => typeof s === 'string') : [])
  boardCtxLinks = new Set(
    Array.isArray(p?.ctxLinks) ? p.ctxLinks.filter((s) => typeof s === 'string') : []
  )
    /* 节点一消失就撤销与它有关的一次性授权，防悬空。
       新 id 已经不可复用了（board-serde.ts 的 newNodeId 是随机后缀），
       但**老工作区里还有 `t1`/`b3` 这种老格式 id**，它们仍可能被复用 ——
       所以这段补偿要留着。 */
    if (Array.isArray(p?.nodeIds)) {
      const alive = new Set(p.nodeIds.filter((s) => typeof s === 'string'))
      for (const g of [...grants]) {
        const [src, dst] = g.split('>')
        /* 跨机授权的 dst 形如 `mac-mini:t1`，**不是本画布的节点**，
           照着 alive 判会每次上报都被撤掉 —— 那等于每派一次弹一次窗，
           勾了"不再询问"也没用。它跟着 app 生命周期走，和本机的一次性 grant 一样。 */
        if (dst?.includes(':')) continue
        if (!alive.has(src) || !alive.has(dst)) grants.delete(g)
      }
    }
  }
)

/* 本次运行内用户当场批准过的跨节点调用（连线之外的逃生口）。
   连线被删掉后授权立即失效，但这里的一次性批准按 app 生命周期保留。 */
const grants = new Set<string>()

/**
 * 跨机派活：ssh 到对端跑它自己的 tb-peer，任务正文走 stdin。
 *
 * 三件事是刻意的：
 * - **白名单在这里查**，不在 tb 脚本里。脚本自己 ssh 就等于绕过白名单，
 *   而 alias 会进 ssh 的 argv（`-oProxyCommand=…` 在**本机**执行任意命令）。
 * - **任务正文不进 argv**：`ps` 对同机所有用户可见，而任务是自由文本。
 * - **超时到了就放弃，不重试**：注入是不可撤回的，重试一次就是把同一个任务
 *   往对面那个 agent 里注两遍。断线只能理解成 detach。
 */
async function callPeer(alias: string, payload: string, what: string): Promise<string> {
  const { peers } = await getSettings()
  if (!peerAllowed(alias, peers)) {
    return `${what}失败：机器「${alias}」不在白名单里。先去设置 → 跨机协作把它加上（那里也写着对端要怎么配）。`
  }
  return new Promise<string>((resolve) => {
    const child = execFile(
      'ssh',
      /* 自测时可以把 helper 指到别处。**只在开发构建里认这个 env** ——
         它整段进 ssh 的远端命令，打包版里留一个能改执行目标的环境变量没有理由。 */
      sshArgs(alias, (!app.isPackaged && process.env['TERMBOARD_PEER_HELPER']) || undefined),
      { timeout: PEER_TIMEOUTS.sshMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const hint = /Permission denied|Host key|Could not resolve|Connection refused/i.test(
            stderr
          )
            ? `\n（先在终端里手动跑一次 ssh ${alias} 确认免密通了）`
            : ''
          return resolve(
            `跨机${what}失败：ssh ${alias} —— ${(stderr || err.message).slice(0, 300)}${hint}`
          )
        }
        resolve(stdout.trim() || '[对端没有返回内容]')
      }
    )
    child.stdin?.end(payload)
  })
}

const askPeer = (
  source: string,
  peer: { alias: string; nodeId: string },
  task: string
): Promise<string> =>
  callPeer(peer.alias, encodePeerAsk({ source, target: peer.nodeId, task }), '派活')

/** `tb agents <机器>`：列对端画布上的 agent 终端。**显式带参数**，不逐台 ssh —— 那会让
    最常用的 `tb agents` 每次都卡上几秒，而多数时候用户问的是本机。 */
const agentsPeer = (source: string, alias: string): Promise<string> =>
  callPeer(alias, encodePeerAgents(source), '列节点')

/**
 * 跨节点动作授权：先看画布连线，没有就弹窗问用户。
 * 诚实说明：source 由调用方脚本自报，同 UID 进程能直接 `tmux send-keys` 绕过整条链路，
 * 所以这是**产品护栏**（防 agent 自己乱来、让连线成为真语义），不是安全边界。
 */
async function authorizeLink(
  source: string,
  target: string,
  what: string,
  detail: string
): Promise<boolean> {
  if (!source || !target) return false
  const key = `${source}>${target}`
  /* **只有"本画布真实节点 id"才认画布连线。**
     这条判据换过两次，每次都是被绕过之后才收紧的：
     ① 最初：broker 不是画布节点 → 假设 key 永不出现在 boardLinks 里。
        被破：`boardLinks` 来自**渲染层上报的边**，导入外部工作区时
        `sanitizeImportedWorkspace` 只净化 nodes、edges 原样加载。
     ② 于是改成 `!target.startsWith('broker:')`。**又被破**：
        跨机派活的 key 是 `${alias}:${nodeId}`，同样永远不是画布节点，
        而它不带 `broker:` 前缀。构造一份工作区，塞一个 **id 就叫 `mac-mini:t1`**
        的诱饵组节点（1×1、坐标 9000,9000、标题空）+ 一条指向它的边 ——
        `sanitizeEdges` 要求两端 id 都在节点集里，而诱饵**就在文件里**，
        所以边不悬空、`dropped` 和 `edges` 全是 0，确认框里一个字都不提示。
        导入后 `tb ask mac-mini:t1 <任务>` **零弹窗**直接注入对端 agent。
     ③ 现在：正向判「是不是本机节点 id」。本机 id 不含冒号
        （`NODE_ID_RE`），所以这一条同时盖住 `broker:`、`alias:node`
        以及将来任何新命名空间 —— 不必每加一种就来补一次前缀黑名单。
        `index.ts` 的撤销循环里早就有 `dst?.includes(':')` 这个同款判据，
        属于"同一个判据存在于两处"，现在合流。 */
  const isCanvasNode = NODE_ID_RE.test(target)
  if (grants.has(key) || (isCanvasNode && boardLinks.has(key))) return true
  if (!mainWin || mainWin.isDestroyed()) return false
  const grantHint = target.startsWith('broker:')
    ? '代理连接不是画布节点；可仅允许本次，或勾选在本次运行内记住。'
    : '画布上这两个节点之间没有连线。拉一条线过去即可长期授权。'
  const { response, checkboxChecked } = await dialog.showMessageBox(mainWin, {
    type: 'question',
    buttons: ['拒绝', '允许本次'],
    defaultId: 0,
    cancelId: 0,
    message: `允许 ${source} ${what} ${target}？`,
    detail: `${detail}\n\n${grantHint}`,
    checkboxLabel: '本次运行内不再询问这一对节点',
    checkboxChecked: false
  })
  if (response !== 1) return false
  if (checkboxChecked) grants.add(key)
  return true
}

// 全工作区已知节点 id（跨所有项目）→ 清理不在其中的孤儿 tmux 会话
ipcMain.handle('sessions:reap', async (e, knownIds: string[]) => {
  if (!fromMainWin(e)) return 0
  const given = Array.isArray(knownIds) ? knownIds.filter(okId) : []
  const keep = new Set([...given, ...ptys.keys()])
  return reapOrphanSessions(keep)
})

// tb browser：主进程 ↔ renderer 往返（renderer 持有 webview）
const browserPending = new Map<string, (r: { ok: boolean; result: string }) => void>()
let browserReqSeq = 0
function browserCommand(
  action: string,
  arg: string,
  nodeId: string,
  source = ''
): Promise<string> {
  return new Promise((resolve) => {
    if (!mainWin || mainWin.isDestroyed()) return resolve('窗口不可用')
    const reqId = `br${++browserReqSeq}`
    const timer = setTimeout(() => {
      browserPending.delete(reqId)
      resolve('浏览器指令超时')
    }, 35_000)
    browserPending.set(reqId, (r) => {
      clearTimeout(timer)
      resolve(r.ok ? r.result : `失败：${r.result}`)
    })
    // source 传给 renderer：open 时自动画一条 终端→浏览器 的连线，
    // 让"谁能驱动这个浏览器"在画布上看得见、也能靠删线撤销
    mainWin.webContents.send('browser:cmd', { reqId, nodeId, action, arg, source })
  })
}
ipcMain.on('browser:result', (_e, r: { reqId: string; ok: boolean; result: string }) => {
  browserPending.get(r.reqId)?.(r)
  browserPending.delete(r.reqId)
})

function sendToWin(channel: string, data: unknown): void {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, data)
}

/** cold-restore 快照路径：release/退出前抓屏落盘，机器重启后 tmux 死了也能回灌 */
const scrollbackFile = (id: string): string =>
  path.join(app.getPath('userData'), 'scrollback', `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`)

async function snapshotScrollback(id: string): Promise<void> {
  try {
    const content = await capturePane(id)
    if (!content) return
    const f = scrollbackFile(id)
    await mkdir(path.dirname(f), { recursive: true })
    await writeFile(f, content)
  } catch {
    // 抓屏失败不影响主流程
  }
}

/** 进行中的抓屏：destroy 删快照前要等它落完，否则删掉又被写回来 */
const pendingSnapshots = new Map<string, Promise<void>>()

/* 同一 nodeId 的 spawn / destroy 必须串行。destroy 里的 kill-session 是异步的，
   紧接着 respawn（换身份）时，迟到的 kill 会把刚建好的新会话杀掉。 */
const idLocks = new Map<string, Promise<unknown>>()
function serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = idLocks.get(id) ?? Promise.resolve()
  const next = prev.then(fn, fn) // 前一个失败也要继续排队
  const tail = next.catch(() => undefined)
  idLocks.set(id, tail)
  // 队尾跑完就把锁清掉，别让 Map 无限长
  void tail.then(() => {
    if (idLocks.get(id) === tail) idLocks.delete(id)
  })
  return next
}

/**
 * 只杀客户端，tmux 会话存活（reload / app 退出 / 重挂载）— 续存的关键。
 * snapshot=false 用于 destroy：节点都要没了，抓屏存下来只会在同 id 重建时回灌旧内容。
 */
function releasePty(id: string, snapshot = true): Promise<void> {
  const p = ptys.get(id)
  if (!p) return pendingSnapshots.get(id) ?? Promise.resolve()
  ptys.delete(id)
  let done = Promise.resolve()
  if (snapshot) {
    done = snapshotScrollback(id)
    pendingSnapshots.set(id, done)
    void done.finally(() => {
      if (pendingSnapshots.get(id) === done) pendingSnapshots.delete(id)
    })
  }
  try {
    p.kill()
  } catch {
    // 进程可能已退出
  }
  return done
}

/**
 * 真结束：kill-session + 客户端 + 清快照（节点 ✕ / 换身份重生成）。
 * 返回销毁前抓到的屏幕内容 —— 撤回删除时拿它回灌，让恢复出来的终端不是一片空白。
 * （进程本身救不回来，这一点在 UI 上要说清楚。）
 */
function destroyPty(id: string): Promise<string> {
  return serialize(id, async () => {
    contextTail?.untrack(id)
    dropNode(id)
    hookSystem?.dropApprovals(id) // 节点没了，挂着的审批也别留着
    await hookSystem?.revokeNodeToken(id) // 吊销身份，别让重建的同 id 节点继承
    // 一次性授权也要清：id 会被新节点复用，留着等于把授权传给了陌生人
    for (const g of [...grants]) {
      if (g.startsWith(`${id}>`) || g.endsWith(`>${id}`)) grants.delete(g)
    }
    // 先抓一份屏幕内容交给调用方（撤回删除时回灌），再动手杀
    const farewell = await capturePane(id).catch(() => '')
    await releasePty(id, false)
    await pendingSnapshots.get(id) // 等在飞的抓屏落完，否则下一行删了又被写回来
    // 快照必须删：否则删掉节点后，新节点若拿到同一个 id 会回灌已删除终端的内容
    await unlink(scrollbackFile(id)).catch(() => undefined)
    /* **kill 的结果必须验**。原来直接忽略返回值：kill-session 超时或失败被压成 false，
       随后 `new-session -A` 会 attach 回**旧会话**（并忽略新的 `-e`），
       于是换凭证后界面显示 B、实际跑的还是 A。这是"静默用错身份"里最难查的一种，
       因为一切看起来都成功了。 */
    await killSession(id)
    if (await hasSession(id)) {
      // 再来一次；tmux 偶尔在客户端刚断开时拒绝 kill
      await new Promise((r) => setTimeout(r, 150))
      await killSession(id)
    }
    if (await hasSession(id)) {
      console.error(`destroyPty: ${id} 的 tmux 会话没能结束`)
      deadSessions.add(id)
    } else {
      deadSessions.delete(id)
    }
    return farewell
  })
}

/**
 * 上一次 destroy 没能真正结束的会话。
 * 下次 spawn 到这个 id 时**不能 attach 回去** —— 那就是接回了旧身份。
 */
const deadSessions = new Set<string>()

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1520,
    height: 940,
    title: 'Termspace',
    backgroundColor: '#00000000',
    vibrancy: 'under-window', // macOS 毛玻璃材质，画布透明底透出
    visualEffectState: 'active',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true // 画布浏览器节点用 <webview>
    }
  })

  // reload 时 renderer effect cleanup 不执行 → 释放客户端（tmux 会话存活，新页面 -A 接回）
  // （did-navigate 先于新页面 JS 执行，不会误杀新 spawn）
  win.webContents.on('did-navigate', () => {
    for (const id of [...ptys.keys()]) void releasePty(id)
  })

  /* ── 外壳收口（Electron 安全基线）──
     主窗口的 preload 暴露了 pty/凭证等能力，一旦被导航到外站就等于把这些交出去。 */

  // 画布浏览器节点的 <webview> 参数由主进程定，不信任 renderer 传的：
  // guest 绝不允许带 preload 或开 node —— 那等于任意网页拿到 Node 权限
  win.webContents.on('will-attach-webview', (_e, prefs, params) => {
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.contextIsolation = true
    const src = String(params.src ?? '')
    if (!/^(https?:\/\/|about:blank)/i.test(src)) params.src = 'about:blank'
    /* **session 隔离在这里执法**。不给 partition 时 <webview> 用 app 默认 session，
       于是所有浏览器节点共享 Cookie —— 而授权是按节点发的（App.tsx 的 browserGrants），
       agent 只要把自己那个节点导航到你在别的节点登录过的站，就白拿了登录态。
       renderer 负责给 `persist:tbwv-<nodeId>`；形状不对一律落到**一次性** session，
       绝不退回默认 session（退回去正是要防的那件事）。 */
    const want = String((params as { partition?: unknown }).partition ?? '')
    const part = /^persist:tbwv-[A-Za-z0-9_-]{1,40}$/.test(want)
      ? want
      : `tbwv-tmp-${randomUUID().slice(0, 8)}`
    ;(params as { partition?: string }).partition = part
    prefs.partition = part
  })

  /* 主窗口自身不许被导航走。用 origin/规范化路径比对，不能用 startsWith：
     `http://localhost:5173.evil.test` 是能通过前缀检查的。 */
  const devOrigin = process.env['ELECTRON_RENDERER_URL']
    ? new URL(process.env['ELECTRON_RENDERER_URL']).origin
    : null
  const prodPage = path.join(__dirname, '../renderer/index.html')
  const allowNav = (raw: string): boolean => {
    try {
      const u = new URL(raw)
      if (devOrigin) return u.origin === devOrigin
      return u.protocol === 'file:' && path.normalize(decodeURIComponent(u.pathname)) === prodPage
    } catch {
      return false
    }
  }
  const blockNav = (e: Electron.Event, url: string): void => {
    if (!allowNav(url)) e.preventDefault()
  }
  win.webContents.on('will-navigate', blockNav)
  win.webContents.on('will-redirect', blockNav)

  // 新窗口一律不在应用内开，扔给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 画布浏览器里的 target="_blank" / window.open：guest 有自己的 handler，
  // 不装的话这类链接是直接失效（点了没反应），而不是"被安全地拦下"
  win.webContents.on('did-attach-webview', (_e, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    // TERMBOARD_PANEL=general 等：自检截图时直接展开设置面板
    const qs = new URLSearchParams()
    if (process.env['TERMBOARD_PANEL']) qs.set('panel', process.env['TERMBOARD_PANEL'])
    // TERMBOARD_PALETTE=1：自检截图时直接展开 ⌘K 面板（键盘事件在截图模式下模拟不了）
    if (process.env['TERMBOARD_PALETTE']) qs.set('palette', '1')
    const q = qs.toString() ? `?${qs}` : ''
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'] + q)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return win
}

interface SpawnOpts {
  identityId?: string
  command?: string // agent 预设启动命令，spawn 后写入 shell
  provider?: string
  contextNodeIds?: string[] // 画布上连到本终端的简报节点
  cwd?: string // 工作目录（来自项目标签页）
}

ipcMain.handle(
  'pty:spawn',
  async (e, id: string, cols: number, rows: number, opts?: SpawnOpts) => {
    if (!fromMainWin(e) || !okId(id)) return
    /* spawn 与 destroy 走同一条串行链。只"等一下旧锁"不够：spawn 自身是异步的，
       后来的 destroy 会和它重叠，kill-session 可能落在刚建好的新会话上。 */
    return serialize(id, async () => {
    // 客户端是同步断开的；抓屏落盘不阻塞 spawn（否则每次重挂载都要等一次 capture-pane）
    void releasePty(id) // 只释放客户端；有 tmux 会话则下面 -A 接回
    const settings = await getSettings()
    /* 不叫 shell：模块顶部从 electron import 了同名的 `shell`（openExternal 那个）。
       在这个作用域里写 shell.openExternal 会拿到一个字符串路径。 */
    const loginShell =
      (settings.defaultShell && existsSync(settings.defaultShell) ? settings.defaultShell : '') ||
      process.env['SHELL'] ||
      '/bin/zsh'
    let env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v
    }
    // 防嵌套：app 若从 tmux 里启动，tmux 会拒绝
    delete env['TMUX']
    delete env['TMUX_PANE']
    env['TERM'] = 'xterm-256color'
    env['COLORTERM'] = 'truecolor'
    // hook 门控：托管脚本只在带 NODE_ID 的终端里工作
    env['TERMBOARD_NODE_ID'] = id
    env['TERMBOARD_AGENT_ID'] = opts?.provider ?? 'claude'
    if (hookSystem) {
      env['TERMBOARD_HOOK_ENDPOINT'] = hookSystem.endpointFile
      /* 每个节点一个 token，服务端据此反查"是谁在调"，不再采信请求里自报的 nodeId。
         每次 spawn 换新：老 token 立即失效，同 id 重建不会继承旧身份。
         env 里这份是给新会话用的；tmux 接回的老会话靠 endpoint 文件现查（-e 会被忽略）。 */
      env['TERMBOARD_HOOK_TOKEN'] = await hookSystem.issueNodeToken(id)
      // F8：tb 命令挂到 PATH 最前，agent 直接可用
      env['PATH'] = `${hookSystem.binDir}:${env['PATH'] ?? ''}`
    }
    // F2 上下文 + F8 工具路由提示（合成一份文件，Claude 预设经 --append-system-prompt 注入）
    env['TERMBOARD_CONTEXT_FILE'] = await buildMergedContext(id, opts?.contextNodeIds ?? [])
    /* identity env 包注入（多账号/多 key，密文存储主进程解密）。
       典型用法不是 API key，而是 CODEX_HOME / CLAUDE_CONFIG_DIR ——
       两个订阅账号各指一个目录，同一条 `codex` 命令在两个节点里登的就是两个号。 */
    const idEnv = await resolveIdentityEnv(opts?.identityId)
    /* **指名了凭证却取不到 = fail-closed，绝不静默退回默认环境。**
       凭证在设置里被删掉后，这个节点原来会：跳过整个 idEnv 块 → 连 unset 都不执行 →
       用户 shell 里 export 的 ANTHROPIC_API_KEY / OPENAI_API_KEY 原样继承进去 →
       CLI 绕过订阅走按量计费，界面上还显示着那个凭证的名字。账单不会吭声。
       所以这里宁可让终端起不来，也不能让它用一个**不是用户选的身份**跑起来。 */
    if (opts?.identityId && !idEnv) {
      sendToWin('pty:spawn-error', {
        nodeId: id,
        message: '这个终端绑定的凭证已经不存在了（可能在设置里被删了）。换一个凭证或摘掉连线再试。'
      })
      return { ok: false, error: 'identity-missing' }
    }
    if (idEnv) {
      /* set 和 unset 一起应用（applyIdentityEnv 是三处共用的那一份）。
         unset 是命根子：继承下来的 OPENAI_API_KEY / ANTHROPIC_API_KEY 会让 CLI
         绕过订阅走 key 计费。保留键在 materializeEnv 里已滤掉，这里再挡一道 ——
         老凭证可能是在加保护之前存进去的。 */
      const safe: ResolvedEnv = {
        set: Object.fromEntries(
          Object.entries(idEnv.set).filter(([k]) => !k.startsWith('TERMBOARD_'))
        ),
        unset: idEnv.unset.filter((k) => !k.startsWith('TERMBOARD_'))
      }
      // applyIdentityEnv 返回新对象（unset 是真删掉的），所以要整个换掉而不是 Object.assign
      env = applyIdentityEnv(env, safe) as Record<string, string>
      /* PATH 现在是保留键（identity 改不了它），所以不再需要"把 tb 目录顶回最前"那段。
         留个注释是因为这条曾经真的坏过：identity 改写 PATH 后 agent 就找不到 tb 了。 */
    }

    /* codex 的状态灯：把托管 hook 装进这个节点实际使用的 CODEX_HOME。
       每个订阅账号一个目录，所以只能在 spawn 时按需装。
       ⚠️ 装了不等于会跑 —— codex 对 hook 有授信机制，未授信时**静默跳过**。
       体检里有一条探针专门验这个，别在这里假设成功。 */
    /* **不判 provider —— 任何终端都装**。原来只给 `provider === 'codex'` 的节点装，
       而用户最常见的用法是先开一个普通 zsh、再手敲 `codex`：那种节点
       provider 是空，于是它**完全不上报状态**，发光边框不亮、额度面板数不到它、
       `tb ask` 也接不了单。而 Claude 那边的 hook 装在全局 `~/.claude`，
       同样的用法就一切正常 —— 两边不对称，用户感知到的就是"codex 少算了"。

       代价：给每个终端的 CODEX_HOME 写一次 hooks.json（幂等、有备份、
       只在用户已同意写 hook 时执行）。没装 codex 的用户那边就是一个没人读的文件。 */
    if (hookSystem && settings.claudeHooks === 'on') {
      const codexHome = env['CODEX_HOME'] || path.join(os.homedir(), '.codex')
      await hookSystem.enableCodexHooks(codexHome).catch((err) => {
        console.warn('codex hook 安装失败:', err)
      })
    }
    /* Claude 同理 —— **原来以为它"一次装全局"就够了，那是错的**：
       `CLAUDE_CONFIG_DIR` 会整个覆盖默认目录（settings / hooks / 会话历史 / 插件），
       隔离账号根本不读 `~/.claude/settings.json`。不按目录装的话，
       用户看到凭证切换成功、登录也成功，但那个节点的状态灯和 `tb ask` 接单
       **静默失效** —— 而多账号正是这个产品的目标用户。 */
    if (hookSystem && settings.claudeHooks === 'on' && env['CLAUDE_CONFIG_DIR']) {
      await hookSystem.enableClaudeHooksIn(env['CLAUDE_CONFIG_DIR']).catch((err) => {
        console.warn('claude hook 安装失败:', err)
      })
    }

  const tmux = settings.tmuxEnabled ? await ensureTmux(settings.scrollback) : null
  // fresh 判定：无可接会话 = 冷启动，才写入预设启动命令（重接不能重复敲）
  const fresh = tmux ? !(await hasSession(id)) : true
  // cold-restore：冷启动且有旧快照 → 先把上次画面回灌进 xterm（机器重启后恢复历史）
  let coldSnapshot = ''
  if (fresh) {
    try {
      coldSnapshot = await readFile(scrollbackFile(id), 'utf8')
    } catch {
      // 无快照
    }
  }
  /* 上一次 destroy 没杀干净的会话，绝不能就这么 attach 回去 ——
     `new-session -A` 会接回旧会话并**忽略新的 -e**，换凭证后界面显示 B、实际还是 A。 */
  if (deadSessions.has(id)) {
    await killSession(id)
    if (await hasSession(id)) {
      sendToWin('pty:spawn-error', {
        nodeId: id,
        message:
          '上一次的会话没能结束（tmux 里还在），为免接回旧账号已拒绝启动。\n' +
          `手动清理：tmux -L termboard kill-session -t =tb-${id}`
      })
      return { ok: false, error: 'stale-session' }
    }
    deadSessions.delete(id)
  }
  const cwd = opts?.cwd && existsSync(opts.cwd) ? opts.cwd : os.homedir()
  spawnedRoots.add(cwd)
  /* identity 的键要显式告诉 tmux 层转发 —— 按前缀猜会漏（见 buildSpawnArgs 注释），
     unset 也只有它知道该删哪些（env 对象里已经没有那些键了，猜不出来）。 */
  /* 密钥不能走 `tmux -e` —— 那会把值原样写进客户端 argv，而客户端进程和终端同寿。
     实测 `ps -Ao args` 全程看得到，同机其他用户也读得到（macOS 没有 hidepid）。
     所以密钥落一份 0600 文件，会话的 shell 先 source 再当场删掉它，argv 里只有路径。
     路径类变量（CODEX_HOME / CLAUDE_CONFIG_DIR）不是秘密，照常走 `-e` ——
     这样用户在会话里手开 window 也还是同一个账号。 */
  let secretFile: string | undefined
  const secrets = Object.entries(idEnv?.set ?? {}).filter(([k]) => identityValueIsSecret(k))
  /* **只有 fresh 才落这份文件**。接回已存在的会话时，`new-session -A` 根本不执行
     那条"source 完就 rm"的 shell 命令 —— 文件于是永久留在 userData 里，
     而每次 remount / 折叠展开 / 切项目都会再留一个。凭证明文躺满一目录，
     设置面板还写着"明文不落盘"。值在会话里本来就已经有了，重发一次没有意义。 */
  if (tmux && fresh && secrets.length) {
    secretFile = path.join(app.getPath('userData'), `env-${randomUUID()}.sh`)
    const body = secrets.map(([k, v]) => `export ${k}=${shellQuote(v)}`).join('\n')
    await writeFile(secretFile, `${body}\n`, { mode: 0o600 })
  }
  const { file, args } = buildSpawnArgs(
    tmux,
    id,
    loginShell,
    cwd,
    env,
    { keys: Object.keys(idEnv?.set ?? {}), unset: idEnv?.unset ?? [] },
    secretFile
  )
  /* 走 tmux 时，客户端进程的环境**必须是干净的** —— 身份只走 `-e`。
     第一个客户端的环境会变成长寿 server 的全局环境，凭证 A 的私钥会就此
     被后来所有会话继承（实测：B 的 pane 打印出了 A 的 key）。见 tmuxClientEnv。
     不走 tmux 时没有别的载体，env 原样传。 */
  const p = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: cols > 0 ? cols : 80,
    rows: rows > 0 ? rows : 24,
    cwd,
    env: tmux
      ? tmuxClientEnv(env, { keys: Object.keys(idEnv?.set ?? {}), unset: idEnv?.unset ?? [] })
      : env
  })
  ptys.set(id, p)

  // agent 预设：等 shell 就绪后写入启动命令（tty 缓冲会排队，200ms 只是保险）
  const cmd = opts?.command?.trim()
  if (cmd && fresh) {
    setTimeout(() => {
      if (ptys.get(id) === p) p.write(`${cmd}\r`)
    }, 200)
  }

  const wc = e.sender
  // 先把冷启动快照推给 xterm（灰显 + 分隔线），再让实时输出接上
  if (coldSnapshot && !wc.isDestroyed()) {
    wc.send(
      `pty:data:${id}`,
      `${coldSnapshot}\r\n\x1b[38;5;244m── 会话已恢复（上次画面）──\x1b[0m\r\n`
    )
  }
  p.onData((data) => {
    // 与 onExit 同样的实例守卫：同 id 重生成后，旧实例的尾部输出不能串进新 xterm
    if (ptys.get(id) !== p) return
    if (!wc.isDestroyed()) wc.send(`pty:data:${id}`, data)
  })
  p.onExit(({ exitCode }) => {
    // 实例守卫：exit 是异步的，同 id 重生成后旧实例的 exit 不能删/通知新实例
    if (ptys.get(id) !== p) return
    ptys.delete(id)
    // 进程没了 → 会话按死处理，迟到的 hook 不得再把它判成活 agent
    dropNode(id)
    if (!wc.isDestroyed()) wc.send(`pty:exit:${id}`, exitCode)
  })
  })
})

ipcMain.on('pty:write', (e, id: string, data: string) => {
  if (!fromMainWin(e) || !okId(id)) return
  if (typeof data !== 'string' || data.length > PTY_WRITE_LIMIT) return
  ptys.get(id)?.write(data)
})

/**
 * 输入框专用的**带回执**写入。
 *
 * `pty:write` 是 fire-and-forget，超限或会话已死时**静默丢弃** —— 对逐键输入
 * 无所谓（丢一个字符看得见），但输入框是「打了一大段、按发送、框清空」：
 * 静默丢弃 = 用户的稿子没了而且他不知道。所以这条走 invoke 拿回执，
 * renderer 收到 ok 才清草稿。
 *
 * 高频单键仍走 `pty:write`，不要改到这条来（每键一次 IPC 往返不值）。
 */
ipcMain.handle('pty:sendInput', (e, id: unknown, data: unknown) => {
  if (!fromMainWin(e) || typeof id !== 'string' || !okId(id)) return { ok: false, reason: 'bad-target' }
  if (typeof data !== 'string' || !data) return { ok: false, reason: 'bad-target' }
  if (data.length > PTY_WRITE_LIMIT) return { ok: false, reason: 'too-long' }
  const p = ptys.get(id)
  if (!p) return { ok: false, reason: 'no-session' }
  p.write(data)
  return { ok: true }
})

/**
 * 输入框上那排 chips 要的东西：**此刻**的目录、分支、脏文件数。
 *
 * 两条判据：
 * - **`live` 必须如实报。** tmux 查得到 `#{pane_current_path}` 才是实时值；
 *   查不到就退回建节点时那个 cwd 并标 `live:false`，让界面写「启动目录」。
 *   悄悄拿旧 cwd 冒充实时 = 用户 `cd` 到别的仓库后，chips 一直显示上一个
 *   仓库的分支，而且不报错、看不出来。
 * - **只查便宜的。** `git status --porcelain` 数脏文件够用；完整
 *   `+新增/-删除` 摘要（`diffSummary`）贵得多，只在用户点开时查，不进轮询。
 */
ipcMain.handle('terminal:meta', async (e, id: unknown, fallbackCwd: unknown) => {
  if (!fromMainWin(e) || typeof id !== 'string' || !okId(id)) return null
  const liveCwd = await paneCwd(id).catch(() => '')
  const cwd = liveCwd || (typeof fallbackCwd === 'string' ? fallbackCwd : '')
  if (!cwd) return null
  const st = await worktreeStatus(cwd).catch(() => null)
  return {
    cwd,
    live: Boolean(liveCwd),
    branch: st?.branch ?? null,
    dirty: st?.dirty ?? null,
    // 渲染层展开 `~/x` 要用。放这里是因为它和 cwd 是同一次查询的自然搭档
    home: os.homedir()
  }
})

ipcMain.on('pty:resize', (e, id: string, cols: number, rows: number) => {
  if (!fromMainWin(e) || !okId(id)) return
  if (cols <= 0 || rows <= 0) return
  const p = ptys.get(id)
  if (!p) return
  /* **尺寸没变就别 resize。** `pty.resize()` 无条件发 TIOCSWINSZ，
     内核照发 SIGWINCH，zsh 每收到一次就重画一遍 prompt —— 而拖拽节点时
     renderer 是每帧调一次的。用户报的"缩放窗口刷出几十行重复 prompt"
     就是这么来的（一帧一行）。

     守卫放在这里而不是调用侧：`IPty` 自带 readonly cols/rows，这是唯一
     知道 pty **当前**尺寸的地方；放调用侧则每个 caller 各存一份影子状态，
     还会和"接回已存在 tmux 会话"这类不经过 renderer 的路径对不上。 */
  if (p.cols === cols && p.rows === rows) return
  try {
    p.resize(cols, rows)
  } catch {
    // resize 竞态：进程刚退出时忽略
  }
})

/**
 * 审批决策：走 Claude 的 PermissionRequest hook 结构化应答，不是往 pty 里盲写 y。
 * 盲写的问题是没法保证那一下落在正确的提示上（agent 可能早换轮或已退出）。
 */
ipcMain.handle('approval:decide', (e, id: string, allow: boolean) => {
  if (!fromMainWin(e) || typeof id !== 'string') return { ok: false, error: '非法请求' }
  const hit = hookSystem?.decideApproval(id, !!allow) ?? false
  return hit
    ? { ok: true }
    : { ok: false, error: '该审批已失效（超时或 agent 已自行处理），请到终端确认' }
})

/**
 * 抓某个终端当前屏的尾部若干行 —— 消息中心用它把"终端到底在问什么"直接显示出来。
 * 只有看得见问题，就地回答才是安全的；否则就是盲按。
 */
/**
 * 当前屏的指纹。**回答必须绑定到"用户看见的那一屏"** ——
 * 卡片每 2.5s 抓一次，而点击发生在两次抓取之间：这段时间里问题可能已经答完、
 * agent 可能已经退到 shell、也可能是新会话接管了同一个节点。
 * 那时写进去的内容会落到另一个提示、另一个会话，甚至直接变成 shell 命令。
 *
 * 用整屏内容做指纹而不是 session id：agent 退出到 shell 时 pane 内容必变，
 * 一个判据同时覆盖"问题变了"和"人换了"。
 */
async function paneSig(id: string): Promise<string> {
  const raw = await capturePane(id)
  return raw ? createHash('sha256').update(raw).digest('hex').slice(0, 16) : ''
}

ipcMain.handle('agent:peek', async (e, id: string, lines = 8) => {
  if (!fromMainWin(e) || !okId(id)) return { text: '', sig: '' }
  const [text, sig] = await Promise.all([peekPane(id, lines), paneSig(id)])
  return { text, sig }
})

/**
 * 就地回答：把用户在消息中心敲的内容写进该终端。
 * 与"盲发 y"的区别是 —— 上面 peek 已经把问题原文显示出来了，用户看着回答，
 * 等价于自己在终端里敲，不是替他猜。
 */
ipcMain.handle('agent:reply', async (e, id: string, text: string, expectSig?: unknown) => {
  if (!fromMainWin(e) || !okId(id)) return { ok: false, error: '非法请求' }
  if (typeof text !== 'string' || text.length > 4096) return { ok: false, error: '内容不合法' }
  /* **落笔前重新对一次指纹**。调用方传的是它渲染那一屏时的指纹；
     对不上说明画面已经变了 —— 拒绝并让卡片刷新，绝不"大概是同一个问题"就写进去。
     ⚠️ capturePane 之后到 p.write 之间**不许再出现 await**：那正是这条要堵的窗口。 */
  if (typeof expectSig === 'string' && expectSig) {
    const now = await paneSig(id)
    if (now !== expectSig) {
      return { ok: false, changed: true, error: '这个终端的画面已经变了，看一眼新内容再答' }
    }
  }
  const p = ptys.get(id)
  if (!p) return { ok: false, error: '终端已不存在' }
  p.write(text)
  return { ok: true }
})

ipcMain.on('pty:kill', (e, id: string) => {
  if (!fromMainWin(e) || !okId(id)) return
  // effect cleanup（remount/HMR/reload 前奏）→ 释放客户端，会话续存
  void releasePty(id)
})

// 节点 ✕ / 换身份 → 真杀会话。可 await：renderer 换身份时要等旧会话确实死透再 respawn
ipcMain.handle('pty:destroy', (e, id: string) => {
  if (!fromMainWin(e) || !okId(id)) return Promise.resolve('')
  return destroyPty(id)
})

/**
 * 撤回删除时回灌屏幕内容：写进 cold-restore 用的快照文件，
 * 节点重建后 spawn 走 fresh 分支就会把它显示出来。
 * 进程本身救不回来 —— 这只是让恢复出来的终端不是一片空白。
 */
ipcMain.handle('session:seedScrollback', async (e, id: string, text: string) => {
  if (!fromMainWin(e) || !okId(id)) return false
  if (typeof text !== 'string' || !text.trim()) return false
  try {
    const f = scrollbackFile(id)
    await mkdir(path.dirname(f), { recursive: true })
    await writeFile(f, text.slice(0, 512 * 1024))
    return true
  } catch {
    return false
  }
})

// ── Worker 操作 IPC（F7）──
ipcMain.handle(
  'worker:action',
  (_e, action: 'result' | 'kill' | 'send' | 'clean', task: string, text?: string) => {
    const r = workerAction(action, task, text)
    // 操作后强制刷新一轮（比如 kill 后状态立刻变）
    setTimeout(() => workerWatch?.refresh(), 500)
    return r
  }
)

// ── 自动更新 IPC ──
let updater: Updater | null = null
/** 设置里的「自动检查更新」。用户点「立即检查」时无视它 —— 那是明确的当下意图 */
let autoUpdateEnabled = true
/** 更新源。空 = 没配，check 会如实说而不是去撞打包时那个占位域名 */
let updateFeedUrl = ''
ipcMain.handle('update:get', (e) => (fromMainWin(e) ? (updater?.state() ?? null) : null))
ipcMain.handle('update:check', (e) => {
  if (fromMainWin(e)) updater?.check(true)
})
/* **装 = 重启 app**，所以必须只认主窗口来的调用。
   webview 里随便一个页面能触发重启的话，用户正在跑的活就没了。 */
ipcMain.handle('update:install', (e) => {
  if (fromMainWin(e)) updater?.install()
})

// ── 设置 IPC ──
/* **设置入口的权限至少要和更新入口一致**。三个 update IPC 都查了 fromMainWin，
   紧邻的 settings 反而没查 —— 而 `updateFeedUrl` 就在这里，改它等于改更新源。
   当前 webview 是 nodeIntegration:false 且无 preload，利用不了；但这是"以后给
   webview 加个 preload 就破"的那种洞，不该留着。 */
ipcMain.handle('settings:get', (e) => (fromMainWin(e) ? getSettings() : null))
ipcMain.handle('settings:set', async (e, patch: Partial<Settings>) => {
  if (!fromMainWin(e)) return null
  /* 收紧方向**先于落盘**生效：用户点掉「允许远程写入」的那一刻门就该关上。
     等 setSettings 成功再更新的话，写盘一失败（磁盘满 / 权限）界面显示"只读"、
     实际 gate 仍是 true —— 安全开关只允许往安全的方向失败。 */
  if (patch.remoteAllowInput === false) remoteAllowInput = false
  if (patch.remoteAllowApprove === false) remoteAllowApprove = false
  /* 总开关同理，而且比上面两个更狠：点「关闭」通常是在应急撤权，
     不能等到下次重启才断。**两个能力 gate 也一起压死** —— 主开关关了
     还留着"允许远程写入"的内存状态，下次打开就自动带着旧权限回来。 */
  if (patch.remoteEnabled === false) {
    remoteAllowInput = false
    remoteAllowApprove = false
    stopRemote()
  }
  const next = await setSettings(patch)
  /* **总开关关着时两个能力 gate 恒为 false**。照抄 settings 的话，
     刚刚 stopRemote 压死的 gate 会被磁盘里那份"允许远程写入=true"原样恢复，
     等于关了个寂寞。 */
  remoteAllowInput = next.remoteEnabled && next.remoteAllowInput // 立刻生效，不用重启
  remoteAllowApprove = next.remoteEnabled && next.remoteAllowApprove
  // 打开：立刻起。地址/端口变了要重启 app（UI 已写明），这里只管开关本身
  if (patch.remoteEnabled === true && !remoteApi) {
    await startRemote(next.remoteBind, next.remotePort)
  }
  autoUpdateEnabled = next.autoUpdate
  updateFeedUrl = next.updateFeedUrl // 改完地址不用重启，下次检查就用新的
  notifyUrl = next.notifyUrl // 同上：改完立刻生效
  notifyLevel = next.notifyLevel
  return next
})

/**
 * 「发一条测试通知」。**必须存在**：这条链路的失败全都是静默的
 * （地址写错 / topic 打错 / 手机没订阅），没有这个按钮用户只能等一次真事件，
 * 而真事件恰恰发生在他不在电脑前的时候。
 *
 * 用面板里当前填的地址，不是已保存的那个 —— 用户的心智是"填完点一下试试"。
 */
ipcMain.handle('notify:test', async (e, url: unknown) => {
  if (!fromMainWin(e)) return { ok: false, error: 'denied' }
  try {
    await sendTestNotification(typeof url === 'string' ? url : '')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
})

/** 远程访问状态（设置面板显示地址与配对 token） */
/* ── git worktree ──
   画布上一个组 = 一棵树，并行 agent 物理隔离（见 src/main/worktree.ts）。
   四个都查 fromMainWin：createWorktree / removeWorktree 会真的动文件系统，
   而 webview guest 也是一个 webContents —— 不查就等于把它们暴露给任意页面。 */
ipcMain.handle('git:probe', async (e, cwd: unknown) => {
  if (!fromMainWin(e)) return null
  if (typeof cwd !== 'string') return null
  return probeRepo(cwd)
})
ipcMain.handle('git:worktreeStatus', async (e, p: unknown) => {
  if (!fromMainWin(e)) return null
  if (typeof p !== 'string') return null
  return worktreeStatus(p)
})
ipcMain.handle('git:createWorktree', async (e, repoRoot: unknown, branch: unknown) => {
  if (!fromMainWin(e)) return { ok: false, error: 'denied' }
  if (typeof repoRoot !== 'string' || typeof branch !== 'string') {
    return { ok: false, error: '参数不合法' }
  }
  return createWorktree(repoRoot, branch)
})
/** 一棵树（或任意仓库路径）相对 HEAD 改了什么。只读 */
ipcMain.handle('git:diffSummary', async (e, p: unknown) => {
  if (!fromMainWin(e)) return null
  if (typeof p !== 'string') return null
  return diffSummary(p)
})

/* 在编辑器打开。**编辑器名走白名单**（见 open-in-editor.ts）——
   不然这个"编辑器命令"设置项就是一个任意命令执行入口。 */
ipcMain.handle('editor:open', async (e, target: unknown, editor: unknown) => {
  if (!fromMainWin(e)) return { ok: false, error: 'denied' }
  if (typeof target !== 'string') return { ok: false, error: '参数不合法' }
  return openInEditor(target, typeof editor === 'string' ? editor : '')
})
ipcMain.handle('editor:list', (e) => (fromMainWin(e) ? editorNames() : []))

ipcMain.handle('git:removeWorktree', async (e, p: unknown) => {
  if (!fromMainWin(e)) return { ok: false, error: 'denied' }
  if (typeof p !== 'string') return { ok: false, error: '参数不合法' }
  return removeWorktree(p)
})

/** 任务账本快照。renderer reload 后靠它重新填卡片（推送是增量的） */
ipcMain.handle('tasks:list', async (e) => {
  if (!fromMainWin(e)) return []
  return sortForReview((await ledger?.list()) ?? [])
})

ipcMain.handle('remote:status', async (e) => {
  if (!fromMainWin(e)) return null
  const s = await getSettings()
  return {
    enabled: s.remoteEnabled,
    allowInput: s.remoteAllowInput,
    allowApprove: s.remoteAllowApprove,
    running: !!remoteApi,
    port: remoteApi?.port ?? s.remotePort,
    token: remoteApi?.token ?? '',
    bindMode: s.remoteBind,
    // 实际绑到的地址。**永远不会是 0.0.0.0** —— 这个进程能 spawn pty、持有凭证
    bind: remoteApi?.host ?? (s.remoteBind === 'tailscale' ? resolveBind('tailscale').host : '127.0.0.1'),
    /** 选了 tailscale 却没找到地址 → 实际只有本机能连，界面必须说清楚 */
    fellBack: remoteFellBack,
    /** 启动失败的原因（端口被占之类）。空 = 没失败 */
    error: remoteError,
    /** 手机扫这个：带 token 的一次性配对链接 */
    pairUrl: remoteApi ? `http://${remoteApi.host}:${remoteApi.port}/#t=${remoteApi.token}` : ''
  }
})
/** 已发出的访问凭据（**只回元数据，token 本身绝不回**，刚签发那次除外） */
ipcMain.handle('remote:tokens', async (e) => {
  if (!fromMainWin(e)) return []
  return (await loadTokens(remoteTokenFile())).map(toMeta)
})

/** 签发一把只读分享链接。返回完整链接（**这是 token 唯一一次出主进程**） */
ipcMain.handle('remote:issueViewer', async (e, label: string) => {
  if (!fromMainWin(e)) return null
  if (!remoteApi) return { error: '远程访问没开' }
  const { issued } = await issueToken(remoteTokenFile(), 'viewer', String(label ?? ''))
  await remoteApi.reloadTokens()
  return {
    url: `http://${remoteApi.host}:${remoteApi.port}/#t=${issued.token}`,
    expiresAt: issued.expiresAt
  }
})

ipcMain.handle('remote:revoke', async (e, hint: string) => {
  if (!fromMainWin(e)) return []
  const list = await loadTokens(remoteTokenFile())
  // 渲染层只有前 6 位（token 本身不出主进程），按它反查
  const hit = list.find((t) => t.token.startsWith(String(hint ?? '')) && String(hint ?? '').length === 6)
  if (hit) await revokeToken(remoteTokenFile(), hit.token)
  await remoteApi?.reloadTokens()
  return (await loadTokens(remoteTokenFile())).map(toMeta)
})

ipcMain.handle('skills:list', async () => {
  const dirs = (await getSettings()).skillDirs
  return (await listSkills(dirs)).map((s) => ({
    name: s.name,
    description: s.description,
    source: s.source
  }))
})
ipcMain.handle('hooks:status', async () => ({
  installed: !!hookSystem,
  endpoint: hookSystem?.endpointFile ?? '',
  settingsPath: path.join(os.homedir(), '.claude', 'settings.json'),
  consent: (await getSettings()).claudeHooks
}))

/** 设置面板「卸载 hook」：摘掉写进用户 settings.json 的条目并记住选择 */
ipcMain.handle('hooks:uninstall', async (e) => {
  if (!fromMainWin(e)) return { ok: false }
  const changed = await uninstallClaudeHooks()
  await setSettings({ claudeHooks: 'off' })
  return { ok: true, changed }
})

/* ── 首启体检：缺依赖时明确说"缺什么、影响什么、怎么补"，
   而不是让人对着一个"看起来开着但某些功能不生效"的应用猜。 ── */
export interface DoctorItem {
  key: string
  label: string
  ok: boolean
  detail: string
  hint: string
}

function which(bin: string): string {
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
    const p = path.join(d, bin)
    if (existsSync(p)) return p
  }
  return ''
}

/**
 * codex 状态 hook 的体检。
 *
 * 有两道关，缺一不可，而**第二道关失败时 codex 完全不吭声**：
 *   1. `$CODEX_HOME/hooks.json` 里有我们的条目（spawn codex 节点时自动写）
 *   2. codex 已经**授信**这些 hook —— 未授信时它静默跳过全部 hook，不报错不提示
 *
 * 第二道关没有公开的查询命令，只能看 config.toml 里有没有落下 trusted_hash。
 * 判不准的时候宁可报"没确认"，也不要给一个绿灯让用户对着不亮的状态灯干瞪眼 ——
 * 这个项目已经栽过两次静默失败了。
 */
async function codexHookCheck(): Promise<DoctorItem> {
  const home = path.join(os.homedir(), '.codex')
  const item = (ok: boolean, detail: string, hint: string): DoctorItem => ({
    key: 'codex-hooks',
    label: 'Codex 状态 hook',
    ok,
    detail,
    hint
  })
  if (!which('codex') && !existsSync(home)) {
    return item(true, '未安装 codex，不适用', '装了 codex 后，codex 节点也会有状态灯')
  }
  const installed = await codexHooksPresent(home).catch(() => false)
  if (!installed) {
    return item(
      false,
      '尚未写入 ~/.codex/hooks.json',
      '在画布上开一个 codex 预设的终端即可自动写入（需先在设置里授权 hook 写入）'
    )
  }
  let trusted = false
  try {
    const toml = await readFile(path.join(home, 'config.toml'), 'utf8')
    trusted = /trusted_hash/.test(toml)
  } catch {
    // 没有 config.toml = 肯定没授信过
  }
  return trusted
    ? item(true, '已写入并已授信', '')
    : item(
        false,
        '条目已写入，但 codex 里查不到授信记录 —— 此时它会静默跳过全部 hook',
        '在这个 codex 终端里跑一次交互式 `codex` 并按提示信任 hook；' +
          '之后状态灯才会亮。用了多个订阅账号的话，每个 CODEX_HOME 都要各授信一次'
      )
}

ipcMain.handle('app:doctor', async (e): Promise<DoctorItem[]> => {
  if (!fromMainWin(e)) return []
  const s = await getSettings()
  const present = await claudeHooksPresent()
  const tmux = which('tmux')
  const claude = which('claude') || existsSync(path.join(os.homedir(), '.claude')) ? 'ok' : ''
  const items: DoctorItem[] = [
    {
      key: 'tmux',
      label: 'tmux 会话续存',
      ok: !!tmux,
      detail: tmux ? tmux : '未找到 tmux',
      hint: '装了才能让终端跨应用重启存活：brew install tmux'
    },
    {
      // 报实情：真去 settings.json 里找条目，而不是只看我们自己记的授权开关
      key: 'hooks',
      label: 'Claude 状态 hook',
      ok: !!hookSystem && present,
      detail: !hookSystem
        ? 'hook 服务未启动'
        : present
          ? s.claudeHooks === 'on'
            ? '已接入'
            : '条目在（早前版本装的），但当前未授权'
          : '未写入 ~/.claude/settings.json',
      hint: '没有它，节点状态只是占位，不反映 agent 真实情况'
    },
    {
      key: 'claude',
      label: 'Claude Code',
      ok: !!claude,
      detail: claude ? '已安装' : '未检测到 ~/.claude',
      hint: 'agent 节点与上下文占用依赖它'
    },
    await codexHookCheck(),
    {
      key: 'cdx',
      label: 'worker 引擎 cdx',
      /* **和轮询用同一个解析器**。以前这里查 `which cdx`、轮询却写死
         `python3 ~/.claude/skills/.../cdx.py` —— 两条判据各自都对，
         合起来就出现"体检绿但没有卡片"和"卡片能用但体检红"。 */
      ok: !!resolveCdx(),
      detail: resolveCdx()?.detail || '未找到 cdx（装 cxcc-subagent skill 或把 cdx 放进 PATH）',
      hint: '仅影响 F7 worker 卡片，其余功能不受影响'
    }
  ]
  return items
})

// ── 选择项目文件夹 ──
ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: '选择项目文件夹'
  })
  return r.canceled ? null : r.filePaths[0]
})

// ── Agent 预设 IPC ──
ipcMain.handle('preset:list', () => listPresets())
ipcMain.handle('preset:upsert', (_e, input: Parameters<typeof upsertPreset>[0]) =>
  upsertPreset(input)
)
ipcMain.handle('preset:delete', (_e, id: string) => deletePreset(id))

// ── Identity（凭证）IPC：渲染层只见元数据，env 值不出主进程 ──
/* 每次增删改都要重建额度账号表。**渲染层不负责通知** ——
   之前只挂了一个 `quota:sync` 监听、没有任何发送方，所以加一个订阅号后
   HUD 里要等下次重启才出现，而且改了 CODEX_HOME 还会继续显示旧号的额度。 */
const afterIdentityChange = <T,>(r: T): T => {
  void syncQuotaAccountsRef?.()
  return r
}
/* 这三条此前漏了 fromMainWin —— 同批的 rename / loginStatus 都有，是不一致而不是有意为之。
   凭证库是这个 app 里最敏感的东西（改一条 identity 就能把某个终端的 CODEX_HOME 指走），
   来源判定必须和同组的其它路由一致。 */
ipcMain.handle('identity:list', (e) => (fromMainWin(e) ? listIdentities() : []))
/* 凭证库的健康状态。**必须有一个出口** —— `identityStoreError()` 原来是死代码，
   于是解密失败时界面显示的是「还没有凭证」，那是**假话**：库还在、只是读不出来，
   而任何写入都会被拒（防止拿残缺视图覆盖真库）。用户看到的是"空列表 + 保存报错"，
   完全对不上。这条 IPC 让面板能如实说出"读不出来，已进入只读保护"。 */
ipcMain.handle('identity:health', (e) => (fromMainWin(e) ? identityStoreError() : null))
ipcMain.handle('identity:upsert', async (e, input: Parameters<typeof upsertIdentity>[0]) =>
  fromMainWin(e) ? afterIdentityChange(await upsertIdentity(input)) : []
)
ipcMain.handle(
  'identity:createSubscription',
  async (e, input: { provider?: unknown; name?: unknown }) => {
    if (!fromMainWin(e)) return null
    const provider = String(input?.provider ?? '')
    const spec = PROVIDERS.find(
      (p) => p.id === provider && p.authModes.includes('isolated-subscription')
    )
    if (!spec || spec.isolationCapability !== 'directory') {
      throw new Error('这个工具不支持可靠的独立登录空间')
    }
    const id = randomUUID()
    const dir = path.join(app.getPath('home'), '.termspace', 'accounts', provider, id)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    /* **两个都从 manifest 派生，绝不在这里再硬编码一份。**
       原来 `conflictKey` 是三元表达式只取一个变量，而 manifest 里 gemini 声明的是
       `GEMINI_API_KEY` + `GOOGLE_API_KEY` 两个 —— 少删的那个会让新隔离空间
       **表面建成功、实际继续用继承来的 key**，不报错，只是账单不吭声。
       （codex 对手方审查逮到。判据：清单声明了什么，就必须清干净什么。） */
    const homeKey = spec.homeEnvKey
    if (!homeKey) throw new Error(`${provider} 的清单没写 homeEnvKey，无法建独立登录空间`)
    const conflictKeys = spec.conflictVariables
    const list = await upsertIdentity({
      id,
      name: String(input?.name ?? ''),
      provider: provider as Parameters<typeof upsertIdentity>[0]['provider'],
      envOps: [
        { key: homeKey, action: 'set', value: dir },
        ...conflictKeys.map((key) => ({ key, action: 'unset' as const }))
      ]
    })
    return { id, list: afterIdentityChange(list) }
  }
)
ipcMain.handle('identity:envPresence', (e, keys: unknown) => {
  if (!fromMainWin(e) || !Array.isArray(keys)) return []
  return keys
    .filter((key): key is string => typeof key === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(key))
    .slice(0, 30)
    .filter((key) => Object.hasOwn(process.env, key))
})
ipcMain.handle('identity:delete', async (e, id: string) =>
  fromMainWin(e) ? afterIdentityChange(await deleteIdentity(id)) : []
)
ipcMain.handle('identity:rename', async (e, id: string, name: string) =>
  fromMainWin(e) ? afterIdentityChange(await renameIdentity(String(id), String(name))) : []
)
/** 凭证节点上的登录态。只读、不花额度；查不出来就如实报 unknown */
ipcMain.handle('identity:loginStatus', (e, id: string) =>
  fromMainWin(e) ? identityLoginStatus(String(id)) : { state: 'unknown', detail: '' }
)

ipcMain.handle('quota:scanUsage', async (e, ids: unknown) => {
  if (!fromMainWin(e) || !Array.isArray(ids)) return {}
  const safe = ids.filter(okId).slice(0, 200)
  const providers = await paneProcessProviders(safe)
  const next = new Set(Object.values(providers))
  const changed =
    next.size !== detectedPaneProviders.size || [...next].some((p) => !detectedPaneProviders.has(p))
  detectedPaneProviders = next
  // 已知 CLI 起停是四个允许的账号扫描触发点之一。
  if (changed) void syncQuotaAccountsRef?.()
  return providers
})

ipcMain.handle('quota:rescan', async (e) => {
  if (!fromMainWin(e)) return
  await syncQuotaAccountsRef?.()
  quotaHub?.refresh()
})

// ── F2 上下文：每个简报节点一个文件，按画布连线决定注入给谁 ──
const ctxDir = (): string => path.join(app.getPath('userData'), 'contexts')
const ctxFile = (nodeId: string): string =>
  path.join(ctxDir(), `${nodeId.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`)

ipcMain.handle('context:load', async (e, nodeId: string) => {
  if (!fromMainWin(e) || !okId(nodeId)) return ''
  // 简报现在按项目隔离（ctx-<projectId>）。找不到自己的文件就沿老版本回退取内容，
  // 保证从「全画布共用一份 ctx-hub」升上来时旧简报不丢；首次编辑即写进本项目自己的文件。
  const chain = [ctxFile(nodeId)]
  if (nodeId.startsWith('ctx-')) {
    chain.push(ctxFile('ctx-hub'), path.join(app.getPath('userData'), 'board-context.md'))
  }
  for (const f of chain) {
    try {
      return await readFile(f, 'utf8')
    } catch {
      // 试下一个回退源
    }
  }
  return ''
})

/* 按节点串行化写入。防抖保存 + 卸载补发可以同时在路上，
   而固定 `.tmp` 会让两次写互相踩：后一次的 rename 撞上 ENOENT（前一次已经改名走了），
   或者两个写者交错把半份内容 rename 成正式文件。settings-store 早就这么做了。 */
const ctxWriteChain = new Map<string, Promise<unknown>>()

ipcMain.handle('context:save', async (e, nodeId: string, text: string) => {
  if (!fromMainWin(e) || !okId(nodeId)) return { ok: false, error: '非法节点 id' }
  const run = (ctxWriteChain.get(nodeId) ?? Promise.resolve()).then(async () => {
    await mkdir(ctxDir(), { recursive: true })
    const f = ctxFile(nodeId)
    const tmp = `${f}.${randomUUID().slice(0, 8)}.tmp`
    await writeFile(tmp, String(text))
    await rename(tmp, f)
  })
  ctxWriteChain.set(nodeId, run.catch(() => undefined)) // 一环失败不能卡死后续写入
  try {
    await run
    return { ok: true }
  } catch (err) {
    console.error('context save failed:', err)
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
})

/* F8 L0 路由提示：常驻成本 ~60 token，只讲"何时去查"，不讲工具内容。
   没有它模型不会主动去 tb 查，整个渐进式披露就白设计了。 */
const TOOL_ROUTING_HINT = `## Termspace 工具中枢
本终端可用 \`tb\` 命令按需取用共享工具（不要凭记忆猜工具用法）：
- 遇到需要专门方法的任务（设计/出图/部署/数据/视频/文档等）先跑 \`tb skills <关键词>\`
- 命中后用 \`tb load <名称>\` 取全文再照做
- \`tb agents\` 看本画布其他 agent 终端，\`tb ask <id> <任务>\` 派活给它们
- \`tb context\` 现取连到本终端的共享上下文。**下面那份是会话开始时的快照，用户随时会改** ——
  开始一件新任务前、或用户提到"看看上下文/需求变了"时，先跑一次 \`tb context\` 拿最新的
- 需要测网页时用 \`tb browser open <url>\`，再 \`tb browser text\` / \`tb browser js <代码>\` 检查——直接开在画布上，用户能实时看到`

/**
 * 按当前连线**现算**该终端的共享上下文。`tb context` 走这条 ——
 * spawn 时注入的那份是快照，用户改完节点内容或改了连线，跑着的会话是看不到的。
 */
async function currentContextText(termId: string): Promise<string> {
  const ctxIds = [...boardCtxLinks]
    .filter((l) => l.endsWith(`>${termId}`))
    .map((l) => l.slice(0, l.indexOf('>')))
  if (!ctxIds.length) return '（这个终端没有连任何上下文节点）'
  const parts: string[] = []
  for (const cid of ctxIds) {
    const t = await readFile(ctxFile(cid), 'utf8').catch(() => '')
    if (t.trim()) parts.push(t.trim())
  }
  return parts.length ? parts.join('\n\n---\n\n') : '（连了上下文节点，但内容是空的）'
}

/** 把连到该终端的所有简报节点合并成一个文件，返回路径（无连线则返回空串） */
async function buildMergedContext(termId: string, ctxIds: string[]): Promise<string> {
  const parts: string[] = [TOOL_ROUTING_HINT]
  for (const cid of ctxIds) {
    try {
      const t = (await readFile(ctxFile(cid), 'utf8')).trim()
      if (t) parts.push(t)
    } catch {
      // 该简报还没存过内容
    }
  }
  await mkdir(ctxDir(), { recursive: true })
  const out = path.join(ctxDir(), `merged-${termId.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`)
  await writeFile(out, parts.join('\n\n---\n\n'))
  return out
}

// ── 工作区持久化：原子写 + last-good 备份 + 损坏隔离 ──
// 裸 writeFile 写一半被杀 = JSON 截断 → load 的 catch 把它当"首次启动" → 整个画布布局静默归零。
// 所以三件事缺一不可：写到 tmp 再 rename（原子）、覆写前留 .bak（有退路）、读不出来就隔离（不静默丢）。
const workspacePath = (): string => path.join(app.getPath('userData'), 'workspace.json')
const workspaceBak = (): string => `${workspacePath()}.bak`

/** 最低限度形状校验：JSON 合法但内容不是工作区（如截断成 `{}`）同样不可信 */
function parseWorkspace(raw: string): Record<string, unknown> | null {
  const v: unknown = JSON.parse(raw)
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  // v2 有 projects，v1 有 nodes；两者皆无 = 不是有效工作区
  if (!Array.isArray(o.projects) && !Array.isArray(o.nodes)) return null
  return o
}

ipcMain.handle('workspace:load', async () => {
  for (const p of [workspacePath(), workspaceBak()]) {
    let raw: string
    try {
      raw = await readFile(p, 'utf8')
    } catch {
      continue // 文件不存在：首次启动，或还没生成过备份
    }
    try {
      const ws = parseWorkspace(raw)
      if (ws) return ws
      throw new Error('形状校验未通过')
    } catch (err) {
      // 文件在、但读不出来 = 损坏。隔离而非丢弃，用户还有手工救回的机会
      const quarantine = `${p}.corrupt-${Date.now()}`
      await rename(p, quarantine).catch(() => {})
      console.error(`workspace 损坏，已隔离到 ${quarantine}:`, err)
    }
  }
  return null
})

/* 定期存档：.bak 只防"文件写坏"，防不了"内容被合法地写坏"——
   误删一堆节点后，接下来几次防抖保存就把 .bak 也覆盖成删除后的状态了（真实发生过）。
   所以每小时另留一份带时间戳的存档，保留最近 24 份，纯兜底不参与正常加载。 */
const ARCHIVE_EVERY_MS = 60 * 60 * 1000
const ARCHIVE_KEEP = 24
let lastArchiveAt = 0

async function archiveWorkspace(json: string): Promise<void> {
  const dir = path.join(app.getPath('userData'), 'workspace-archive')
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  await writeFile(path.join(dir, `workspace-${stamp}.json`), json)
  const files = (await readdir(dir)).filter((f) => f.startsWith('workspace-')).toSorted()
  for (const old of files.slice(0, Math.max(0, files.length - ARCHIVE_KEEP))) {
    await unlink(path.join(dir, old)).catch(() => undefined)
  }
}

/** 导入已经把文件换掉、正在退出 —— renderer 那边的防抖保存不能再回写旧画布 */
let workspaceFrozen = false

ipcMain.handle('workspace:save', async (_e, data: unknown) => {
  if (workspaceFrozen) return { ok: false, error: '正在导入，已冻结' }
  const f = workspacePath()
  try {
    const json = JSON.stringify(data, null, 2)
    await writeFile(`${f}.tmp`, json)
    // 先把上一版转成备份再换新：这中间被杀，load 会从 .bak 恢复
    if (existsSync(f)) await rename(f, workspaceBak())
    await rename(`${f}.tmp`, f)
    if (Date.now() - lastArchiveAt > ARCHIVE_EVERY_MS) {
      lastArchiveAt = Date.now()
      await archiveWorkspace(json).catch(() => undefined) // 存档失败不影响主保存
    }
    return { ok: true }
  } catch (err) {
    console.error('workspace save failed:', err)
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
})

// ── 导出 / 导入 / 崩溃日志 ──
// 工作区是用户攒了几周的画布。`.bak` 和每小时存档都只在本机 userData 里，
// 换机、重装、误操作时够不着 —— 所以要有一个能拿走的文件。

const fileStamp = (): string => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

ipcMain.handle('workspace:export', async (e, data: unknown) => {
  if (!fromMainWin(e) || !mainWin) return { ok: false, error: 'denied' }
  const r = await dialog.showSaveDialog(mainWin, {
    title: '导出工作区',
    defaultPath: path.join(app.getPath('downloads'), `termspace-${fileStamp()}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (r.canceled || !r.filePath) return { ok: false, canceled: true }
  try {
    // 存的是 renderer 手上的实时状态，不是磁盘上那份（那份可能还差一个防抖周期）
    await writeFile(r.filePath, JSON.stringify(data, null, 2))
    return { ok: true, path: r.filePath }
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
})

/**
 * 导出任务布局模板。**和导出工作区是两件事**：
 * 模板要能发给别人，所以不含凭证、cwd 相对化、命令改名成"建议命令"。
 */
/* 代理连接的管理。**连接串只进不出** —— 没有任何 IPC 能把它读回渲染层，
   那正是这层设计的意义（见 broker-store.ts）。 */
const brokerMutations = createBrokerMutations({
  getSettings,
  setSettings,
  setBrokerTarget,
  deleteBrokerTarget,
  randomId: randomUUID
})

ipcMain.handle('broker:save', async (e, input: unknown) => {
  if (!fromMainWin(e)) return { ok: false, error: 'denied' }
  const b = input as {
    id?: string
    name?: string
    kind?: 'ssh' | 'postgres'
    readOnly?: boolean
    target?: string
  }
  if (!b?.name || (b.kind !== 'ssh' && b.kind !== 'postgres')) {
    return { ok: false, error: '参数不合法' }
  }
  return brokerMutations.save({
    id: b.id,
    name: b.name,
    kind: b.kind,
    readOnly: b.readOnly,
    target: b.target
  })
})

ipcMain.handle('broker:delete', async (e, id: unknown) => {
  if (!fromMainWin(e) || typeof id !== 'string') return { ok: false }
  return brokerMutations.delete(id)
})

ipcMain.handle('layout:export', async (e, payload: unknown) => {
  if (!fromMainWin(e) || !mainWin) return { ok: false, error: 'denied' }
  const p = payload as {
    name?: string
    description?: string
    root?: string
    nodes?: Parameters<typeof toTemplate>[1]
    edges?: Parameters<typeof toTemplate>[2]
  } | null
  if (!p?.root || !Array.isArray(p.nodes)) return { ok: false, error: '参数不合法' }
  const tpl = toTemplate(p.name ?? '布局', p.nodes, p.edges ?? [], p.root, p.description)
  const r = await dialog.showSaveDialog(mainWin, {
    title: '导出任务布局',
    defaultPath: path.join(app.getPath('downloads'), `${tpl.name}-layout.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (r.canceled || !r.filePath) return { ok: false, canceled: true }
  try {
    await writeFile(r.filePath, JSON.stringify(tpl, null, 2))
    return { ok: true, path: r.filePath }
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
})

/**
 * 导入布局模板：**只铺节点，一条命令都不跑**。
 *
 * 先让用户选一个根目录（模板里的 cwd 是相对它的），再确认。
 * 确认框里必须说清楚"带建议命令的节点有几个、它们不会自动执行" ——
 * 这正是外部 workspace 导入那个 P0 的教训。
 */
ipcMain.handle('layout:import', async (e) => {
  if (!fromMainWin(e) || !mainWin) return { ok: false, error: 'denied' }
  const pick = await dialog.showOpenDialog(mainWin, {
    title: '导入任务布局',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (pick.canceled || !pick.filePaths[0]) return { ok: false, canceled: true }
  let raw: LayoutTemplate
  try {
    raw = JSON.parse(await readFile(pick.filePaths[0], 'utf8')) as LayoutTemplate
  } catch (err) {
    return { ok: false, error: `读不出来：${String((err as Error)?.message ?? err)}` }
  }
  const rootPick = await dialog.showOpenDialog(mainWin, {
    title: '这个布局铺在哪个目录下？',
    properties: ['openDirectory', 'createDirectory']
  })
  if (rootPick.canceled || !rootPick.filePaths[0]) return { ok: false, canceled: true }
  const root = rootPick.filePaths[0]

  const parsed = fromTemplate(raw, root)
  if (!parsed.ok) return parsed
  const { response } = await dialog.showMessageBox(mainWin, {
    type: 'question',
    buttons: ['取消', '铺到画布'],
    defaultId: 0,
    cancelId: 0,
    message: `导入布局「${parsed.name}」`,
    detail:
      `会在当前画布上新增 ${parsed.nodes?.length ?? 0} 个节点，根目录 ${root}。\n\n` +
      (parsed.withCommands
        ? `其中 ${parsed.withCommands} 个带着建议命令 —— **不会自动执行**，` +
          '节点铺出来后你自己决定跑不跑。'
        : '模板里没有建议命令。')
  })
  if (response !== 1) return { ok: false, canceled: true }
  return parsed
})

ipcMain.handle('workspace:import', async (e) => {
  if (!fromMainWin(e) || !mainWin) return { ok: false, error: 'denied' }
  const pick = await dialog.showOpenDialog(mainWin, {
    title: '导入工作区',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  const src = pick.filePaths[0]
  if (pick.canceled || !src) return { ok: false, canceled: true }

  let json: string
  let ws: Record<string, unknown> | null
  try {
    json = await readFile(src, 'utf8')
    ws = parseWorkspace(json)
  } catch (err) {
    return { ok: false, error: `读不出来：${String((err as Error)?.message ?? err)}` }
  }
  if (!ws) return { ok: false, error: '这不是 Termspace 的工作区文件（缺 projects/nodes）' }

  /* **外部文件一律先净化**（见 workspace-import.ts）：SavedNode 的 `command` 会在
     终端第一次起会话时直接进登录 shell —— 不摘掉，"打开别人发来的画布"就等于
     执行文件里写的任意命令，而下面这个确认框一个字都没提执行。 */
  const clean = sanitizeImportedWorkspace(ws)
  ws = clean.ws

  /* 导入是**整块替换**，且下次启动的 reap 会把不在新画布里的 tmux 会话当孤儿杀掉 ——
     这是不可逆的，必须说清楚再动手。 */
  const stripped = [
    clean.commands ? `${clean.commands} 个节点的启动命令` : '',
    clean.identities ? `${clean.identities} 个节点的凭证绑定` : '',
    clean.dropped ? `${clean.dropped} 个类型不认识的节点` : '',
    // 连线就是授权，摘掉了多少条必须说出来（悬空边曾能白拿 tb db 的永久授权）
    clean.edges ? `${clean.edges} 条端点不存在的连线（连线=授权）` : ''
  ].filter(Boolean)
  const { response } = await dialog.showMessageBox(mainWin, {
    type: 'warning',
    buttons: ['取消', '导入并重启'],
    defaultId: 0,
    cancelId: 0,
    message: '导入会整块替换当前画布',
    detail:
      '当前工作区会先存进 workspace-archive/ 备份目录，可手工救回。\n\n' +
      '导入后 app 会重启。当前跑着的终端里，凡是不在新画布中的，' +
      '其 tmux 会话会在重启时被当成孤儿结束。' +
      (stripped.length
        ? `\n\n已从这份文件里摘掉：${stripped.join('、')}。` +
          '外部文件里的命令不会被自动执行 —— 节点铺出来，要跑什么你自己敲。'
        : '')
  })
  if (response !== 1) return { ok: false, canceled: true }

  try {
    const cur = await readFile(workspacePath(), 'utf8').catch(() => '')
    if (cur) await archiveWorkspace(cur)
    workspaceFrozen = true // 先冻结：renderer 的防抖保存随时可能把旧画布写回来
    const f = workspacePath()
    await writeFile(`${f}.tmp`, JSON.stringify(ws, null, 2))
    await rename(`${f}.tmp`, f)
  } catch (err) {
    workspaceFrozen = false
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
  app.relaunch()
  app.exit(0)
  return { ok: true }
})

ipcMain.handle('app:info', (e) => {
  if (!fromMainWin(e)) return null
  let crashBytes = 0
  try {
    crashBytes = statSync(crashLogPath()).size
  } catch {
    // 没崩过，正常
  }
  return {
    version: app.getVersion(),
    electron: process.versions.electron,
    userData: app.getPath('userData'),
    crashBytes,
    crashCount
  }
})

ipcMain.handle('app:revealUserData', (e) => {
  if (!fromMainWin(e)) return
  // 崩溃日志有就直接定位到它，没有就打开目录 —— 用户要找的多半是那个文件
  if (existsSync(crashLogPath())) shell.showItemInFolder(crashLogPath())
  else void shell.openPath(app.getPath('userData'))
})

app.whenReady().then(async () => {
  // 设计系统 dark-first：vibrancy 跟随系统会在浅色模式下透白，先锁深色
  nativeTheme.themeSource = 'dark'

  /* 回收遗留的密钥文件。正常路径是"shell source 完当场 rm"，但 spawn 失败、
     app 被杀、以及历史版本在 attach 时也建文件的那条路，都会留下凭证明文。
     只删够老的（>5 分钟）——刚建出来还没被 source 的那份不能碰。 */
  void (async () => {
    const dir = app.getPath('userData')
    const now = Date.now()
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (!/^env-.*\.sh$/.test(f)) continue
      const p = path.join(dir, f)
      const st = await stat(p).catch(() => null)
      if (st && now - st.mtimeMs > 5 * 60_000) await unlink(p).catch(() => undefined)
    }
  })()

  /* 渲染进程/GPU 进程崩了主进程收不到 uncaughtException —— 单独接。
     白屏比闪退更迷惑人，日志里必须留下痕迹。 */
  app.on('render-process-gone', (_e, wc, d) =>
    logCrash('render-process-gone', `${isMainWc(wc) ? '主窗口' : 'webview'} reason=${d.reason} exit=${d.exitCode}`)
  )
  app.on('child-process-gone', (_e, d) =>
    logCrash('child-process-gone', `type=${d.type} reason=${d.reason} name=${d.name ?? '-'}`)
  )

  /* 权限收口：画布浏览器（webview guest）只用来看页面/做测试，摄像头麦克风定位通知一律不给。
     但主窗口自己要读剪贴板 —— 终端粘贴走的就是 navigator.clipboard.readText()，别误伤。 */
  const isMainWc = (wc: Electron.WebContents | null): boolean =>
    !!wc && !!mainWin && !mainWin.isDestroyed() && wc === mainWin.webContents
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) =>
    cb(isMainWc(wc) && permission.startsWith('clipboard'))
  )
  session.defaultSession.setPermissionCheckHandler((wc, permission) =>
    isMainWc(wc) && permission.startsWith('clipboard')
  )

  /* 写用户全局的 ~/.claude/settings.json 有侵入性，必须先问过 —— 但不能在这里问：
     对话框会把启动整个卡住（窗口都还没建）。先按已有选择起服务，窗口起来之后再问。 */
  const st = await getSettings()
  const installHooks = st.claudeHooks === 'on'
  remoteAllowInput = st.remoteAllowInput
  remoteAllowApprove = st.remoteAllowApprove
  notifyUrl = st.notifyUrl
  notifyLevel = st.notifyLevel

  // hook 系统先于窗口（pty spawn 需要 endpoint 路径）；失败不阻塞启动
  contextTail = createContextTail((u) => sendToWin('agent:context', u))
  try {
    hookSystem = await startHookSystem(
      (e) => {
        sendToWin('agent:status', e)
        remoteApi?.push('status', e)
        // 「我不在电脑面前」：agent 卡住等你时推一条到手机。默认没配地址 = 不发
        notifier.onState(e.nodeId, e.state, titleOfNode(e.nodeId))
        // 派活等待判完成 + 会话存活判定（sessionId 用来挡已结束会话的迟到事件）
        noteStatus(e.nodeId, e.state, e.event, e.sessionId)
      },
      (nodeId, tp) => {
        contextTail?.track(nodeId, tp)
        noteTranscript(nodeId, tp) // 派活取结果用
      },
      {
        // F8 工具中枢：agent 在终端里跑 tb 命令走这三个处理器
        skills: async (q) => {
          const dirs = (await getSettings()).skillDirs
          const hits = await searchSkills(q, dirs)
          if (!hits.length) return `没有匹配「${q}」的 skill。tb skills 不带参数可列出全部。`
          return hits.map((s) => `${s.name}\n    ${s.description}`).join('\n')
        },
        load: async (name) => {
          const dirs = (await getSettings()).skillDirs
          const text = await loadSkill(name, dirs)
          return text ?? `未找到 skill「${name}」，先用 tb skills <关键词> 查名字。`
        },
        context: (source) => currentContextText(source),
        agents: async (source, peerAlias) => {
          // `tb agents <机器>` → 问对端要它的清单
          if (peerAlias) return agentsPeer(source, peerAlias)
          const others = boardAgents.filter((a) => a.id !== source)
          if (!others.length) return '画布上暂无其他 agent 终端。'
          return others
            .map((a) => {
              const linked = boardLinks.has(`${source}>${a.id}`) ? '已连线' : '未连线'
              const live = isAgentSession(a.id) ? 'agent' : 'shell'
              return `${a.id}\t${a.title}\t${a.provider ?? 'shell'}\t${a.status}\t${live}\t${linked}`
            })
            .join('\n')
        },
        ask: async (source, target, task) => {
          // `mini:t-abc` = 派到另一台机器。不含冒号则是本机，走下面原路。
          const peer = parsePeerTarget(target)
          if (peer) {
            /* **跨机也要过授权闸**。原来这里直接 askPeer，于是本机派活要连线或弹窗、
               后果更重的跨机（驱动另一台机器上有 Bash 权限的 agent，再把结果回灌进
               本机 agent 的上下文）反而零摩擦。典型触发不是"agent 越权"，是**提示词注入**：
               agent 读到一段带指令的网页或 issue，就能替用户把任务推到另一台机器上跑。

               `peers` 白名单是机器级的一次性许可（"我允许往这台派"），
               不等于"每个节点随时都能派"。这里补的是按目标、按次的那一层。
               CLAUDE.md 为「跨机不弹窗」给的理由是"远端没人看窗"—— 那只覆盖**接收侧**，
               发起侧用户就在本机，本机那套弹窗在这里完全适用。 */
            const ok = await authorizeLink(
              source,
              `${peer.alias}:${peer.nodeId}`,
              '把任务派到另一台机器',
              `任务会通过 ssh 送到 ${peer.alias}，作为输入敲进那台机器上的 ${peer.nodeId}：\n${sanitizeTask(task).slice(0, 300)}`
            )
            if (!ok) {
              return `派活被拒：${source} → ${peer.alias}:${peer.nodeId} 未获授权（跨机派活每对目标需要确认一次）。`
            }
            return askPeer(source, peer, task)
          }
          return withLedger({ source, target, task, branch: branchOfNode(target) }, () =>
            delegate(
            {
              hasNode: (nid) => ptys.has(nid),
              writeToPty: (nid, data) => ptys.get(nid)?.write(data),
              // 注入前查前台进程：agent 退出但 SessionEnd 丢了时，这是最后一道闸
              foreground: (nid) => paneCommand(nid),
              authorize: (s, t, task2) =>
                authorizeLink(
                  s,
                  t,
                  '把任务派给',
                  `任务内容会被当作输入敲进 ${t} 的终端：\n${task2.slice(0, 300)}`
                )
            },
            source,
            target,
            task
            )
          )
        },
        /* 别的机器 ssh 过来派的活。**授权判据和本机那条完全不同**：
           本机比对画布连线，跨机比对设置里的开关 —— peer 不是画布上的节点，
           拿它去比连线永远不成立，只会弹一个远端没人看的窗。
           `source` 是对方自报的，只写进弹不出去的日志和返回文案，不参与判定。 */
        /* 对端问「你这儿有哪些 agent 终端」。**同样受跨机开关门控** ——
           节点标题里有项目名和你在做什么，不想让对面派活的人多半也不想让他看见这些。 */
        peerAgents: async (source) => {
          if (!(await getSettings()).peerDelegate) {
            return '被拒：这台机器没开「接受跨机派活」（设置 → 跨机协作）。'
          }
          const rows = boardAgents.map((a) => {
            const live = isAgentSession(a.id) ? 'agent' : 'shell'
            return `${a.id}\t${a.title}\t${a.provider ?? 'shell'}\t${a.status}\t${live}`
          })
          return rows.length
            ? `[来自 ${source || '对端'} 的查询]\n${rows.join('\n')}`
            : '这台机器的画布上没有终端节点。'
        },
        /**
         * 代理连接：agent 给名字和正文，**连接串在这里取、用完就走**，
         * 一个字节都不回给终端。这是整个产品里唯一真正做到
         * "用得到、拿不到"的地方（见 broker.ts 的文件头）。
         */
        broker: async (source, kind, name, payload) => {
          return handleBroker(
            {
              getSettings,
              getBrokerTarget,
              authorize: authorizeLink,
              run: brokerRun,
              withLedger,
              branchOfNode
            },
            source,
            kind,
            name,
            payload
          )
        },
        peerAsk: async (source, target, task) => {
          if (!(await getSettings()).peerDelegate) {
            return '派活被拒：这台机器没开「接受跨机派活」（设置 → 跨机协作）。'
          }
          return withLedger({ source: `peer:${source || '?'}`, target, task }, () =>
            delegate(
            {
              hasNode: (nid) => ptys.has(nid),
              writeToPty: (nid, data) => ptys.get(nid)?.write(data),
              foreground: (nid) => paneCommand(nid),
              /* 开关就是这条链路的授权，不再逐次弹窗 —— 远端多半没人在电脑前，
                 弹窗只会挂到超时。 */
              authorize: async () => (await getSettings()).peerDelegate,
              /* 还要再查一遍：authorize 之后还有前台探测和 stat 两个 await，
                 用户完全可能在这中间把开关关掉。finalGate 是注入前最后一步。 */
              finalGate: async () => (await getSettings()).peerDelegate
            },
            `peer:${source || '?'}`,
            target,
            task,
            PEER_TIMEOUTS.remoteDelegateMs
            )
          )
        },
        browser: async (source, action, arg, nodeId) => {
          // list 之外的动作都碰得到已登录页面的内容（text/shot 同样能读走邮箱、后台、token），
          // 所以一律要授权；open 是新建一个空白节点，创建者当场获授权。
          if (action !== 'list') {
            // 省略 --node 时必须先解析出**真实**的默认节点 id 再授权，
            // 否则拿一个虚构 key 去比对连线，永远匹配不上（授权形同虚设）
            let target = nodeId
            if (!target && action !== 'open') {
              const ids = (await browserCommand('list', '', ''))
                .split('\n')
                .map((s) => s.trim())
                .filter((s) => /^[A-Za-z0-9_-]+$/.test(s))
              if (!ids.length) return '画布上没有浏览器节点，先 tb browser open <url>'
              target = ids[0]
            }
            if (action !== 'open') {
              const ok = await authorizeLink(
                source,
                target,
                '驱动浏览器节点',
                `动作：${action} ${arg.slice(0, 200)}\n目标：${target}\n该页面可能持有你的登录态。`
              )
              if (!ok) {
                return `已拒绝：${source} 未获授权驱动 ${target}。在画布上从该终端拉一条线到该浏览器节点即可长期授权。`
              }
            }
            nodeId = target
          }
          const r = await browserCommand(action, arg, nodeId, source)
          // open 出来的节点归创建者：renderer 侧已自动连线，这里再补一条 grant 兜底
          // （连线是渲染态，落盘前主进程还没收到 links 上报）
          if (action === 'open' && source && /^[A-Za-z0-9_-]+$/.test(r.trim().split('\n')[0])) {
            grants.add(`${source}>${r.trim().split('\n')[0]}`)
          }
          // 截图：把 data URL 落盘成 png，返回路径给 agent 读图
          if (action === 'shot' && r.startsWith('data:image')) {
            try {
              const b64 = r.split(',')[1] ?? ''
              const dir = path.join(app.getPath('userData'), 'shots')
              await mkdir(dir, { recursive: true })
              const f = path.join(dir, `shot-${Date.now().toString(36)}.png`)
              await writeFile(f, Buffer.from(b64, 'base64'))
              return `截图已存：${f}\n（用你的读图能力打开此文件查看页面）`
            } catch (err) {
              return `截图保存失败：${String(err)}`
            }
          }
          return r
        }
      },
      (list) => {
        const enriched = withVerdict(list)
        sendToWin('approvals:update', enriched)
        remoteApi?.push('approvals', enriched)
        /* 和上面的 blocked 是同一件事的两条上报路径（PermissionRequest hook /
           托管 PreToolUse 拦截），notifier 里共用 'attention' 节流键去重。 */
        for (const a of list) notifier.onApprovalPending(a.nodeId, titleOfNode(a.nodeId))
      },
      installHooks
    )
  } catch (err) {
    console.error('hook system failed to start:', err)
  }

  // 任务账本（派活留痕）。JSONL 追加写，见 task-ledger.ts
  ledger = createLedger(path.join(app.getPath('userData'), 'tasks.jsonl'))
  pushTasks()

  // F7 worker 卡片：轮询 cdx list（franke_skills 引擎）
  workerWatch = startWorkerWatch((rows) => sendToWin('workers:update', rows))

  /* 远程 API（阶段 0）：默认关闭。只绑 127.0.0.1，远程访问请走 Tailscale 这类
     设备级 VPN —— 这个进程能 spawn pty、持有凭证，绝不能自己往公网监听。 */
  if (st.remoteEnabled) await startRemote(st.remoteBind, st.remotePort)

  /* 额度 HUD：**按账号**采集（见 docs/QUOTA.md）。
     以前是读一个本机快照文件、只有 Claude、还分不清账号 ——
     两个 codex 订阅会被混成一个数。 */
  quotaHub = startQuotaHub(os.homedir(), (list) => sendToWin('quota:update', list))
  const syncQuotaAccounts = async (): Promise<void> => {
    const ids = await listIdentities()
    const claudeSystem = await probeClaudeAccount(os.homedir())
    const presenceOf = (s: Awaited<ReturnType<typeof probeClaudeAccount>>) => ({
      state: s.state === 'in' ? 'verified' as const : s.state === 'out' ? 'not_logged_in' as const : 'unknown' as const,
      detail: s.detail,
      discovered: true
    })
    const accounts: QuotaAccount[] = [
      // 系统默认 = 没绑凭证的节点用的那个登录态，它也是一个账号
      {
        accountId: 'system:claude',
        provider: 'claude',
        name: '系统默认',
        env: {},
        kind: billingKind(process.env, 'claude') === 'api-key' ? 'api-key' : 'subscription',
        presence: presenceOf(claudeSystem),
        email: claudeSystem.email,
        plan: claudeSystem.plan
      },
      {
        accountId: 'system:codex',
        provider: 'codex',
        name: '系统默认',
        env: {},
        kind: billingKind(process.env, 'codex') === 'api-key' ? 'api-key' : 'subscription'
      },
      // Copilot 只有一个账号（跟着 gh 的登录态走），没有多号概念
      { accountId: 'system:copilot', provider: 'copilot', name: 'GitHub', env: {} }
    ]
    for (const i of ids) {
      if (i.provider !== 'codex' && i.provider !== 'claude') continue
      const resolved = await resolveIdentityEnv(i.id)
      const env = resolved?.set ?? {}
      /* 计费方式判据**和登录态那边共用 billingKind**，两处各写一套就会互相矛盾
         （一个说"查不到订阅额度"、另一个说"已登录"）。看的是**最终生效的**环境：
         用户 shell 里 export 的 API key 会被 app 继承，那也真的会生效。

         另外，没有 CODEX_HOME / CLAUDE_CONFIG_DIR 的凭证不能当订阅号建采集器 ——
         采集器会回退到默认目录 / 默认钥匙串，**把系统默认订阅号的额度标在它名下**，
         用户看到的百分比属于另一个账号。 */
      const probeEnv = applyIdentityEnv(process.env, resolved)
      const isolated = i.provider === 'codex' ? env['CODEX_HOME'] : env['CLAUDE_CONFIG_DIR']
      const kind =
        billingKind(probeEnv, i.provider) === 'api-key' || !isolated ? 'api-key' : 'subscription'
      const claude =
        i.provider === 'claude' && kind === 'subscription'
          ? await probeClaudeAccount(os.homedir(), { ...probeEnv, CLAUDE_CONFIG_DIR: isolated })
          : null
      accounts.push({
        accountId: i.id,
        provider: i.provider,
        name: i.name,
        env,
        kind,
        presence: claude ? { ...presenceOf(claude), discovered: false } : undefined,
        email: claude?.email,
        plan: claude?.plan
      })
    }
    for (const d of await discoverLowConfidenceAccounts(os.homedir(), detectedPaneProviders)) {
      accounts.push({ ...d, env: {} })
    }
    quotaHub?.setAccounts(accounts)
  }
  void syncQuotaAccounts()
  // identity 的三个 handler 在模块级注册（早于 whenReady），拿不到这个闭包 → 用引用挂过去
  syncQuotaAccountsRef = syncQuotaAccounts
  // 派活开始/结束 → 画布上那条线点亮/熄灭流光
  setDelegateFlightListener((e) => sendToWin('delegate:flight', e))
  /* 自动更新。**只在打包版里真的跑**（dev 没有 app-update.yml，见 updater.ts）。
     开关默认开，但"检查"和"装"是两件事：下载完只提示，装不装用户说了算 ——
     终端里跑着人家的活，自动重启会把那一轮掐掉。 */
  const st0 = await getSettings()
  autoUpdateEnabled = st0.autoUpdate
  updateFeedUrl = st0.updateFeedUrl
  updater = startUpdater(() => mainWin, {
    enabled: () => autoUpdateEnabled,
    feedUrl: () => updateFeedUrl
  })

  app.on('before-quit', () => {
    quotaHub?.dispose()
    updater?.dispose()
  })

  const win = createWindow()
  mainWin = win
  // 渲染层 React mount 后主动握手 → 重推全部状态
  // （did-finish-load 早于 React 订阅注册，直接推会竞态丢失）
  ipcMain.on('renderer:ready', () => {
    // reload 后先把已有快照推回去（HUD 别空一拍），再让 hub 按自己的节奏刷
    const snap = quotaHub?.snapshot() ?? []
    if (snap.length) sendToWin('quota:update', snap)
    quotaHub?.refresh()
    workerWatch?.refresh()
    // 首启征求 hook 写入同意：放在窗口起来之后问，别卡启动；自检截图模式下跳过。
    // renderer:ready 每次 reload/HMR 都会来，askedConsent 保证一轮只问一次。
    if (st.claudeHooks === 'ask' && !askedConsent && !process.env['TERMBOARD_SHOT']) {
      askedConsent = true
      void dialog
        .showMessageBox(win, {
          type: 'question',
          buttons: ['暂不', '允许写入'],
          defaultId: 1,
          cancelId: 0,
          message: 'Termspace 需要写入 ~/.claude/settings.json',
          detail:
            '用于接收 Claude Code 的运行状态（节点发光、谁在等你审批、上下文占用），' +
            '以及把工具调用审批接到画布上。\n\n' +
            '已有 hook 条目会保留，原文件首次备份为 settings.json.termboard-backup，' +
            '随时可在「设置 → Hooks 与状态」里卸载。\n\n' +
            '选「暂不」也能正常使用，只是节点状态不反映 agent 真实情况。'
        })
        .then(async ({ response }) => {
          const yes = response === 1
          await setSettings({ claudeHooks: yes ? 'on' : 'off' })
          // 说「暂不」时要把早前版本装进去的条目也摘掉，否则嘴上拒绝、文件里还留着
          if (yes) await hookSystem?.enableHooks()
          else await uninstallClaudeHooks()
        })
    }
    // 审批只有增量推送，reload/HMR 后既有的挂起审批就再也不显示了 → 重放一次快照
    // 必须过 withVerdict：漏了这一层，reload 后重放出来的危险请求会退化成
    // 一枚普通蓝色「批准」（verdict 为空 → 不显示风险横幅、也没有两段式确认）
    const pend = withVerdict(hookSystem?.listApprovals() ?? [])
    if (pend.length) sendToWin('approvals:update', pend)
  })

  /* 自检模式：TERMBOARD_SHOT=/path/x.png 启动 → 默认 6 秒后截图退出。
     `TERMBOARD_SHOT_DELAY=<毫秒>` 可以调长 —— 有些链路 6 秒根本跑不完
     （账号发现要等进程树扫描先报上来，再触发重扫、采集、推送四步），
     窗口太短会拍到一个"功能没生效"的假象，而那正是我们要验的东西。 */
  const shotPath = process.env['TERMBOARD_SHOT']
  if (shotPath) {
    const shotDelay = Math.min(120_000, Math.max(1000, Number(process.env['TERMBOARD_SHOT_DELAY']) || 6000))
    setTimeout(async () => {
      try {
        /* TERMBOARD_WEBGL_STRESS=N：开 N 个终端，把 WebGL context 打爆，测降级。
           每个终端一个 context，Chromium 每页 ~16 个上限，**超限时最老的被强制丢弃**；
           "一屏几十个终端"正是这个产品的卖点，这条降级路径必须验过而不是想当然。

           判据是**终端还有没有在渲染字**，不是"截图看着还行"：
           WebGL renderer 画在 canvas 上、`.xterm-rows` 是空的；掉回 DOM renderer 后
           反过来 —— rows 里有字才说明 onContextLoss → dispose 那条路真的接住了。 */
        const n = Number(process.env['TERMBOARD_WEBGL_STRESS'] ?? 0)
        if (n > 0) {
          // 先冻结落盘：不然这 N 个临时终端会被防抖保存写进用户真实的画布
          workspaceFrozen = true
          const probe = `(() => [...document.querySelectorAll('.xterm')].map((el) => ({
            webgl: el.querySelectorAll('canvas').length >= 2,
            dom: el.querySelectorAll('.xterm-rows > div').length > 0
          })))()`
          const sum = (r: { webgl: boolean; dom: boolean }[]): string =>
            `${r.length} 个终端 · WebGL ${r.filter((x) => x.webgl).length} · DOM 渲染出字 ${r.filter((x) => x.dom).length}`
          // 点工具栏的「新建终端」，走和用户完全一样的那条路
          await win.webContents.executeJavaScript(
            `(async () => {
              const b = document.querySelector('.toolbar-btn.split-main')
              for (let i = 0; i < ${n}; i++) { b.click(); await new Promise(r => setTimeout(r, 120)) }
            })()`
          )
          await new Promise((r) => setTimeout(r, 3000))
          console.log(`[webgl-stress] 打爆前：${sum(await win.webContents.executeJavaScript(probe))}`)
          // 先挂监听再打爆：canvas 元素在 context 丢失后照样留在 DOM 里，
          // 数元素个数根本看不出死活，只有这个事件是硬证据
          await win.webContents.executeJavaScript(`(() => {
            window.__lost = 0
            document.querySelectorAll('.xterm canvas').forEach((c) =>
              c.addEventListener('webglcontextlost', () => window.__lost++))
          })()`)
          await win.webContents.executeJavaScript(`(() => {
            const keep = []
            for (let i = 0; i < 32; i++) {
              const c = document.createElement('canvas')
              c.width = c.height = 64
              const gl = c.getContext('webgl2') || c.getContext('webgl')
              if (gl) keep.push(gl)
            }
            window.__stressHold = keep   // 别让 GC 把它们收走，否则 context 又还回来了
            return keep.length
          })()`)
          await new Promise((r) => setTimeout(r, 6000)) // 见下：addon 要等满 3s 才 fire onContextLoss
          const lost = await win.webContents.executeJavaScript('window.__lost')
          console.log(`[webgl-stress] 打爆后：${sum(await win.webContents.executeJavaScript(probe))}`)
          console.log(`[webgl-stress] contextlost 触发 ${lost} 次`)
        }

        /* TERMBOARD_LOD_BENCH=N：LOD 到底有没有在白烧 CPU。
           「缩到全景看颜色分布」是这个产品的招牌交互，而 LOD 只设了 visibility:hidden ——
           终端全都还活着、还在渲染。这里让 N 个终端持续输出，分别量缩放 1.0 和 LOD 下
           渲染进程的 CPU，用数字回答该不该改成真正停渲染。 */
        /* TERMBOARD_CTX_TEST=1：验证 tb context 是不是真的现读现返。
           判据：**不重开会话**的前提下改上下文节点内容，第二次 tb context 要能读到新内容。
           这正是原来 --append-system-prompt 那条路做不到的事。 */
        if (process.env['TERMBOARD_CTX_TEST']) {
          /* 用一个自造的临时上下文节点，测完删干净 —— 不碰用户真实数据。
             判据：**不重开会话**的前提下改内容，第二次读要能读到新内容。
             这正是原来 --append-system-prompt 那条路做不到的事（它只在 spawn 时灌一次）。 */
          const cid = 'ctxtest-tmp'
          const tid = 'ctxtest-term'
          await mkdir(ctxDir(), { recursive: true })
          boardCtxLinks.add(`${cid}>${tid}`)
          try {
            await writeFile(ctxFile(cid), '第一版：目标是 A')
            const v1 = await currentContextText(tid)
            await writeFile(ctxFile(cid), '第二版：目标改成 B 了')
            const v2 = await currentContextText(tid)
            const none = await currentContextText('没连线的终端')
            console.log(`[ctx-test] 第一次读：${JSON.stringify(v1)}`)
            console.log(`[ctx-test] 改完再读：${JSON.stringify(v2)}`)
            console.log(`[ctx-test] 实时生效：${v1 !== v2 && v2.includes('B')}`)
            console.log(`[ctx-test] 没连线时：${JSON.stringify(none)}`)
          } finally {
            boardCtxLinks.delete(`${cid}>${tid}`)
            await unlink(ctxFile(cid)).catch(() => undefined)
          }
        }

        /* TERMBOARD_FITPROBE=1：底行被裁到底裁了几像素、裁在谁身上。
           用户实测报「终端底部内容被切」，而两种机制会得出相反的修法：
           ① FitAddon 算多了 rows → canvas 比可用区高，被 body 的 overflow:hidden 裁掉
           ② FitAddon 算对了，是别的元素（xterm-screen / viewport）多出来
           **纯读 DOM 矩形，不改任何东西** —— 直接量 canvas 底边超出 body 内容区多少。 */
        if (process.env['TERMBOARD_FITPROBE']) {
          const rows = await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('.term-node-body')].map((body) => {
              const cs = getComputedStyle(body)
              const xt = body.querySelector('.xterm')
              const scr = body.querySelector('.xterm-screen')
              const cv = body.querySelector('canvas')
              const r = (el) => el ? (({top,bottom,left,right,height,width}) =>
                ({top:+top.toFixed(1),bottom:+bottom.toFixed(1),left:+left.toFixed(1),
                  right:+right.toFixed(1),h:+height.toFixed(1),w:+width.toFixed(1)}))(el.getBoundingClientRect()) : null
              const b = r(body)
              // body 的**内容盒**（padding 之内）—— canvas 该待的地方
              const pad = {t:parseFloat(cs.paddingTop),b:parseFloat(cs.paddingBottom),
                           l:parseFloat(cs.paddingLeft),r:parseFloat(cs.paddingRight)}
              return {
                bodyRect: b,
                bodyPad: pad,
                bodyComputedH: cs.height, bodyComputedW: cs.width,
                bodyClientH: body.clientHeight, bodyClientW: body.clientWidth,
                contentBottom: b ? +(b.bottom - pad.b).toFixed(1) : null,
                contentRight: b ? +(b.right - pad.r).toFixed(1) : null,
                xtermRect: r(xt), xtermPad: xt ? getComputedStyle(xt).padding : null,
                screenRect: r(scr), canvasRect: r(cv),
                rows: scr ? scr.querySelectorAll('div').length : null
              }
            })`
          )
          for (const [i, m] of (rows as Record<string, unknown>[]).entries()) {
            const mm = m as { contentBottom: number; contentRight: number; canvasRect?: { bottom: number; right: number } | null }
            const overV = mm.canvasRect ? +(mm.canvasRect.bottom - mm.contentBottom).toFixed(1) : null
            const overH = mm.canvasRect ? +(mm.canvasRect.right - mm.contentRight).toFixed(1) : null
            console.log(`[fit-probe #${i}] 竖向超出内容区 ${overV}px、横向 ${overH}px（正数=被裁）`)
            console.log(`[fit-probe #${i}] ${JSON.stringify(m)}`)
          }
        }

        const bench = Number(process.env['TERMBOARD_LOD_BENCH'] ?? 0)
        if (bench > 0) {
          workspaceFrozen = true
          const ids: string[] = await win.webContents.executeJavaScript(
            `(async () => {
              const b = document.querySelector('.toolbar-btn.split-main')
              const before = new Set([...document.querySelectorAll('.react-flow__node-terminal')].map(n => n.dataset.id))
              for (let i = 0; i < ${bench}; i++) { b.click(); await new Promise(r => setTimeout(r, 120)) }
              return [...document.querySelectorAll('.react-flow__node-terminal')]
                .map(n => n.dataset.id).filter(x => !before.has(x))
            })()`
          )
          await new Promise((r) => setTimeout(r, 2500))
          // 让每个终端持续吐字（走真实 pty，不是往 xterm 里灌假数据）
          for (const tid of ids) ptys.get(tid)?.write('while :; do seq 1 60; sleep 0.02; done\r')

          /** 采样窗口内渲染进程的平均 CPU。percentCPUUsage 是"距上次调用"的均值 */
          const rendererCpu = async (ms: number): Promise<number> => {
            app.getAppMetrics()
            await new Promise((r) => setTimeout(r, ms))
            /* GPU 进程要单独看：LOD 省的是**合成/绘制**，那笔账记在 GPU 上，
               只盯 renderer 会得出"LOD 毫无用处"的错误结论 */
            const all = app.getAppMetrics()
            const by = (t: string): number =>
              all.filter((m) => m.type === t).reduce((s, m) => s + m.cpu.percentCPUUsage, 0)
            console.log(`[lod-bench]   renderer ${by('Tab').toFixed(1)}% · GPU ${by('GPU').toFixed(1)}%`)
            return by('Tab')
          }
          await new Promise((r) => setTimeout(r, 3000))
          const hot = await rendererCpu(5000)
          // 缩到 LOD 以下
          await win.webContents.executeJavaScript(
            `(async () => {
              const z = document.querySelector('.react-flow__controls-zoomout')
              // 停在 LOD 与 far 之间（0.14 < zoom < 0.35），那才是"看全景"的真实状态
              for (let i = 0; i < 5; i++) { z.click(); await new Promise(r => setTimeout(r, 120)) }
            })()`
          )
          await new Promise((r) => setTimeout(r, 3000))
          const cold = await rendererCpu(5000)
          const vis = await win.webContents.executeJavaScript(
            `JSON.stringify({
              zoom: +(document.querySelector('.react-flow__viewport')?.style.transform.match(/scale\\(([\\d.]+)/)?.[1] ?? 0),
              lod: document.querySelectorAll('.term-node-lod').length,
              far: document.querySelectorAll('.term-node-far-chip').length,
              xterm: document.querySelectorAll('.xterm').length,\n              chars: [...document.querySelectorAll('.xterm-rows, .xterm-screen')].length
            })`
          )
          console.log(`[lod-bench] ${bench} 个终端持续输出（seq 1 60 / 20ms）`)
          console.log(`[lod-bench] 缩放 1.0 全部可见 → renderer ${hot.toFixed(1)}%`)
          console.log(`[lod-bench] 缩到 LOD ${vis} → renderer ${cold.toFixed(1)}%`)
          // 自检产物必须自己收干净，否则留一地孤儿 tmux 会话
          for (const tid of ids) await destroyPty(tid)
        }
        /* `TERMBOARD_DEMO=1`：把界面上的**可识别信息**换成 demo 值，再截图。
           给文档/官网出图用 —— 真实截图比手画的示意图有说服力得多，
           但项目名、邮箱、机器名不能发出去。

           ⚠️ **终端正文是画在 WebGL canvas 上的，DOM 替换不了它。**
           所以这个开关只处理 DOM 文本；终端内容要靠**缩到 LOD 档**
           （`TERMBOARD_ZOOM`）让它退化成色块 —— 而那恰好是这个产品的招牌视图。
           两件配合才安全，只用其中一个都会漏。

           ⚠️ 下面整段正文在**模板字符串**里，反斜杠会先被 TS 吃掉一层：
           想让浏览器里的正则拿到字面点号必须写 `\\.`，写 `\.` 到那边只剩 `.`
           （任意字符），脱敏正则会比预期宽。同理这段里不能出现裸反引号。 */
        if (process.env['TERMBOARD_DEMO']) {
          await win.webContents.executeJavaScript(
            `(() => {
              const TABS = ['我的项目', 'api-service', 'web-app', '实验']
              let i = 0
              for (const el of document.querySelectorAll('.project-tab-name, .project-tab-cwd')) {
                el.textContent = el.classList.contains('project-tab-cwd')
                  ? '~/code/demo'
                  : (TABS[i++ % TABS.length])
              }
              // 邮箱：连脱敏过的也换掉（a***@gmail.com 仍能看出首字母）
              for (const el of document.querySelectorAll('.quota-email, .quota-account-note')) {
                el.textContent = el.textContent.replace(
                  /[A-Za-z0-9._%+*-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g,
                  'demo@example.com'
                )
              }
              // 额度面板：套餐档位 + 用量百分比 + 重置倒计时都是**个人遥测**。
              // 不是凭证，但公开出图等于告诉所有人你买了哪档、这周用了多少、几点在干活。
              const PCT = [12, 41, 3, 7, 24, 5]
              let p = 0
              for (const el of document.querySelectorAll('.quota-pct')) {
                el.textContent = PCT[p++ % PCT.length] + '%'
              }
              for (const el of document.querySelectorAll('.quota-bar')) {
                const fill = el.firstElementChild
                if (fill && fill.style) fill.style.width = PCT[p++ % PCT.length] + '%'
              }
              for (const el of document.querySelectorAll('.quota-reset')) el.textContent = '3h00m'
              for (const el of document.querySelectorAll('.quota-plan')) el.textContent = 'demo'
              for (const el of document.querySelectorAll('.quota-money')) el.textContent = '$0.00'
              return true
            })()`
          )
          console.log('[demo] 已替换 DOM 里的可识别文本')
        }
        /* `TERMBOARD_ZOOM=<0-1>`：截图前把画布缩到指定比例。
           LOD 阈值是 0.35 —— 低于它终端就退化成纯色块，正文不可读。
           这正是 demo 出图需要的：既展示了招牌视图，又不会把终端里的真实内容发出去。

           ⚠️ 先切到**有节点的那个项目**再缩。用户的工作区里有空项目，
           上一次出图就落在空的那个上，截出来是一片黑（而且 minimap 也空着，
           一眼能看出不对 —— 出图后必须真的看一眼，别只看命令有没有报错）。 */
        if (process.env['TERMBOARD_ZOOM']) {
          const z = Number(process.env['TERMBOARD_ZOOM'])
          const picked = await win.webContents.executeJavaScript(
            `(async () => {
              const tabs = [...document.querySelectorAll('.project-tab')]
              // 逐个试，停在第一个真有终端节点的项目上
              for (const t of tabs) {
                t.click()
                await new Promise((r) => setTimeout(r, 700))
                if (document.querySelectorAll('.react-flow__node-terminal').length > 0) {
                  return document.querySelectorAll('.react-flow__node-terminal').length
                }
              }
              return 0
            })()`
          )
          console.log(`[demo] 选中的项目有 ${picked} 个终端`)
          // 缩放：`.react-flow__controls-button` 的顺序是 zoomIn / zoomOut / fitView / lock
          await win.webContents.executeJavaScript(
            `(() => {
              const b = document.querySelectorAll('.react-flow__controls-button')
              b[2]?.click()   // fitView：先把全部节点收进视野
              return true
            })()`
          )
          await new Promise((r) => setTimeout(r, 700))
          if (Number.isFinite(z) && z > 0 && z < 1) {
            await win.webContents.executeJavaScript(
              `(() => {
                const vp = document.querySelector('.react-flow__viewport')
                const m = /scale\\(([\\d.]+)\\)/.exec(vp?.style.transform || '')
                const cur = m ? Number(m[1]) : 1
                const times = Math.max(0, Math.round(Math.log(${z} / cur) / Math.log(1 / 1.2)))
                const out = document.querySelectorAll('.react-flow__controls-button')[1]
                for (let i = 0; i < times; i++) out?.click()
                return cur
              })()`
            )
            await new Promise((r) => setTimeout(r, 700))
            /* **报出真正缩到了多少。** 缩放是按 1.2 倍离散点击实现的，落点必然量化 ——
               请求 0.15 可能停在 0.17。不报的话，每次拿这个开关做的测量都是在拿
               请求值当实测值，而 LOD 阈值这类判断恰恰只在真实值上成立。
               （定 LOD 阈值时我就这么误判过一轮。） */
            const got = await win.webContents.executeJavaScript(
              `(() => {
                const vp = document.querySelector('.react-flow__viewport')
                const m = /scale\\(([\\d.]+)\\)/.exec(vp?.style.transform || '')
                /* 标题在**屏幕上**多高，是这几档能不能读的唯一判据 ——
                   canvas 坐标里的 font-size 会被画布缩放吃掉，只看它等于没量。
                   getBoundingClientRect 已经是屏幕像素，直接可比。 */
                const t = document.querySelector('.term-node-lod-title')
                const c = document.querySelector('.term-node-far-chip')
                return JSON.stringify({
                  zoom: m ? Number(m[1]) : null,
                  terminals: document.querySelectorAll('.react-flow__node-terminal').length,
                  lod: document.querySelectorAll('.term-node-lod').length,
                  farChips: document.querySelectorAll('.term-node-far-chip').length,
                  lodTitlePx: t ? Math.round(t.getBoundingClientRect().height) : null,
                  farChipPx: c ? Math.round(c.getBoundingClientRect().height) : null
                })
              })()`
            )
            console.log(`[demo] 请求 zoom=${z}，实际 ${got}`)
          }
        }
        /* `TERMBOARD_CLICK=<CSS 选择器>[|<选择器>…]`：截图前依次点一遍。
           没有它就只能拍到"入口"，拍不到点进去之后的样子 ——
           而需要验的恰恰是流程本身（比如「添加账号」点开后的四选一）。
           选中器里可以用 `text=xxx` 按可见文字找，因为按钮多半没有稳定的 class。 */
        const clicks = (process.env['TERMBOARD_CLICK'] ?? '').split('|').filter(Boolean)
        for (const sel of clicks) {
          const ok = await win.webContents.executeJavaScript(
            `(() => {
              const s = ${JSON.stringify(sel)}
              const el = s.startsWith('text=')
                ? [...document.querySelectorAll('button,a,[role=button]')]
                    .find(n => n.textContent?.trim() === s.slice(5))
                : document.querySelector(s)
              if (!el) return false
              el.click()
              return true
            })()`
          )
          console.log(`[shot-click] ${sel} → ${ok ? '点到了' : '**没找到**'}`)
          await new Promise((r) => setTimeout(r, 600))
        }
        const img = await win.webContents.capturePage()
        await writeFile(shotPath, img.toPNG())
      } finally {
        app.quit()
      }
    }, shotDelay)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitting = false
app.on('window-all-closed', () => {
  if (quitting) return
  quitting = true
  // 只释放客户端 —— tmux 会话跨 app 重启存活（续存核心语义）。
  // 抓屏是异步的，必须等它写完再 quit，否则 cold-restore 快照永远缺最后一屏。
  const snapshots = [...ptys.keys()].map((id) => releasePty(id))
  hookSystem?.dispose()
  workerWatch?.dispose()
  contextTail?.dispose()
  remoteApi?.dispose()
  // 兜底 3s：某个 tmux capture 卡住也不能让 app 关不掉
  void Promise.race([
    Promise.allSettled(snapshots),
    new Promise((r) => setTimeout(r, 3000))
  ]).then(() => app.quit())
})
