/**
 * 钉住一次**真实回归**：面板从"有数据"变成"没数据"，而 334 条测试一条都没红。
 *
 * 现象（自检截图拍到的）：codex 卡片原本显示
 *   `CODEX 系统默认 pro / a***@gmail.com / 周 ▓ 1% 156h8m`
 * 变成了三行互相矛盾的话：
 *   `等待确认` + `仅管理员可查询` + `API key 按量计费，没有订阅额度可查`
 *
 * 根因：本机登录 shell 里 export 着 `OPENAI_API_KEY`（app 会继承），
 * 于是 `billingKind` 把 `system:codex` 判成 api-key，而那条分支**在调用采集器之前**
 * 就短路返回了。可事实是 codex CLI 走的是 OAuth 订阅 —— 采集器本来查得到。
 *
 * 判据因此定成一句话：**只有目标存储属于该账号才允许探测，且观测压过推断**。
 * 「采集器真拿到了窗口」是观测，「env 里有 key」只是推断。
 * 订阅和 API key 完全可以同时存在，只有采集器确实空手而归才退回按量计费那句。
 * 用户自建凭证没有隔离目录时则不许碰系统默认目录或默认钥匙串，避免把系统号额度错标给它。
 *
 * 第二条同源：拿到真实窗口本身就是登录态的证明（那个接口要凭据才答得出话），
 * 却仍挂着默认的「等待确认」，于是卡片上「已经查到 1%」和「等待确认」并存。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decorateQuota,
  hasRealWindows,
  defaultPresence,
  apiKeyUnavailable,
  pickQuota,
  mayProbe,
  startQuotaHub,
  type QuotaAccount
} from '../src/main/quota/index.ts'
import { now, type AccountQuota } from '../src/main/quota/types.ts'

const acct = (over: Partial<QuotaAccount> = {}): QuotaAccount => ({
  accountId: 'system:codex',
  provider: 'codex',
  name: '系统默认',
  env: {},
  ...over
})

const collected = (over: Partial<AccountQuota> = {}): AccountQuota => ({
  accountId: 'system:codex',
  provider: 'codex',
  name: '系统默认',
  state: 'ok',
  quotaCapability: 'supported',
  presence: { state: 'verified', detail: '', discovered: false },
  capturedAt: now(),
  source: 'app-server',
  windows: [{ label: '周', usedPercent: 1, windowDurationMins: 10080, resetsInMins: 9368 }],
  ...over
})

test('只有拿到真实窗口时才算查到了额度。', () => {
  assert.equal(hasRealWindows(collected()), true)
  assert.equal(hasRealWindows(collected({ state: 'stale' })), true, 'stale 是旧数据但仍是真数据')
  assert.equal(hasRealWindows(collected({ windows: [] })), false, '空窗口不能画进度条')
  assert.equal(hasRealWindows(collected({ state: 'unavailable' })), false)
  assert.equal(hasRealWindows(collected({ state: 'unconfigured' })), false)
  assert.equal(hasRealWindows(null), false)
})

test('查到额度后不能继续显示「等待确认」。', () => {
  const a = acct()
  const p = defaultPresence(a)
  assert.equal(p.state, 'unknown', '前提：系统账号默认就是 unknown')
  assert.equal(p.detail, '等待确认')

  const out = decorateQuota(a, p, collected())
  assert.equal(out.presence.state, 'verified', '拿到真窗口 = 这个账号确实登录着')
  assert.ok(!out.presence.detail.includes('等待确认'), `文案没换：${out.presence.detail}`)
  assert.ok(out.presence.detail.length <= 8, `这行紧挨着进度条，别啰嗦：${out.presence.detail}`)
})

test('没查到额度时不能伪造登录态。', () => {
  const a = acct()
  const p = defaultPresence(a)
  const out = decorateQuota(a, p, collected({ state: 'unavailable', windows: [] }))
  assert.equal(out.presence.state, 'unknown', '查不到就只能说不知道')
})

test('已经验证的 presence 不会被较笼统的结果覆盖。', () => {
  const a = acct({ presence: { state: 'verified', detail: 'codex login status 已验证', discovered: false } })
  const out = decorateQuota(a, defaultPresence(a), collected())
  assert.equal(out.presence.detail, 'codex login status 已验证')
})

test('API key 兜底与真实数据互斥，并且兜底结果不带窗口。', () => {
  /* 这条钉的是形状：兜底对象**必须**是空窗口 + unavailable，
     否则它一旦被误用在有订阅的账号上，界面会画出一个空进度槽 ——
     而"空槽"和"用了 0%"在视觉上分不开。 */
  const a = acct({ kind: 'api-key' })
  const fb = apiKeyUnavailable(a, defaultPresence(a))
  assert.equal(fb.state, 'unavailable')
  assert.deepEqual(fb.windows, [])
  assert.equal(hasRealWindows(fb), false)
  assert.match(fb.hint ?? '', /按量计费/)
})

test('系统账号被推断为 API key 时仍然优先显示采集到的真实数据。', () => {
  /* 模拟本机实况：shell 里 export 了 OPENAI_API_KEY（→ kind 判成 api-key），
     而 codex 实际走 OAuth 订阅，采集器返回了真实的周窗口。
     老实现在 probe 之前就 return 了兜底 → 真数据永远到不了界面。 */
  const a = acct({ kind: 'api-key' })
  const p = defaultPresence(a)
  const r = collected()

  const final = pickQuota(a, p, r)

  assert.equal(final?.state, 'ok', 'api-key 这个标签把真实订阅额度顶掉了')
  assert.equal(final?.windows.length, 1)
  assert.ok(!final.hint?.includes('按量计费'), '不该再挂按量计费的说明')
})

test('API key 账号只有在采集器压根没跑时才退回按量计费说明。', () => {
  /* 「空手而归」= `r === null`（mayProbe 拒了，或这个 provider 没有采集器）。
     这条用例原来传的是一个**非空**的 r，名字和断言对不上 —— 它钉住的正是下面那条
     bug 的行为。 */
  const a = acct({ kind: 'api-key' })
  const final = pickQuota(a, defaultPresence(a), null)
  assert.match(final?.hint ?? '', /按量计费/)
  assert.equal(final?.quotaCapability, 'admin_only')
})

test('采集器跑过但失败时，报的是本次失败，不是「仅管理员可查询」。', () => {
  /* 本机实况：登录 shell 里 export 了 OPENAI_API_KEY → system:codex 被判成 api-key；
     而 mayProbe 对 system:* 一律放行 → 采集**一定**会跑。于是一次网络超时
     （codex app-server 的 rateLimits 走网络，15s 硬超时）就会走进 api-key 兜底，
     界面显示「仅管理员可查询」。

     那句话是错的：手跑同一个接口拿得到周窗 28%，codex 的额度不是 admin-only；
     而且它把**瞬时**失败说成**永久**权限限制，真因还被丢了。 */
  const a = acct({ kind: 'api-key' })
  const r = collected({ state: 'unavailable', windows: [], hint: '查询超时' })

  const final = pickQuota(a, defaultPresence(a), r)

  assert.notEqual(final?.quotaCapability, 'admin_only', '把一次超时说成了权限限制')
  assert.equal(final?.state, 'unavailable')
  assert.match(final?.hint ?? '', /超时/, '采集器带回的真实诊断被兜底盖掉了')
})

test('采集器说未登录时，保留「未登录」而不是换成按量计费。', () => {
  /* 「未登录」用户能自己修（去跑一次 login），「按量计费查不到」只能干等 ——
     这两句话给出的下一步动作完全不同，不能互相顶替。 */
  const a = acct({ kind: 'api-key' })
  const r = collected({ state: 'unconfigured', windows: [] })
  const final = pickQuota(a, defaultPresence(a), r)
  assert.equal(final?.state, 'unconfigured')
  assert.ok(!final?.hint?.includes('按量计费'))
})

test('API key 账号没有隔离目录时不会调用 probe。', async () => {
  let probeCalls = 0
  const updates: AccountQuota[][] = []
  const hub = startQuotaHub(
    '/tmp',
    (list) => updates.push(list),
    undefined,
    async () => {
      probeCalls++
      return collected()
    }
  )

  hub.setAccounts([
    acct({
      accountId: 'user-api-key',
      kind: 'api-key',
      env: {}
    })
  ])
  for (let i = 0; i < 50 && updates.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  hub.dispose()

  assert.equal(probeCalls, 0, '无隔离目录的自建凭证碰了系统默认存储')
  assert.equal(updates.length, 1, '采集轮次没有完成')
  assert.match(updates[0]?.[0]?.hint ?? '', /按量计费/)
})

test('账号自带的 email 和 plan 会覆盖采集器结果。', () => {
  const a = acct({ email: 'x@y.com', plan: 'pro' })
  const out = decorateQuota(a, defaultPresence(a), collected({ email: 'old@z.com' }))
  assert.equal(out.email, 'x@y.com')
  assert.equal(out.plan, 'pro')
})

/* ── 允不允许探测（codex 第二轮 P0）─────────────────────────────────────
   老判据 `env['CODEX_HOME'] || env['CLAUDE_CONFIG_DIR']` 有两个反例，
   两个都会把**别人的**额度标到这个凭证名下，而且不报错： */

test('**codex 凭证只配了 CLAUDE_CONFIG_DIR → 不许探测**（否则读的是系统默认 ~/.codex）', () => {
  assert.equal(
    mayProbe(acct({ accountId: 'u1', provider: 'codex', env: { CLAUDE_CONFIG_DIR: '/x' } })),
    false
  )
})

test('**同时配了隔离目录和 API key → 不许探测**（登录态那条路已经判它按量计费）', () => {
  /* 界面上会出现「订阅剩余 92%」而真实调用在按量出账 ——
     identity-env.ts 明写登录态和额度必须共用 billingKind 这一个判据。 */
  assert.equal(
    mayProbe(acct({ accountId: 'u2', provider: 'codex', kind: 'api-key', env: { CODEX_HOME: '/x' } })),
    false
  )
})

test('配了自己 provider 隔离目录的订阅凭证 → 允许探测', () => {
  assert.equal(mayProbe(acct({ accountId: 'u3', provider: 'codex', env: { CODEX_HOME: '/x' } })), true)
  assert.equal(
    mayProbe(acct({ accountId: 'u4', provider: 'claude', env: { CLAUDE_CONFIG_DIR: '/x' } })),
    true
  )
})

test('**系统账号永远放行** —— 它查默认目录本来就是查它自己', () => {
  /* 这一支是「观测压过推断」那次回归修复的落点：
     shell 里 export 的 OPENAI_API_KEY 会让 system:codex 被判成 api-key，
     但它的订阅额度是真查得到的，不能因为 kind 就不查。 */
  assert.equal(mayProbe(acct({ accountId: 'system:codex', kind: 'api-key', env: {} })), true)
})
