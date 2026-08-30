import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  MarkerType,
  type Viewport
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import TerminalNode, { type TermNode } from './nodes/TerminalNode'
import GroupNode, { type GroupNodeT } from './nodes/GroupNode'
import WorkerNode, { type WorkerNodeT } from './nodes/WorkerNode'
import ContextNode from './nodes/ContextNode'
import BrowserNode, { browserViews } from './nodes/BrowserNode'
import { CredentialNode } from './nodes/CredentialNode'
import {
  fromSaved,
  toSaved,
  newNodeId,
  DEFAULT_SIZE,
  reclaimBoardId,
  pruneEmptyBoards,
  orphanBoardsToRecover,
  type BoardNode,
  type SavedNode
} from './board-serde'

export type { BoardNode }
import { IdentityContext, TmuxContext, RequestDeleteContext } from './identity-context'
import { SettingsPanel, type SettingsSection } from './SettingsPanel'
import { shouldShowAccount } from './quota-visibility'
import { countUsing } from './quota-usage'
import { loadHudPrefs, saveHudPrefs, toggleIn, type HudPrefs } from './hud-prefs'
import { loadCanvasPrefs, saveCanvasPrefs, nextBg, BG_LABEL } from './canvas-prefs'
import { hasQuotaProgress, maskEmail, quotaUnavailableText } from './quota-display'
import { placeNewNode, viewportCenter } from './place-node'
import { CommandPalette } from './CommandPalette'
import type { PaletteNode } from './palette'
import { MessageCenter } from './MessageCenter'
import {
  IconTerminal,
  IconAgent,
  IconBrief,
  IconFit,
  IconKey,
  IconSettings,
  IconGroup,
  IconChevron,
  IconGlobe,
  IconHand,
  IconCursor,
  IconPlus,
  IconMinus
} from './Icons'
import { PROVIDERS } from '../../shared/provider-manifest'


/** 挂起中的工具审批（Claude PermissionRequest hook，主进程把那次 HTTP 请求挂着等决定） */
export interface PendingApproval {
  id: string
  nodeId: string
  toolName: string
  /** 已截断的展示用摘要 —— 完整输入只在主进程，安全判定不能用这个 */
  summary: string
  toolUseId: string
  createdAt: number
  sessionId: string
  cwd: string
  inputHash: string
  /** 规则引擎判定。只会是「转人工」或「建议拒绝」，永远没有「自动放行」 */
  verdict?: PolicyVerdict
}

/** 一次删除操作的可撤回记录 */
interface UndoEntry {
  label: string
  nodes: BoardNode[]
  edges: Edge[]
  /** nodeId → 销毁前抓到的屏幕内容（撤回时回灌，避免恢复出来是一片空白） */
  screens: Record<string, string>
  /**
   * 终端 id → 删除前绑的凭证。
   * **删凭证节点会连带把相关终端改回系统默认身份**，光恢复节点和线不够 ——
   * 橙线回来了、实际跑的还是默认账号，画布在说假话。
   */
  rebind: Record<string, string>
  at: number
}

const nodeTypes = {
  terminal: TerminalNode,
  group: GroupNode,
  worker: WorkerNode,
  context: ContextNode,
  browser: BrowserNode,
  credential: CredentialNode
}

const statusColor: Record<string, string> = {
  running: '#0A84FF',
  attention: '#FF9F0A',
  error: '#FF453A',
  idle: '#48484A',
  group: '#2C2C2E'
}

/**
 * 连线的四种语义。加新种类时**务必同步改三处**：edgeStyle、reportAgents 的 links 过滤
 * （授权图！漏了就是该放行的被拒）、以及加载时的迁移。
 */
type EdgeKind = 'context' | 'delegate' | 'credential' | 'drive'

/* 磁盘上的工作区格式（只存布局，不存运行时状态） */
interface SavedEdge {
  id: string
  source: string
  target: string
  kind: EdgeKind
}
/* 项目 = 一张画布 + 一个工作目录（新终端继承它） */
interface Project {
  id: string
  name: string
  cwd: string
}
interface SavedBoard {
  nodes: SavedNode[]
  edges?: SavedEdge[]
  viewport?: Viewport
  /** 这块画布属于哪个目录。**关掉标签页后靠它认领回原 pid**（见 reclaimBoardId）。
   *  项目记录本身会随关闭消失，所以这个信息只能存在 board 上。 */
  cwd?: string
}
interface Workspace extends SavedBoard {
  // v2
  projects?: Project[]
  activeProjectId?: string
  boards?: Record<string, SavedBoard>
}

const HOME_LABEL = '默认'

function shortPath(p: string): string {
  const home = p.match(/^\/Users\/[^/]+/)?.[0]
  return home ? p.replace(home, '~') : p
}

/* 连线语义：简报→终端 = 注入上下文；终端→终端 = 派活通道（M5-p3 接 MCP） */
/**
 * 连线的三种语义。**凭证边一度被标成 `context`** —— 类型上没人管，
 * 但"按 kind 找上下文源"的地方（`ctxLinks` → `tb context`）就会把凭证节点也算进去。
 * 连线是这个产品的协议本身，标错 kind = 协议本身说了假话。
 */
/**
 * 连线的三种语义。**凭证边一度被标成 `context`** —— 类型上没人管，
 * 但"按 kind 找上下文源"的地方（`ctxLinks` → `tb context`）就会把凭证节点也算进去。
 * 连线是这个产品的协议本身，标错 kind = 协议本身说了假话。
 *
 * 视觉语言分两类：
 * - **派活线有箭头**：终端→终端是有主从的，箭头指向"听命的那一方"。
 *   缩到全景时，一眼就能看出谁在指挥谁 —— 这正是画布相对 tab 的价值。
 * - **附着线没箭头**：上下文/凭证是"挂在这个终端上"的属性，不是一次动作，
 *   画箭头会让人误以为它也是某种调用方向。
 */
function edgeStyle(kind: EdgeKind): Partial<Edge> {
  if (kind === 'context') {
    return {
      animated: false,
      style: { stroke: '#BF5AF2', strokeWidth: 1.6, strokeDasharray: '5 4' },
      data: { kind }
    }
  }
  if (kind === 'credential') {
    // 身份线：实线、暖色，和上下文的紫色虚线区分开
    return {
      animated: false,
      style: { stroke: '#FF9F0A', strokeWidth: 1.8 },
      data: { kind }
    }
  }
  if (kind === 'drive') {
    /* 终端→浏览器：**有方向但不是主从**。agent 驱动一个工具，不是指挥另一个 agent。
       原来和派活线共用同一种蓝色箭头 —— 和「凭证边一度被标成 context」是同一类问题：
       连线是这个产品的协议本身，标错 kind = 协议说了假话。 */
    return {
      animated: false,
      style: { stroke: '#64D2FF', strokeWidth: 1.6 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#64D2FF', width: 14, height: 14 },
      data: { kind }
    }
  }
  return {
    animated: false,
    style: { stroke: '#0A84FF', strokeWidth: 1.8 },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#0A84FF', width: 16, height: 16 },
    data: { kind }
  }
}

/* 成组自动排列参数 */
const GROUP_GAP = 16
const GROUP_PAD = 20
const GROUP_HEAD = 48

/* ── 额度 HUD ──────────────────────────────────────────
   归属单位是**账号**，不是 provider（见 docs/QUOTA.md）。
   同时挂两个 codex 订阅时那就是两行，绝不能混成一个数。 */

/** 超过这个岁数就明确标出来，别让用户拿旧数做决定 */
const STALE_SEC = 5 * 60

function ago(capturedAt: number): string {
  const sec = Math.max(0, Math.round(Date.now() / 1000 - capturedAt))
  const min = Math.round(sec / 60)
  return min >= 60 ? `${Math.floor(min / 60)} 小时前` : `${min} 分钟前`
}

function zoneClass(pct: number): string {
  // 对齐太极三区：🟢<60 🟡60-78 🔴>78
  return pct > 78 ? 'red' : pct > 60 ? 'yellow' : 'green'
}

function resetIn(resetsAt: number): string {
  const min = Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60_000))
  return min >= 60 ? `${Math.floor(min / 60)}h${min % 60}m` : `${min}m`
}

function QuotaRow({ w }: { w: QuotaWindow }): React.JSX.Element {
  const pct = Math.round(w.usedPercent)
  const label = w.scopeModel ? `${w.label}·${w.scopeModel}` : w.label
  return (
    <div
      className="quota-row"
      title={`${label} 已用 ${w.usedPercent}%${w.resetsAt ? `，${resetIn(w.resetsAt)} 后重置` : ''}`}
    >
      <span className="quota-label">{label}</span>
      {w.unlimited ? (
        <span className="quota-unlimited">无限</span>
      ) : (
        <>
          <span className="quota-bar">
            <span
              className={`quota-fill ${w.severity === 'critical' ? 'red' : w.severity === 'warning' ? 'yellow' : zoneClass(pct)}`}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </span>
          <span className="quota-pct">{pct}%</span>
        </>
      )}
      <span className="quota-reset">{w.resetsAt ? resetIn(w.resetsAt) : ''}</span>
    </div>
  )
}

/** state 不是 ok 时 UI 上该说什么。「查不到」和「用了 0%」必须是两种东西 */
/* 三种「没数」必须用不同的话说清，别共用一句含混的"暂无数据"：
   未登录能自己修（去跑一次 login），查不到只能等，字段不认识是上游变了。
   混成一句的话，用户会对着一个能修的问题干等。 */
const money = (minor: number, cur: string): string => `${(minor / 100).toFixed(2)} ${cur}`

/**
 * 花钱那一行的文案。
 * 「已花」和「余额」是两个方向相反的数，**绝不能都渲染成同一个位置的裸数字** ——
 * codex 的 credits 是余额，曾被当成上限配上假的 used=0，界面上写着「0 / 766」。
 */
function spendText(sp: QuotaSpend): string {
  if (sp.enabled === false) return '未开启'
  if (typeof sp.remainingMinor === 'number') return `剩 ${money(sp.remainingMinor, sp.currency)}`
  if (typeof sp.usedMinor === 'number') {
    const limit = sp.limitMinor ? ` / ${(sp.limitMinor / 100).toFixed(0)}` : ''
    return `${(sp.usedMinor / 100).toFixed(2)}${limit} ${sp.currency}`
  }
  return '∞'
}

/**
 * 一个账号一块。
 * `usingCount` 是「画布上有几个终端在用这个号」—— 它把"终端里用的"和"账号"连起来；
 * 0 个却仍在消耗，就说明画布之外也在用这个号（这正是最容易让人困惑的情形）。
 */
function AccountBlock({
  a,
  usingCount,
  expanded,
  onToggle
}: {
  a: AccountQuota
  usingCount: number
  /** 精简态只留"看一眼就想知道的"：徽标 / 名字 / 套餐 / 几个终端 / 进度条。
      邮箱、登录态文案、花费明细都是**查证信息**，点开才给 —— 用户明确要求的 */
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element | null {
  // 判据只有一份，见 quota-visibility.ts（这里和外层 filter 曾经各写一份）
  if (!shouldShowAccount({ accountId: a.accountId, usingCount })) return null
  const stale =
    a.state === 'stale' || (a.state === 'ok' && Date.now() / 1000 - a.capturedAt > STALE_SEC)
  // 只有真拿到数了才画进度条。查不到/未登录画一根空槽 = 看着就像"用了 0%"
  const hasData = hasQuotaProgress(a)
  return (
    <div className={`quota-account${stale ? ' stale' : ''}`} title={`${a.source}｜${a.hint ?? ''}`}>
      {/* 用原生 button 而不是 `div role="button"`：键盘、焦点环、
          屏幕阅读器的"可点"语义全都白送，还省掉手写的 onKeyDown */}
      <button
        type="button"
        className="quota-account-head clickable"
        aria-expanded={expanded}
        title={expanded ? '收起账号详情' : '展开账号详情（邮箱 / 登录态 / 花费）'}
        onClick={onToggle}
      >
        <span className={`identity-provider ${a.provider}`}>{a.provider}</span>
        <span className="quota-account-name">{a.name}</span>
        {a.plan && <span className="quota-plan">{a.plan}</span>}
        {/* **说"终端"不说"节点"**：用户会把"1 节点"读成"1 个凭证/1 把 key"，
            而它的意思是"画布上有几个终端在用这个账号"。实测被误解过一次。 */}
        <span
          className={`quota-using${usingCount ? ' on' : ''}`}
          title={
            usingCount
              ? `画布上有 ${usingCount} 个终端正在用这个账号`
              : '画布上暂时没有终端在用这个账号'
          }
        >
          {usingCount} 个终端
        </span>
      </button>
      {/* 邮箱是区分两个同 provider 订阅号的唯一可靠标识 —— planType 都叫 'pro'。
          但那是**要查的时候才需要**，日常占两行不值，所以收进展开态。 */}
      {expanded && a.email && <div className="quota-email">{maskEmail(a.email)}</div>}
      {/* handle 是 GitHub login 这类**非邮箱**标识，不脱敏 ——
          maskEmail 会把不含 `@` 的串整个打成 `***`，而这一行的全部理由
          就是让用户分得出是哪个号 */}
      {expanded && !a.email && a.handle && <div className="quota-email">{a.handle}</div>}
      {expanded && <div className="quota-account-note">{a.presence.detail}</div>}
      {hasData ? (
        <div className="quota-provider-rows">
          {a.windows.map((w) => (
            <QuotaRow key={w.id} w={w} />
          ))}
        </div>
      ) : (
        <div className="quota-account-note">{quotaUnavailableText(a)}</div>
      )}
      {/* 花钱侧不画进度条，只给金额 —— 和上面的百分比混在一起必然被读成一回事。
          enabled:false 要显式说「未开启」，藏起来等于告诉用户"没这回事" */}
      {expanded &&
        a.spend?.map((sp) => (
        <div key={sp.label} className="quota-row">
          <span className="quota-label">{sp.label}</span>
          <span className="quota-money">{spendText(sp)}</span>
        </div>
      ))}
      {/* **stale 永远显示** —— "这个数不新鲜"精简了也必须知道，
          否则用户会照着一个几小时前的百分比做决定。hint 是解释，收进展开态。 */}
      {(stale || (expanded && a.hint)) && (
        <div className="quota-account-note">
          {stale ? `⚠ ${ago(a.capturedAt)}的数` : ''}
          {stale && expanded && a.hint ? ' · ' : ''}
          {expanded ? (a.hint ?? '') : ''}
        </div>
      )}
    </div>
  )
}

/* ── HUD：额度 + 画布概览（M4，用户想法 #1）── */
interface NodeCtx {
  pct: number
  model: string
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '').slice(0, 16)
}

function BoardHUD({
  nodes,
  ctxMap,
  liveAgents,
  onFocus
}: {
  nodes: BoardNode[]
  ctxMap: Record<string, NodeCtx>
  /** 节点 id → 此刻真的在里面跑着的 agent（由 hook 事件得出，见 onAgentStatus） */
  liveAgents: Record<string, string>
  onFocus: (id: string) => void
}): React.JSX.Element | null {
  const [quota, setQuota] = useState<AccountQuota[]>([])
  const [processAgents, setProcessAgents] = useState<Record<string, string>>({})
  const [collapsed, setCollapsed] = useState(false)
  const [prefs, setPrefs] = useState<HudPrefs>(() => loadHudPrefs())
  const updatePrefs = (next: HudPrefs): void => {
    setPrefs(next)
    saveHudPrefs(next)
  }
  const scanGeneration = useRef(0)
  useEffect(() => window.termspace.onQuota(setQuota), [])

  const terms = nodes.filter((n): n is TermNode => n.type === 'terminal')
  const termIds = terms.map((n) => n.id).toSorted().join('\n')
  const scan = useCallback((): void => {
    if (document.hidden) return
    const generation = ++scanGeneration.current
    void window.termspace.scanQuotaUsage(termIds ? termIds.split('\n') : []).then((result) => {
      if (scanGeneration.current === generation) setProcessAgents(result)
    })
  }, [termIds])
  /* 进程树扫描：每轮两次 `ps`（先只取 PID 图、再只对本 pane 的子孙取 argv）。
     **窗口不可见时必须跳过** —— 这个 app 是开一整天的，后台每 4 秒唤醒两个进程
     纯属白烧电，而"用户手敲了 codex"这件事在他看不见界面时也没人要看。
     间隔也从 4s 放到 10s：这是"补上 hook 报不到的那部分"的兜底信号，
     不是需要秒级响应的东西（真 agent 会话有 hook，那条路是事件驱动的）。 */
  useEffect(() => {
    scan()
    const timer = window.setInterval(scan, 10_000)
    // 切回前台立刻补一轮，否则最长要等 10 秒界面才追上
    document.addEventListener('visibilitychange', scan)
    return () => {
      scanGeneration.current++
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', scan)
    }
  }, [scan])
  const observedAgents = { ...processAgents, ...liveAgents }
  const running = terms.filter((n) => n.data.status === 'running').length
  const attention = terms.filter((n) => n.data.status === 'attention').length
  /* "agent 节点" = **观测到在跑 agent** / 有 provider / 有 context 数据 / 非空闲，最多列 6 行。
     `observedAgents` 必须参与判定，否则会和上面那排账号卡自相矛盾 ——
     实测拍到过：账号卡写着「4 个终端」在用 codex（那个数用了进程探测），
     下面「画布」却只列出 1 个 Codex，因为手敲 `codex` 的三个节点
     `provider` 是空、状态又是 idle，被这一行滤掉了。同一份观测，一处用一处不用。 */
  const agentRows = terms
    .filter((n) => observedAgents[n.id] || n.data.provider || ctxMap[n.id] || n.data.status !== 'idle')
    .toSorted((a, b) => {
      const rank = (s: string): number => (s === 'attention' ? 0 : s === 'running' ? 1 : 2)
      return rank(a.data.status) - rank(b.data.status)
    })
  const shown = agentRows.slice(0, 6)

  /* 每个账号有几个终端在用它。没绑凭证的节点算在「系统默认」头上 ——
     这一列就是把"终端里用的"和"账号"连起来的那根线。 */
  /* `provider` 缺失 = **这不是个 agent 终端**（普通 zsh），不能默认成 claude ——
     那样只要画布上有一个普通 shell，`system:claude` 的 usingCount 就 >0，
     "没人在用就不显示"这条判据对 Claude 恰好永远不成立。
     实测就是这个现象：还没在画布上登录 codex，右上角却已经有额度卡。 */
  /* 判据抽到 quota-usage.ts —— 它有三个来源（凭证连线 / hook 报的实跑 agent /
     建节点时的 provider），顺序错了就会把正在烧的账号藏起来。见那边的文件头。 */
  const usingCount = (a: AccountQuota): number =>
    countUsing(
      terms.map((n) => ({ id: n.id, identityId: n.data.identityId, provider: n.data.provider })),
      a.accountId,
      observedAgents
    )

  // 和 AccountBlock 共用同一个判据（quota-visibility.ts），不再各写一份
  const accounts = quota.filter((a) =>
    shouldShowAccount({ accountId: a.accountId, usingCount: usingCount(a) })
  )
  if (accounts.length === 0 && agentRows.length === 0) return null

  /* 折叠态摘要。**不能无脑取 windows 的最大值** ——
     只有花钱账号（API key）或全都查不到时，那个 Math.max 会得出 0，
     折叠条上就写着一个自信的「0%」，而真相是"根本没数据"。 */
  const withData = accounts.filter((a) => (a.state === 'ok' || a.state === 'stale') && a.windows.length)
  const broken = accounts.filter((a) => a.state === 'unavailable' || a.state === 'unknown-shape').length
  const peak = withData.length
    ? Math.max(...withData.flatMap((a) => a.windows.map((w) => Math.round(w.usedPercent))))
    : null
  const summary =
    peak !== null
      ? `${withData.every((a) => a.state === 'stale') ? '~' : ''}${peak}%`
      : broken
        ? `${broken} 个查不到`
        : ''

  return (
    <div className={`quota-hud${collapsed ? ' collapsed' : ''}`}>
      <button
        className="hud-toggle"
        onClick={() =>
          setCollapsed((c) => {
            if (c) void window.termspace.rescanAccounts()
            return !c
          })
        }
      >
        <span className="hud-toggle-label">
          {collapsed
            ? `${summary}${
                attention > 0 ? `${summary ? ' · ' : ''}${attention} 需要你` : running > 0 ? `${summary ? ' · ' : ''}${running} 运行` : ''
              }` || '概览'
            : '用量'}
        </span>
        <span className="hud-caret">{collapsed ? '▾' : '▴'}</span>
      </button>
      {!collapsed && (
        <>
          {accounts.length > 0 && (
            <>
              {/* 写清楚这是**账号级**的量：一个号可能同时被画布外的终端/IDE 用着，
                  所以「0 节点」不代表它不会涨 —— 这正是最容易让人困惑的地方 */}
              <span className="quota-title" title="按账号统计；查不到、未登录和 0% 是三种不同状态">
                账号与用量
                <button
                  className="quota-rescan"
                  title="重新扫描本机账号与终端进程"
                  onClick={() => {
                    void window.termspace.rescanAccounts()
                    scan()
                  }}
                >
                  ↻
                </button>
              </span>
              {accounts.map((a) => (
                <AccountBlock
                  key={a.accountId}
                  a={a}
                  usingCount={usingCount(a)}
                  expanded={prefs.accounts.includes(a.accountId)}
                  onToggle={() =>
                    updatePrefs({ ...prefs, accounts: toggleIn(prefs.accounts, a.accountId) })
                  }
                />
              ))}
            </>
          )}
          {agentRows.length > 0 && (
        <>
          <div className="hud-divider" />
          {/* 折叠时**计数和"需要你"仍然留在标题里** —— 这一段的全部价值就是
              "有没有 agent 在等我"，藏成一个光秃秃的 ▾ 等于把功能一起折掉了 */}
          <button
            type="button"
            className="quota-title as-toggle"
            aria-expanded={prefs.board}
            title={prefs.board ? '收起画布终端列表' : '展开画布终端列表'}
            onClick={() => updatePrefs({ ...prefs, board: !prefs.board })}
          >
            <span>
              画布 · {terms.length} 终端
              {running > 0 && ` · ${running} 运行`}
              {attention > 0 && ` · ${attention} 需要你`}
            </span>
            <span className="hud-caret">{prefs.board ? '▴' : '▾'}</span>
          </button>
          {prefs.board &&
            shown.map((n) => {
            const ctx = ctxMap[n.id]
            return (
              <button
                key={n.id}
                className="hud-node-row"
                title="点击聚焦节点"
                onClick={() => onFocus(n.id)}
              >
                <span className={`status-dot ${n.data.status}`} />
                <span className="hud-node-title">{n.data.title}</span>
                {/* 观测到在跑、但节点本身没定 provider（用户在普通 zsh 里手敲的）——
                    不标一下的话这行就是光秃秃一个 "zsh · t-11fpce"，
                    用户看不出它为什么被列进来 */}
                {!n.data.provider && observedAgents[n.id] && (
                  <span className="hud-node-model">{observedAgents[n.id]}</span>
                )}
                {ctx && (
                  <>
                    <span className="hud-node-model">{shortModel(ctx.model)}</span>
                    <span className={`ctx-meter ${ctx.pct > 80 ? 'hot' : ctx.pct > 60 ? 'warm' : ''}`}>
                      <span className="ctx-fill" style={{ width: `${ctx.pct}%` }} />
                    </span>
                    <span className="hud-node-pct">{ctx.pct}%</span>
                  </>
                )}
              </button>
            )
          })}
          {prefs.board && agentRows.length > shown.length && (
            <span className="hud-more">还有 {agentRows.length - shown.length} 个…</span>
          )}
        </>
      )}
        </>
      )}
    </div>
  )
}

/* ── Identity 管理面板 ── */
function IdentityPanel({
  identities,
  onChanged,
  usageOf,
  onDeleted,
  onOpenIdentity,
  onOpenSystem
}: {
  identities: IdentityMeta[]
  onChanged: (list: IdentityMeta[]) => void
  /** 这个凭证被谁在用 —— 删之前要让用户看到代价 */
  usageOf: (id: string) => { terminals: number; nodes: number; presets: number }
  /** 删库**之前**先撤销画布上的引用（关会话、清 identityId、删凭证节点和线） */
  onDeleted: (id: string) => Promise<void>
  /** 新建隔离账号后，只开绑定好的普通 shell；绝不自动执行 login。 */
  onOpenIdentity: (id: string, provider: IdentityMeta['provider'], name: string) => void
  onOpenSystem: (provider: IdentityMeta['provider'], name: string) => void
}): React.JSX.Element {
  type Mode = 'closed' | 'menu' | 'system' | 'subscription' | 'api' | 'advanced'
  type EditAction = 'set' | 'unset' | 'retain' | 'replace' | 'delete'
  type Row = { key: string; action: EditAction; value: string }
  const [mode, setMode] = useState<Mode>('closed')
  const [name, setName] = useState('')
  const [provider, setProvider] = useState<IdentityMeta['provider']>('codex')
  const [rows, setRows] = useState<Row[]>([{ key: '', action: 'set', value: '' }])
  const [editingId, setEditingId] = useState<string>()
  const [presentVars, setPresentVars] = useState<string[]>([])
  const [error, setError] = useState('')
  /* 凭证库读不出来时（换机器 / 钥匙串变更 / 磁盘半坏），列表会是空的而库还在。
     不显示这条的话界面说的是「还没有凭证」—— **那是假话**，且用户新建一个
     会发现保存被拒，两条信息完全对不上。 */
  const [storeError, setStoreError] = useState<string | null>(null)
  useEffect(() => {
    void window.termspace.identityStoreHealth().then(setStoreError)
  }, [identities])

  const selectedSpec = PROVIDERS.find((p) => p.id === provider)

  useEffect(() => {
    const keys = selectedSpec?.conflictVariables ?? []
    void window.termspace.identityEnvPresence(keys).then(setPresentVars)
  }, [provider, selectedSpec])

  const resetForm = (): void => {
    setName('')
    setRows([{ key: '', action: 'set', value: '' }])
    setEditingId(undefined)
    setError('')
    setMode('closed')
  }

  const saveRows = async (): Promise<void> => {
    const envOps = rows
      .filter((r) => r.key.trim())
      .map((r) =>
        r.action === 'set' || r.action === 'replace'
          ? { key: r.key.trim(), action: r.action, value: r.value }
          : { key: r.key.trim(), action: r.action }
      )
    if (!name.trim() || envOps.length === 0) {
      setError('请填写名称和至少一项环境操作')
      return
    }
    if (envOps.some((op) => (op.action === 'set' || op.action === 'replace') && !('value' in op && op.value))) {
      setError('“设置新值/替换”必须填写值')
      return
    }
    try {
      onChanged(await window.termspace.upsertIdentity({ id: editingId, name, provider, envOps }))
      resetForm()
    } catch (e) {
      setError((e as Error).message || '保存失败')
    }
  }

  const saveApiKey = async (): Promise<void> => {
    if (!selectedSpec) return
    const envOps = selectedSpec.fields
      .map((field) => {
        const row = rows.find((r) => r.key === field.envKey)
        return row?.value ? { key: field.envKey, action: 'set' as const, value: row.value } : null
      })
      .filter((x): x is { key: string; action: 'set'; value: string } => !!x)
    if (!name.trim() || !envOps.some((op) => selectedSpec.fields.find((f) => f.envKey === op.key)?.secret)) {
      setError('请填写名称和 API key')
      return
    }
    try {
      onChanged(await window.termspace.upsertIdentity({ name, provider, envOps }))
      resetForm()
    } catch (e) {
      setError((e as Error).message || '保存失败')
    }
  }

  const createSubscription = async (): Promise<void> => {
    try {
      const result = await window.termspace.createSubscriptionIdentity({ provider, name })
      onChanged(result.list)
      const created = result.list.find((i) => i.id === result.id)
      onOpenIdentity(result.id, provider, created?.name ?? (name || provider))
      resetForm()
    } catch (e) {
      setError((e as Error).message || '创建失败')
    }
  }

  return (
    <div className="settings-section">
        <h3 className="settings-h">凭证管理</h3>
        <div className="identity-list">
          {storeError ? (
            <div className="identity-warning">
              ⚠ 凭证库读不出来（{storeError}），已进入只读保护。库还在、没有被覆盖 ——
              换过机器或钥匙串变更时会这样。修好之前保存会被拒绝。
            </div>
          ) : (
            identities.length === 0 && <div className="identity-empty">还没有凭证</div>
          )}
          {identities.map((i) => (
            <div key={i.id} className="identity-row">
              <span className={`identity-provider ${i.provider}`}>{i.provider}</span>
              {/* 就地改名。以前只能删了重建 —— 而 env 值渲染层只拿得到 key/action，
                  重建就得把所有密钥重新输一遍，等于根本不能改名。 */}
              <input
                className="identity-name-edit"
                defaultValue={i.name}
                title="改个名字，回车或点别处保存"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
                onBlur={async (e) => {
                  const v = e.currentTarget.value.trim()
                  if (!v || v === i.name) {
                    e.currentTarget.value = i.name
                    return
                  }
                  onChanged(await window.termspace.renameIdentity(i.id, v))
                }}
              />
              <span className="identity-keys">
                {i.envOps.map((op) => `${op.key}：${op.action === 'unset' ? '移除' : '已设置'}`).join(' · ')}
              </span>
              <button
                className="identity-del"
                onClick={() => {
                  setEditingId(i.id)
                  setName(i.name)
                  setProvider(i.provider)
                  setRows(i.envOps.map((op) => ({ key: op.key, action: 'retain', value: '' })))
                  setMode('advanced')
                }}
              >
                编辑
              </button>
              <button
                className="identity-del"
                onClick={async () => {
                  /* 删凭证前必须查引用。原来是**无确认、无检查**直接删 ——
                     正在用它的终端会继续持有旧 secret 跑到天荒地老，
                     画布上的凭证节点变成指向虚空，preset 也留着悬空引用。 */
                  const u = usageOf(i.id)
                  const parts = [
                    u.terminals ? `${u.terminals} 个终端正在用它` : '',
                    u.nodes ? `${u.nodes} 个凭证节点指向它` : '',
                    u.presets ? `${u.presets} 个预设引用它` : ''
                  ].filter(Boolean)
                  const detail = parts.length
                    ? `\n\n${parts.join('、')}。这些终端会被关掉会话、改用系统默认身份重开。`
                    : ''
                  if (!window.confirm(`删除凭证「${i.name}」？${detail}\n\n这个操作不能撤回。`)) return
                  await onDeleted(i.id) // 先撤销引用，再删库
                  onChanged(await window.termspace.deleteIdentity(i.id))
                }}
              >
                删除
              </button>
            </div>
          ))}
        </div>
        <div className="identity-form">
          {mode === 'closed' && (
            <button className="toolbar-btn identity-add-main" onClick={() => setMode('menu')}>
              添加账号或密钥
            </button>
          )}
          {mode === 'menu' ? (
            <>
              <div className="identity-choice-title">你想做什么？</div>
              <button className="identity-choice" onClick={() => {
                setProvider('codex')
                setMode('system')
              }}>
                使用这台机器已登录的账号 <b>推荐</b>
              </button>
              <button className="identity-choice" onClick={() => {
                setProvider('codex')
                setMode('subscription')
              }}>
                登录另一个订阅账号
              </button>
              <button className="identity-choice" onClick={() => {
                setProvider('codex')
                setRows([{ key: 'OPENAI_API_KEY', action: 'set', value: '' }])
                setMode('api')
              }}>
                添加 API key
              </button>
              <button className="identity-choice" onClick={() => {
                setProvider('custom')
                setMode('advanced')
              }}>
                高级：自定义环境变量
              </button>
            </>
          ) : mode !== 'closed' ? (
            <button className="identity-back" onClick={resetForm}>← 返回四种添加方式</button>
          ) : null}

          {mode === 'system' && (
            <>
              <div className="identity-form-row">
                <select value={provider} onChange={(e) => setProvider(e.currentTarget.value as IdentityMeta['provider'])}>
                  {PROVIDERS.filter((p) => p.authModes.includes('system')).map((p) => (
                    <option key={p.id} value={p.id}>{p.displayName}</option>
                  ))}
                </select>
              </div>
              <p className="settings-note">
                Termspace 使用自动发现到的系统登录状态，不读取或复制登录令牌。
                Copilot、Cursor 和 Antigravity 的系统登录只能共享。
              </p>
              <button className="toolbar-btn" onClick={() => {
                const spec = PROVIDERS.find((p) => p.id === provider)
                onOpenSystem(provider, `${spec?.displayName ?? provider} · 系统账号`)
                resetForm()
              }}>用新终端打开</button>
            </>
          )}

          {mode === 'subscription' && (
            <>
              <div className="identity-form-row">
                <select value={provider} onChange={(e) => setProvider(e.currentTarget.value as IdentityMeta['provider'])}>
                  {PROVIDERS.filter((p) => p.authModes.includes('isolated-subscription')).map((p) => (
                    <option key={p.id} value={p.id}>{p.displayName}</option>
                  ))}
                </select>
                <input placeholder="给账号起个名字（可选）" value={name} onChange={(e) => setName(e.currentTarget.value)} />
              </div>
              <div className="identity-safe-copy">✓ 使用独立登录空间（目录由 Termspace 自动生成）</div>
              <div className="identity-safe-copy">✓ 防止意外按 API 计费 —— 此账号会移除终端继承的 {selectedSpec?.conflictVariables.join('、')}</div>
              {presentVars.length > 0 && <div className="identity-warning">⚠ 检测到父环境含 {presentVars.join('、')}。这里只显示存在性，不读取值。</div>}
              {/* **必须写出具体命令**。只说"运行该 CLI 的 login"等于把认知成本
                  全留给用户，而各家形状根本不一样、猜不到：
                  claude 的登录是进 TUI 之后的斜杠命令、不是 shell 命令；
                  gemini / antigravity 压根没有 login 子命令。
                  这是 codex 自己在交付报告里点出的缺口。 */}
              <p className="settings-note">
                会创建并打开一个绑定此账号的新终端。Termspace <b>不会</b>自动执行登录 —— 在那个终端里敲：
              </p>
              <div className="identity-login-cmd">{selectedSpec?.loginHint}</div>
              <button className="toolbar-btn" onClick={() => void createSubscription()}>创建并打开登录终端</button>
            </>
          )}

          {mode === 'api' && (
            <>
              <div className="identity-form-row">
                <select value={provider} onChange={(e) => {
                  const next = e.currentTarget.value as IdentityMeta['provider']
                  setProvider(next)
                  const spec = PROVIDERS.find((p) => p.id === next)
                  setRows((spec?.fields ?? []).map((f) => ({ key: f.envKey, action: 'set', value: f.default ?? '' })))
                }}>
                  {PROVIDERS.filter((p) => p.authModes.includes('api-key')).map((p) => (
                    <option key={p.id} value={p.id}>{p.displayName}</option>
                  ))}
                  <option value="custom">自定义服务</option>
                </select>
                <input placeholder="名称" value={name} onChange={(e) => setName(e.currentTarget.value)} />
              </div>
              {(selectedSpec?.fields ?? []).map((field) => (
                <input
                  key={field.envKey}
                  type={field.secret ? 'password' : 'text'}
                  placeholder={field.label}
                  value={rows.find((r) => r.key === field.envKey)?.value ?? ''}
                  onChange={(e) => setRows((old) => [
                    ...old.filter((r) => r.key !== field.envKey),
                    { key: field.envKey, action: 'set', value: e.currentTarget.value }
                  ])}
                />
              ))}
              {provider === 'custom' && <button className="toolbar-btn" onClick={() => setMode('advanced')}>填写自定义服务变量</button>}
              <div className="identity-danger-copy">这把 key 会注入整个终端会话，其中运行的命令和 agent 都能读取它。</div>
              <button className="toolbar-btn" disabled={provider === 'custom'} onClick={() => void saveApiKey()}>保存 API key</button>
            </>
          )}

          {mode === 'advanced' && (
            <>
              <div className="identity-form-row">
                <input placeholder="名称" value={name} onChange={(e) => setName(e.currentTarget.value)} />
                <select value={provider} onChange={(e) => setProvider(e.currentTarget.value as IdentityMeta['provider'])}>
                  {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                  <option value="custom">自定义服务</option>
                </select>
              </div>
              {rows.map((row, index) => (
                <div className="identity-op-row" key={`${index}-${row.key}`}>
                  <input placeholder="变量名，例如 MY_API_KEY" value={row.key} disabled={!!editingId} onChange={(e) => setRows((old) => old.map((r, n) => n === index ? { ...r, key: e.currentTarget.value } : r))} />
                  <select value={row.action} onChange={(e) => setRows((old) => old.map((r, n) => n === index ? { ...r, action: e.currentTarget.value as EditAction, value: '' } : r))}>
                    {editingId ? (
                      <>
                        <option value="retain">保留原值</option>
                        <option value="replace">替换</option>
                        <option value="delete">删除这项</option>
                      </>
                    ) : (
                      <>
                        <option value="set">设置</option>
                        <option value="unset">从终端移除</option>
                      </>
                    )}
                  </select>
                  {(row.action === 'set' || row.action === 'replace') && <input type="password" placeholder="新值" value={row.value} onChange={(e) => setRows((old) => old.map((r, n) => n === index ? { ...r, value: e.currentTarget.value } : r))} />}
                </div>
              ))}
              {!editingId && <button className="identity-back" onClick={() => setRows((r) => [...r, { key: '', action: 'set', value: '' }])}>＋ 添加变量</button>}
              <div className="identity-danger-copy">这些值会注入整个终端会话，其中运行的命令和 agent 都能读取它们。危险的启动注入变量会被主进程拒绝。</div>
              <button className="toolbar-btn" onClick={() => void saveRows()}>{editingId ? '保存修改' : '保存自定义凭证'}</button>
            </>
          )}
          {error && <div className="identity-error">{error}</div>}
        </div>
    </div>
  )
}

/* ── Agent 预设面板（F6）── */
function PresetPanel({
  presets,
  identities,
  onChanged
}: {
  presets: Preset[]
  identities: IdentityMeta[]
  onChanged: (list: Preset[]) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [provider, setProvider] = useState<Preset['provider']>('claude')
  const [command, setCommand] = useState('')
  const [identityId, setIdentityId] = useState('')
  const [error, setError] = useState('')

  const save = async (): Promise<void> => {
    if (!name.trim()) {
      setError('名称必填')
      return
    }
    onChanged(
      await window.termspace.upsertPreset({
        name,
        provider,
        command,
        identityId: identityId || undefined
      })
    )
    setName('')
    setCommand('')
    setIdentityId('')
    setError('')
  }

  const identityName = (id?: string): string =>
    identities.find((i) => i.id === id)?.name ?? ''

  return (
    <div className="settings-section">
        <h3 className="settings-h">Agent 节点预设</h3>
        <p className="settings-note">
          预设 = 启动命令 + 身份。工具栏「Agent」按预设一键起节点，终端落在当前项目目录。
        </p>
        <div className="identity-list">
          {presets.map((p) => (
            <div key={p.id} className="identity-row">
              <span className={`identity-provider ${p.provider}`}>{p.provider}</span>
              <span className="identity-name">{p.name}</span>
              <span className="identity-keys">
                {p.command || '(纯终端)'}
                {p.identityId ? ` @ ${identityName(p.identityId)}` : ''}
              </span>
              <button
                className="identity-del"
                onClick={async () => onChanged(await window.termspace.deletePreset(p.id))}
              >
                删除
              </button>
            </div>
          ))}
        </div>
        <div className="identity-form">
          <div className="identity-form-row">
            <input
              placeholder="名称（如 Claude 主脑）"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <select
              value={provider}
              onChange={(e) => setProvider(e.currentTarget.value as Preset['provider'])}
            >
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="gemini">gemini</option>
              <option value="custom">custom</option>
            </select>
          </div>
          <div className="identity-form-row">
            <input
              placeholder="启动命令（如 claude --model opus）"
              value={command}
              onChange={(e) => setCommand(e.currentTarget.value)}
            />
            <select value={identityId} onChange={(e) => setIdentityId(e.currentTarget.value)}>
              <option value="">默认身份</option>
              {identities.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </div>
          {error && <div className="identity-error">{error}</div>}
          <button className="toolbar-btn" onClick={() => void save()}>
            保存预设
          </button>
        </div>
    </div>
  )
}

function seedNodes(): BoardNode[] {
  return [
    {
      id: 't1',
      type: 'terminal',
      position: { x: 80, y: 120 },
      ...DEFAULT_SIZE,
      data: { title: 'zsh · main', status: 'idle' }
    }
  ]
}

/** 当前画布里取一个新 id（见 board-serde.ts 的 newNodeId：不可复用是它存在的理由） */
function nextId(nodes: BoardNode[], prefix: string): string {
  return newNodeId(prefix, nodes.map((n) => n.id))
}

function Board(): React.JSX.Element {
  const [nodes, setNodes] = useState<BoardNode[]>([])
  /** 最新 nodes 的同步镜像：给那些不该因 nodes 变化而重建的 callback 用 */
  const nodesRef = useRef<BoardNode[]>([])
  nodesRef.current = nodes
  const edgesRef = useRef<Edge[]>([])
  /* 撤回栈。删终端会真杀 tmux 会话 —— 进程救不回来，但布局、配置、连线和
     最后一屏内容可以，够把"手滑删掉"从灾难降级成麻烦。 */
  const undoRef = useRef<UndoEntry[]>([])
  const [undoHint, setUndoHint] = useState<UndoEntry | null>(null)
  const hintTimer = useRef(0)
  const [edges, setEdges] = useState<Edge[]>([])
  edgesRef.current = edges
  const [loaded, setLoaded] = useState(false)
  const [saveTick, setSaveTick] = useState(0)
  // 落盘失败必须让用户看见：静默失败 = 用户以为存好了，关掉就没了
  const [saveErr, setSaveErr] = useState<string | null>(null)
  // 一次性提示（审批失效等）
  const [notice, setNotice] = useState<string | null>(null)
  /** 挂起中的工具审批（来自 Claude PermissionRequest hook，主进程把请求挂着） */
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  /* 节点 id → 此刻真的跑在里面的 agent。**只从 hook 事件得出**：
     前台进程名不可用（实测 claude 报版本号 `2.1.220`、codex 报 `Python`、gemini 报 `node`）。
     额度面板靠它认出"用户手敲起来的 agent"，见 BoardHUD 的 usingCount。 */
  const [liveAgents, setLiveAgents] = useState<Record<string, string>>({})
  /* `?palette=1` 让自检截图能拍到这块面板 —— 否则 Cmd+K 是唯一一处
     没有任何回归证据的 UI（键盘事件在截图模式下没法模拟）。 */
  const [paletteOpen, setPaletteOpen] = useState(
    new URLSearchParams(location.search).get('palette') === '1'
  )
  useEffect(() => window.termspace.onApprovals(setApprovals), [])
  const [identities, setIdentities] = useState<IdentityMeta[]>([])
  const [presets, setPresets] = useState<Preset[]>([])
  const [defaultIdentity, setDefaultIdentity] = useState('')
  const [defaultFontSize, setDefaultFontSize] = useState(13)
  /** tmux 可用与否决定集群能不能折叠（无 tmux 时隐藏子节点 = 杀进程） */
  const [tmuxOk, setTmuxOk] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(
    // 自检截图模式下直接展开设置面板
    new URLSearchParams(location.search).get('panel') as SettingsSection | null
  )
  const [showAgentMenu, setShowAgentMenu] = useState(false)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    nodeId?: string
    selection?: boolean
    edgeId?: string
  } | null>(null)
  const [mapActive, setMapActive] = useState(false)
  // 控件栈里的百分比要跟着画布走 —— 订阅 transform 而不是每帧 getViewport()
  const [canvasPrefs, setCanvasPrefs] = useState(loadCanvasPrefs)
  const patchCanvasPrefs = useCallback((patch: Partial<typeof canvasPrefs>): void => {
    setCanvasPrefs((prev) => {
      const next = { ...prev, ...patch }
      saveCanvasPrefs(next)
      return next
    })
  }, [])

  const zoomPct = useStore((st) => st.transform[2])
  const [canvasMode, setCanvasMode] = useState<'pan' | 'select'>('pan')
  const mapTimer = useRef(0)
  const [ctxMap, setCtxMap] = useState<Record<string, NodeCtx>>({})
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProject, setActiveProject] = useState('')
  // 非活跃项目的画布（终端不销毁 pty，tmux 会话续存，切回来自动 attach）
  /* ⌘1…9 要在 keydown handler 里读最新的项目列表，而 handler 只挂一次 ——
     直接闭包捕获 projects 会一直读到挂载那一刻的旧值。 */
  const projectsRef = useRef<Project[]>([])
  projectsRef.current = projects

  /**
   * 当前选中的节点 id，**连同组内子节点**。
   *
   * 单独抽出来是因为 ⌫ 和 ⌘W 用的是同一套判定，各写一遍必然分叉。
   * 子节点必须一起收：只删组的话，子节点会变成看不见也删不掉的孤儿
   * （画布上没有它们的位置，而 reap 认的是"所有 board 里出现过的节点 id"，
   *  于是里面的终端会一直活着）。
   */
  const selectedWithChildren = useCallback((): string[] => {
    const sel = new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id))
    if (!sel.size) return []
    return nodesRef.current
      .filter((n) => n.selected || (n.parentId && sel.has(n.parentId)))
      .map((n) => n.id)
  }, [])

  const boardsRef = useRef<Record<string, SavedBoard>>({})
  const hadSaved = useRef(false)
  const viewportRef = useRef<Viewport | null>(null)
  const { setViewport, fitView, getViewport, zoomIn, zoomOut, zoomTo } = useReactFlow()
  /* 新节点落在**当前视口正中**（判据见 place-node.ts）。
     老实现用画布绝对坐标的固定网格，把画布拖走之后新建的节点会出现在几千像素外，
     每次都要满画布找 —— 用户实测报的就是这个。 */
  /* **绝对坐标的换算放在这里，不放在调用方。**
     React Flow 里组内节点的 `position` 是**相对父节点**的 —— 四个调用方各自
     `ns.map(x => x.position)` 的话，组在 (1000,1000)、子节点相对 (24,56) 时会
     ① 在原点附近造出幽灵碰撞、② 漏掉真实 (1024,1056) 处的遮挡。
     （codex 第三轮 P1，是我加"带上尺寸"那次引入的。）
     收在 centerOf 里，四个调用点一次修好，将来新增的也不会再写错。 */
  const centerOf = useCallback(
    (size: { width: number; height: number }, nodes: BoardNode[]) => {
      const byId = new Map(nodes.map((n) => [n.id, n]))
      const absolute = (n: BoardNode): { x: number; y: number } => {
        let x = n.position.x
        let y = n.position.y
        // 组可以嵌套，所以要一路累加上去；带环的数据也不能把这里挂死
        const seen = new Set<string>([n.id])
        let pid = n.parentId
        while (pid && !seen.has(pid)) {
          seen.add(pid)
          const p = byId.get(pid)
          if (!p) break
          x += p.position.x
          y += p.position.y
          pid = p.parentId
        }
        return { x, y }
      }
      const pane = document.querySelector('.react-flow__viewport')?.parentElement
      const r = pane?.getBoundingClientRect()
      const center = viewportCenter(getViewport(), {
        width: r?.width ?? window.innerWidth,
        height: r?.height ?? window.innerHeight
      })
      return placeNewNode(
        center,
        size,
        /* **折叠组里的隐藏子节点不参与碰撞。** 组折叠后子节点是 `hidden: true`，
           屏幕上一个像素都没有，却照样把新节点往外推 —— 实测：可见节点算出来是
           (1024,1068)，把隐藏子节点也算进去就被推到 (1296,1340)，偏了 272px。
           用户看到的是"新终端莫名其妙落在很远的地方"。（codex 第四轮 P1） */
        nodes
          .filter((n) => !n.hidden)
          .map((n) => ({
          ...absolute(n),
            width: n.width ?? n.measured?.width,
            height: n.height ?? n.measured?.height
          }))
      )
    },
    [getViewport]
  )

  // HUD 画布概览用：收集各节点 context 用量（事件只在变化时来，频率低）
  useEffect(
    () =>
      window.termspace.onAgentContext((e) => {
        setCtxMap((m) => ({ ...m, [e.nodeId]: { pct: e.usedPercent, model: e.model } }))
      }),
    []
  )

  const focusNode = useCallback(
    (id: string) => {
      void fitView({ nodes: [{ id }], duration: 300, maxZoom: 1 })
    },
    [fitView]
  )

  // 审批应答：走 Claude 的 PermissionRequest 结构化通道（主进程把那次 hook 请求挂着等这一下），
  // 不再往 pty 盲写 y —— 盲写没法保证落在正确的提示上。
  const decideApproval = useCallback((id: string, allow: boolean) => {
    void window.termspace.decideApproval(id, allow).then((r) => {
      if (!r.ok) setNotice(r.error ?? '应答失败')
    })
  }, [])

  // F7：cdx worker 状态 → 卡片节点（upsert 保留用户拖过的位置；不持久化）
  useEffect(
    () =>
      window.termspace.onWorkers((rows) => {
        setNodes((ns) => {
          const existing = new Map(
            ns.filter((n) => n.type === 'worker').map((n) => [n.id, n])
          )
          const others = ns.filter((n) => n.type !== 'worker')
          // 新卡片放到现有内容右侧一列
          const baseX =
            others.length > 0
              ? Math.max(...others.map((n) => n.position.x + (n.width ?? 580))) + 80
              : 80
          let placed = 0
          const workers: BoardNode[] = rows.map((r) => {
            const id = `w:${r.task}`
            const prev = existing.get(id)
            const data = {
              task: r.task,
              backend: r.backend,
              model: r.model,
              state: r.state,
              repo: r.repo,
              question: r.question,
              ageS: r.age_s
            }
            if (prev) return { ...prev, data } as BoardNode
            return {
              id,
              type: 'worker' as const,
              position: { x: baseX, y: 80 + placed++ * 170 },
              width: 280, // 高度随内容自适应（回复框/结果区会展开）
              data
            }
          })
          return [...others, ...workers]
        })
      }),
    []
  )

  useEffect(() => {
    void window.termspace.listIdentities().then(setIdentities)
    void window.termspace.listPresets().then(setPresets)
    void window.termspace.getSettings().then((s) => {
      const cfg = s as { defaultFontSize?: number; tmuxEnabled?: boolean } | null
      if (typeof cfg?.defaultFontSize === 'number' && cfg.defaultFontSize > 0) {
        setDefaultFontSize(cfg.defaultFontSize)
      }
      // 设置里开着还不够，本机得真装了 tmux
      void window.termspace.doctor().then((items) => {
        const tmux = items.find((d) => d.key === 'tmux')
        setTmuxOk(!!cfg?.tmuxEnabled && !!tmux?.ok)
      })
    })
  }, [])

  const applyBoard = useCallback(
    (b: SavedBoard | undefined) => {
      // 折叠的组：子节点 hidden 不进磁盘（那是派生状态），加载时按父组重算
      const collapsedGroups = new Set(
        (b?.nodes ?? []).filter((n) => n.type === 'group' && n.collapsed).map((n) => n.id)
      )
      setNodes(
        (b?.nodes ?? [])
          .map(fromSaved)
          .map((n) =>
            n.parentId && collapsedGroups.has(n.parentId) ? { ...n, hidden: true } : n
          )
      )
      /* 老工作区里的凭证边标的是 `context`（那时还没有 credential 这个 kind）。
         按**源节点类型**纠正一次 —— 不纠的话它们会被当成上下文源，
         `ctxLinks` → `tb context` 会去读一个凭证节点根本不存在的上下文文件。 */
      const credIds = new Set(
        (b?.nodes ?? []).filter((n) => n.type === 'credential').map((n) => n.id)
      )
      // 老工作区里 terminal→browser 也标成 delegate，按目标节点类型纠正
      const browserIds = new Set(
        (b?.nodes ?? []).filter((n) => n.type === 'browser').map((n) => n.id)
      )
      const fixKind = (e: SavedEdge): EdgeKind =>
        credIds.has(e.source) ? 'credential' : browserIds.has(e.target) ? 'drive' : e.kind
      setEdges(
        (b?.edges ?? []).map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          ...edgeStyle(fixKind(e))
        }))
      )
      viewportRef.current = b?.viewport ?? null
      if (b?.viewport) void setViewport(b.viewport)
      else setTimeout(() => void fitView({ padding: 0.25, maxZoom: 1 }), 60)
    },
    [setViewport, fitView]
  )

  // 启动恢复（含 v1 单画布 → v2 多项目迁移）
  useEffect(() => {
    let reapTimer = 0
    void window.termspace.loadWorkspace().then((raw) => {
      const ws = raw as Workspace | null
      let projs = ws?.projects
      let boards = ws?.boards
      let active = ws?.activeProjectId

      if (!projs?.length) {
        // v1 迁移：老画布收编成「默认」项目
        const def: Project = { id: 'p1', name: HOME_LABEL, cwd: '' }
        projs = [def]
        boards = {
          p1: {
            nodes:
              ws?.nodes ??
              seedNodes()
                .filter((n): n is Exclude<BoardNode, WorkerNodeT> => n.type !== 'worker')
                .map(toSaved),
            edges: ws?.edges,
            viewport: ws?.viewport
          }
        }
        active = 'p1'
      }
      hadSaved.current = true
      boardsRef.current = boards ?? {}
      // 一次性恢复老版本留下的孤儿画布。它们没有 cwd 可认领，而里面的终端
      // 会被 reap 当成"在册"继续活着 —— 不给标签页就是界面上永远够不着的活进程。
      const stranded = orphanBoardsToRecover(
        boardsRef.current,
        projs.map((p) => p.id)
      )
      if (stranded.length) {
        projs = [
          ...projs,
          ...stranded.map((pid, i) => ({
            id: pid,
            name: stranded.length > 1 ? `已恢复 ${i + 1}` : '已恢复',
            cwd: ''
          }))
        ]
      }
      setProjects(projs)
      const act = active && projs.some((p) => p.id === active) ? active : projs[0].id
      setActiveProject(act)
      applyBoard(boardsRef.current[act])
      setLoaded(true)
      // 清理孤儿 tmux 会话：全工作区所有项目的节点 id 都保留，其余杀掉。
      // 只在**确实读到**工作区时做 —— 读不到（首次启动 / 文件损坏）时 known 里只有种子节点，
      // reap 会把用户全部真会话当孤儿杀光，和 workspace 损坏组成连环丢数据。
      if (raw) {
        const known = Object.values(boardsRef.current).flatMap((b) => b.nodes.map((n) => n.id))
        // 延迟 5s，等活跃画布节点 spawn 完（它们也在 ptys 里被保护）
        reapTimer = window.setTimeout(() => void window.termspace.reapSessions(known), 5000)
      }
    })
    return () => window.clearTimeout(reapTimer)
  }, [applyBoard])

  // 当前画布快照（worker 卡片是运行时投影，不持久化）
  const snapshot = useCallback(
    (): SavedBoard => ({
      nodes: nodes
        .filter((n): n is Exclude<BoardNode, WorkerNodeT> => n.type !== 'worker')
        .map(toSaved),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        kind: (e.data?.kind as SavedEdge['kind']) ?? 'delegate'
      })),
      viewport: viewportRef.current ?? undefined
    }),
    [nodes, edges]
  )

  // 防抖落盘：当前画布写回所属项目，整个工作区一起存
  useEffect(() => {
    if (!loaded || !activeProject) return
    const t = setTimeout(() => {
      boardsRef.current[activeProject] = snapshot()
      // 每次落盘都把 cwd 补到 board 上 —— 关标签页时项目记录就没了，
      // 到那时再想记已经来不及。也顺带给老工作区里的 board 补上。
      for (const p of projects) {
        const b = boardsRef.current[p.id]
        if (b && p.cwd) b.cwd = p.cwd
      }
      // 清掉既没人用又空无一物的 board（只有空壳会被清，见 pruneEmptyBoards）
      boardsRef.current = pruneEmptyBoards(
        boardsRef.current,
        projects.map((p) => p.id)
      )
      void window.termspace
        .saveWorkspace({
          projects,
          activeProjectId: activeProject,
          boards: boardsRef.current
        })
        .then((r) => setSaveErr(r?.ok === false ? (r.error ?? '未知错误') : null))
    }, 500)
    return () => clearTimeout(t)
  }, [saveTick, loaded, activeProject, projects, snapshot])

  const switchProject = useCallback(
    (pid: string) => {
      if (pid === activeProject) return
      boardsRef.current[activeProject] = snapshot()
      setActiveProject(pid)
      applyBoard(boardsRef.current[pid])
    },
    [activeProject, snapshot, applyBoard]
  )

  const addProject = useCallback(async () => {
    const dir = await window.termspace.pickFolder()
    if (!dir) return
    boardsRef.current[activeProject] = snapshot()
    // 这个目录以前开过又关掉了？认领回原来的 pid —— 画布和里面还活着的终端一起回来。
    // 铸新 pid 会把旧画布永久孤儿化（见 reclaimBoardId 的注释）。
    const openPids = projects.map((p) => p.id)
    const reclaimed = reclaimBoardId(boardsRef.current, openPids, dir)
    // 加随机后缀：纯时间戳在同一毫秒建两个项目会撞，而 pid 决定上下文节点的文件名
    const pid = reclaimed ?? newNodeId('p', openPids)
    if (!reclaimed) boardsRef.current[pid] = { nodes: [], edges: [], cwd: dir }
    setProjects((ps) => [...ps, { id: pid, name: dir.split('/').pop() || '项目', cwd: dir }])
    setActiveProject(pid)
    applyBoard(boardsRef.current[pid])
  }, [activeProject, snapshot, applyBoard, projects])

  /**
   * 把一个布局模板铺到当前画布上。
   *
   * **建议命令只填进节点，绝不自动跑** —— 这是整条设计的落点：
   * 节点上会显示那条命令，用户点「启动」才执行。今天刚修过的那个 P0
   * （外部 workspace 里的 command 自动进登录 shell）就是反面教材。
   *
   * 局部 ref → 新 id 的映射一次算好：连线也要跟着重指，
   * 直接沿用模板里的 ref 会和画布上已有节点撞 id。
   */
  const applyLayout = useCallback(async () => {
    const r = await window.termspace.importLayout()
    if (!r.ok || !r.nodes) {
      if (r.error) window.alert(`导入失败：${r.error}`)
      return
    }
    const idOf = new Map<string, string>()
    setNodes((ns) => {
      const taken = [
        ...ns.map((n) => n.id),
        ...Object.values(boardsRef.current).flatMap((b) => b.nodes.map((n) => n.id))
      ]
      const made: BoardNode[] = []
      for (const t of r.nodes ?? []) {
        const prefix = t.type === 'browser' ? 'b' : t.type === 'group' ? 'g' : t.type === 'context' ? 'ctx' : 't'
        const id = newNodeId(prefix, [...taken, ...made.map((m) => m.id)])
        idOf.set(t.ref, id)
        made.push({
          id,
          type: t.type,
          position: { x: t.x, y: t.y },
          width: t.width ?? DEFAULT_SIZE.width,
          height: t.height ?? DEFAULT_SIZE.height,
          data: {
            title: t.title,
            status: 'idle',
            ...(t.absCwd ? { cwd: t.absCwd } : {}),
            ...(t.provider ? { provider: t.provider } : {}),
            ...(t.url ? { url: t.url } : {}),
            /* **suggestedCommand，不是 command** —— 后者会被 spawn 自动执行。
               两个字段名不同是有意的：忘了处理时的默认结果是"不跑"。 */
            ...(t.suggestedCommand ? { suggestedCommand: t.suggestedCommand } : {})
          }
        } as BoardNode)
      }
      // 父子关系要在 id 映射完成之后补
      for (const t of r.nodes ?? []) {
        if (!t.parent) continue
        const me = made.find((m) => m.id === idOf.get(t.ref))
        const pid = idOf.get(t.parent)
        if (me && pid) {
          me.parentId = pid
          me.extent = 'parent'
        }
      }
      return [...ns, ...made]
    })
    setEdges((es) => [
      ...es,
      ...(r.edges ?? [])
        .map((e) => {
          const src = idOf.get(e.from)
          const tgt = idOf.get(e.to)
          if (!src || !tgt) return null
          return {
            id: `${src}-${tgt}`,
            source: src,
            target: tgt,
            ...edgeStyle(e.kind as EdgeKind)
          }
        })
        .filter(Boolean) as Edge[]
    ])
  }, [])

  const closeProject = useCallback(
    (pid: string) => {
      // 只从标签栏移除；画布记录保留（tmux 会话也还活着）。
      // 重新添加**同一个目录**会认领回这个 pid，画布和终端一起回来（reclaimBoardId）。
      /* **先抓快照再切板**。switchProject / addProject 都这么做，唯独这里漏了 ——
         而落盘是 500ms 防抖的，关标签页会清掉那个 timer 并把下一次快照写给**新的**
         active project。症状不是报错：项目确实认领得回来，但最后几步改动没了
         （移动的节点、刚拉的线、刚调的 viewport）。 */
      if (pid === activeProject) boardsRef.current[pid] = snapshot()
      setProjects((ps) => {
        if (ps.length <= 1) return ps
        const rest = ps.filter((p) => p.id !== pid)
        if (pid === activeProject) {
          const next = rest[0].id
          setActiveProject(next)
          applyBoard(boardsRef.current[next])
        }
        return rest
      })
    },
    [activeProject, applyBoard, snapshot]
  )

  const projectCwd = projects.find((p) => p.id === activeProject)?.cwd || undefined

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)),
    []
  )

  // 连线规则：简报→终端=上下文注入；终端→终端=派活通道；终端→浏览器=允许驱动该浏览器；其余拒绝
  const onConnect = useCallback(
    (rawConn: Connection) => {
      let c = rawConn
      let src = nodes.find((n) => n.id === c.source)
      let tgt = nodes.find((n) => n.id === c.target)
      if (!src || !tgt || src.id === tgt.id) return
      /* **反着拉也要认**。原来严格要求 source 是 credential/context，反向拉就静默 return ——
         没线、没提示、没抖动，用户只会觉得"这软件坏了"。
         而"附着线不画箭头"这个决定恰恰加剧了它：线上没有方向指示，
         用户更没理由知道该从哪头开始拉。
         用户的意图是明确的（把这两个连起来），方向是我们的实现细节，不该让用户来记。 */
      const needsSwap =
        (tgt.type === 'credential' && src.type === 'terminal') ||
        (tgt.type === 'context' && src.type === 'terminal') ||
        (tgt.type === 'terminal' && src.type === 'browser')
      if (needsSwap) {
        c = { ...c, source: rawConn.target, target: rawConn.source }
        ;[src, tgt] = [tgt, src]
      }
      /* 凭证 → 终端：这条线**不只是标注**，它会真的把该终端切到这个账号，
         而切换凭证 = 杀掉 tmux 会话重开（identityId 变更即 destroy + respawn）。
         拉一根线是很轻的手势，后果却是重启用户正在跑的活 —— 必须先确认。 */
      if (src.type === 'credential' && tgt.type === 'terminal') {
        const idn = (src.data as { identityId?: string }).identityId
        if (!idn) return
        const cred = identities.find((i) => i.id === idn)
        if (tgt.data.identityId === idn) return // 已经是它了，不用重开
        if (
          !window.confirm(
            `把「${tgt.data.title}」切到凭证「${cred?.name ?? idn}」？\n\n` +
              '会关掉这个终端当前的会话并用新账号重开，正在跑的进程会结束。\n' +
              '（凭证只负责隔离登录态，新账号第一次仍需在终端里跑一次 codex login）'
          )
        ) {
          return
        }
        // 一个终端只能有一个凭证：先摘掉指向它的旧凭证连线，再连新的
        setEdges((es) => [
          ...es.filter(
            (e) =>
              !(
                e.target === tgt.id &&
                nodesRef.current.find((n) => n.id === e.source)?.type === 'credential'
              )
          ),
          ...addEdge({ ...c, ...edgeStyle('credential') }, [])
        ])
        void window.termspace.destroy(tgt.id)
        setNodes((ns) =>
          ns.map((n) =>
            n.id === tgt.id && n.type === 'terminal'
              ? { ...n, data: { ...n.data, identityId: idn } }
              : n
          )
        )
        return
      }

      let kind: EdgeKind | null = null
      if (src.type === 'context' && tgt.type === 'terminal') kind = 'context'
      else if (src.type === 'terminal' && tgt.type === 'terminal') kind = 'delegate'
      else if (src.type === 'terminal' && tgt.type === 'browser') kind = 'drive'
      if (!kind) return
      setEdges((es) => addEdge({ ...c, ...edgeStyle(kind) }, es))
    },
    // identities 用在确认框里显示凭证名字；漏了它就会拿旧列表去查，
    // 刚新建的凭证连线时确认框写的是 id 而不是名字
    [nodes, identities]
  )

  /** 上一拍有凭证连线的终端。用来识别「线被删了」这个瞬间 */
  const prevBoundRef = useRef<Set<string>>(new Set())

  /* 连线是凭证的唯一真相源之一 —— 有线连过来时把节点头部的下拉锁掉，
     否则同一件事两个入口，用户改了下拉却发现被连线覆盖，或反过来。 */
  useEffect(() => {
    const bound = new Set(
      edges
        .filter((e) => nodesRef.current.find((n) => n.id === e.source)?.type === 'credential')
        .map((e) => e.target)
    )

    /* **删线必须真撤销**。原来断线只解锁下拉、`identityId` 原样留着 ——
       画布上看着没线了，那个终端还在用刚被撤掉的账号 / API key 跑着，
       连 tmux 会话都还attach 在旧身份上。「用户已撤销、进程仍持有 secret」
       是确定的错误，不是可以商量的语义。

       撤销要重开会话（和连线时同一个代价），所以要确认；
       **用户若不同意，就把线加回去** —— 画布必须始终等于真相，
       不能出现"线没了但身份还在"的中间态。 */
    const revoked = [...prevBoundRef.current].filter((id) => !bound.has(id))
    prevBoundRef.current = bound
    for (const termId of revoked) {
      const term = nodesRef.current.find((n) => n.id === termId)
      if (!term || term.type !== 'terminal' || !term.data.identityId) continue
      /* 凭证**节点**还在不在，决定这是"删了一条线"还是"删了整个凭证节点"：
         - 节点还在 → 用户只删了线，问一句，取消就把线还回去
         - 节点没了 → 用户在删节点那步已经确认过一次了，**不能再问第二遍**，
           更不能在他点"取消"时去还原一条指向已删节点的线（原来正是这样：
           credNode 查不到 → 既没还原也没清 identityId → 终端挂在一个不存在的凭证上） */
      const credNode = nodesRef.current.find(
        (n) => n.type === 'credential' && n.data.identityId === term.data.identityId
      )
      const ok =
        !credNode ||
        window.confirm(
          `撤掉「${term.data.title}」的凭证？\n\n` +
            '这个终端会关掉当前会话、用系统默认身份重开，正在跑的进程会结束。\n' +
            '点取消则把连线加回去（保持现在的身份）。'
        )
      if (!ok && credNode) {
        // 还原连线：画布不能停在"线没了但身份还在"的中间态
        prevBoundRef.current.add(termId) // 加回去后别再当成一次新的撤销
        setEdges((es) =>
          addEdge(
            { id: `${credNode.id}-${termId}`, source: credNode.id, target: termId, ...edgeStyle('credential') },
            es
          )
        )
        continue
      }
      void window.termspace.destroy(termId)
      setNodes((ns) =>
        ns.map((n) =>
          n.id === termId && n.type === 'terminal'
            ? { ...n, data: { ...n.data, identityId: undefined } }
            : n
        )
      )
    }

    setNodes((ns) => {
      let changed = false
      const next = ns.map((n) => {
        if (n.type !== 'terminal') return n
        const b = bound.has(n.id)
        if (!!n.data.credBound === b) return n
        changed = true
        return { ...n, data: { ...n.data, credBound: b } }
      })
      return changed ? next : ns
    })
  }, [edges])

  /* 派活流光：只在**此刻真有一次注入在飞**时点亮那一条线。
     常驻 animated 在全景视图里是纯噪声，还和 agent 状态 glow 抢注意力 ——
     屏幕上唯一在动的东西，应该是"现在真有事发生"。 */
  useEffect(
    () =>
      window.termspace.onDelegateFlight(({ source, target, active }) => {
        setEdges((es) =>
          es.map((e) =>
            e.source === source && e.target === target && !!e.animated !== active
              ? { ...e, animated: active }
              : e
          )
        )
      }),
    []
  )

  const onNodesChange = useCallback(
    (changes: NodeChange<BoardNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    []
  )

  // agent 状态事件 → 节点 glow/胶囊（兜底策略见 ARCHITECTURE-NOTES.md §3）
  useEffect(() => {
    const doneAt = new Map<string, number>()
    const lastEventAt = new Map<string, number>()

    /* error 是进程非零退出置的，属于"这个终端已经出事了"的终态。
       迟到的 hook 事件（Stop/PostToolUse）不能把它洗回 idle/running —— 那样红框一闪就没了。
       只有明确的新一轮（SessionStart / 用户提交新 prompt）才允许覆盖。 */
    const apply = (
      nodeId: string,
      status: TermNode['data']['status'],
      canClearError = false
    ): void => {
      setNodes((ns) =>
        ns.map((n) => {
          if (n.id !== nodeId || n.type !== 'terminal') return n
          if (n.data.status === status) return n
          if (n.data.status === 'error' && !canClearError) return n
          return { ...n, data: { ...n.data, status } }
        })
      )
    }

    const off = window.termspace.onAgentStatus((e) => {
      lastEventAt.set(e.nodeId, Date.now())
      /* **谁在这个节点里真的跑起来了**。节点的 `provider` 是建节点时定的，
         而用户经常先开一个普通 zsh、再手敲 `claude` —— 那种节点 provider 是空，
         额度面板于是把这个正在烧的账号整个藏起来。
         hook 事件是"真有 agent 在跑"的唯一可靠信号：
         前台进程名不能用（实测 claude 报的是版本号 `2.1.220`、codex 报 `Python`）。
         SessionEnd 就摘掉。 */
      if (e.agentId) {
        setLiveAgents((m) =>
          e.event === 'SessionEnd'
            ? (delete m[e.nodeId], { ...m })
            : m[e.nodeId] === e.agentId
              ? m
              : { ...m, [e.nodeId]: e.agentId as string }
        )
      }
      const fresh = e.newTurn || e.event === 'SessionStart' // 新一轮才允许清 error
      if (e.state === 'working') {
        // done-holdoff 3s：并行 hook 晚到的 working 不许复活已结束的 turn
        if (!e.newTurn && Date.now() - (doneAt.get(e.nodeId) ?? 0) < 3000) return
        apply(e.nodeId, 'running', fresh)
      } else if (e.state === 'blocked' || e.state === 'waiting') {
        apply(e.nodeId, 'attention', fresh)
      } else {
        doneAt.set(e.nodeId, Date.now())
        apply(e.nodeId, 'idle', fresh)
      }
    })

    // stale-working 清扫：丢 Stop / CLI 崩溃的最后防线（30min 无事件回 idle）
    const sweep = setInterval(() => {
      const now = Date.now()
      setNodes((ns) =>
        ns.map((n) => {
          if (n.type !== 'terminal' || n.data.status === 'idle') return n
          const last = lastEventAt.get(n.id)
          return last && now - last > 30 * 60_000
            ? { ...n, data: { ...n.data, status: 'idle' as const } }
            : n
        })
      )
    }, 60_000)

    return () => {
      off()
      clearInterval(sweep)
    }
  }, [])

  const onMoveEnd = useCallback((_: unknown, vp: Viewport) => {
    viewportRef.current = vp
    setSaveTick((t) => t + 1) // 走统一防抖保存
  }, [])

  // minimap：平移/缩放时浮现，静止 1.6s 后淡出
  const onMove = useCallback(() => {
    setMapActive(true)
    window.clearTimeout(mapTimer.current)
    mapTimer.current = window.setTimeout(() => setMapActive(false), 1600)
  }, [])

  const addTerminal = useCallback(
    (preset?: Preset) => {
      setShowAgentMenu(false)
      /* 选中了一个绑了 worktree 的组 → 新终端直接进这个组、落在那棵树上。
         没选组就照旧落在项目目录 —— 不改变原有习惯，只是多一条路。 */
      const selGroup = nodesRef.current.find((n) => n.type === 'group' && n.selected)
      const groupId = selGroup?.id
      const groupWt = (selGroup?.data as { worktree?: { path: string } } | undefined)?.worktree?.path
      setNodes((ns) => {
        // id 必须全工作区唯一：它就是 tmux 会话名，跨项目撞名会串会话
        const allIds = [
          ...ns.map((n) => n.id),
          ...Object.values(boardsRef.current).flatMap((b) => b.nodes.map((n) => n.id))
        ]
        const id = newNodeId('t', allIds)
        const n = ns.length
        return [
          ...ns,
          {
            id,
            type: 'terminal' as const,
            /* **parentId / extent 是节点的顶层字段，不是 data 里的** ——
               放进 data 时 typecheck 照过（data 是宽松对象），React Flow 却完全
               看不见，于是"新终端直接进这个组"从来没发生过：折叠、群发、批量重启、
               父子持久化全都不认它。cwd 那半边是对的，所以现象是
               "树进去了、组没进去"，最难看出来的那种半成功。 */
            ...(groupId
              ? {
                  parentId: groupId,
                  extent: 'parent' as const,
                  // 有父节点时 position 是**相对组身**的，用绝对坐标会飞到组外
                  position: { x: 24, y: 56 + (n % 3) * 40 }
                }
              : {
                  position: centerOf(DEFAULT_SIZE, ns)
                }),
            ...DEFAULT_SIZE,
            data: {
              title: preset ? `${preset.name} · ${id}` : `zsh · ${id}`,
              status: 'idle' as const,
              identityId: preset?.identityId || defaultIdentity || undefined,
              command: preset?.command || undefined,
              provider: preset?.provider,
              /* cwd 解析顺序：**选中的组若绑了 worktree 就落在那棵树上**，
                 否则回到项目目录。这就是隔离本身 —— 组 = 一棵树，
                 组内的 agent 和别处物理分开，不靠提示词约束。 */
              cwd: groupWt ?? projectCwd,
              fontSize: defaultFontSize // 设置里的默认字号（此前存了但没人读，改了不生效）
            }
          }
        ]
      })
    },
    [defaultIdentity, projectCwd, defaultFontSize]
  )

  /** 返回新节点 id：tb browser open 要靠它把「创建者即所有者」的授权落到实处 */
  const addBrowser = useCallback(
    (url?: string): string => {
      // id 在更新器外算：setNodes 的更新器不是同步跑的，拿不到返回值。
      // 同一 tick 连开两个浏览器会撞 id，但这条路径由 IPC 串行驱动，实际不会发生。
      const newId = nextId(nodesRef.current, 'b')
      setNodes((ns) => {
        if (ns.some((n) => n.id === newId)) return ns
        return [
          ...ns,
          {
            id: newId,
            type: 'browser' as const,
            position: centerOf({ width: 640, height: 460 }, ns),
            width: 640,
            height: 460,
            data: { url: url || 'https://www.google.com' }
          }
        ]
      })
      return newId
    },
    []
  )

  /** 凭证节点：账号在画布上的实体。同一个凭证只放一个，重复点就聚焦已有的 */
  const addCredential = useCallback((identityId: string) => {
    setNodes((ns) => {
      const existing = ns.find(
        (n) => n.type === 'credential' && n.data.identityId === identityId
      )
      if (existing) return ns.map((n) => ({ ...n, selected: n.id === existing.id }))
      const newId = nextId(ns, 'k')
      return [
        ...ns,
        {
          id: newId,
          type: 'credential' as const,
          position: centerOf({ width: 220, height: 132 }, ns),
          width: 220,
          height: 132,
          data: { identityId }
        }
      ]
    })
  }, [])

  // F2: 共享上下文 Hub — 无则建（一块板一个），有则聚焦。
  // id 必须带项目号：早期硬编码 'ctx-hub' 导致所有项目共用同一个磁盘文件，简报跨项目串板。
  const openContextHub = useCallback(() => {
    setNodes((ns) => {
      const existing = ns.find((n) => n.type === 'context')
      if (existing) {
        setTimeout(() => focusNode(existing.id), 0)
        return ns
      }
      return [
        ...ns,
        {
          id: `ctx-${activeProject}`,
          type: 'context' as const,
          position: centerOf({ width: 420, height: 320 }, ns),
          width: 420,
          height: 320,
          data: { title: '共享上下文' }
        }
      ]
    })
  }, [focusNode, activeProject])

  // F1: 框选成组 + 自动网格排列（Shift+拖拽框选后点「成组」）
  const groupSelected = useCallback(() => {
    setNodes((ns) => {
      const sel = ns.filter(
        (n): n is TermNode => n.type === 'terminal' && !!n.selected && !n.parentId
      )
      if (sel.length < 2) return ns
      const selIds = new Set(sel.map((n) => n.id))
      const rest = ns.filter((n) => !selIds.has(n.id))
      const gid = nextId(ns, 'g')
      const cols = Math.ceil(Math.sqrt(sel.length))
      const rows = Math.ceil(sel.length / cols)
      const cellW = Math.max(...sel.map((n) => n.width ?? DEFAULT_SIZE.width))
      const cellH = Math.max(...sel.map((n) => n.height ?? DEFAULT_SIZE.height))
      const gw = GROUP_PAD * 2 + cols * cellW + (cols - 1) * GROUP_GAP
      const gh = GROUP_HEAD + GROUP_PAD + rows * cellH + (rows - 1) * GROUP_GAP + GROUP_PAD
      const minX = Math.min(...sel.map((n) => n.position.x))
      const minY = Math.min(...sel.map((n) => n.position.y))
      // 按视觉位置排序后填网格 = 整整齐齐
      const sorted = [...sel].toSorted(
        (a, b) => a.position.y - b.position.y || a.position.x - b.position.x
      )
      const group: GroupNodeT = {
        id: gid,
        type: 'group',
        position: { x: minX - GROUP_PAD, y: minY - GROUP_HEAD - GROUP_PAD },
        width: gw,
        height: gh,
        data: { title: `集群 ${gid.slice(1)}` }
      }
      const children = sorted.map((n, i) => ({
        ...n,
        parentId: gid,
        extent: 'parent' as const,
        selected: false,
        width: cellW,
        height: cellH,
        position: {
          x: GROUP_PAD + (i % cols) * (cellW + GROUP_GAP),
          y: GROUP_HEAD + GROUP_PAD + Math.floor(i / cols) * (cellH + GROUP_GAP)
        }
      }))
      // 父节点必须排在子节点前面（React Flow 要求）
      return [...rest, group, ...children]
    })
  }, [])

  // 所有订阅 effect 注册完之后握手：主进程收到才重推 quota/workers（防启动竞态）
  useEffect(() => {
    window.termspace.ready()
  }, [])

  // tb browser 驱动：主进程转发指令 → 操作对应 webview → 回结果
  useEffect(
    () =>
      window.termspace.onBrowserCmd(async (req) => {
        const { reqId, nodeId, action, arg } = req
        const done = (ok: boolean, result: string): void =>
          window.termspace.browserResult({ reqId, ok, result })
        // nodeId 为空 → 取第一个浏览器节点（agent 常只开一个）；
        // 但**指名了却找不到**必须报错，不能静默回退 —— 否则 goto/js 会打到另一个
        // 浏览器节点上，而那个节点里可能是用户已登录的会话。
        if (nodeId && !browserViews.has(nodeId)) {
          return done(
            false,
            `找不到浏览器节点 ${nodeId}（tb browser list 看现有节点）。已拒绝，未回退到其他节点。`
          )
        }
        const wv = nodeId
          ? (browserViews.get(nodeId) ?? null)
          : browserViews.size
            ? [...browserViews.values()][0]
            : null
        if (action === 'list') {
          return done(true, [...browserViews.keys()].join('\n') || '(画布上没有浏览器节点)')
        }
        if (action === 'open') {
          // 首行是裸 id：主进程据此把「创建者即所有者」的授权落到真实节点上，
          // agent 也能拿它做后续的 --node 参数
          const newId = addBrowser(arg)
          // 谁开的就自动连一条线：授权在画布上看得见，想撤销直接删线
          if (req.source) {
            setEdges((es) =>
              addEdge(
                {
                  source: req.source,
                  target: newId,
                  sourceHandle: null,
                  targetHandle: null,
                  ...edgeStyle('delegate')
                },
                es
              )
            )
          }
          return done(true, `${newId}\n已打开浏览器节点 ${newId}：${arg}`)
        }
        if (!wv) return done(false, '画布上没有浏览器节点，先 tb browser open <url>')
        try {
          if (action === 'goto') {
            await wv.loadURL(arg)
            return done(true, `已导航到 ${arg}`)
          }
          if (action === 'text') {
            const t = await wv.executeJavaScript('document.body.innerText')
            return done(true, String(t).slice(0, 8000))
          }
          if (action === 'js') {
            const r = await wv.executeJavaScript(arg)
            return done(true, typeof r === 'string' ? r : JSON.stringify(r ?? null))
          }
          if (action === 'shot') {
            const img = await wv.capturePage()
            // arg 为落盘路径（主进程给），data URL 转 base64 回传由主进程存文件
            return done(true, img.toDataURL())
          }
          return done(false, `未知动作 ${action}`)
        } catch (e) {
          return done(false, `执行失败：${String(e)}`)
        }
      }),
    [addBrowser]
  )

  // 把画布 agent 摘要 + 授权连线同步给主进程（tb agents / 派活 / 浏览器驱动都要用）。
  // 连线即授权：终端→终端 = 可派活，终端→浏览器 = 可驱动该浏览器。删线即撤销。
  useEffect(() => {
    window.termspace.reportAgents({
      agents: nodes
        .filter((n): n is TermNode => n.type === 'terminal')
        .map((n) => ({
          id: n.id,
          title: n.data.title,
          provider: n.data.provider,
          status: n.data.status
        })),
      links: edges
        /* **drive 也要算进授权图**：主进程的 authorizeLink 同时管派活和浏览器驱动，
           漏掉 drive 会让"连了线的浏览器"每次都弹确认框 */
        .filter((e) => {
          const k = (e.data?.kind as EdgeKind) ?? 'delegate'
          return k === 'delegate' || k === 'drive'
        })
        .map((e) => `${e.source}>${e.target}`),
      /* 上下文连线单独报：`tb context` 要按当前连线**现算**内容。
         spawn 时那份 contextNodeIds 是快照，用户改完连线不会重新传上来。 */
      ctxLinks: edges
        .filter((e) => e.data?.kind === 'context')
        .map((e) => `${e.source}>${e.target}`),
      // 现存节点全集：主进程据此撤销指向已消失节点的一次性授权（id 会被复用）
      nodeIds: nodes.filter((n) => n.type !== 'worker').map((n) => n.id),
      /* 完整画布快照，给远程 API（手机端要按同样的空间关系画出来）。
         只含布局与状态，不含任何终端内容 —— 内容走单独的 peek 接口。 */
      board: {
        projects,
        activeProjectId: activeProject,
        nodes: nodes
          .filter((n) => n.type !== 'worker')
          .map((n) => ({
            id: n.id,
            type: n.type,
            title:
              n.type === 'terminal'
                ? n.data.title
                : n.type === 'browser'
                  ? (n.data.title ?? '浏览器')
                  : n.type === 'context'
                    ? '共享上下文'
                    : n.data.title,
            status: n.type === 'terminal' ? n.data.status : undefined,
            provider: n.type === 'terminal' ? n.data.provider : undefined,
            x: n.position.x,
            y: n.position.y,
            width: n.width ?? n.measured?.width ?? 0,
            height: n.height ?? n.measured?.height ?? 0,
            parentId: n.parentId,
            hidden: !!n.hidden
          })),
        edges: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          kind: (e.data?.kind as string) ?? 'delegate'
        }))
      }
    })
  }, [nodes, edges, projects, activeProject])

  // 右键菜单动作
  const menuNode = menu?.nodeId ? nodes.find((n) => n.id === menu.nodeId) : undefined
  const bumpFont = useCallback(
    (delta: number) => {
      if (!menu?.nodeId) return
      setNodes((ns) =>
        ns.map((n) => {
          if (n.id !== menu.nodeId || n.type !== 'terminal') return n
          const cur = n.data.fontSize ?? 13
          return { ...n, data: { ...n.data, fontSize: Math.min(24, Math.max(8, cur + delta)) } }
        })
      )
    },
    [menu]
  )
  /** 删节点必须连带删它的连线：连线就是授权图，而节点 id 会复用
      —— 老 id 是 max+1 会复用，新 id 已改成不可复用（board-serde.ts 的 newNodeId），
      但**老工作区里的 t1/b3 仍然存在**，而且这条清理本身是对的：删了节点就该收回它的授权 */
  const dropEdgesOf = useCallback((ids: Set<string>) => {
    setEdges((es) => es.filter((e) => !ids.has(e.source) && !ids.has(e.target)))
  }, [])

  /**
   * 统一的删除入口：确认 → 收好可撤回记录 → destroy（拿回最后一屏）→ 移除节点与连线。
   * 所有删除路径都走这里，别再各写各的 —— 之前就是散在四处才漏掉了连线和子节点。
   */
  const removeNodes = useCallback(
    async (ids: string[], label: string, opts?: { skipConfirm?: boolean }): Promise<void> => {
      const gone = new Set(ids)
      const doomed = nodesRef.current.filter((n) => gone.has(n.id))
      if (!doomed.length) return
      const terms = doomed.filter((n) => n.type === 'terminal')
      if (!opts?.skipConfirm) {
        const what =
          terms.length > 0
            ? `${label}？其中 ${terms.length} 个终端的会话会被结束（跑着的进程无法恢复）。`
            : `${label}？`
        if (!window.confirm(`${what}\n\n删除后可以用 ⌘Z 撤回布局与配置。`)) return
      }
      // destroy 会返回销毁前的屏幕内容，留着撤回时回灌
      const screens: Record<string, string> = {}
      await Promise.all(
        terms.map(async (n) => {
          screens[n.id] = await window.termspace.destroy(n.id).catch(() => '')
        })
      )
      const keptEdges = edgesRef.current.filter((e) => gone.has(e.source) || gone.has(e.target))
      /* 删的若是凭证节点，把它绑着的终端此刻的 identityId 记下来 ——
         撤销逻辑随后会把这些终端改回默认身份，⌘Z 得能把身份也还回去 */
      const rebind: Record<string, string> = {}
      for (const e of keptEdges) {
        const src = nodesRef.current.find((n) => n.id === e.source)
        if (src?.type !== 'credential') continue
        const term = nodesRef.current.find((n) => n.id === e.target)
        const idn = (term?.data as { identityId?: string } | undefined)?.identityId
        if (term?.type === 'terminal' && idn) rebind[term.id] = idn
      }
      undoRef.current.push({ label, nodes: doomed, edges: keptEdges, screens, rebind, at: Date.now() })
      if (undoRef.current.length > 20) undoRef.current.shift()
      setNodes((ns) => ns.filter((n) => !gone.has(n.id)))
      dropEdgesOf(gone)
      setUndoHint(undoRef.current[undoRef.current.length - 1])
      window.clearTimeout(hintTimer.current)
      hintTimer.current = window.setTimeout(() => setUndoHint(null), 12_000)
    },
    [dropEdgesOf]
  )

  /** 撤回：先把屏幕内容写回快照文件，再放节点回画布（顺序反了就会先 spawn 后回灌，白屏） */
  /** 这个凭证被谁在用（**全工作区**，不只当前画布 —— 别的项目里的终端一样会断） */
  const identityUsage = useCallback(
    (idn: string): { terminals: number; nodes: number; presets: number } => {
      const allNodes = [
        ...nodesRef.current,
        ...Object.entries(boardsRef.current)
          .filter(([pid]) => pid !== activeProject)
          .flatMap(([, b]) => b.nodes)
      ]
      let terminals = 0
      // 不叫 nodes：外层的 `nodes` 是 ReactFlow 的节点数组，在这段里写 nodes 会拿到计数器
      let credNodes = 0
      for (const n of allNodes) {
        const t = (n as { type?: string }).type
        const bound = (n as { data?: { identityId?: string }; identityId?: string })
        const owned = bound.data?.identityId ?? bound.identityId
        if (owned !== idn) continue
        if (t === 'credential') credNodes++
        else if (t === 'terminal') terminals++
      }
      return {
        terminals,
        nodes: credNodes,
        presets: presets.filter((p) => p.identityId === idn).length
      }
    },
    [activeProject, presets]
  )

  /**
   * 删凭证前先把画布上的引用撤干净。
   *
   * **顺序很重要**：先关会话、清 identityId、摘掉凭证节点和线，**再**删库。
   * 反过来的话，那些终端会在下一次启动时因为"凭证不存在"被 fail-closed 挡住，
   * 用户看到的是一排起不来的终端，而不是一次干净的降级。
   * 别的项目（非当前画布）里的引用也要清，否则切过去就是一堆起不来的终端。
   */
  const revokeIdentityEverywhere = useCallback(
    async (idn: string): Promise<void> => {
      const hit = nodesRef.current.filter(
        (n) =>
          (n.type === 'terminal' || n.type === 'credential') &&
          (n.data as { identityId?: string }).identityId === idn
      )
      await Promise.all(
        hit.filter((n) => n.type === 'terminal').map((n) => window.termspace.destroy(n.id).catch(() => ''))
      )
      const credIds = new Set(hit.filter((n) => n.type === 'credential').map((n) => n.id))
      setNodes((ns) =>
        ns
          .filter((n) => !credIds.has(n.id))
          .map((n) =>
            n.type === 'terminal' && (n.data as { identityId?: string }).identityId === idn
              ? { ...n, data: { ...n.data, identityId: undefined, credBound: false } }
              : n
          )
      )
      setEdges((es) => es.filter((e) => !credIds.has(e.source) && !credIds.has(e.target)))
      // 非当前画布的快照也要清，否则切过去全是起不来的终端
      for (const b of Object.values(boardsRef.current)) {
        b.nodes = b.nodes
          .filter((n) => !(n.type === 'credential' && n.identityId === idn))
          .map((n) => (n.identityId === idn ? { ...n, identityId: undefined } : n))
      }
      setSaveTick((t) => t + 1)
    },
    []
  )

  const requestDelete = useCallback(
    (ids: string[], label: string): void => {
      void removeNodes(ids, label)
    },
    [removeNodes]
  )

  const undoDelete = useCallback(async (): Promise<void> => {
    const entry = undoRef.current.pop()
    if (!entry) return
    setUndoHint(null)
    await Promise.all(
      Object.entries(entry.screens).map(([id, text]) =>
        text ? window.termspace.seedScrollback(id, text) : Promise.resolve(false)
      )
    )
    /* 老 id（t1/t2…）是 max+1 生成的、会被复用；新 id 已不可复用。
       但老工作区里那些 id 还在，这道判定要留着：
       - 被删过、现在又出现了 = 有**新节点占了这个 id**，既不恢复它也不恢复它的连线
         （连线是授权图，还给新节点等于让陌生人白捡旧节点的授权）
       - 没被删过、现在还在 = 原封不动的幸存者，安全 */
    const deleted = new Set(entry.nodes.map((n) => n.id))
    const present = new Set(nodesRef.current.map((n) => n.id))
    const safeEnd = (id: string): boolean => (deleted.has(id) ? !present.has(id) : present.has(id))
    const okEdges = entry.edges.filter((e) => safeEnd(e.source) && safeEnd(e.target))

    setNodes((ns) => {
      const back = entry.nodes.filter((n) => !ns.some((x) => x.id === n.id))
      // 身份也要还回去，否则橙线回来了、跑的还是默认账号
      const restored = ns.map((n) =>
        n.type === 'terminal' && entry.rebind[n.id]
          ? { ...n, data: { ...n.data, identityId: entry.rebind[n.id] } }
          : n
      )
      return [...restored, ...back]
    })
    setEdges((es) => [...es, ...okEdges.filter((e) => !es.some((x) => x.id === e.id))])
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      /* ⌘K **在终端里也要能开**：终端里没有比"跳到另一个 agent"更重要的
         ⌘K 语义，而这个键的价值恰恰在于"手在键盘上就能换地方"。
         （⌘Z 相反：终端里那是它自己的撤销，所以下面那条要避开。） */
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        /* **但输入框里要放行。** 终端节点底部的输入框是个真 textarea，
           `Ctrl+K` 在 macOS 里是原生的「删到行尾」，⌘K 也可能是编辑手势 ——
           全局吞掉的话，用户在输入框里按这两个键会莫名其妙弹出命令面板。
           终端本体（.term-node-body）不在此列：那里没有原生文本编辑语义，
           上面那段注释说的「终端里 ⌘K 也要能开」仍然成立。 */
        const t0 = e.target as HTMLElement | null
        if (t0?.closest('.term-composer')) return
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        // 终端里 ⌘Z 有自己的语义，只在画布上生效
        const t = e.target as HTMLElement | null
        if (t?.closest('.term-node-body, input, textarea')) return
        e.preventDefault()
        void undoDelete()
      }
      /* ⌫ / ⌦ 删除选中节点。
         React Flow 自带的 deleteKeyCode 仍然关着（`deleteKeyCode={null}`）——
         它直接删，没有确认也不进可撤回记录。这里自己接，是为了走 `removeNodes`
         那一个入口（确认 + ⌘Z 撤回 + 连带删连线和组内子节点）。

         ⚠️ **退格是终端里最高频的键**，误伤一次就是杀掉一个跑着的 shell。
         所以判据必须是「焦点不在任何可输入的地方」，而不是「有没有选中节点」——
         终端里可以既有选中的节点、又正在打字。浏览器节点的 <webview> 是独立进程，
         它的按键根本不冒泡到这里，天然安全；但地址栏是本文档的 input，要挡。 */
      if (e.key === 'Backspace' || e.key === 'Delete') {
        const t = e.target as HTMLElement | null
        if (
          t?.closest(
            '.term-node-body, .browser-body, .browser-addr, .context-node-body, input, textarea, select, [contenteditable]'
          )
        )
          return
        const gone = selectedWithChildren()
        if (!gone.length) return
        e.preventDefault()
        void removeNodes(gone, gone.length > 1 ? `删除选中的 ${gone.length} 个节点` : '删除该节点')
      }

      if (!(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      const inField = (): boolean =>
        !!(e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable]')

      /* ⇧⌘W 关窗口 · ⌘W 关选中的节点。
         **两者的后果差一个数量级**：关窗口只 releasePty，tmux 会话全部续存
         （下次打开原样回来）；关节点是 destroyPty = kill-session，里面跑着的
         那一轮 agent 对话再也回不来（⌘Z 能还原布局和配置，还不了会话）。
         所以 ⌘W 必须走 removeNodes 那个带确认的入口，不能直接删。

         ⚠️ **没选中节点时 ⌘W 什么都不做。** 最初的设计是"没选中就关 app"，
         但那是个很糟的失败模式：想关一个节点、恰好没选中，整个 app 就没了。
         关窗口已经由 ⇧⌘W 明确承担，不需要一个会误伤的兜底。 */
      if (k === 'w') {
        e.preventDefault()
        if (e.shiftKey) {
          window.close()
          return
        }
        const gone = selectedWithChildren()
        if (!gone.length) {
          setNotice('没有选中的节点。⌘W 关闭选中的终端，⇧⌘W 关闭窗口。')
          return
        }
        void removeNodes(gone, gone.length > 1 ? `关闭选中的 ${gone.length} 个节点` : '关闭该节点')
        return
      }

      if (inField()) return // 下面这些在输入框里都有原生语义，别抢

      if (k === 't') {
        e.preventDefault()
        addTerminal()
      } else if (k === '0') {
        e.preventDefault()
        void zoomTo(1, { duration: 160 })
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        void zoomIn({ duration: 160 })
      } else if (e.key === '-') {
        e.preventDefault()
        void zoomOut({ duration: 160 })
      } else if (k === 'f' && e.shiftKey) {
        e.preventDefault()
        void fitView({ padding: 0.2, duration: 300 })
      } else if (/^[1-9]$/.test(e.key)) {
        // ⌘1…9 切标签页。越界（只有 3 个项目却按 ⌘7）什么都不做，别跳到最后一个
        const target = projectsRef.current[Number(e.key) - 1]
        if (target) {
          e.preventDefault()
          switchProject(target.id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undoDelete, removeNodes, selectedWithChildren, addTerminal, switchProject, zoomIn, zoomOut, zoomTo, fitView])

  const deleteMenuNode = useCallback(() => {
    if (!menuNode) return
    const kids = nodes.filter((n) => n.parentId === menuNode.id).map((n) => n.id)
    const label =
      menuNode.type === 'group' ? `删除集群及组内 ${kids.length} 个节点` : '删除该节点'
    void removeNodes([menuNode.id, ...kids], label)
    setMenu(null)
  }, [menuNode, nodes, removeNodes])

  const selectedCount = nodes.filter(
    (n) => n.type === 'terminal' && n.selected && !n.parentId
  ).length

  return (
    <IdentityContext.Provider value={identities}>
      <TmuxContext.Provider value={tmuxOk}>
      <RequestDeleteContext.Provider value={requestDelete}>
      <div className={`h-screen w-screen mode-${canvasMode}`}>
        {settingsOpen && (
          <SettingsPanel
            initial={settingsOpen}
            onClose={() => setSettingsOpen(null)}
            renderPresets={() => (
              <PresetPanel presets={presets} identities={identities} onChanged={setPresets} />
            )}
            onExportLayout={async () => {
              const root = projects.find((p) => p.id === activeProject)?.cwd
              if (!root) return window.alert('这个项目没有目录，没法算相对路径。先给它选一个目录。')
              const name = window.prompt('给这个布局起个名字', '我的工作流')
              if (!name) return
              const r = await window.termspace.exportLayout({
                name,
                root,
                nodes: nodesRef.current,
                edges: edgesRef.current
              })
              if (r.ok) window.alert(`已导出到 ${r.path}`)
              else if (!r.canceled) window.alert(`导出失败：${r.error}`)
            }}
            onImportLayout={applyLayout}
            renderIdentities={() => (
              <IdentityPanel
                identities={identities}
                onChanged={setIdentities}
                usageOf={identityUsage}
                onDeleted={revokeIdentityEverywhere}
                onOpenIdentity={(id, provider, identityName) =>
                  addTerminal({
                    id: `identity-${id}`,
                    name: identityName,
                    provider,
                    command: '',
                    identityId: id
                  })
                }
                onOpenSystem={(provider, identityName) =>
                  addTerminal({
                    id: `system-${provider}`,
                    name: identityName,
                    provider,
                    command: ''
                  })
                }
              />
            )}
            /* 导出取的是内存里的实时状态，不是磁盘那份 —— 磁盘那份最多落后一个 500ms 防抖周期，
               但用户点「导出」时刚拖完的节点位置就该在里面 */
            getWorkspace={() => ({
              projects,
              activeProjectId: activeProject,
              boards: { ...boardsRef.current, [activeProject]: snapshot() }
            })}
          />
        )}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onMoveEnd={onMoveEnd}
          onMove={onMove}
          onPaneClick={() => setMenu(null)}
          onPaneContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY })
          }}
          onNodeContextMenu={(e, n) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, nodeId: n.id })
          }}
          onSelectionContextMenu={(e) => {
            // 框选后右键：弹「成组」菜单
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, selection: true })
          }}
          onEdgeContextMenu={(e, edge) => {
            // 连线右键 → 删除。连线即授权，所以必须能撤销
            e.preventDefault()
            e.stopPropagation()
            setMenu({ x: e.clientX, y: e.clientY, edgeId: edge.id })
          }}
          nodeTypes={nodeTypes}
          colorMode="dark"
          minZoom={0.02} /* 真·无限：能缩到极远看全局分布 */
          translateExtent={[
            [-Infinity, -Infinity],
            [Infinity, Infinity]
          ]}
          nodeExtent={[
            [-Infinity, -Infinity],
            [Infinity, Infinity]
          ]}
          maxZoom={1.5} /* ponytail: WebGL canvas 放大是位图拉伸会糊，>1.5 不可接受；真·清晰放大需按 zoom 重设 fontSize，后续做 */
          panOnScroll
          zoomOnScroll={false}
          deleteKeyCode={null}
          panOnDrag={canvasMode === 'pan'}
          selectionOnDrag={canvasMode === 'select'}
          selectionKeyCode={canvasMode === 'pan' ? 'Shift' : null}
          edgesReconnectable={false}
          connectionLineStyle={{ stroke: '#0A84FF', strokeWidth: 2 }}
          proOptions={{ hideAttribution: true }}
        >
          {/* 'plain' 不是"画一个纯色背景",是**根本不渲染 Background** ——
              画布本来就透着 --tb-bg,多画一层只会多一次合成。 */}
          {canvasPrefs.bg !== 'plain' && (
            <Background
              variant={canvasPrefs.bg === 'grid' ? BackgroundVariant.Lines : BackgroundVariant.Dots}
              gap={24}
              /* 网格是连续的线,和点阵同样的不透明度会明显更吵 —— 压暗一档 */
              size={canvasPrefs.bg === 'grid' ? 1 : 1.2}
              color={
                canvasPrefs.bg === 'grid'
                  ? 'rgba(255, 255, 255, 0.055)'
                  : 'rgba(255, 255, 255, 0.22)'
              }
              bgColor="transparent"
            />
          )}
          {undoHint && !saveErr && !notice && (
            <Panel position="bottom-center" className="undo-toast">
              已{undoHint.label}
              <button
                className="undo-btn"
                onClick={() => {
                  void undoDelete()
                }}
              >
                撤回（⌘Z）
              </button>
              <button className="undo-dismiss" onClick={() => setUndoHint(null)}>
                ✕
              </button>
            </Panel>
          )}
          {(saveErr || notice) && (
            <Panel position="bottom-center" className="save-alert">
              <span className="save-alert-dot" />
              {saveErr ? `画布未能保存：${saveErr}` : notice}
              <button
                className="save-alert-retry"
                onClick={() => (saveErr ? setSaveTick((t) => t + 1) : setNotice(null))}
              >
                {saveErr ? '重试' : '知道了'}
              </button>
            </Panel>
          )}
          {/* 画布控件栈。**一个容器,不是两个叠起来。**
              老实现是 React Flow 自带的 <Controls> 加一个独立的 .mode-switch 面板,
              靠 `margin-bottom: 92px !important` 手工让开 —— 于是圆角(9 vs 10)、
              按钮尺寸、内边距三处都对不齐,而且那个魔数一改布局就废。
              合成一个之后顺带装下缩放百分比。 */}
          <Panel position="bottom-left" className="canvas-dock">
            <button
              className={`dock-btn mode ${canvasMode}`}
              title={
                canvasMode === 'pan'
                  ? '当前：拖拽平移（Shift 框选）· 点击切到框选'
                  : '当前：拖拽框选（空格平移）· 点击切到平移'
              }
              onClick={() => setCanvasMode((m) => (m === 'pan' ? 'select' : 'pan'))}
            >
              {canvasMode === 'pan' ? <IconHand /> : <IconCursor />}
            </button>
            <span className="dock-sep" />
            <button className="dock-btn" title="放大（⌘=）" onClick={() => zoomIn({ duration: 160 })}>
              <IconPlus />
            </button>
            {/* 百分比同时是按钮:点一下回 100%(⌘0)。
                纯展示的数字在这里是浪费 —— 用户看到"37%"的下一个念头就是想回去。 */}
            <button
              className="dock-zoom"
              title="缩放（点击回到 100%，⌘0）"
              onClick={() => zoomTo(1, { duration: 160 })}
            >
              {Math.round(zoomPct * 100)}%
            </button>
            <button className="dock-btn" title="缩小（⌘-）" onClick={() => zoomOut({ duration: 160 })}>
              <IconMinus />
            </button>
            <span className="dock-sep" />
            <button
              className="dock-btn"
              title="全览所有节点（⇧⌘F）"
              onClick={() => void fitView({ padding: 0.2, duration: 300 })}
            >
              <IconFit />
            </button>
            <button
              className="dock-btn dock-bg"
              title={`画布背景：${BG_LABEL[canvasPrefs.bg]}（点击切换）`}
              onClick={() => patchCanvasPrefs({ bg: nextBg(canvasPrefs.bg) })}
            >
              {BG_LABEL[canvasPrefs.bg].slice(0, 1)}
            </button>
          </Panel>
          <MiniMap
            className={mapActive ? 'map-visible' : 'map-hidden'}
            pannable
            zoomable
            nodeColor={(n) => {
              if (n.type === 'context') return '#BF5AF2'
              if (n.type === 'browser') return '#5AC8FA'
              if (n.type === 'group') return statusColor['group']
              if (n.type === 'worker') {
                const st = (n.data as { state?: string }).state
                if (st === 'working') return statusColor['running']
                if (st === 'awaiting_reply' || st === 'stalled') return statusColor['attention']
                return statusColor['idle']
              }
              return statusColor[(n.data as { status?: string }).status ?? 'idle']
            }}
            nodeStrokeWidth={3}
          />
          {/* 右上角单一栏：额度 HUD 与消息中心竖排。两个各自的 top-right Panel
              会被绝对定位到同一点上，字直接压在一起 */}
          <Panel position="top-right" className="right-rail">
            <BoardHUD nodes={nodes} ctxMap={ctxMap} liveAgents={liveAgents} onFocus={focusNode} />
            <CommandPalette
              open={paletteOpen}
              nodes={nodes as unknown as PaletteNode[]}
              projects={projects.map((p) => ({ id: p.id, name: p.name, cwd: p.cwd }))}
              liveAgents={liveAgents}
              onClose={() => setPaletteOpen(false)}
              onPick={(kind, id) => {
                /* 跨项目跳转：目标节点可能不在当前画布上。先切板再聚焦 ——
                   focusNode 在别的板上找不到那个 id，会静默什么都不做。 */
                if (kind === 'project') return switchProject(id)
                const here = nodesRef.current.some((n) => n.id === id)
                if (here) return focusNode(id)
                const owner = Object.entries(boardsRef.current).find(([, b]) =>
                  b.nodes.some((n) => n.id === id)
                )?.[0]
                if (!owner) return
                switchProject(owner)
                // 切板会整块换掉 nodes，等一帧再聚焦
                setTimeout(() => focusNode(id), 0)
              }}
            />
            <MessageCenter
              nodes={nodes}
              approvals={approvals}
              onFocus={focusNode}
              onDecide={decideApproval}
            />
          </Panel>
          {/* 浏览器式顶部标签条：贴顶、满宽、横向滚动 */}
          <Panel position="top-center" className="project-tabbar">
            <div className="project-tabs">
              {projects.map((p) => (
                <button
                  key={p.id}
                  className={`project-tab${p.id === activeProject ? ' active' : ''}`}
                  title={p.cwd ? shortPath(p.cwd) : '未指定目录（终端在 ~ 启动）'}
                  onClick={() => switchProject(p.id)}
                >
                  <span className="project-tab-name">{p.name}</span>
                  {p.cwd && <span className="project-tab-cwd">{shortPath(p.cwd)}</span>}
                  {projects.length > 1 && (
                    <span
                      className="project-tab-close"
                      onClick={(e) => {
                        e.stopPropagation()
                        closeProject(p.id)
                      }}
                    >
                      ✕
                    </span>
                  )}
                </button>
              ))}
              <button className="project-tab add" title="打开项目文件夹" onClick={addProject}>
                ＋
              </button>
            </div>
          </Panel>
          <Panel position="top-left" className="board-top">
            <div className={`toolbar${canvasPrefs.toolbarCollapsed ? ' collapsed' : ''}`}>
            {/* 拆分按钮：最高频的「新建终端」保持一键，其余节点类型收进下拉。
                此前 4 个带文字 + 3 个纯图标混排，没有主次，视觉也乱。 */}
            <span className="agent-menu-wrap split">
              <button
                className="toolbar-btn split-main"
                title="新建终端"
                onClick={() => addTerminal()}
              >
                <IconTerminal />
                <span>新建终端</span>
              </button>
              <button
                className="toolbar-btn split-caret"
                title="新建其他节点：agent 预设 / 简报 / 浏览器"
                onClick={() => setShowAgentMenu((s) => !s)}
              >
                <IconChevron />
              </button>
              {showAgentMenu && (
                <div className="agent-menu">
                  <div className="agent-menu-label">Agent 预设</div>
                  {presets.map((p) => (
                    <button
                      key={p.id}
                      className="agent-menu-item"
                      onClick={() => {
                        setShowAgentMenu(false)
                        addTerminal(p)
                      }}
                    >
                      <span className={`identity-provider ${p.provider}`}>{p.provider}</span>
                      {p.name}
                    </button>
                  ))}
                  <div className="ctx-menu-sep" />
                  <button
                    className="agent-menu-item"
                    onClick={() => {
                      setShowAgentMenu(false)
                      openContextHub()
                    }}
                  >
                    <IconBrief />
                    项目简报（共享上下文）
                  </button>
                  <button
                    className="agent-menu-item"
                    onClick={() => {
                      setShowAgentMenu(false)
                      addBrowser()
                    }}
                  >
                    <IconGlobe />
                    画布内浏览器
                  </button>
                  {identities.length > 0 && (
                    <>
                      <div className="ctx-menu-sep" />
                      <div className="agent-menu-label">凭证节点（连到终端 = 换账号）</div>
                      {identities.map((i) => (
                        <button
                          key={i.id}
                          className="agent-menu-item"
                          onClick={() => {
                            setShowAgentMenu(false)
                            addCredential(i.id)
                          }}
                        >
                          <span className={`identity-provider ${i.provider}`}>{i.provider}</span>
                          {i.name}
                        </button>
                      ))}
                    </>
                  )}
                  <div className="ctx-menu-sep" />
                  <button
                    className="agent-menu-item manage"
                    onClick={() => {
                      setShowAgentMenu(false)
                      setSettingsOpen('presets')
                    }}
                  >
                    管理预设…
                  </button>
                </div>
              )}
            </span>
            {!canvasPrefs.toolbarCollapsed && selectedCount >= 2 && (
              <button className="toolbar-btn accent" onClick={groupSelected}>
                <IconGroup />
                <span>成组 {selectedCount}</span>
              </button>
            )}
            {!canvasPrefs.toolbarCollapsed && identities.length > 0 && (
              <select
                className="identity-select"
                value={defaultIdentity}
                title="新终端使用的默认身份"
                onChange={(e) => setDefaultIdentity(e.currentTarget.value)}
              >
                <option value="">默认身份</option>
                {identities.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            )}
            {!canvasPrefs.toolbarCollapsed && (
              <>
                <span className="toolbar-sep" />
                <button
                  className="toolbar-btn icon-only"
                  title="凭证管理"
                  onClick={() => setSettingsOpen('identities')}
                >
                  <IconKey />
                </button>
                <button
                  className="toolbar-btn icon-only"
                  title="设置"
                  onClick={() => setSettingsOpen('general')}
                >
                  <IconSettings />
                </button>
                <span className="toolbar-count">{nodes.length}</span>
              </>
            )}
            {/* 折叠钮。**永远在最右**,展开/收起位置不变 —— 位置一跳,
                用户第二次就找不到它了。 */}
            <button
              className="toolbar-collapse"
              title={canvasPrefs.toolbarCollapsed ? '展开工具栏' : '收起工具栏'}
              onClick={() => patchCanvasPrefs({ toolbarCollapsed: !canvasPrefs.toolbarCollapsed })}
            >
              <IconChevron />
            </button>
            </div>
          </Panel>
          {menu && (
            <div
              className="ctx-menu"
              style={{ left: menu.x, top: menu.y }}
              onMouseLeave={() => setMenu(null)}
            >
              {menu.edgeId && (
                <>
                  <div className="ctx-menu-title">
                    {edges.find((e) => e.id === menu.edgeId)?.data?.kind === 'context'
                      ? '上下文注入连线'
                      : '派活 / 驱动授权连线'}
                  </div>
                  <button
                    className="ctx-menu-item danger"
                    onClick={() => {
                      setEdges((es) => es.filter((e) => e.id !== menu.edgeId))
                      setMenu(null)
                    }}
                  >
                    删除连线（撤销该授权）
                  </button>
                </>
              )}
              {menu.selection && (
                <>
                  <button
                    className="ctx-menu-item"
                    onClick={() => {
                      groupSelected()
                      setMenu(null)
                    }}
                  >
                    <IconGroup />
                    成组（{selectedCount}）
                  </button>
                  <button
                    className="ctx-menu-item danger"
                    onClick={() => {
                      // 选中里若有集群，子节点要一起删 —— 否则组没了、子节点还留着
                      // parentId 和 hidden:true，变成永远看不见也删不掉的孤儿
                      const selIds = new Set(nodes.filter((n) => n.selected).map((n) => n.id))
                      const gone = nodes
                        .filter((n) => n.selected || (n.parentId && selIds.has(n.parentId)))
                        .map((n) => n.id)
                      void removeNodes(gone, `删除选中的 ${gone.length} 个节点`)
                      setMenu(null)
                    }}
                  >
                    删除选中（{selectedCount}）
                  </button>
                </>
              )}
              {!menu.nodeId && !menu.selection && !menu.edgeId && (
                <>
                  <button
                    className="ctx-menu-item"
                    onClick={() => {
                      addTerminal()
                      setMenu(null)
                    }}
                  >
                    <IconTerminal />
                    新建终端
                  </button>
                  {presets.map((p) => (
                    <button
                      key={p.id}
                      className="ctx-menu-item"
                      onClick={() => {
                        addTerminal(p)
                        setMenu(null)
                      }}
                    >
                      <IconAgent />
                      新建 {p.name}
                    </button>
                  ))}
                  <div className="ctx-menu-sep" />
                  <button
                    className="ctx-menu-item"
                    onClick={() => {
                      openContextHub()
                      setMenu(null)
                    }}
                  >
                    <IconBrief />
                    项目简报
                  </button>
                  <button
                    className="ctx-menu-item"
                    onClick={() => {
                      addBrowser()
                      setMenu(null)
                    }}
                  >
                    <IconGlobe />
                    浏览器
                  </button>
                  <button
                    className="ctx-menu-item"
                    onClick={() => {
                      void fitView({ padding: 0.2, duration: 300 })
                      setMenu(null)
                    }}
                  >
                    <IconFit />
                    适应全部
                  </button>
                </>
              )}
              {menu.nodeId && (
                <>
                  {menuNode?.type === 'terminal' && (
                    <>
                      <button className="ctx-menu-item" onClick={() => bumpFont(1)}>
                        字号放大
                        <span className="ctx-menu-hint">⌥滚轮</span>
                      </button>
                      <button className="ctx-menu-item" onClick={() => bumpFont(-1)}>
                        字号缩小
                        <span className="ctx-menu-hint">⌥滚轮</span>
                      </button>
                      <div className="ctx-menu-sep" />
                    </>
                  )}
                  {selectedCount >= 2 && (
                    <button
                      className="ctx-menu-item"
                      onClick={() => {
                        groupSelected()
                        setMenu(null)
                      }}
                    >
                      <IconGroup />
                      成组（{selectedCount}）
                    </button>
                  )}
                  <button className="ctx-menu-item danger" onClick={deleteMenuNode}>
                    删除
                    {menuNode?.type === 'terminal' && (
                      <span className="ctx-menu-hint">结束会话</span>
                    )}
                  </button>
                </>
              )}
            </div>
          )}
        </ReactFlow>
      </div>
      </RequestDeleteContext.Provider>
      </TmuxContext.Provider>
    </IdentityContext.Provider>
  )
}

export default function App(): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <Board />
    </ReactFlowProvider>
  )
}
