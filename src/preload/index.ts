import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
// 只引类型（编译期擦除），不会把主进程代码打进 preload bundle
import type { AccountQuota } from '../main/quota/types'
import type { UpdateState } from '../main/updater'

const api = {
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
  ): Promise<void> => ipcRenderer.invoke('pty:spawn', id, cols, rows, opts),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),
  getSettings: (): Promise<unknown> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: unknown): Promise<unknown> => ipcRenderer.invoke('settings:set', patch),
  hooksStatus: (): Promise<unknown> => ipcRenderer.invoke('hooks:status'),
  uninstallHooks: (): Promise<{ ok: boolean; changed?: boolean }> =>
    ipcRenderer.invoke('hooks:uninstall'),
  doctor: (): Promise<unknown[]> => ipcRenderer.invoke('app:doctor'),
  /** 已发出的访问凭据（只有元数据，没有 token 本身） */
  remoteTokens: (): Promise<
    { label: string; role: 'owner' | 'viewer'; createdAt: number; expiresAt?: number; hint: string }[]
  > => ipcRenderer.invoke('remote:tokens'),
  /** 签发只读分享链接。**token 一生只出主进程这一次**，之后只剩前 6 位 */
  issueViewerLink: (
    label: string
  ): Promise<{ url?: string; expiresAt?: number; error?: string } | null> =>
    ipcRenderer.invoke('remote:issueViewer', label),
  revokeRemoteToken: (
    hint: string
  ): Promise<
    { label: string; role: 'owner' | 'viewer'; createdAt: number; expiresAt?: number; hint: string }[]
  > => ipcRenderer.invoke('remote:revoke', hint),
  remoteStatus: (): Promise<unknown> => ipcRenderer.invoke('remote:status'),
  // 出站通知的连通性自检（设置 → 远程访问）
  notifyTest: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('notify:test', url),
  reapSessions: (knownIds: string[]): Promise<number> =>
    ipcRenderer.invoke('sessions:reap', knownIds),
  listSkills: (): Promise<unknown> => ipcRenderer.invoke('skills:list'),
  reportAgents: (payload: unknown): void => {
    ipcRenderer.send('board:agents', payload)
  },
  onBrowserCmd: (
    cb: (req: { reqId: string; nodeId: string; action: string; arg: string; source: string }) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, req: Parameters<typeof cb>[0]): void => cb(req)
    ipcRenderer.on('browser:cmd', listener)
    return () => ipcRenderer.removeListener('browser:cmd', listener)
  },
  browserResult: (r: { reqId: string; ok: boolean; result: string }): void => {
    ipcRenderer.send('browser:result', r)
  },
  /** 输入框 chips：此刻的 cwd / 分支 / 脏文件数。live=false 表示只拿到启动目录 */
  terminalMeta: (
    id: string,
    fallbackCwd?: string
  ): Promise<{ cwd: string; live: boolean; branch: string | null; dirty: number | null } | null> =>
    ipcRenderer.invoke('terminal:meta', id, fallbackCwd),
  /** 输入框专用：带回执，收到 ok 才能清草稿（`pty:write` 超限会静默丢弃） */
  sendInput: (id: string, data: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('pty:sendInput', id, data),
  write: (id: string, data: string): void => {
    ipcRenderer.send('pty:write', id, data)
  },
  resize: (id: string, cols: number, rows: number): void => {
    ipcRenderer.send('pty:resize', id, cols, rows)
  },
  kill: (id: string): void => {
    ipcRenderer.send('pty:kill', id)
  },
  destroy: (id: string): Promise<string> => ipcRenderer.invoke('pty:destroy', id),
  seedScrollback: (id: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke('session:seedScrollback', id, text),
  onApprovals: (cb: (list: unknown[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, list: unknown[]): void => cb(list)
    ipcRenderer.on('approvals:update', listener)
    return () => ipcRenderer.removeListener('approvals:update', listener)
  },
  decideApproval: (id: string, allow: boolean): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('approval:decide', id, allow),
  /** 任务账本：快照 + 变更推送（派活留痕，见 main/task-ledger.ts） */
  listTasks: (): Promise<unknown[]> => ipcRenderer.invoke('tasks:list'),
  onTasks: (cb: (rows: unknown[]) => void): (() => void) => {
    const h = (_e: unknown, rows: unknown[]): void => cb(rows)
    ipcRenderer.on('tasks:update', h)
    return () => ipcRenderer.off('tasks:update', h)
  },
  peek: (id: string, lines?: number): Promise<{ text: string; sig: string }> =>
    ipcRenderer.invoke('agent:peek', id, lines),
  /** expectSig = 调用方渲染那一屏时的指纹；主进程落笔前会重对一次（见 agent:reply） */
  reply: (
    id: string,
    text: string,
    expectSig?: string
  ): Promise<{ ok: boolean; error?: string; changed?: boolean }> =>
    ipcRenderer.invoke('agent:reply', id, text, expectSig),
  onData: (id: string, cb: (data: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: string): void => cb(data)
    ipcRenderer.on(`pty:data:${id}`, listener)
    return () => ipcRenderer.removeListener(`pty:data:${id}`, listener)
  },
  onExit: (id: string, cb: (code: number) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, code: number): void => cb(code)
    ipcRenderer.on(`pty:exit:${id}`, listener)
    return () => ipcRenderer.removeListener(`pty:exit:${id}`, listener)
  },
  /** 起不来的原因（凭证没了之类）。没有这条的话终端就是一块什么都不显示的黑板 */
  onSpawnError: (cb: (e: { nodeId: string; message: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, ev: Parameters<typeof cb>[0]): void => cb(ev)
    ipcRenderer.on('pty:spawn-error', listener)
    return () => ipcRenderer.removeListener('pty:spawn-error', listener)
  },
  /** 派活在飞：画布据此只给"此刻真有事发生"的那条线加流光 */
  onDelegateFlight: (
    cb: (e: { source: string; target: string; active: boolean }) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, ev: Parameters<typeof cb>[0]): void => cb(ev)
    ipcRenderer.on('delegate:flight', listener)
    return () => ipcRenderer.removeListener('delegate:flight', listener)
  },
  /** 自动更新：状态推送 + 手动检查 + 「重启并安装」 */
  onUpdateState: (cb: (s: UpdateState) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, s: UpdateState): void => cb(s)
    ipcRenderer.on('update:state', listener)
    return () => ipcRenderer.removeListener('update:state', listener)
  },
  updateState: (): Promise<UpdateState> => ipcRenderer.invoke('update:get'),
  checkUpdate: (): Promise<void> => ipcRenderer.invoke('update:check'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
  loadContext: (nodeId: string): Promise<string> => ipcRenderer.invoke('context:load', nodeId),
  saveContext: (nodeId: string, text: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('context:save', nodeId, text),
  loadWorkspace: (): Promise<unknown> => ipcRenderer.invoke('workspace:load'),
  saveWorkspace: (data: unknown): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('workspace:save', data),
  exportWorkspace: (
    data: unknown
  ): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('workspace:export', data),
  importWorkspace: (): Promise<{ ok: boolean; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('workspace:import'),
  appInfo: (): Promise<{
    version: string
    electron: string
    userData: string
    crashBytes: number
    crashCount: number
  } | null> => ipcRenderer.invoke('app:info'),
  revealUserData: (): Promise<void> => ipcRenderer.invoke('app:revealUserData'),
  onAgentStatus: (
    cb: (e: { nodeId: string; agentId: string; state: string; newTurn: boolean; event?: string }) => void
  ): (() => void) => {
    const listener = (
      _e: IpcRendererEvent,
      ev: { nodeId: string; agentId: string; state: string; newTurn: boolean; event?: string }
    ): void => cb(ev)
    ipcRenderer.on('agent:status', listener)
    return () => ipcRenderer.removeListener('agent:status', listener)
  },
  onAgentContext: (
    cb: (e: {
      nodeId: string
      usedTokens: number
      windowTokens: number
      usedPercent: number
      model: string
    }) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, ev: Parameters<typeof cb>[0]): void => cb(ev)
    ipcRenderer.on('agent:context', listener)
    return () => ipcRenderer.removeListener('agent:context', listener)
  },
  ready: (): void => {
    ipcRenderer.send('renderer:ready')
  },
  workerAction: (
    action: 'result' | 'kill' | 'send' | 'clean',
    task: string,
    text?: string
  ): Promise<{ ok: boolean; output: string }> =>
    ipcRenderer.invoke('worker:action', action, task, text),
  onWorkers: (cb: (rows: unknown[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, rows: unknown[]): void => cb(rows)
    ipcRenderer.on('workers:update', listener)
    return () => ipcRenderer.removeListener('workers:update', listener)
  },
  listPresets: (): Promise<unknown> => ipcRenderer.invoke('preset:list'),
  upsertPreset: (input: unknown): Promise<unknown> => ipcRenderer.invoke('preset:upsert', input),
  deletePreset: (id: string): Promise<unknown> => ipcRenderer.invoke('preset:delete', id),
  listIdentities: (): Promise<unknown> => ipcRenderer.invoke('identity:list'),
  identityStoreHealth: (): Promise<string | null> => ipcRenderer.invoke('identity:health'),
  upsertIdentity: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke('identity:upsert', input),
  createSubscriptionIdentity: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke('identity:createSubscription', input),
  identityEnvPresence: (keys: string[]): Promise<string[]> =>
    ipcRenderer.invoke('identity:envPresence', keys),
  deleteIdentity: (id: string): Promise<unknown> => ipcRenderer.invoke('identity:delete', id),
  renameIdentity: (id: string, name: string): Promise<unknown> =>
    ipcRenderer.invoke('identity:rename', id, name),
  identityLoginStatus: (id: string): Promise<unknown> =>
    ipcRenderer.invoke('identity:loginStatus', id),
  /* git worktree —— 画布上一个组 = 一棵树，让并行 agent 物理隔离。
     probe 返回 null = 这个目录不是 git 仓库，UI 据此把整个功能藏起来
     （用户的项目目录大多不是仓库，不能变成噪音）。 */
  gitProbe: (cwd: string): Promise<unknown> => ipcRenderer.invoke('git:probe', cwd),
  gitWorktreeStatus: (path: string): Promise<unknown> =>
    ipcRenderer.invoke('git:worktreeStatus', path),
  gitCreateWorktree: (repoRoot: string, branch: string): Promise<unknown> =>
    ipcRenderer.invoke('git:createWorktree', repoRoot, branch),
  /** 代理连接：**没有读回连接串的通道，那是有意的**（见 broker-store.ts） */
  saveBroker: (b: {
    id?: string
    name: string
    kind: 'ssh' | 'postgres'
    readOnly: boolean
    target?: string
  }): Promise<{ ok: boolean; error?: string; brokers?: unknown[] }> =>
    ipcRenderer.invoke('broker:save', b),
  deleteBroker: (id: string): Promise<{ ok: boolean; brokers?: unknown[] }> =>
    ipcRenderer.invoke('broker:delete', id),
  exportLayout: (payload: unknown): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('layout:export', payload),
  importLayout: (): Promise<unknown> => ipcRenderer.invoke('layout:import'),
  gitDiffSummary: (path: string): Promise<unknown> => ipcRenderer.invoke('git:diffSummary', path),
  /** 在编辑器打开。编辑器名在主进程走白名单，这里传什么都不会变成命令 */
  openInEditor: (target: string, editor: string): Promise<{ ok: boolean; via?: string; error?: string }> =>
    ipcRenderer.invoke('editor:open', target, editor),
  listEditors: (): Promise<string[]> => ipcRenderer.invoke('editor:list'),
  gitRemoveWorktree: (path: string): Promise<unknown> =>
    ipcRenderer.invoke('git:removeWorktree', path),
  /* 类型直接从主进程的模型引进来。以前这里还写着早已换掉的单账号 Claude payload
     （five_hour/seven_day），而主进程发的是 AccountQuota[] —— 两套声明各自自洽，
     typecheck 全绿，实际字段一个都对不上。IPC 两端必须共用同一个类型。 */
  onQuota: (cb: (list: AccountQuota[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, q: Parameters<typeof cb>[0]): void => cb(q)
    ipcRenderer.on('quota:update', listener)
    return () => ipcRenderer.removeListener('quota:update', listener)
  },
  scanQuotaUsage: (nodeIds: string[]): Promise<Record<string, string>> =>
    ipcRenderer.invoke('quota:scanUsage', nodeIds),
  rescanAccounts: (): Promise<void> => ipcRenderer.invoke('quota:rescan')
}

contextBridge.exposeInMainWorld('termspace', api)

export type TermspaceApi = typeof api
