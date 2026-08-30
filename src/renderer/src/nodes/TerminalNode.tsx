import { memo, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { IdentityContext, RequestDeleteContext } from '../identity-context'
import { FarChip, FAR_ZOOM } from './FarChip'
import { usePinchZoom } from '../usePinchZoom'
import { fitToNode } from '../fit-to-node'
import {
  Handle,
  NodeResizer,
  Position,
  useReactFlow,
  useStore,
  type Node,
  type NodeProps
} from '@xyflow/react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

export type TermStatus = 'running' | 'idle' | 'attention' | 'error'
export type TermNode = Node<
  {
    title: string
    status: TermStatus
    identityId?: string
    command?: string // agent 预设启动命令
    provider?: string
    fontSize?: number
    cwd?: string
    /** 自增即重开会话（集群批量重启用）；不持久化 */
    restartTick?: number
    /** 凭证由画布上的连线决定（此时锁掉下拉，避免同一件事两个入口互相打架）；不持久化 */
    credBound?: boolean
    /**
     * 布局模板带来的**建议**命令。**和 `command` 是两个字段，这是有意的** ——
     * `command` 会被 spawn 自动执行，而模板来自外部文件，绝不能自动跑。
     * 用户点节点上那个按钮，才把它变成 command 并重开会话。
     */
    suggestedCommand?: string
  },
  'terminal'
>

/**
 * 退化成 LOD 占位的判据：**屏幕上的有效字号**，不是画布缩放。
 *
 * 老判据是 `zoom < 0.35` —— 一刀切，与节点多大、字号多少无关。
 * 于是把节点拉大、或把字号调到 20，屏幕上明明还看得见纹理，却照样被收成一块占位。
 * 用户报的就是这个：节点在屏幕上还很大，内容已经没了。
 *
 * 换成 `fontSize × zoom`，它直接就是「这行字在屏幕上有几个像素高」——
 * 也就是「还看不看得出东西」本身。字号 13 时等价 zoom 0.154（旧的是 0.35），
 * 字号 20 时等价 0.10，正是你把字调大时想要的行为。
 *
 * **为什么是 2 而不是更大**：判据不是"读得出字"，是"看得出结构"。
 * 实测（TERMBOARD_ZOOM 逐档拍图）有效字号 2.4px 时段落分块、彩色行、
 * 空白分布都还认得出 —— 那正是用户要的「缩小但别消失」。低于 2px 塌成均匀灰带。
 *
 * 再往下由 `FAR_ZOOM`(0.14) 接管，直接给状态胶囊。字号 13 时这两条线
 * 几乎重合，所以 LOD 占位实际只在很窄一段出现 —— 这是有意的：
 * 中间态本来就该短，要么看得见内容，要么看状态。
 *
 * 代价已实测（CLAUDE.md「LOD 的账记在 GPU 上」）：16 个终端满负荷时
 * 全渲染 GPU 6.1% / LOD 1.1%，renderer 两者几乎不动。晚一点退化多花的是
 * 合成绘制，不是 xterm 解析 —— 6% 没有要解决的问题。
 */
const LOD_EFFECTIVE_FONT_PX = 2

// macOS Terminal.app 深色系配色 + 系统色
const XTERM_THEME = {
  background: '#131315',
  foreground: '#F5F5F7',
  cursor: '#0A84FF',
  cursorAccent: '#131315',
  selectionBackground: 'rgba(10, 132, 255, 0.28)',
  black: '#2C2C2E',
  red: '#FF453A',
  green: '#30D158',
  yellow: '#FF9F0A',
  blue: '#0A84FF',
  magenta: '#BF5AF2',
  cyan: '#64D2FF',
  white: '#F5F5F7',
  brightBlack: '#636366',
  brightRed: '#FF6961',
  brightGreen: '#66E884',
  brightYellow: '#FFB340',
  brightBlue: '#409CFF',
  brightMagenta: '#DA8FFF',
  brightCyan: '#70D7FF',
  brightWhite: '#FFFFFF'
}

const STATUS_LABEL: Record<TermStatus, string> = {
  running: '运行中',
  attention: '需要你',
  idle: '空闲',
  error: '已退出'
}

const FONT_MIN = 8
const FONT_MAX = 24
const FONT_DEFAULT = 13

function TerminalNodeImpl({ id, data, selected }: NodeProps<TermNode>): React.JSX.Element {
  const holderRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const zoom = useStore((s) => s.transform[2])
  /* **实际生效的字号**，不是用户设的那个 —— 节点尺寸会把它等比放大缩小
     （见 fit-to-node.ts）。LOD 判的是"屏幕上有几个像素高"，
     拿 data.fontSize 判就等于假装节点还是参照尺寸：把节点拉大一倍再缩画布，
     屏幕上字还很清楚，内容却已经被收成一块占位。 */
  const [effFont, setEffFont] = useState(data.fontSize ?? FONT_DEFAULT)
  /**
   * 把新格子数交给 pty。**防抖 80ms。**
   *
   * 主进程那道「尺寸没变就不发」的守卫挡不住拖拽：`fitToNode` 按**整数**字号算，
   * 拖动边框时字号会一档一档跳（13→14→13），每跳一次 cols/rows 就真的变一次，
   * 于是每帧一个 SIGWINCH，zsh 每收到一次重画一遍 prompt —— 屏幕上刷出几十行
   * 一模一样的提示符。xterm 那侧照旧每帧 fit（视觉跟手），只有**发给 pty 的
   * 那一下**压到停顿之后。
   */
  const sizeTimer = useRef(0)
  const pushSize = (cols: number, rows: number): void => {
    window.clearTimeout(sizeTimer.current)
    sizeTimer.current = window.setTimeout(() => window.termspace.resize(id, cols, rows), 80)
  }
  // 判据是屏幕上的有效字号，不是缩放本身 —— 见 LOD_EFFECTIVE_FONT_PX
  const lod = effFont * zoom < LOD_EFFECTIVE_FONT_PX
  const far = zoom < FAR_ZOOM

  // 连到本终端的简报节点（画布连线决定注入哪份上下文）
  const ctxIds = useStore((s) =>
    s.edges
      .filter((e) => e.target === id && e.data?.kind === 'context')
      .map((e) => e.source)
      .toSorted()
      .join(',')
  )
  const { updateNodeData } = useReactFlow()
  const identities = useContext(IdentityContext)
  const requestDelete = useContext(RequestDeleteContext)
  const [editing, setEditing] = useState(false)
  const [ctxPct, setCtxPct] = useState<number | null>(null)
  /* 起这个会话时注入的是哪几份上下文。和当前连线不一致 = 会话里的 system prompt
     还是旧的 —— tmux 接回已存在会话时启动命令不会重跑，改连线改不了它。 */
  const [injectedCtx, setInjectedCtx] = useState<string | null>(null)
  const ctxStale = injectedCtx !== null && injectedCtx !== ctxIds
  const [fontHint, setFontHint] = useState(false)

  // per-node 订阅，避免高频 usage 更新走 setNodes 触发全画布 rerender
  useEffect(
    () =>
      window.termspace.onAgentContext((e) => {
        if (e.nodeId === id) setCtxPct(e.usedPercent)
      }),
    [id]
  )

  useEffect(() => {
    const el = holderRef.current
    if (!el) return

    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: data.fontSize ?? FONT_DEFAULT,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: XTERM_THEME,
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    termRef.current = term
    fitRef.current = fit
    let webgl: WebglAddon | undefined
    try {
      /* Chromium 每页 ~16 个 WebGL context 上限，超限最老的被强制丢弃。
         这条降级路径已实测（`TERMBOARD_WEBGL_STRESS=20 npm run dev`）：
         开 20 个终端 → 17 个拿到 context、3 个一开始就走 DOM renderer；
         再打爆 → contextlost 触发 16 次，那 16 个全部变成 `rowDivs:18` 的 DOM 渲染，
         **字还在，不需要额外 refresh**（addon 的 dispose 内部会 setRenderer + handleResize）。

         ⚠️ 验证时注意：addon 收到 webglcontextlost 后会**先等满 3 秒**看 context 会不会
         自己恢复，之后才 fire onContextLoss。测量窗口短于 3s 会得出"降级失效"的错误结论
         （我第一次就这么误判过）。 */
      webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl?.dispose())
      term.loadAddon(webgl)
    } catch {
      /* WebGL 不可用 → xterm 自动落回 DOM renderer。
         但**必须显式 dispose**：AddonManager 是 `_addons.push()` 之后才 `activate()`，
         activate 抛错时这个半死的 addon 仍留在列表里，term.dispose() 时还会被再调一次。 */
      webgl?.dispose()
      webgl = undefined
    }
    setEffFont(fitToNode(term, fit, data.fontSize ?? FONT_DEFAULT))

    /* 起不来的原因要写进屏幕。**不写的话这个终端就是一块纯黑板** ——
       用户看不出是"还没输出"还是"根本没起来"，这正是这个项目反复栽的静默失败。 */
    const offSpawnErr = window.termspace.onSpawnError((e) => {
      if (e.nodeId !== id) return
      term.write(`\r\n\x1b[38;5;203m[起不来] ${e.message}\x1b[0m\r\n`)
      updateNodeData(id, { status: 'error' })
    })
    const offData = window.termspace.onData(id, (d) => term.write(d))
    const offExit = window.termspace.onExit(id, (code) => {
      term.write(`\r\n\x1b[38;5;244m[进程已退出 code=${code}]\x1b[0m\r\n`)
      // 非零退出 = 真出事了，红边框比一行灰字显眼得多（缩到全景也看得见）
      if (code !== 0) updateNodeData(id, { status: 'error' })
    })
    /* 记下这一轮注入的是哪几份上下文。**注意这只在真 fresh 时才是准的** ——
       接回已存在的会话时启动命令不会重跑，那个会话里的 system prompt 是它
       自己起来那次注入的。这里当基线用：之后连线一变就显示 stale，
       让用户自己决定要不要重开，而不是替他猜。 */
    setInjectedCtx(ctxIds)
    void window.termspace.spawn(id, term.cols, term.rows, {
      identityId: data.identityId,
      command: data.command,
      provider: data.provider,
      contextNodeIds: ctxIds ? ctxIds.split(',') : [],
      cwd: data.cwd
    })
    const inputSub = term.onData((d) => window.termspace.write(id, d))

    // Warp 式复制粘贴：选中即可复制（⌘C），⌘V 粘贴；右键也走这套
    const onKey = term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !(e.metaKey || e.ctrlKey)) return true
      if (e.key === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        return false
      }
      if (e.key === 'v') {
        void navigator.clipboard.readText().then((t) => window.termspace.write(id, t))
        return false
      }
      return true
    })
    void onKey

    let raf = 0
    const ro = new ResizeObserver(() => {
      // rAF 合帧：NodeResizer 拖拽期间每帧触发
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        /* 尺寸为 0 时**不能 fit**：那会把 cols/rows 算成 1×1 并真的发给 pty，
           shell 会照着重排一遍输出，用户回来看到的是一屏被揉烂的历史。
           元素被 display:none / 折叠 / 尚未布局时都会走到这里。 */
        if (!el.clientWidth || !el.clientHeight) return
        setEffFont(fitToNode(term, fit, data.fontSize ?? FONT_DEFAULT))
        pushSize(term.cols, term.rows)
      })
    })
    ro.observe(el)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      inputSub.dispose()
      offSpawnErr()
      offData()
      offExit()
      window.termspace.kill(id)
      termRef.current = null
      fitRef.current = null
      term.dispose()
    }
    // identityId/command 变更 = 重生成会话（cleanup kill → respawn）
    // fontSize 故意不在依赖里：改字号只重排，不重开会话
    // restartTick 变更 = 批量重启：调用方已 destroy 掉旧会话，这里重跑即新开
    //
    // ⚠️ **ctxIds 故意不在依赖里**。它以前在，注释还写着"上下文是启动时注入的，
    // 所以要重生成" —— 但 cleanup 走的是 releasePty（会话续存），respawn 用
    // `new-session -A` 接回同一个会话，**启动命令根本不会再跑一遍**。
    // 于是 effect 白重跑一轮，`--append-system-prompt` 仍是旧快照，
    // 而画布上连线显示"已连接"。这是最难查的那种静默错：看起来生效了。
    // 现在改成如实显示 stale + 让用户显式重开（见下面的 ctxStale）。
  }, [id, data.identityId, data.command, data.cwd, data.restartTick])

  // 字号变更：改渲染 + refit + 通知 pty 新 cols/rows（会话不动）
  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    // 走同一条 fitToNode —— 否则用户设的字号会绕过窄节点的自动缩小
    setEffFont(fitToNode(term, fit, data.fontSize ?? FONT_DEFAULT))
    // 同样防抖：⌥滚轮连着滚几下也是一串阶跃
    pushSize(term.cols, term.rows)
  }, [id, data.fontSize])

  // 字号改动时头部短暂提示当前值（⌥滚轮 / 右键菜单调节）
  const hintTimer = useRef(0)
  const stepFont = (delta: number): void => {
    const next = Math.min(FONT_MAX, Math.max(FONT_MIN, (data.fontSize ?? FONT_DEFAULT) + delta))
    updateNodeData(id, { fontSize: next })
    setFontHint(true)
    window.clearTimeout(hintTimer.current)
    hintTimer.current = window.setTimeout(() => setFontHint(false), 1200)
  }
  useEffect(
    () => () => {
      window.clearTimeout(hintTimer.current)
      window.clearTimeout(sizeTimer.current)
    },
    []
  )

  /* 内容区滚轮分流（原生 non-passive 监听，见 usePinchZoom 注释）：
     pinch → 缩放画布；⌥+滚轮 → 调字号；**普通滚轮一律归终端**。
     这里不再判"终端还能不能回滚"——那个滚动链是个每天都在烦人的设计错误，
     新开的 shell 没有回滚历史，判断立刻为假，于是每次滚动都在平移画布。 */
  const attachWheel = usePinchZoom((e) => {
    if (e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      stepFont(e.deltaY < 0 ? 1 : -1)
      return true
    }
    /* 返回 false = 不管它，让事件继续往下走。**绝不能 stopPropagation**：
       这是祖先的 capture 阶段，拦下来 xterm（监听在子元素 .xterm 上）就收不到了。 */
    return false
  })
  const setHolder = useCallback(
    (el: HTMLDivElement | null): void => {
      holderRef.current = el
      attachWheel(el)
    },
    [attachWheel]
  )

  return (
    <div
      className={`term-node status-${data.status}${selected ? ' selected' : ''}${
        far ? ` far far-${data.status}` : ''
      }`}
    >
      {/* 手柄透明：拖节点边角即可缩放，不用四个丑圆点；选中态改用发光边框表达 */}
      <NodeResizer
        minWidth={360}
        minHeight={220}
        isVisible
        handleStyle={{ opacity: 0, width: 16, height: 16, border: 'none' }}
        lineStyle={{ opacity: 0, borderWidth: 8 }}
      />
      {/* 左：接收（简报注入 / 被上游派活）；右：派活给下游 agent */}
      <Handle type="target" position={Position.Left} className="tb-handle in" />
      <Handle type="source" position={Position.Right} className="tb-handle out" />
      <div className="term-node-header">
        <span className={`status-dot ${data.status}`} />
        {editing ? (
          <input
            className="term-node-title-input nodrag"
            defaultValue={data.title}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim()
              if (v) updateNodeData(id, { title: v })
              setEditing(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <span className="term-node-title" onDoubleClick={() => setEditing(true)}>
            {data.title}
          </span>
        )}
        {identities.length > 0 && (
          <select
            className="identity-select nodrag"
            value={data.identityId ?? ''}
            disabled={data.credBound}
            title={
              data.credBound
                ? '凭证由画布上连过来的凭证节点决定 —— 想换就改连线（删线即回默认身份）'
                : '切换凭证会重开会话'
            }
            onChange={(e) => {
              const next = e.currentTarget.value || undefined
              if (next === data.identityId) return
              /* **同一件事的两个入口，防护必须一样重**：从画布拉一条凭证连线会弹确认，
                 从这个下拉切却是立刻 destroy —— 而后果完全相同（结束 tmux 会话和
                 里面正在跑的 agent，不可撤销）。多账号用户恰恰最常点这个下拉。 */
              const to = next ? (identities.find((i) => i.id === next)?.name ?? next) : '默认身份'
              if (
                !window.confirm(
                  `把「${data.title}」切到「${to}」？\n\n` +
                    '会关掉这个终端当前的会话并用新账号重开，正在跑的进程会结束。\n' +
                    '（凭证只负责隔离登录态，新账号第一次仍需在终端里登录一次）'
                )
              ) {
                // 用户取消：把 select 的显示值拨回去（受控组件，重渲染即恢复）
                e.currentTarget.value = data.identityId ?? ''
                return
              }
              // 换身份 = 新 env → 必须真杀旧会话（否则 tmux -A 会接回旧 env 的会话）
              void window.termspace.destroy(id)
              updateNodeData(id, { identityId: next })
            }}
          >
            <option value="">默认身份</option>
            {identities.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        )}
        {fontHint && <span className="font-hint">{effFont} px</span>}
        {ctxPct !== null && (
          <span
            className={`ctx-meter ${ctxPct > 80 ? 'hot' : ctxPct > 60 ? 'warm' : ''}`}
            title={`上下文已用 ${ctxPct}%`}
          >
            <span className="ctx-fill" style={{ width: `${ctxPct}%` }} />
          </span>
        )}
        {/* 连线改了但会话里的 system prompt 还是旧的。**必须显式说出来** ——
            以前的做法是让 effect 重跑一轮假装重新注入了，而 tmux 接回已存在会话
            时启动命令根本不会再执行。点它才真重开（会结束正在跑的那一轮）。 */}
        {/* 模板铺出来的建议命令：**显示但不执行**。点了才变成真的启动命令。
            外部文件里的命令自动执行是今天刚修的那个 P0，这里不能重蹈。 */}
        {data.suggestedCommand && !data.command && (
          <button
            className="status-chip attention nodrag"
            title={`建议命令（来自布局模板，尚未执行）：\n${data.suggestedCommand}\n\n点击后会以它重开这个终端`}
            onClick={(e) => {
              e.stopPropagation()
              const cmd = data.suggestedCommand ?? ''
              if (!window.confirm(`在这个终端里执行？\n\n${cmd}`)) return
              void window.termspace.destroy(id)
              updateNodeData(id, {
                command: cmd,
                suggestedCommand: undefined,
                restartTick: ((data as { restartTick?: number }).restartTick ?? 0) + 1
              })
            }}
          >
            ▶ 待运行
          </button>
        )}
        {ctxStale && (
          <button
            className="status-chip attention nodrag"
            title="画布上的上下文连线变了，但这个会话启动时注入的还是旧的那份。点击重开会话并注入新上下文（当前跑着的一轮会结束）"
            onClick={(e) => {
              e.stopPropagation()
              if (!window.confirm('重开这个终端并注入新的上下文？\n当前会话会结束，正在跑的那一轮会中断。')) return
              void window.termspace.destroy(id)
              updateNodeData(id, {
                restartTick: ((data as { restartTick?: number }).restartTick ?? 0) + 1
              })
            }}
          >
            上下文已变 · 重开注入
          </button>
        )}
        <span className={`status-chip ${data.status}`}>{STATUS_LABEL[data.status]}</span>
        <button
          className="term-node-close nodrag"
          title="关闭终端（结束会话）"
          onClick={(e) => {
            e.stopPropagation()
            // 走画布统一删除入口：带确认、可撤回、连线一并处理
            requestDelete([id], `关闭终端「${data.title}」`)
          }}
        >
          ✕
        </button>
      </div>
      <div
        ref={setHolder}
        className="term-node-body nodrag nowheel"
        style={{ visibility: lod ? 'hidden' : 'visible' }}
        onContextMenu={(e) => {
          // 终端内右键：有选中就复制，否则粘贴（不弹画布菜单）
          e.preventDefault()
          e.stopPropagation()
          const term = termRef.current
          if (term?.hasSelection()) {
            void navigator.clipboard.writeText(term.getSelection())
          } else {
            void navigator.clipboard.readText().then((t) => window.termspace.write(id, t))
          }
        }}
      />
      {lod && !far && (
        <div className="term-node-lod">
          {/* 内容 ×(1/zoom)，再被画布 ×zoom → **屏幕尺寸恒定**，和 FarChip 同一招。
              不加这个的话 28px 是画布坐标：缩到 0.11 只剩 3px 高，
              这一档就变成「内容没了、字也读不出」，比它两边都糟。
              系数 0.5 让标题固定落在 28×0.5 ≈ 14px 的屏幕高度。
              ⚠️ 是 `max` 不是 `min` —— 这里要的是"至少放大到 1 倍"，
              写成 min 会把 4.6 夹回 1，等于整个反缩放没生效（实测 5px 而不是 17px，
              一量就露馅；靠眼睛看只会觉得"好像没变"）。 */}
          <div
            className="term-node-lod-inner"
            style={{ transform: `scale(${Math.max(1, 0.5 / zoom)})` }}
          >
            <span className={`status-dot big ${data.status}`} />
            <span className="term-node-lod-title">{data.title}</span>
          </div>
        </div>
      )}
      {far && (
        <FarChip
          zoom={zoom}
          dotClass={data.status}
          title={data.title}
          state={STATUS_LABEL[data.status]}
          stateClass={data.status}
          extra={ctxPct !== null ? `${ctxPct}%` : undefined}
        />
      )}
    </div>
  )
}

export default memo(TerminalNodeImpl)
