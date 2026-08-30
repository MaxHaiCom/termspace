/**
 * Termspace 手机端。
 *
 * 刻意不用框架、不用打包器：整个客户端就三个静态文件，主进程白名单直发，
 * 改一行不用重新 build。CSP 也因此能锁到 script-src 'self'（无 'unsafe-inline'），
 * 这对一个把 token 存 localStorage 的页面是硬要求。
 *
 * 交互取向：手机上重现桌面的**空间关系**（哪些 agent 在跑、哪些在等你），
 * 而不是退化成一列 list —— 列表版本在评估里被否掉了，那等于把画布这个差异化点扔了。
 */

const KEYS = {
  enter: '\r',
  esc: '\x1b',
  ctrlc: '\x03',
  up: '\x1b[A',
  down: '\x1b[B',
  tab: '\t'
}

const $ = (id) => document.getElementById(id)
const body = document.body

let token = ''
let latest = null // 最近一次 /api/board 响应
let currentId = null // 正在看的终端
let boardTimer = 0
let peekTimer = 0
/* 往回翻了多少行（0 = 最新一屏）。**看历史时禁掉选项按钮和快捷键** ——
   历史里的「1. Yes」按下去会答到当前这个完全不同的问题上。 */
let peekBefore = 0
const PEEK_LINES = 60
/* 每次往回翻 40 行而不是整屏 60：留 20 行重叠，接得上上下文 */
const PEEK_STEP = 40

// ── 会话 token ───────────────────────────────────────────────────────────────

/* 扫码进来的形态是 http://host:port/#t=<token>。
   立刻落 localStorage 并把 hash 抹掉 —— 留在地址栏里会进历史记录和分享面板。 */
function takeTokenFromUrl() {
  const m = location.hash.match(/[#&]t=([A-Za-z0-9]+)/)
  if (!m) return
  localStorage.setItem('ts.token', m[1])
  history.replaceState(null, '', location.pathname)
}

function screen(name) {
  body.dataset.screen = name
}

// ── HTTP ────────────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    cache: 'no-store'
  })
  if (res.status === 401) {
    // token 失效（电脑上删了 remote-token 重启过）→ 回配对页重来
    localStorage.removeItem('ts.token')
    token = ''
    stopAll()
    screen('pair')
    throw new Error('unauthorized')
  }
  return res
}

// ── 画布 ─────────────────────────────────────────────────────────────────────

const view = { x: 0, y: 0, k: 1 }
const stage = $('stage')
const wires = $('wires')
const nodesEl = $('nodes')

/**
 * 渲染模型：**地图针**，不是缩放整张图。
 *
 * 一开始照搬桌面的做法（整个 world 上 CSS transform scale），在手机上直接崩了：
 * 390px 宽的屏幕要装下几千像素跨度的画布，缩放比落到 0.05 左右，节点变成看不见的
 * 一个点，只剩标签堆在一起。而画布的全部价值就是"扫一眼看出谁在等你" ——
 * 看不见颜色 = 这个功能等于没有。
 *
 * 所以：**坐标跟着缩放，尺寸不跟**。终端是屏幕尺寸恒定的针，组是会缩放的区域框
 * （组表达的是空间归属，该跟着缩）。代价是每帧要用 JS 摆位而不是一句 transform，
 * 但节点数是几十量级，无所谓。
 */
let placed = [] // {el, kind, x, y, w, h}，世界坐标
let wired = [] // {line, ax, ay, bx, by}，世界坐标

function applyView() {
  const { x, y, k } = view
  for (const p of placed) {
    if (p.kind === 'group') {
      p.el.style.left = `${p.x * k + x}px`
      p.el.style.top = `${p.y * k + y}px`
      p.el.style.width = `${p.w * k}px`
      p.el.style.height = `${p.h * k}px`
    } else {
      // 针锚在节点中心；CSS 里 translate(-50%,-50%) 把自己拉回来
      p.el.style.left = `${(p.x + p.w / 2) * k + x}px`
      p.el.style.top = `${(p.y + p.h / 2) * k + y}px`
    }
  }
  for (const w of wired) {
    w.line.setAttribute('x1', w.ax * k + x)
    w.line.setAttribute('y1', w.ay * k + y)
    w.line.setAttribute('x2', w.bx * k + x)
    w.line.setAttribute('y2', w.by * k + y)
  }
  updateLod()
}

/**
 * 挤到一起就退化成圆点。
 *
 * 判据是**实际最近邻屏幕距离**，不是缩放比：同一个缩放比下，三个终端的画布很宽敞，
 * 三十个终端的画布糊成一团。用 k 当阈值会把这两种情况一视同仁。
 * 退化后仍然保留状态色 —— 全景视图要回答的问题是"谁在等我"，不是"它叫什么"。
 */
function updateLod() {
  const pins = placed.filter((p) => p.kind !== 'group')
  let min = Infinity
  for (let i = 0; i < pins.length && min > 120; i++) {
    for (let j = i + 1; j < pins.length; j++) {
      const a = pins[i]
      const b = pins[j]
      const dx = (a.x + a.w / 2 - (b.x + b.w / 2)) * view.k
      const dy = (a.y + a.h / 2 - (b.y + b.h / 2)) * view.k
      const d = Math.hypot(dx, dy)
      if (d < min) min = d
    }
  }
  stage.dataset.lod = min < 120 ? 'dot' : 'full'
}

/** React Flow 里子节点坐标是相对父节点的，画之前先摊平成绝对坐标 */
function absolutePositions(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const abs = new Map()
  const resolve = (n, seen = new Set()) => {
    if (abs.has(n.id)) return abs.get(n.id)
    // parentId 理论上不会成环，但坏掉的工作区文件能让它成环，这里兜一下
    if (seen.has(n.id)) return { x: n.x, y: n.y }
    seen.add(n.id)
    const p = n.parentId ? byId.get(n.parentId) : null
    const base = p ? resolve(p, seen) : { x: 0, y: 0 }
    const pos = { x: base.x + n.x, y: base.y + n.y }
    abs.set(n.id, pos)
    return pos
  }
  for (const n of nodes) resolve(n)
  return abs
}

const STATE_LABEL = {
  running: '运行中',
  attention: '等你',
  done: '完成',
  idle: '空闲',
  session: '会话中',
  error: '出错'
}

/* 上一次的布局签名。轮询每 2.5s 回来一次，但布局多数时候没变 —— 只有状态在变。
   不比对就整棵重建 DOM：白烧电，而且重建瞬间点下去的那一下会落空（实测被咬过）。 */
let layoutSig = ''

function renderBoard(data) {
  const b = data.board
  if (!b || !Array.isArray(b.nodes)) {
    $('board-foot').textContent = '电脑端画布还没上报（主窗口是不是没打开？）'
    return
  }
  const visible = b.nodes.filter((n) => !n.hidden)
  const abs = absolutePositions(visible)
  const size = (n) => ({ w: n.width || 320, h: n.height || 200 })
  updateFoot(b, visible)

  const sig = JSON.stringify([
    visible.map((n) => [n.id, n.type, n.x, n.y, n.width, n.height, n.parentId]),
    (b.edges || []).map((e) => [e.id, e.source, e.target, e.kind])
  ])
  if (sig === layoutSig) {
    // 布局没变 → 只刷状态，DOM 保持原样
    for (const p of placed) {
      if (p.kind === 'group') continue
      const n = visible.find((x) => x.id === p.el.dataset.id)
      if (!n) continue
      if (n.status) p.el.dataset.status = n.status
      const st = p.el.querySelector('.pin-state')
      if (st && n.status) st.textContent = STATE_LABEL[n.status] || n.status
      const ti = p.el.querySelector('.pin-title')
      if (ti) ti.textContent = n.title || n.id
    }
    return
  }
  layoutSig = sig

  nodesEl.textContent = ''
  placed = []
  // 组先建，压在针底下
  const ordered = [...visible].toSorted((a, c) => (a.type === 'group' ? -1 : c.type === 'group' ? 1 : 0))
  for (const n of ordered) {
    const p = abs.get(n.id)
    const { w, h } = size(n)
    if (n.type === 'group') {
      const box = document.createElement('div')
      box.className = 'zone'
      const lbl = document.createElement('span')
      lbl.className = 'zone-label'
      lbl.textContent = n.title || '集群'
      box.append(lbl)
      nodesEl.append(box)
      placed.push({ el: box, kind: 'group', x: p.x, y: p.y, w, h })
      continue
    }
    const el = document.createElement('button')
    el.type = 'button'
    el.className = `pin pin-${n.type}`
    el.dataset.id = n.id
    if (n.status) el.dataset.status = n.status

    const dot = document.createElement('span')
    dot.className = 'pin-dot'
    const title = document.createElement('span')
    title.className = 'pin-title'
    title.textContent = n.title || n.id // textContent：标题是用户输入，绝不进 innerHTML
    el.append(dot, title)
    if (n.status) {
      const st = document.createElement('span')
      st.className = 'pin-state'
      st.textContent = STATE_LABEL[n.status] || n.status
      el.append(st)
    }
    nodesEl.append(el)
    placed.push({ el, kind: n.type, x: p.x, y: p.y, w, h })
  }

  // 连线
  wires.textContent = ''
  wired = []
  const center = (id) => {
    const n = visible.find((x) => x.id === id)
    const p = abs.get(id)
    if (!n || !p) return null
    const { w, h } = size(n)
    return { x: p.x + w / 2, y: p.y + h / 2 }
  }
  for (const e of b.edges || []) {
    const a = center(e.source)
    const c = center(e.target)
    if (!a || !c) continue
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line.setAttribute('class', `w w-${e.kind}`)
    wires.append(line)
    wired.push({ line, ax: a.x, ay: a.y, bx: c.x, by: c.y })
  }

  applyView()
}

function updateFoot(b, visible) {
  const proj = (b.projects || []).find((p) => p.id === b.activeProjectId)
  $('board-title').textContent = proj ? proj.name : '画布'
  const terms = visible.filter((n) => n.type === 'terminal')
  const busy = terms.filter((n) => n.status === 'running').length
  const wait = terms.filter((n) => n.status === 'attention').length
  $('board-foot').textContent = `${terms.length} 终端 · ${busy} 运行中 · ${wait} 等你`
}

/* 下限 0.02 够装下很散的画布；上限 3 之外就该点进终端看内容了，再放大没意义 */
const clampK = (k) => Math.max(0.02, Math.min(3, k))

/**
 * 缩放到全部。
 *
 * 只框**终端和集群** —— 简报节点和浏览器窗口常年被丢在画布几千像素外，
 * 把它们算进包围盒会让真正要看的那簇终端被挤成一个点（实测就是这样）。
 * 没有终端时才退回框住所有节点。
 */
function fit() {
  const care = placed.filter((p) => p.kind === 'terminal' || p.kind === 'group')
  const use = care.length ? care : placed
  if (!use.length) return
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of use) {
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x + p.w)
    y1 = Math.max(y1, p.y + p.h)
  }
  const w = Math.max(1, x1 - x0)
  const h = Math.max(1, y1 - y0)
  const r = stage.getBoundingClientRect()
  // 留 72px 边距：针是屏幕尺寸恒定的，贴边的针会被裁掉一半
  const pad = 72
  const k = clampK(Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / h))
  view.k = k
  view.x = (r.width - w * k) / 2 - x0 * k
  view.y = (r.height - h * k) / 2 - y0 * k
  applyView()
}

// ── 触摸：单指平移 / 双指缩放 ────────────────────────────────────────────────

let gesture = null
let moved = false

const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
const mid = (t) => ({
  x: (t[0].clientX + t[1].clientX) / 2,
  y: (t[0].clientY + t[1].clientY) / 2
})

stage.addEventListener(
  'touchstart',
  (e) => {
    const t = e.touches
    moved = false
    if (t.length === 1) {
      gesture = { mode: 'pan', x: t[0].clientX, y: t[0].clientY, vx: view.x, vy: view.y }
    } else if (t.length === 2) {
      const m = mid(t)
      gesture = { mode: 'zoom', d: dist(t), k: view.k, mx: m.x, my: m.y, vx: view.x, vy: view.y }
    }
  },
  { passive: true }
)

stage.addEventListener(
  'touchmove',
  (e) => {
    if (!gesture) return
    const t = e.touches
    // 画布要吃掉手势，否则 Safari 会把它当成页面滚动/回弹
    e.preventDefault()
    if (gesture.mode === 'pan' && t.length === 1) {
      const dx = t[0].clientX - gesture.x
      const dy = t[0].clientY - gesture.y
      if (Math.abs(dx) + Math.abs(dy) > 8) moved = true
      view.x = gesture.vx + dx
      view.y = gesture.vy + dy
      applyView()
    } else if (gesture.mode === 'zoom' && t.length === 2) {
      moved = true
      const k = clampK((gesture.k * dist(t)) / gesture.d)
      // 以双指中点为不动点缩放
      const r = stage.getBoundingClientRect()
      const cx = gesture.mx - r.left
      const cy = gesture.my - r.top
      view.x = cx - ((cx - gesture.vx) * k) / gesture.k
      view.y = cy - ((cy - gesture.vy) * k) / gesture.k
      view.k = k
      applyView()
    }
  },
  { passive: false }
)

/* touchend / touchcancel 都要收手；而且要按剩下的手指数**重建**手势状态：
   双指里松开一根后 touches.length 变 1，若还留着 zoom 手势，下一次 move 会拿
   单指去算双指距离 → 缩放跳飞。来电/通知会发 touchcancel，漏了会卡住手势。 */
const endGesture = (e) => {
  const t = e.touches
  if (t.length === 1) {
    gesture = { mode: 'pan', x: t[0].clientX, y: t[0].clientY, vx: view.x, vy: view.y }
  } else {
    gesture = null
  }
}
stage.addEventListener('touchend', endGesture)
stage.addEventListener('touchcancel', endGesture)

nodesEl.addEventListener('click', (e) => {
  if (moved) return // 刚才在拖画布，不是点节点
  const el = e.target.closest('.pin[data-id]')
  if (!el) return
  const n = (latest?.board?.nodes || []).find((x) => x.id === el.dataset.id)
  if (n && n.type !== 'terminal') return // 浏览器/简报节点手机上暂时只显示，不进详情
  openTerm(el.dataset.id)
})

// ── 单终端 ───────────────────────────────────────────────────────────────────

/**
 * 认出「1. Yes, I trust this folder」这类编号选项，变成可点按钮。
 * 和桌面 MessageCenter 用同一条正则 —— TUI 菜单本来就是键盘驱动的，
 * 手机上没有键盘，这几个按钮是能不能用起来的分界线。
 */
function parseChoices(text) {
  const out = []
  for (const raw of text.split('\n')) {
    const m = raw.match(/^\s*[❯>▸*]?\s*(\d{1,2})[.)、]\s+(\S.*?)\s*$/)
    if (!m) continue
    if (out.some((o) => o.key === m[1])) continue
    out.push({ key: m[1], label: m[2].slice(0, 40) })
  }
  return out.length >= 2 ? out.slice(0, 6) : []
}

/** 按状态给的语义快捷键：等你 → 作答；跑完/空闲 → 推进 */
function quickFor(status) {
  if (status === 'attention') return ['是', '否', '继续']
  if (status === 'running') return ['状态？']
  return ['继续', '跑一下测试', '总结一下进度', 'git status']
}

function nodeById(id) {
  return (latest?.board?.nodes || []).find((n) => n.id === id)
}

function openTerm(id) {
  currentId = id
  peekBefore = 0
  const n = nodeById(id)
  $('term-title').textContent = n?.title || id
  $('screen-text').textContent = '读取中…'
  // 从一个翻着历史的终端切过来时，别让旧的「往前 N 行」留在屏幕上
  renderPeekbar(false)
  $('choices').textContent = ''
  $('quick').textContent = ''
  screen('term')
  refreshTerm()
  clearInterval(peekTimer)
  peekTimer = setInterval(refreshTerm, 1300)
}

function closeTerm() {
  currentId = null
  peekBefore = 0
  clearInterval(peekTimer)
  peekTimer = 0
  screen('board')
}

async function refreshTerm() {
  if (!currentId || document.hidden) return
  /* 必须把目标 id 钉在这一刻。慢网下打开 A、马上切到 B，A 的迟到响应会覆盖 B 的屏幕，
     而选项按钮读的是全局 currentId —— 用户看着 A 的问题，答案发进了 B。 */
  const id = currentId
  try {
    /* before 也钉在这一刻：翻页请求飞在路上时用户又点了一下，
       晚到的那份不该把 peekbar 的状态改回去 */
    const before = peekBefore
    const r = await api(
      `/api/terminal/${encodeURIComponent(id)}?lines=${PEEK_LINES}&before=${before}`
    )
    if (id !== currentId || before !== peekBefore) return // 期间换终端/又翻了页，这份响应作废
    if (!r.ok) {
      note(r.status === 404 ? '这个终端在电脑上已经没了' : `读取失败（${r.status}）`)
      return
    }
    const { text, more } = await r.json()
    if (id !== currentId || before !== peekBefore) return
    const pre = $('screen-text')
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40
    pre.textContent = text || (before ? '（往前没有更多了）' : '（这个终端还没有输出）')
    if (atBottom) pre.scrollTop = pre.scrollHeight
    renderPeekbar(more)

    const n = nodeById(currentId)
    const st = n?.status || 'idle'
    $('term-status').textContent = STATE_LABEL[st] || st
    $('term-status').dataset.status = st

    /* 按钮把目标 id 闭包进去：切了终端还没重画时点下去，也只会发给它本来那一个。
       **翻着历史时一个都不给**：历史里的「1. Yes」按下去会答到当前那个
       完全不同的问题上，而屏幕上看不出这一点。 */
    renderChips(
      $('choices'), id, before ? [] : parseChoices(text),
      (c) => send(`${c.key}\r`, id), (c) => `${c.key} ${c.label}`
    )
    renderChips($('quick'), id, before ? [] : quickFor(st), (q) => send(`${q}\r`, id), (q) => q)
  } catch {
    // 网络抖动/切后台，等下一拍
  }
}

/** 翻历史条。`more` 由服务端算（它才知道 capture-pane 抓到了多少行） */
function renderPeekbar(more) {
  // 没历史可翻时整条收起来 —— 一条全是灰按钮的横条只是在占位
  $('peekbar').hidden = peekBefore === 0 && !more
  $('peek-older').disabled = !more
  $('peek-latest').hidden = peekBefore === 0
  $('peek-hint').textContent = peekBefore ? `往前 ${peekBefore} 行 · 不是当前画面` : ''
  // 底色变暗 + 禁掉选项，两个信号一起给：只有一行小字的话，误把历史当现状太容易了
  $('term').classList.toggle('history', peekBefore > 0)
}

function peekJump(delta) {
  const next = Math.max(0, peekBefore + delta)
  if (next === peekBefore) return
  peekBefore = next
  renderPeekbar(true) // 先让按钮状态跟手，真正的 more 等响应回来再校准
  refreshTerm()
}

function renderChips(host, id, items, onTap, label) {
  // 1.3 秒一拍的轮询里，选项多数时候一个字都没变。无脑重建 = 用户点下去的瞬间
  // 按钮被换掉，这一下就落空（审批卡片那边已经因为同样的原因修过一次）。
  // 签名必须含终端 id：换到一个选项文本恰好相同的终端时，旧按钮闭包里还绑着旧 id
  const sig = id + "|" + items.map(label).join(" ")
  if (host.dataset.sig === sig) return
  host.dataset.sig = sig
  host.textContent = ''
  for (const it of items) {
    const b = document.createElement('button')
    b.className = 'chip-btn'
    b.textContent = label(it)
    b.addEventListener('click', () => onTap(it))
    host.append(b)
  }
}

let noteTimer = 0
/** 提示条。手机上没有别的地方能说话，失败必须落在这里 —— 静默 = 用户以为发出去了 */
function note(msg) {
  const el = $('term-note')
  clearTimeout(noteTimer)
  if (!msg) {
    el.hidden = true
    return
  }
  el.textContent = msg
  el.hidden = false
  noteTimer = setTimeout(() => (el.hidden = true), 6000)
}

/**
 * 往终端写入。target 显式传入 —— 绝不在 await 之后再去读全局 currentId，
 * 那正是"看着 A 的问题、答案发进 B"的成因。
 * 返回是否真的发出去了，调用方据此决定要不要把用户打的字还回去。
 */
async function send(text, target = currentId) {
  if (!target || !text) return false
  try {
    const r = await api(`/api/terminal/${encodeURIComponent(target)}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text })
    })
    if (!r.ok) {
      /* 以前只处理 403，其余（404 终端已没了 / 400 内容超长 / 500）全被当成成功。
         而输入框在这之前就清空了 —— 用户打的字直接蒸发，屏幕看着还一切正常。 */
      const { error } = await r.json().catch(() => ({}))
      note(error || `发送失败（${r.status}）`)
      return false
    }
    note('')
    if (target === currentId) setTimeout(refreshTerm, 250) // 让回显尽快出来，别等下一拍
    return true
  } catch (e) {
    // 401 已在 api() 里处理并跳转；其余多半是网络抖动（Wi-Fi↔蜂窝切换）
    if (String(e?.message) !== 'unauthorized') note('发送失败，检查网络')
    return false
  }
}

/**
 * 把电脑端的「允许远程输入」开关映射到 UI。
 *
 * 不这么做也不会漏权限（服务端每次都重新 gate），但用户会打完一整段字才被 403 顶回来。
 * 灰掉输入框是**如实告知**，不是安全措施 —— 服务端那道才是。
 */
function applyGates(data) {
  const on = data.allowInput === true
  $('cmd').disabled = !on
  $('send').disabled = !on
  for (const b of $('keys').querySelectorAll('button')) b.disabled = !on
  $('cmd').placeholder = on ? '输入…（长按麦克风可语音转文字）' : '只读 —— 电脑上没开「允许远程输入」'
  $('term').classList.toggle('readonly', !on)
}

$('inputbar').addEventListener('submit', (e) => {
  e.preventDefault()
  const input = $('cmd')
  const v = input.value
  if (!v) return
  input.value = ''
  void send(`${v}\r`).then((ok) => {
    // 没发出去就把内容还回去。手机上没有历史记录，丢了就真没了
    if (!ok && !input.value) input.value = v
  })
})

for (const b of $('keys').querySelectorAll('button[data-key]')) {
  b.addEventListener('click', () => send(KEYS[b.dataset.key] || '', currentId))
}
$('btn-back').addEventListener('click', closeTerm)
$('btn-fit').addEventListener('click', fit)

// ── 审批 ─────────────────────────────────────────────────────────────────────

/* 同上：轮询回来时若待批清单没变，就别重建卡片。
   重建会把「仍然批准」的上膛态清掉 —— 用户点了第一下、2.5s 后卡片被换掉，
   第二下就落到一个全新的按钮上，永远确认不了。 */
let approvalSig = ''

function renderApprovals(data) {
  const list = data.approvals || []
  const btn = $('btn-alerts')
  btn.hidden = list.length === 0
  btn.textContent = `${list.length} 待批准`
  btn.classList.toggle('urgent', list.length > 0)
  if (!list.length) $('sheet').hidden = true // 批完了自动收起，别留个空抽屉挡着

  /* 签名要含 allowApprove 与判定：只哈希 id 的话，电脑上打开「允许远程批准」开关
     或判定发生变化时，手机上这张卡永远不会重画 */
  const sig = `${data.allowApprove}|${list.map((a) => `${a.id}:${a.verdict?.decision ?? ''}`).join(',')}`
  if (sig === approvalSig) return
  approvalSig = sig

  const host = $('sheet-list')
  host.textContent = ''
  for (const a of list) {
    const card = document.createElement('div')
    card.className = 'ap'

    const head = document.createElement('div')
    head.className = 'ap-head'
    const who = document.createElement('span')
    who.className = 'ap-who'
    who.textContent = nodeById(a.nodeId)?.title || a.nodeId
    const tool = document.createElement('span')
    tool.className = 'ap-tool'
    tool.textContent = a.toolName
    head.append(who, tool)

    const detail = document.createElement('div')
    detail.className = 'ap-detail'
    detail.textContent = a.summary

    card.append(head, detail)

    // 规则引擎的判定。它只会说「转人工」或「建议拒绝」，永远不会替你说「可以」
    if (a.verdict) {
      const v = document.createElement('div')
      v.className = `ap-verdict ${a.verdict.decision}`
      v.textContent =
        a.verdict.decision === 'deny'
          ? `建议拒绝：${a.verdict.reason}`
          : `需要你决定：${a.verdict.reason}`
      card.append(v)
    }

    const acts = document.createElement('div')
    acts.className = 'ap-acts'
    if (data.allowApprove) {
      const ok = document.createElement('button')
      const risky = a.verdict?.decision === 'deny'
      // 危险项不做成实心主按钮：视觉上"推荐点这个"和内容上"建议别点"不能对着干
      ok.className = risky ? 'ap-ok risky' : 'ap-ok'
      ok.textContent = risky ? '仍然批准' : '批准'
      let armed = false
      ok.addEventListener('click', () => {
        // 规则引擎建议拒绝时要二次确认：手机上误触一下就把 rm -rf 放行了
        if (risky && !armed) {
          armed = true
          ok.textContent = '确定？再点一次'
          ok.classList.add('armed')
          setTimeout(() => {
            armed = false
            ok.textContent = '仍然批准'
            ok.classList.remove('armed')
          }, 4000)
          return
        }
        decide(a.id, true, card)
      })
      const no = document.createElement('button')
      no.className = 'ap-no'
      no.textContent = '拒绝'
      no.addEventListener('click', () => decide(a.id, false, card))
      acts.append(ok, no)
    } else {
      const hint = document.createElement('span')
      hint.className = 'muted'
      hint.textContent = '远程批准未开启 —— 在电脑上「设置 → 远程访问」里打开'
      acts.append(hint)
    }
    card.append(acts)
    host.append(card)
  }
}

async function decide(id, allow, card) {
  try {
    const r = await api(`/api/approvals/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allow })
    })
    if (!r.ok) {
      /* 409 = 这条审批已经超时（服务端挂 120s 就放手）或被电脑那边处理了。
         不说话的话，卡片下一拍消失，用户会以为是自己刚才批准/拒绝生效了。 */
      const { error } = await r.json().catch(() => ({}))
      const tip = document.createElement('div')
      tip.className = 'ap-verdict deny'
      tip.textContent =
        r.status === 409 ? '这条审批已失效（超时或已在电脑上处理），你的操作没有生效' : error || `操作失败（${r.status}）`
      card?.append(tip)
      approvalSig = '' // 强制下一拍重画，别让这张废卡留着
      return
    }
  } catch {
    /* 401 已处理 */
  }
  refreshBoard()
}

$('btn-alerts').addEventListener('click', () => {
  $('sheet').hidden = false
})
$('sheet-close').addEventListener('click', () => {
  $('sheet').hidden = true
})
$('sheet').addEventListener('click', (e) => {
  if (e.target === $('sheet')) $('sheet').hidden = true // 点遮罩关闭
})

// ── 主循环 ───────────────────────────────────────────────────────────────────

let firstBoard = true

/* 最近一次成功拿到 board 的时刻。**画布静止和画布断线在屏幕上长得一模一样** ——
   没有这个指示器，手机进了电梯、电脑睡了，用户看到的还是一屏"运行中"的绿灯。
   这个项目最怕的就是这种静默失败。 */
let lastOk = Date.now()
let visibleSince = Date.now()

function checkStale() {
  // 页面在后台时本来就不轮询，那不叫失联；刚切回来也给一拍的宽限，别闪一下红条
  if (document.hidden || Date.now() - visibleSince < 4000) {
    $('offline').hidden = true
    return
  }
  const age = Math.round((Date.now() - lastOk) / 1000)
  const bad = age > 8 // 轮询 2.5s 一拍，连丢三拍才算数
  $('offline').hidden = !bad
  if (bad) $('offline').textContent = `失联 ${age}s —— 画面是旧的`
}

async function refreshBoard() {
  if (!token || document.hidden) return
  try {
    const r = await api('/api/board')
    latest = await r.json()
    lastOk = Date.now()
    renderBoard(latest)
    renderApprovals(latest)
    applyGates(latest)
    // 必须等真的画出东西了才算"首屏" —— 电脑端主窗口还没上报时 board 是 null，
    // 那时候 fit 一个空画布，然后就再也不会 fit 了
    if (firstBoard && placed.length) {
      firstBoard = false
      fit()
    }
    // 正在看的终端在电脑上被删了 → 退回画布，别停在一块永远不更新的死屏上
    if (currentId && !nodeById(currentId)) closeTerm()
  } catch {
    /* 401 已处理；其余等下一拍。**故意不更新 lastOk** —— 失联要看得见 */
  }
  checkStale()
}

function stopAll() {
  clearInterval(boardTimer)
  clearInterval(peekTimer)
  boardTimer = 0
  peekTimer = 0
  currentId = null
  // 签名清空：重新配对后必须整棵重建，否则会拿着上一台机器的布局不放
  layoutSig = ''
  approvalSig = ''
  // 审批抽屉是全屏遮罩：不关掉的话，掉回配对页时它会盖住 token 输入框
  $('sheet').hidden = true
  $('btn-alerts').hidden = true
  $('offline').hidden = true // 配对页上挂个"失联"条只会让人以为是配对失败
  note('')
}

/* 只轮询不上 SSE：EventSource 设不了 Authorization 头，硬用就得把 token 塞进
   query string（会进历史/日志）。手机看画面时屏幕本来就亮着，2.5s 轮询这点电不算什么；
   真正的后台推送要 Web Push，那是另一个量级的东西，现在不值当。 */
function start() {
  screen('board')
  firstBoard = true // 重新配对后要再 fit 一次
  lastOk = Date.now()
  refreshBoard()
  clearInterval(boardTimer)
  /* checkStale 也挂在这拍上，不能只靠 refreshBoard 里那次 ——
     fetch 卡住（弱网常态）时 refreshBoard 迟迟不返回，那条路径根本不会执行到 */
  boardTimer = setInterval(() => {
    void refreshBoard()
    checkStale()
  }, 2500)
}

$('peek-older').addEventListener('click', () => peekJump(PEEK_STEP))
$('peek-latest').addEventListener('click', () => peekJump(-Infinity))

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  visibleSince = Date.now()
  refreshBoard()
  if (currentId) refreshTerm()
})

$('token-go').addEventListener('click', async () => {
  const v = $('token-input').value.trim()
  if (!v) return
  token = v
  try {
    const r = await api('/api/board')
    if (!r.ok) throw new Error('bad')
    localStorage.setItem('ts.token', v)
    $('pair-err').hidden = true
    start()
  } catch {
    token = ''
    $('pair-err').textContent = 'token 不对，或者电脑上的远程访问没开'
    $('pair-err').hidden = false
  }
})

takeTokenFromUrl()
token = localStorage.getItem('ts.token') || ''
if (token) start()
else screen('pair')

/* Service Worker 只在**安全上下文**里存在。直连 http://100.x.y.z:7333 不是安全上下文
   （localhost 才豁免），所以这里的 navigator.serviceWorker 是 undefined，
   离线壳和安卓的"安装应用"都拿不到 —— 这是浏览器的硬规则，不是配置问题。
   iOS 的"添加到主屏幕"不依赖 SW，照样能用（靠 apple-mobile-web-app-* 那几个 meta）。
   想要完整 PWA：在 Tailscale 后台打开 HTTPS 证书，然后 `tailscale serve --bg 7333`，
   用 https://<机器名>.<tailnet>.ts.net 访问，这段代码届时会自动生效。 */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // 注册失败不影响使用，只是没有离线壳
  })
}
