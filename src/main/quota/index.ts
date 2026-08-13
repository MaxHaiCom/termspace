/**
 * 额度采集调度。
 *
 * **一个账号一个采集器，全局单例拉一次广播给所有节点** —— 额度是账号级的，
 * 绝不每个节点各拉一遍（同一个号会被查 N 次，还可能撞限流）。
 */
import { collectClaude } from './claude.ts'
import { collectCodex } from './codex.ts'
import { collectCopilot } from './copilot.ts'
import { now, type AccountPresence, type AccountQuota, type QuotaCapability } from './types.ts'
import { PROVIDERS } from '../../shared/provider-manifest.ts'

export type {
  AccountPresence,
  AccountQuota,
  QuotaCapability,
  QuotaWindow,
  QuotaSpend,
  QuotaState
} from './types.ts'

/** 5 分钟。Claude Code 自己的写节流就是 5min，比这更密没有信息增量，只是白打后端 */
const INTERVAL_MS = 5 * 60_000
/** 手动触发（HUD 展开、turn 结束）的最小间隔，防连点 */
const MIN_GAP_MS = 60_000

export interface QuotaAccount {
  accountId: string
  provider: string
  name: string
  /** identity 展开后的 env（只需要 CODEX_HOME / CLAUDE_CONFIG_DIR 两个键） */
  env: Record<string, string>
  /**
   * 计费方式。**`api-key` 的账号绝不能走订阅采集器** ——
   * 没有隔离目录时采集器会回退到默认目录/默认钥匙串，把**系统默认订阅号的额度**
   * 标在这个 API key 名下，用户看到的百分比属于另一个账号，
   * 而这个终端实际是按量计费。显示反了比不显示糟得多。
   */
  kind?: 'subscription' | 'api-key'
  quotaCapability?: QuotaCapability
  presence?: AccountPresence
  email?: string
  plan?: string
}

export interface QuotaHub {
  /** 当前全部账号的额度快照 */
  snapshot: () => AccountQuota[]
  /** 账号列表变了（新增/删除凭证）时重建 */
  setAccounts: (list: QuotaAccount[]) => void
  refresh: (force?: boolean) => void
  dispose: () => void
}

/** 账号列表的稳定指纹。任一影响采集结果的字段变了就该重采 */
export function fingerprint(list: QuotaAccount[]): string {
  return list
    .map((a) => {
      const env = Object.entries(a.env)
        .toSorted(([x], [y]) => (x < y ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
      return `${a.accountId}|${a.provider}|${a.name}|${a.kind ?? ''}|${a.quotaCapability ?? ''}|${a.presence?.state ?? ''}|${a.email ?? ''}|${a.plan ?? ''}|${env}`
    })
    .toSorted()
    .join('\n')
}

/** 账号存在态的兜底值。系统自动发现的标 `discovered`，用户自建的不标 */
export function defaultPresence(a: QuotaAccount): AccountPresence {
  return (
    a.presence ?? {
      state: 'unknown',
      detail: '等待确认',
      discovered: a.accountId.startsWith('system:')
    }
  )
}

/** 采集器真的拿到了这个账号的额度窗口 —— 只有这种才允许画进度条 */
export function hasRealWindows(r: AccountQuota | null): boolean {
  return !!r && (r.state === 'ok' || r.state === 'stale') && r.windows.length > 0
}

/**
 * 采集结果 + 账号元信息 → 最终展示对象。
 *
 * **抽出来是为了能测**：这里两个判据都是"静默做错事"的形状 ——
 * 错了不报错、typecheck 全绿、只是界面上安静地显示错误的东西。
 */
export function decorateQuota(
  a: QuotaAccount,
  presence: AccountPresence,
  r: AccountQuota
): AccountQuota {
  return {
    ...r,
    quotaCapability: a.quotaCapability ?? r.quotaCapability,
    /* **拿到真实额度窗口本身就是登录态的证明** —— 那个接口要带着这个账号的
       凭据才答得出话。此时还挂着默认的「等待确认」，卡片上就会出现
       "邮箱 + pro + 周 1% 进度条 + 等待确认" 这种自相矛盾的组合（实测拍到过）。
       观测压过推断：能查到 = 已登录，不必再等别的探测器确认。 */
    presence:
      hasRealWindows(r) && presence.state !== 'verified'
        ? { ...presence, state: 'verified', detail: '已验证登录' }
        : presence,
    ...(presence.state === 'verified' && r.state === 'unconfigured'
      ? {
          state: 'unavailable' as const,
          quotaCapability: 'blocked_by_policy' as const,
          hint: '已验证登录，但无法在安全边界内取得额度凭据'
        }
      : {}),
    email: a.email ?? r.email,
    plan: a.plan ?? r.plan
  }
}

/**
 * 按量计费的账号如实说"查不到订阅额度"，而不是从 HUD 里消失 ——
 * 凭证明明在画布上，额度面板里却没有它，用户只会以为坏了。
 * 各家的按量用量 API 见 docs/QUOTA.md「明确不做」那节（多数要 org admin key）。
 *
 * ⚠️ **这个兜底只能在采集器什么都没拿到之后用**，见 collectOne 里那段注释。
 */
export function apiKeyUnavailable(a: QuotaAccount, presence: AccountPresence): AccountQuota {
  return {
    accountId: a.accountId,
    provider: a.provider,
    name: a.name,
    state: 'unavailable',
    quotaCapability: a.quotaCapability ?? 'admin_only',
    presence,
    capturedAt: now(),
    source: '-',
    windows: [],
    hint: 'API key 按量计费，没有订阅额度可查'
  }
}

/**
 * 统一选择真实采集结果或 API key 兜底，避免测试和生产各写一套判定顺序。
 *
 * **`r` 非 null 就一律用它 —— 哪怕这次采集失败了。**
 *
 * 老实现的顺序是「有窗口 → 用；否则 api-key → 兜底；否则用 r」，于是
 * `kind === 'api-key'` 的账号只要**采集失败**（超时 / app-server 提前退出 /
 * 找不到二进制），采集器带回来的真实诊断就被 `apiKeyUnavailable` 整个盖掉，
 * 界面显示 **「仅管理员可查询」**（`admin_only`）。
 *
 * 这句话三重错：codex 的额度**根本不是** admin-only（本机手跑同一个接口就能拿到
 * 周窗 28%）；它把一次**瞬时**网络超时说成**永久**的权限限制；而真正的原因
 * （"本次查询失败"）被丢掉了，用户没有任何线索去修。
 *
 * 触发条件在本机是常态而非边角：登录 shell 里 export 了 `OPENAI_API_KEY`，
 * `billingKind` 就把 `system:codex` 判成 api-key；而 `mayProbe` 对 `system:*`
 * 一律放行 —— 也就是说**系统默认账号永远会走采集，失败时永远落进这个兜底**。
 *
 * 兜底的正确适用范围只有一条：**采集根本没跑**（`mayProbe` 拒了，或这个 provider
 * 没有采集器）—— 那时 `r === null`，此时说「API key 按量计费，没有订阅额度可查」
 * 才是真话。CLAUDE.md 里「只有采集器确实空手而归才退回按量计费那句话」说的就是它，
 * 上一轮只修到了 `r === null` 这一半，"跑了但失败"仍在被当成"空手而归"。
 *
 * 「api-key 账号不该显示订阅额度」由 `mayProbe` 在**采集之前**保证，不靠这里兜。
 */
export function pickQuota(
  a: QuotaAccount,
  presence: AccountPresence,
  r: AccountQuota | null
): AccountQuota | null {
  if (r) return decorateQuota(a, presence, r)
  if (a.kind === 'api-key') return apiKeyUnavailable(a, presence)
  return null
}

/**
 * 这个账号**允许不允许**去查额度。
 *
 * 判据必须同时满足两条，缺一条都会出跨账号错标：
 *
 * 1. **隔离目录要是这个 provider 自己的那一个**。老实现写的是
 *    `env['CODEX_HOME'] || env['CLAUDE_CONFIG_DIR']` —— 于是一个 **codex** 凭证
 *    只配了 `CLAUDE_CONFIG_DIR` 也会放行，然后去读**系统默认的** `~/.codex`，
 *    把系统号的额度、邮箱、「已验证登录」全标到这个凭证名下。
 *    键名从 manifest 的 `homeEnvKey` 取，**不在这里再硬编码一份**
 *    （上一轮 P0-4 就是硬编码那份漏了变量）。
 *
 * 2. **不能是按量计费的**。`billingKind` 判成 api-key 的凭证（哪怕它同时配了
 *    `CODEX_HOME`），登录态那条路已经在 probe **之前**短路成「按量计费，
 *    没有订阅登录态」（`identity-store.ts`）。额度这边要是还去探测那个目录、
 *    再让订阅窗口压过 api-key，界面就会显示**订阅剩余额度、而真实调用在按量出账**。
 *    `identity-env.ts` 明写这两处必须共用同一个判据。
 *
 * 系统账号（`system:*`）是唯一的例外，显式放行：它查默认目录**本来就是查它自己**。
 * 那条「观测压过推断」的回归修复（shell 里 export 的 key 让 system:codex 被误判成
 * api-key，真实订阅额度被顶掉）正是靠这一支继续生效的。
 */
export function mayProbe(a: QuotaAccount): boolean {
  if (a.accountId.startsWith('system:')) return true
  if (a.kind === 'api-key') return false
  const homeKey = PROVIDERS.find((p) => p.id === a.provider)?.homeEnvKey
  return !!homeKey && !!a.env[homeKey]
}

export function startQuotaHub(
  homeDir: string,
  onUpdate: (list: AccountQuota[]) => void,
  /** 只给测试用：替换真采集器。生产不传 —— 真采集要打网络、跑子进程，测不了调度逻辑 */
  collectOverride?: (a: QuotaAccount) => Promise<AccountQuota>,
  /** 只给测试用：观察 collectOne 是否调用底层 probe；不替换 collectOne 自身的判定 */
  probeOverride?: (a: QuotaAccount) => Promise<AccountQuota | null>
): QuotaHub {
  let accounts: QuotaAccount[] = []
  const results = new Map<string, AccountQuota>()
  let lastRun = 0
  let running = false

  const collectOne = async (a: QuotaAccount): Promise<AccountQuota> => {
    const presence = defaultPresence(a)
    try {
      const probe = async (): Promise<AccountQuota | null> => {
        if (probeOverride) return probeOverride(a)
        if (a.provider === 'codex') {
          return collectCodex({
            accountId: a.accountId,
            name: a.name,
            codexHome: a.env['CODEX_HOME'] || `${homeDir}/.codex`,
            homeDir
          })
        }
        if (a.provider === 'copilot') return collectCopilot({ accountId: a.accountId, name: a.name })
        if (a.provider === 'claude') {
          return collectClaude({
            accountId: a.accountId,
            name: a.name,
            configDir: a.env['CLAUDE_CONFIG_DIR'],
            homeDir
          })
        }
        return null
      }
      const r = mayProbe(a) ? await probe() : null
      /* **`kind` 绝不能在采集之前短路**（实测回归：本机 `OPENAI_API_KEY` 在登录 shell 里
         export 着，于是 `billingKind` 把 `system:codex` 判成 api-key，
         而 codex CLI 实际走的是 OAuth 订阅 —— 真实的 `pro` + 周窗 1% 被三行
         "查不到"顶掉，面板从有数据变成没数据）。
         **订阅和 API key 可以同时存在**，而"采集器真拿到了窗口"是观测，
         "env 里有 key"只是推断 —— 观测赢。
         只有采集器确实什么都没拿到时，才退回按量计费那句话。 */
      const picked = pickQuota(a, presence, r)
      if (picked) return picked
    } catch (e) {
      // 采集器不该抛，但真抛了也不能让整轮挂掉
      return {
        accountId: a.accountId,
        provider: a.provider,
        name: a.name,
        state: 'unavailable',
        quotaCapability: 'collector_error',
        presence,
        capturedAt: now(),
        source: '-',
        windows: [],
        hint: `采集器出错：${(e as Error).message}`
      }
    }
    return {
      accountId: a.accountId,
      provider: a.provider,
      name: a.name,
      state: 'unavailable',
      quotaCapability: a.quotaCapability ?? 'officially_unavailable',
      presence,
      capturedAt: now(),
      source: '-',
      windows: []
      /* 这里**不给 hint**。渲染层已经按 `quotaCapability` 出了一句
         「无官方程序化查询接口」，再补一句「暂不支持 X 的额度查询」就是
         同一件事说两遍 —— 卡片上三行里两行同义，正是用户抱怨的
         「看不懂、太复杂」。hint 只该带**额外**信息（比如具体是哪次查询失败）。 */
    }
  }

  /* 采集期间来的强制刷新。**不能直接丢** —— 一轮采集要几秒（codex 未登录时硬超时 15s），
     用户正好在这段时间里换了凭证的隔离目录，那次 setAccounts 的 run(true) 就被
     `if (running) return` 吃掉了，界面上继续挂着旧号的额度直到下一个 5 分钟周期。
     而且**正在跑的那轮用的是旧 accounts**（Promise.all 的入参在 await 之前就求值完了），
     它结束时还会拿旧账号的结果 onUpdate 一次，等于把新配置的显示又盖回去。 */
  let pending = false

  const run = async (force = false): Promise<void> => {
    if (running) {
      if (force) pending = true
      return
    }
    if (!force && Date.now() - lastRun < MIN_GAP_MS) return
    running = true
    lastRun = Date.now()
    try {
      // 各账号并行；一个挂了不影响别的
      const list = await Promise.all(accounts.map(collectOverride ?? collectOne))
      results.clear()
      for (const r of list) results.set(r.accountId, r)
      onUpdate(list)
    } finally {
      running = false
      if (pending) {
        pending = false
        void run(true) // running 已经翻回 false，不会递归下去
      }
    }
  }

  const timer = setInterval(() => void run(), INTERVAL_MS)

  return {
    snapshot: () => [...results.values()],
    setAccounts: (list) => {
      /* 指纹要含 provider / 名字 / 隔离目录 —— 只比 accountId 的话，
         把凭证的 CODEX_HOME 改到另一个订阅号上，界面会继续显示旧号的额度，
         而 accountId 一个字都没变。改名同理（名字就画在 HUD 上）。 */
      const changed = fingerprint(list) !== fingerprint(accounts)
      accounts = list
      if (changed) void run(true)
    },
    refresh: (force) => void run(force),
    dispose: () => clearInterval(timer)
  }
}
