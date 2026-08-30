/// <reference types="vite/client" />

/* **不能写 export**：这个文件靠"没有顶层 import/export"才是全局声明文件，
   一加 export 它就变成模块，`interface Window` 增强整个失效 ——
   症状是所有 `window.termspace` 一起报 TS2339（实测）。 */
interface BrokerMeta {
  id: string
  name: string
  kind: 'ssh' | 'postgres'
  readOnly: boolean
}

interface TaskRow {
  id: string
  source: string
  target: string
  brief: string
  startedAt: number
  endedAt?: number
  state: 'running' | 'done' | 'failed' | 'timeout' | 'rejected'
  result?: string
  error?: string
  branch?: string
  transcript?: string
}

interface AppSettings {
  defaultFontSize: number
  defaultShell: string
  tmuxEnabled: boolean
  scrollback: number
  skillDirs: string[]
  claudeHooks: 'ask' | 'on' | 'off'
  remoteEnabled: boolean
  remoteAllowInput: boolean
  remoteAllowApprove: boolean
  remotePort: number
  remoteBind: 'loopback' | 'tailscale'
  /** 可以跨机派活过去的 ssh 别名白名单（只是别名，不含任何密钥） */
  peers: string[]
  /** 本机是否接受别的机器派进来的活 */
  peerDelegate: boolean
  /** 后台检查更新。下载完只提示，装不装用户说了算 */
  autoUpdate: boolean
  /** 更新源（存 latest-mac.yml + zip 的 HTTPS 目录）。空 = 没配，更新不工作 */
  updateFeedUrl: string
  editorCommand: string
  brokers: BrokerMeta[]
  /** 出站通知的推送地址（ntfy / Bark）。空 = 不通知 */
  notifyUrl: string
  notifyLevel: 'attention' | 'all'
}

/** 更新状态。五档必须能区分 —— 界面据此决定显示什么 */
type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'current'; version: string }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string; notes?: string }
  | { phase: 'error'; message: string }

/** 额度：一个窗口（5h / 周 / 按模型）。语义只能从 windowMinutes 推，不许按位置认 */
interface QuotaWindow {
  id: string
  label: string
  usedPercent: number
  windowMinutes?: number
  resetsAt?: number
  severity?: 'normal' | 'warning' | 'critical'
  scopeModel?: string
  unlimited?: boolean
}

interface QuotaSpend {
  label: string
  /** 已花。**和 remainingMinor 是两回事**，缺哪个就 undefined，绝不拿 0 顶上 */
  usedMinor?: number
  limitMinor?: number
  /** 余额（codex 的 credits 是「还剩多少」，不是「花了多少」） */
  remainingMinor?: number
  currency: string
  enabled?: boolean
}

/** 额度的归属单位是**账号**（见 docs/QUOTA.md），不是 provider 也不是节点 */
interface AccountQuota {
  accountId: string
  provider: string
  name: string
  state: 'ok' | 'stale' | 'unconfigured' | 'unavailable' | 'unknown-shape'
  quotaCapability:
    | 'supported'
    | 'officially_unavailable'
    | 'web_only'
    | 'admin_only'
    | 'blocked_by_policy'
    | 'collector_error'
  presence: {
    state: 'verified' | 'detected' | 'not_logged_in' | 'unknown'
    detail: string
    discovered: boolean
  }
  capturedAt: number
  source: string
  plan?: string
  /** 账号邮箱 —— 区分两个同 provider 订阅号的唯一可靠标识（planType 都是 'pro'） */
  email?: string
  /** 非邮箱形态的账号标识（GitHub login 之类）。**不走 maskEmail** */
  handle?: string
  windows: QuotaWindow[]
  spend?: QuotaSpend[]
  hint?: string
}

/** 审批规则引擎的判定。**没有 allow** —— 见 src/main/approval-policy.ts */
interface PolicyVerdict {
  decision: 'require_human' | 'deny'
  rule: string
  reason: string
}

interface IdentityMeta {
  id: string
  name: string
  provider:
    | 'claude'
    | 'codex'
    | 'gemini'
    | 'copilot'
    | 'cursor'
    | 'antigravity'
    | 'openrouter'
    | 'custom'
  envOps: { key: string; action: 'set' | 'unset' }[]
}

/** 一条访问凭据的元数据。**没有 token 本身** —— 它只在签发那一刻出过主进程一次 */
interface RemoteTokenMeta {
  label: string
  role: 'owner' | 'viewer'
  createdAt: number
  expiresAt?: number
  /** 前 6 位，够在列表里认出是哪条 */
  hint: string
}

interface Preset {
  id: string
  name: string
  provider: IdentityMeta['provider']
  command: string
  identityId?: string
}

interface TermspaceApi {
  spawn: (
    id: string,
    cols: number,
    rows: number,
    opts?: {
      identityId?: string
      command?: string
      provider?: string
      contextNodeIds?: string[]
      cwd?: string
    }
  ) => Promise<void>
  pickFolder: () => Promise<string | null>
  getSettings: () => Promise<AppSettings>
  setSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  hooksStatus: () => Promise<{
    installed: boolean
    endpoint: string
    settingsPath: string
    consent: 'ask' | 'on' | 'off'
  }>
  uninstallHooks: () => Promise<{ ok: boolean; changed?: boolean }>
  notifyTest: (url: string) => Promise<{ ok: boolean; error?: string }>
  remoteStatus: () => Promise<{
    enabled: boolean
    allowInput: boolean
    allowApprove: boolean
    running: boolean
    port: number
    token: string
    bind: string
    bindMode: 'loopback' | 'tailscale'
    /** 选了 tailscale 却没找到 100.x 地址，实际退回了回环 */
    fellBack: boolean
    /** 启动失败原因，空表示没失败 */
    error: string
    /** 带 token 的配对链接，手机扫码即连 */
    pairUrl: string
  } | null>
  doctor: () => Promise<
    { key: string; label: string; ok: boolean; detail: string; hint: string }[]
  >
  remoteTokens: () => Promise<RemoteTokenMeta[]>
  issueViewerLink: (
    label: string
  ) => Promise<{ url?: string; expiresAt?: number; error?: string } | null>
  revokeRemoteToken: (hint: string) => Promise<RemoteTokenMeta[]>
  reapSessions: (knownIds: string[]) => Promise<number>
  listSkills: () => Promise<{ name: string; description: string; source: string }[]>
  reportAgents: (payload: {
    agents: { id: string; title: string; provider?: string; status: string }[]
    /** 授权连线，形如 `source>target` */
    links: string[]
    /** 上下文节点→终端的连线，形如 `ctx>term`。`tb context` 靠它现算内容 */
    ctxLinks: string[]
    /** 现存节点 id 全集（主进程据此撤销失效授权） */
    nodeIds: string[]
    /** 完整画布快照（远程 API 用；只含布局与状态，不含终端内容） */
    board: unknown
  }) => void
  onApprovals: (
    cb: (
      list: {
        id: string
        nodeId: string
        toolName: string
        summary: string
        toolUseId: string
        createdAt: number
        sessionId: string
        cwd: string
        inputHash: string
        verdict?: PolicyVerdict
      }[]
    ) => void
  ) => () => void
  decideApproval: (id: string, allow: boolean) => Promise<{ ok: boolean; error?: string }>
  /** 抓终端当前屏尾部若干行（消息中心显示"它在问什么"） */
  listTasks: () => Promise<TaskRow[]>
  onTasks: (cb: (rows: TaskRow[]) => void) => () => void
  peek: (id: string, lines?: number) => Promise<{ text: string; sig: string }>
  /** 就地把内容写进该终端 */
  reply: (
    id: string,
    text: string,
    expectSig?: string
  ) => Promise<{ ok: boolean; error?: string; changed?: boolean }>
  onBrowserCmd: (
    cb: (req: {
      reqId: string
      nodeId: string
      action: string
      arg: string
      /** 发起这条指令的终端节点 id（open 时用来自动连线） */
      source: string
    }) => void | Promise<void>
  ) => () => void
  browserResult: (r: { reqId: string; ok: boolean; result: string }) => void
  write: (id: string, data: string) => void
  /** 输入框 chips：此刻的 cwd / 分支 / 脏文件数。live=false 表示只拿到启动目录 */
  terminalMeta: (
    id: string,
    fallbackCwd?: string
  ) => Promise<{
    cwd: string
    live: boolean
    branch: string | null
    dirty: number | null
    home: string
  } | null>
  /** 带回执的写入（输入框用）。ok 才代表真进了 pty */
  sendInput: (id: string, data: string) => Promise<{ ok: boolean; reason?: string }>
  resize: (id: string, cols: number, rows: number) => void
  kill: (id: string) => void
  /** 返回销毁前抓到的屏幕内容，撤回删除时回灌 */
  destroy: (id: string) => Promise<string>
  seedScrollback: (id: string, text: string) => Promise<boolean>
  onData: (id: string, cb: (data: string) => void) => () => void
  onExit: (id: string, cb: (code: number) => void) => () => void
  loadContext: (nodeId: string) => Promise<string>
  saveContext: (nodeId: string, text: string) => Promise<{ ok: boolean; error?: string }>
  onDelegateFlight: (
    cb: (e: { source: string; target: string; active: boolean }) => void
  ) => () => void
  onSpawnError: (cb: (e: { nodeId: string; message: string }) => void) => () => void
  onUpdateState: (cb: (s: UpdateState) => void) => () => void
  updateState: () => Promise<UpdateState | null>
  checkUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
  loadWorkspace: () => Promise<unknown>
  saveWorkspace: (data: unknown) => Promise<{ ok: boolean; error?: string }>
  exportWorkspace: (
    data: unknown
  ) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
  importWorkspace: () => Promise<{ ok: boolean; canceled?: boolean; error?: string }>
  appInfo: () => Promise<{
    version: string
    electron: string
    userData: string
    crashBytes: number
    crashCount: number
  } | null>
  revealUserData: () => Promise<void>
  onAgentStatus: (
    cb: (e: { nodeId: string; agentId: string; state: string; newTurn: boolean; event?: string }) => void
  ) => () => void
  onAgentContext: (
    cb: (e: {
      nodeId: string
      usedTokens: number
      windowTokens: number
      usedPercent: number
      model: string
    }) => void
  ) => () => void
  onQuota: (cb: (list: AccountQuota[]) => void) => () => void
  scanQuotaUsage: (nodeIds: string[]) => Promise<Record<string, string>>
  rescanAccounts: () => Promise<void>
  ready: () => void
  workerAction: (
    action: 'result' | 'kill' | 'send' | 'clean',
    task: string,
    text?: string
  ) => Promise<{ ok: boolean; output: string }>
  onWorkers: (
    cb: (
      rows: {
        task: string
        backend: string
        model?: string
        state: string
        repo?: string
        age_s?: number
        question?: string | null
      }[]
    ) => void
  ) => () => void
  listPresets: () => Promise<Preset[]>
  upsertPreset: (input: Omit<Preset, 'id'> & { id?: string }) => Promise<Preset[]>
  deletePreset: (id: string) => Promise<Preset[]>
  identityStoreHealth: () => Promise<string | null>
  listIdentities: () => Promise<IdentityMeta[]>
  upsertIdentity: (input: {
    id?: string
    name: string
    provider: IdentityMeta['provider']
    envOps: (
      | { key: string; action: 'set' | 'replace'; value: string }
      | { key: string; action: 'unset' | 'retain' | 'delete' }
    )[]
  }) => Promise<IdentityMeta[]>
  createSubscriptionIdentity: (input: {
    provider: IdentityMeta['provider']
    name: string
  }) => Promise<{ id: string; list: IdentityMeta[] }>
  identityEnvPresence: (keys: string[]) => Promise<string[]>
  deleteIdentity: (id: string) => Promise<IdentityMeta[]>
  renameIdentity: (id: string, name: string) => Promise<IdentityMeta[]>
  /** 凭证登录态。只有 codex 能真查（codex login status），其余如实报 unknown */
  identityLoginStatus: (id: string) => Promise<{
    state: 'in' | 'out' | 'unknown'
    detail: string
    home?: string
  }>
  /** 这个目录是不是 git 仓库。**null = 不是**，UI 据此完全隐藏 worktree 功能 */
  gitProbe: (cwd: string) => Promise<{
    repoRoot: string
    branch: string | null
    worktrees: { path: string; head: string; branch: string | null }[]
  } | null>
  /** 一棵树的分支与脏文件数。路径不存在（被外部删了）返回 null */
  gitWorktreeStatus: (path: string) => Promise<{ branch: string | null; dirty: number } | null>
  gitCreateWorktree: (
    repoRoot: string,
    branch: string
  ) => Promise<{ ok: boolean; path?: string; error?: string }>
  /** 绝不 --force：脏树删不掉是特性，error 里带 git 的原话 */
  saveBroker: (b: {
    id?: string
    name: string
    kind: 'ssh' | 'postgres'
    readOnly: boolean
    target?: string
  }) => Promise<{ ok: boolean; error?: string; brokers?: BrokerMeta[] }>
  deleteBroker: (id: string) => Promise<{ ok: boolean; brokers?: BrokerMeta[] }>
  exportLayout: (payload: {
    name: string
    description?: string
    root: string
    nodes: unknown[]
    edges: unknown[]
  }) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
  importLayout: () => Promise<{
    ok: boolean
    error?: string
    canceled?: boolean
    name?: string
    nodes?: {
      ref: string
      type: 'terminal' | 'browser' | 'context' | 'group'
      title: string
      absCwd?: string
      suggestedCommand?: string
      provider?: string
      url?: string
      parent?: string
      x: number
      y: number
      width?: number
      height?: number
    }[]
    edges?: { from: string; to: string; kind: string }[]
    withCommands?: number
  }>
  gitDiffSummary: (path: string) => Promise<{
    files: { path: string; added: number; removed: number; untracked?: boolean }[]
    added: number
    removed: number
    truncated: number
  } | null>
  openInEditor: (
    target: string,
    editor: string
  ) => Promise<{ ok: boolean; via?: string; error?: string }>
  listEditors: () => Promise<string[]>
  gitRemoveWorktree: (path: string) => Promise<{ ok: boolean; error?: string }>
}

declare interface Window {
  termspace: TermspaceApi
}
