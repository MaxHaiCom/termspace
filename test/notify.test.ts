/**
 * 出站通知。这是 app 里唯一主动往外网发东西的地方，而地址那头不是我们的服务器 ——
 * 所以这里钉的三件事都是**判据**，不是行为描述：
 *
 * ① 只收 https；② 正文里只能有节点标题和状态；③ 同一件事一分钟内只推一条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createNotifier,
  messageForState,
  sanitizeNotifyLevel,
  sanitizeNotifyUrl,
  type NotifyMessage
} from '../src/main/notify.ts'

test('http 一律拒 —— 正文里的项目名和 URL 里的 topic 都会在路上明文', () => {
  assert.equal(sanitizeNotifyUrl('http://ntfy.sh/abc'), '')
  assert.equal(sanitizeNotifyUrl('http://127.0.0.1:8080/x'), '')
  assert.equal(sanitizeNotifyUrl('HTTP://ntfy.sh/abc'), '')
})

test('别的协议也拒', () => {
  for (const bad of ['file:///tmp/x', 'ftp://x/', 'javascript:alert(1)', 'data:text/plain,x']) {
    assert.equal(sanitizeNotifyUrl(bad), '', `${bad} 必须拒`)
  }
})

test('空 / 非字符串 / 不是 URL → 空串（合法的"没配"状态，不回落任何默认地址）', () => {
  for (const v of ['', '   ', null, undefined, 42, {}, [], 'not a url']) {
    assert.equal(sanitizeNotifyUrl(v), '')
  }
})

test('内嵌 user:pass 拒 —— 没有服务需要它，留着只会被 URL 规范化搬来搬去', () => {
  assert.equal(sanitizeNotifyUrl('https://u:p@ntfy.sh/abc'), '')
  assert.equal(sanitizeNotifyUrl('https://u@ntfy.sh/abc'), '')
})

test('query 要放行 —— 和 updateFeedUrl 的区别所在（ntfy 的 token、Bark 的参数都在这）', () => {
  assert.equal(sanitizeNotifyUrl('https://ntfy.sh/abc?auth=tk_x'), 'https://ntfy.sh/abc?auth=tk_x')
})

test('hash 抹掉 —— fetch 不会发它，留着让人以为它有用', () => {
  assert.equal(sanitizeNotifyUrl('https://ntfy.sh/abc#frag'), 'https://ntfy.sh/abc')
})

test('level 只有两档，脏值一律收到更安静的那一档', () => {
  assert.equal(sanitizeNotifyLevel('all'), 'all')
  assert.equal(sanitizeNotifyLevel('attention'), 'attention')
  for (const v of ['ALL', 'everything', '', null, undefined, 1, {}]) {
    assert.equal(sanitizeNotifyLevel(v), 'attention')
  }
})

test('blocked / waiting 一定推，working / session 一定不推', () => {
  assert.ok(messageForState('blocked', '前端重构', 'attention'))
  assert.ok(messageForState('waiting', '前端重构', 'attention'))
  assert.equal(messageForState('working', '前端重构', 'all'), null)
  assert.equal(messageForState('session', '前端重构', 'all'), null)
  assert.equal(messageForState('随便什么没见过的状态', '前端重构', 'all'), null)
})

test('done 只在 all 档推 —— 每轮回答都响一下会让人关掉整个功能', () => {
  assert.equal(messageForState('done', '前端重构', 'attention'), null)
  assert.ok(messageForState('done', '前端重构', 'all'))
})

test('blocked 和「有审批待批」共用节流键 —— 同一件事的两条上报路径', () => {
  // 这条钉的是 key 而不是文案：它们分别由 PermissionRequest hook 和托管
  // PreToolUse 拦截触发，键不同就会一次响两下
  assert.equal(messageForState('blocked', 'x', 'attention')?.key, 'attention')
  assert.equal(messageForState('waiting', 'x', 'attention')?.key, 'attention')
  assert.equal(messageForState('done', 'x', 'all')?.key, 'done')
})

test('正文只含节点标题 —— 终端内容/路径/命令一个字都不该进得来', () => {
  /* 这条是这个文件里最重要的一条。messageForState 的签名只接受 title，
     调用方想把 cwd 或屏幕内容拼进来，得先改签名 —— 那时会撞上这条用例。 */
  const m = messageForState('blocked', '前端重构', 'attention')!
  assert.ok(m.body.includes('前端重构'))
  // 正文 = 标题 + 一句固定的话，没有第三样东西
  assert.equal(m.body.replace('前端重构', ''), '「」要你批准工具调用')
})

test('标题为空时给个占位，不发出「「」在等你回答」这种句子', () => {
  assert.ok(messageForState('waiting', '   ', 'attention')!.body.includes('某个终端'))
})

// ── 节流 ────────────────────────────────────────────────────────────────────

function harness(url = 'https://ntfy.sh/abc', level: 'attention' | 'all' = 'attention') {
  const sent: NotifyMessage[] = []
  let t = 1_000_000
  const n = createNotifier({
    get: () => ({ url, level }),
    post: async (_u, m) => {
      sent.push(m)
    },
    now: () => t
  })
  return { sent, n, advance: (ms: number) => (t += ms) }
}

test('同一个节点同一类事，一分钟内只推一条', () => {
  const h = harness()
  h.n.onState('t-1', 'blocked', '甲')
  h.n.onState('t-1', 'blocked', '甲')
  h.n.onState('t-1', 'waiting', '甲') // 同为 attention 键
  assert.equal(h.sent.length, 1)
  h.advance(61_000)
  h.n.onState('t-1', 'blocked', '甲')
  assert.equal(h.sent.length, 2)
})

test('两个节点同时等你 → 两条都要到（节流键含 nodeId）', () => {
  const h = harness()
  h.n.onState('t-1', 'blocked', '甲')
  h.n.onState('t-2', 'blocked', '乙')
  assert.equal(h.sent.length, 2)
})

test('blocked 之后紧跟同节点的审批待批 → 不重复响', () => {
  const h = harness()
  h.n.onState('t-1', 'blocked', '甲')
  h.n.onApprovalPending('t-1', '甲')
  assert.equal(h.sent.length, 1)
})

test('「跑完了」和「等你」是两件事，各有各的节流窗口', () => {
  const h = harness('https://ntfy.sh/abc', 'all')
  h.n.onState('t-1', 'blocked', '甲')
  h.n.onState('t-1', 'done', '甲')
  assert.equal(h.sent.length, 2)
})

test('没配地址 = 一条都不发（默认状态）', () => {
  const h = harness('')
  h.n.onState('t-1', 'blocked', '甲')
  h.n.onApprovalPending('t-1', '甲')
  assert.equal(h.sent.length, 0)
})

test('地址不合法（http）也一条都不发 —— 校验在发之前，不靠 UI 挡', () => {
  const h = harness('http://ntfy.sh/abc')
  h.n.onState('t-1', 'blocked', '甲')
  assert.equal(h.sent.length, 0)
})

test('设置改完立刻生效：url 是每次现取的，不是构造时锁死的', () => {
  const sent: NotifyMessage[] = []
  let url = ''
  const n = createNotifier({
    get: () => ({ url, level: 'attention' }),
    post: async (_u, m) => {
      sent.push(m)
    }
  })
  n.onState('t-1', 'blocked', '甲')
  assert.equal(sent.length, 0)
  url = 'https://ntfy.sh/abc'
  n.onState('t-2', 'blocked', '乙')
  assert.equal(sent.length, 1)
})

test('dispose 之后不再发 —— 关掉远程/退出时不该还有推送在路上', () => {
  const h = harness()
  h.n.dispose()
  h.n.onState('t-1', 'blocked', '甲')
  assert.equal(h.sent.length, 0)
})

test('post 抛错不能冒泡 —— 通知发不出去不该影响 agent 状态流转', () => {
  const n = createNotifier({
    get: () => ({ url: 'https://ntfy.sh/abc', level: 'attention' }),
    post: () => Promise.reject(new Error('网络炸了'))
  })
  assert.doesNotThrow(() => n.onState('t-1', 'blocked', '甲'))
})
