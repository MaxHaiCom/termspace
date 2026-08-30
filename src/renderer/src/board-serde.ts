/**
 * 画布节点 ↔ 磁盘格式。
 *
 * 独立成文件是为了能被 `node --test` 直接跑 —— App.tsx 带着 React 和 React Flow
 * 进不去，而这里正是**已经出过事**的地方：`toSaved` 写了 `credential`，
 * `fromSaved` 却没有对应分支，于是重启后凭证节点掉进 terminal 兜底，
 * 变成一个终端，还拿着 identityId 真去 spawn 一个 pty。
 *
 * **兜底分支是 terminal，静默且危险** —— 每加一种节点类型都必须在 fromSaved 里补一支，
 * board-serde.test.ts 的 round-trip 用例会在忘记时炸掉。
 */
import type { TermNode } from './nodes/TerminalNode'
import type { GroupNodeT } from './nodes/GroupNode'
import type { WorkerNodeT } from './nodes/WorkerNode'
import type { ContextNodeT } from './nodes/ContextNode'
import type { BrowserNodeT } from './nodes/BrowserNode'
import type { CredentialNodeType } from './nodes/CredentialNode'

export type BoardNode =
  | TermNode
  | GroupNodeT
  | WorkerNodeT
  | ContextNodeT
  | BrowserNodeT
  | CredentialNodeType

export const DEFAULT_SIZE = { width: 580, height: 380 }

/** 画布上所有可持久化的节点类型。加新类型时这里和 fromSaved 都要动 */
export const SAVED_TYPES = ['terminal', 'group', 'context', 'browser', 'credential'] as const

/**
 * 主进程对 nodeId 的字符白名单。**这里必须和 src/main/index.ts 的 NODE_ID_RE 一致** ——
 * 生成一个主进程会拒收的 id，症状是终端静默起不来。
 */
export const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * 新节点 id。**不可复用**，这是它存在的全部理由。
 *
 * 原来是 `max + 1`（`t1` `t2` …），删掉 `t7` 再建一个还叫 `t7`。而 nodeId 同时是：
 * tmux 会话名 `tb-<id>`、scrollback 快照文件名、上下文文件名、hook token 文件名、
 * pty 表的键、连线授权图的键。**id 一复用，这六条链路一起串台** ——
 * 新节点白捡旧节点的授权、回灌到别人的历史、顶着别人的身份上报。
 * 代码里为此写过四处补偿逻辑，它们的共同前提是"复用发生在删除之后"；
 * 一旦有第二个客户端，就变成"复用发生在同时"，四处全部失效。
 *
 * **没用完整 UUID**：nodeId 是用户和 agent 要念出来的东西（`tb ask <节点id> <任务>`），
 * 36 位 UUID 会让这个招牌功能变得没法用。6 位 base36 = 22 亿，
 * 单张画布撞的概率可以忽略，而 `t-7k3f9a` 还看得出是个终端。
 */
export function newNodeId(prefix: string, existing: Iterable<string> = []): string {
  const taken = new Set(existing)
  for (let i = 0; i < 50; i++) {
    const buf = new Uint32Array(2)
    crypto.getRandomValues(buf)
    const suffix = `${buf[0]!.toString(36)}${buf[1]!.toString(36)}`.slice(0, 6)
    const id = `${prefix}-${suffix}`
    // 撞了就重摇。也挡住和老 id（t1/b3/g2）重名的极端情况
    if (!taken.has(id) && NODE_ID_RE.test(id)) return id
  }
  // 50 次都撞几乎不可能；真到了就用时间戳兜底，绝不返回一个可能重复的 id
  return `${prefix}-${Date.now().toString(36)}`
}

/** board 记录里为认领而存的最小信息。真正的 SavedBoard 还有 nodes/edges/viewport */
export interface BoardStub {
  cwd?: string
  nodes: readonly unknown[]
}

/**
 * 再次添加某个目录时，认领回它原来的 pid。
 *
 * **关标签页不删数据是有意的**（画布记录留着、tmux 会话继续活着），
 * 但那条路只有在"重新添加同目录能拿回原来的 pid"时才闭环 ——
 * 否则铸一个新 pid 就等于：旧画布连同**里面还在跑的终端**永远够不着，
 * 而 reap 认的是"所有 board 里出现过的节点 id"，那些会话会一直活下去，
 * 界面上看不见、也关不掉，只能去命令行 `tmux -L termboard kill-session`。
 *
 * pid 还决定上下文节点的文件名，所以认领的是 **pid 本身**，不是"把节点搬过去"。
 *
 * 只认没有项目在用的 board（`openPids`）—— 同一个目录开着两个标签页时，
 * 新加的那个必须是独立画布，不能劫持正在用的那个。
 */
export function reclaimBoardId(
  boards: Readonly<Record<string, BoardStub>>,
  openPids: Iterable<string>,
  cwd: string
): string | null {
  // 空 cwd 是 v1 迁移来的「默认」项目，不是真目录，不参与匹配
  if (!cwd) return null
  const open = new Set(openPids)
  for (const [pid, b] of Object.entries(boards)) {
    if (!open.has(pid) && b.cwd === cwd) return pid
  }
  return null
}

/**
 * 找出**没有 cwd 可认领、却还装着东西**的孤儿 board。
 *
 * 一次性迁移：修复之前 `addProject` 每次铸新 pid，关掉的标签页无从认领，
 * board 里的终端会一直活着而界面上够不着。这些老 board 没有 cwd，
 * `reclaimBoardId` 救不了它们 —— 只能在启动时直接给它们造一个标签页。
 *
 * 判据是「有没有 terminal / browser 节点」而不是「有没有节点」：
 * `ctx-hub` 是每块画布自动播种的，只剩它的 board 是空画布，
 * 给它造标签页只会在标签栏里堆垃圾。终端才是那个**会留下活进程**的。
 *
 * 有 cwd 的孤儿不在此列：那些重新添加同一个目录就能拿回来，
 * 自动恢复反而会让「关掉标签页」这个动作失效（下次启动它又回来了）。
 */
export function orphanBoardsToRecover(
  boards: Readonly<Record<string, { cwd?: string; nodes: readonly { type?: string }[] }>>,
  openPids: Iterable<string>
): string[] {
  const open = new Set(openPids)
  return Object.entries(boards)
    .filter(
      ([pid, b]) =>
        !open.has(pid) &&
        !b.cwd &&
        b.nodes.some((n) => n.type === 'terminal' || n.type === 'browser')
    )
    .map(([pid]) => pid)
}

/**
 * 丢掉既没有项目在用、又一个节点都没有的 board。
 *
 * 保守到近乎无用是**故意的**：只要还有节点就留着，因为节点 id 一旦从
 * `boards` 里消失，reap 就会把它对应的 tmux 会话当孤儿杀掉 ——
 * 而那可能是用户跑了一整天的活。这里只清真正的空壳。
 */
export function pruneEmptyBoards<T extends BoardStub>(
  boards: Readonly<Record<string, T>>,
  openPids: Iterable<string>
): Record<string, T> {
  const open = new Set(openPids)
  const out: Record<string, T> = {}
  for (const [pid, b] of Object.entries(boards)) {
    if (open.has(pid) || b.nodes.length > 0) out[pid] = b
  }
  return out
}

export interface SavedNode {
  id: string
  x: number
  y: number
  width: number
  height: number
  title: string
  type?: 'terminal' | 'group' | 'context' | 'browser' | 'credential'
  parentId?: string
  identityId?: string
  command?: string
  /** 布局模板带来的建议命令。**存它是安全的** —— 它永远不会被 spawn 自动执行，
      只有用户点了节点上那个「▶ 待运行」才会变成 command（见 TerminalNode） */
  suggestedCommand?: string
  provider?: string
  fontSize?: number
  cwd?: string
  /** 底部输入框展开与否。**只存开关，草稿正文故意不落盘**（见 TerminalNode 的 draftStore） */
  composer?: boolean
  url?: string
  collapsed?: boolean
  /** group 专用：绑定的 git worktree（见 GroupNode 的 GroupWorktree） */
  worktree?: { repo: string; branch: string; path: string }
}

export function fromSaved(s: SavedNode): BoardNode {
  if (s.type === 'browser') {
    return {
      id: s.id,
      type: 'browser',
      position: { x: s.x, y: s.y },
      width: s.width,
      height: s.height,
      data: { url: s.url || 'about:blank', title: s.title }
    }
  }
  if (s.type === 'context') {
    return {
      id: s.id,
      type: 'context',
      position: { x: s.x, y: s.y },
      width: s.width,
      height: s.height,
      data: { title: s.title }
    }
  }
  if (s.type === 'group') {
    return {
      id: s.id,
      type: 'group',
      position: { x: s.x, y: s.y },
      width: s.width,
      height: s.height,
      data: { title: s.title, collapsed: s.collapsed, worktree: s.worktree }
    }
  }
  /* 凭证节点。**漏了这个分支的后果不是"少一个节点"**：它会掉进下面的 terminal
     兜底，重启后凭证节点变成一个终端，还拿着 identityId 真去 spawn 一个 pty。
     每加一种节点类型都要在这里补一支 —— 兜底分支是 terminal，静默且危险。 */
  if (s.type === 'credential') {
    return {
      id: s.id,
      type: 'credential',
      position: { x: s.x, y: s.y },
      width: s.width,
      height: s.height,
      data: { identityId: s.identityId ?? '' }
    }
  }
  return {
    id: s.id,
    type: 'terminal',
    position: { x: s.x, y: s.y },
    width: s.width || DEFAULT_SIZE.width,
    height: s.height || DEFAULT_SIZE.height,
    parentId: s.parentId,
    extent: s.parentId ? ('parent' as const) : undefined,
    data: {
      title: s.title || s.id,
      status: 'idle',
      identityId: s.identityId,
      command: s.command,
      suggestedCommand: s.suggestedCommand,
      provider: s.provider,
      fontSize: s.fontSize,
      cwd: s.cwd,
      composer: s.composer === true
    }
  }
}

export function toSaved(n: Exclude<BoardNode, WorkerNodeT>): SavedNode {
  const base = {
    id: n.id,
    x: n.position.x,
    y: n.position.y,
    width: n.width ?? n.measured?.width ?? DEFAULT_SIZE.width,
    height: n.height ?? n.measured?.height ?? DEFAULT_SIZE.height,
    title:
      n.type === 'browser'
        ? (n.data.title ?? '浏览器')
        : n.type === 'credential'
          ? (n.data.title ?? '凭证')
          : n.data.title,
    type: n.type
  }
  if (n.type === 'browser') return { ...base, url: n.data.url }
  // 折叠态要持久化：不然重开后组身还是缩着、子终端却全冒出来
  if (n.type === 'group')
    return { ...base, collapsed: n.data.collapsed, worktree: n.data.worktree }
  if (n.type === 'context') return base
  // 凭证节点只存"指向哪个凭证"；env 值一直在主进程加密着，画布文件里绝不出现
  if (n.type === 'credential') return { ...base, identityId: n.data.identityId }
  return {
    ...base,
    parentId: n.parentId,
    identityId: n.data.identityId,
    command: n.data.command,
    suggestedCommand: n.data.suggestedCommand,
    provider: n.data.provider,
    fontSize: n.data.fontSize,
    cwd: n.data.cwd,
    composer: n.data.composer === true ? true : undefined
  }
}
