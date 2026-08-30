/** 系统级设置（明文 JSON，无敏感信息） */
import { app } from 'electron'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { isPeerAlias } from './peer'
import { sanitizeFeedUrl } from './update-url'
import { sanitizeNotifyLevel, sanitizeNotifyUrl } from './notify'

export interface Settings {
  defaultFontSize: number
  defaultShell: string // '' = 跟随 $SHELL
  tmuxEnabled: boolean
  scrollback: number
  skillDirs: string[] // F8 工具中枢的 skill 库来源
  /**
   * 是否把托管 hook 写进用户全局的 ~/.claude/settings.json。
   * 'ask' = 还没问过（首启会弹窗征得同意）。改用户全局配置这种事不能默默做。
   */
  claudeHooks: 'ask' | 'on' | 'off'
  /** 远程 API（手机/其他电脑当客户端）。默认关闭，只绑 127.0.0.1 */
  remoteEnabled: boolean
  /** 远程端能否往终端写入。默认只读 —— 写入是把 shell 交出去，必须显式开 */
  remoteAllowInput: boolean
  /** 远程端能否批准工具调用。默认关 —— 批一次 rm -rf 比敲一行字危险得多 */
  remoteAllowApprove: boolean
  remotePort: number
  /**
   * 绑哪张网卡。'loopback' = 只有本机；'tailscale' = 绑 tailnet 那个 100.x 地址，
   * 手机加入同一 tailnet 后可访问。**没有 0.0.0.0 这个选项，也不要加**。
   */
  remoteBind: 'loopback' | 'tailscale'
  /**
   * 可以跨机派活过去的 ssh alias 白名单（`tb ask mini:t-abc <任务>` 里的 `mini`）。
   * **只存 alias，不存任何密钥** —— 认证完全交给用户已有的 ssh 配置。
   * 白名单是必须的：alias 直接进 ssh 的 argv，见 peer.ts 的 peerAllowed。
   */
  peers: string[]
  /**
   * 本机是否接受**别的机器**派过来的活。默认关。
   * 诚实说明：能 ssh 进本机的人本来就有完整 shell 权限，所以这个开关
   * 和 peers 白名单一样是产品护栏（挡误用、挡 agent 自作主张），不是安全边界。
   */
  peerDelegate: boolean
  /**
   * 后台检查更新。默认开 —— 但「检查+下载」和「装」是两件事：
   * 下载完只提示，装不装用户说了算（终端里跑着人家的活，自动重启会把那一轮掐掉）。
   */
  autoUpdate: boolean
  /**
   * 更新源。默认就是官方源（见 `OFFICIAL_FEED`）。
   *
   * 仍然放在设置里而不是焊进打包配置：换发布源不用重新打包。
   * 但**默认值不能是空串** —— 发布者机器上配过不代表新用户机器上有，
   * 设置是不随安装包走的。空默认意味着 fresh install 永远查不到更新，
   * 而第一版里最需要更新的恰恰是新用户。
   */
  updateFeedUrl: string
  /**
   * 「在编辑器打开」用哪个命令（`code` / `cursor` / `zed` …）。
   *
   * **它进不了 shell**：主进程按白名单把名字解析成绝对路径再 execFile
   * （见 open-in-editor.ts）。认不出就退回 Finder 定位，并如实告诉用户。
   * 空 = 一律 Finder。
   */
  editorCommand: string
  /**
   * 代理连接（见 broker.ts）：agent 能用、但拿不到里面的凭证。
   *
   * ⚠️ **target 里通常带密码**，而 settings.json 是明文的 —— 所以这里只存
   * `id/name/kind/readOnly`，真正的连接串走 Keychain（identity-store 那套）。
   * 别为了"少一次跳转"把 target 放进来。
   */
  brokers: { id: string; name: string; kind: 'ssh' | 'postgres'; readOnly: boolean }[]
  /**
   * 出站通知的推送地址（ntfy / Bark 那类）。空 = 不通知，这是默认。
   *
   * ⚠️ 这是整个 app 里**唯一主动往外网发东西**的地方，且这里没有可信服务器 ——
   * 地址是用户自己填的。所以正文只有节点标题和状态，判据见 notify.ts 的文件头。
   */
  notifyUrl: string
  /** 'attention' = 只在 agent 等你时；'all' = 加上「跑完了」 */
  notifyLevel: 'attention' | 'all'
}

/**
 * 官方更新源。指向一个存着 `latest-mac.yml` + `*.zip` 的 HTTPS 目录。
 *
 * ⚠️ 信任根是**这个目录的控制权**，代码签名是最后一道而不是第一道
 * （见 CLAUDE.md「自动更新」那张表）。所以它虽然可改，UI 上要显著显示
 * 当前生效的域名 —— 被诱导改源等于换掉了信任根。
 *
 * 📌 **fork 这个仓库的人请改掉这个值。** 保持原样的话，你的构建会去查
 * 上游的更新源。下载下来的包**装不上**（Squirrel 要求候选包的签名满足
 * 当前 app 的 designated requirement，签名主体不同就会被拒），
 * 所以不是安全问题 —— 但你的用户会看到一个永远失败的更新，
 * 而流量记在上游的账上。要么指向你自己的目录，要么设成空串关掉更新。
 */
export const OFFICIAL_FEED = 'https://updates.termspace.app/'

export const DEFAULTS: Settings = {
  defaultFontSize: 13,
  defaultShell: '',
  tmuxEnabled: true,
  scrollback: 8000,
  skillDirs: [],
  claudeHooks: 'ask',
  remoteEnabled: false,
  remoteAllowInput: false,
  remoteAllowApprove: false,
  remotePort: 7333,
  remoteBind: 'loopback',
  peers: [],
  peerDelegate: false,
  autoUpdate: true,
  updateFeedUrl: OFFICIAL_FEED,
  editorCommand: '',
  brokers: [],
  notifyUrl: '',
  notifyLevel: 'attention'
}

const file = (): string => path.join(app.getPath('userData'), 'settings.json')
let cache: Settings | null = null

export async function getSettings(): Promise<Settings> {
  if (cache) return cache
  if (!existsSync(file())) {
    cache = { ...DEFAULTS }
    return cache
  }
  try {
    cache = sanitize({
      ...DEFAULTS,
      ...(JSON.parse(await readFile(file(), 'utf8')) as Partial<Settings>)
    })
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

/**
 * 收敛到合法值。**读盘和写盘都要过**：手改文件把 `"remoteAllowInput": "false"` 写成字符串
 * 时，浅合并出来是个 truthy 值，等于把远程写入偷偷打开了 —— 三个安全开关只认 `=== true`。
 */
function sanitize(s: Settings): Settings {
  const bool = (v: unknown): boolean => v === true
  return {
    ...s,
    defaultFontSize: clampInt(s.defaultFontSize, 8, 24, DEFAULTS.defaultFontSize),
    scrollback: clampInt(s.scrollback, 500, 100_000, DEFAULTS.scrollback),
    // 0 会让 Node 绑一个随机端口（二维码里的端口就对不上了），必须挡住
    remotePort: clampInt(s.remotePort, 1024, 65535, DEFAULTS.remotePort),
    tmuxEnabled: s.tmuxEnabled !== false,
    remoteEnabled: bool(s.remoteEnabled),
    remoteAllowInput: bool(s.remoteAllowInput),
    remoteAllowApprove: bool(s.remoteAllowApprove),
    peerDelegate: bool(s.peerDelegate),
    // 这个默认**开**，所以不能用 `=== true`（缺字段时会变成关）
    autoUpdate: s.autoUpdate !== false,
    /* 只收 https + 补结尾斜杠，判据和理由见 update-url.ts。
       **空/不合法一律回落官方源**：老用户存的是空串（那时还没有官方源），
       浅合并不会把它换成新默认值，于是他们永远查不到更新。
       想彻底不更新请关 autoUpdate —— 那是这件事的正经开关。 */
    updateFeedUrl: sanitizeFeedUrl(s.updateFeedUrl) || OFFICIAL_FEED,
    /* alias 会进 ssh 的 argv，**读盘这一步就要把脏的滤掉**：
       手改 settings.json 塞一个 `-oProxyCommand=...` 进去，等于让任何能派活的
       agent 在本机执行任意命令。判据直接用 peer.ts 的，不另写一份正则。 */
    peers: Array.isArray(s.peers) ? s.peers.filter(isPeerAlias) : [],
    // 绑定地址不接受任意输入：不是精确的 'tailscale' 一律当仅本机
    remoteBind: s.remoteBind === 'tailscale' ? 'tailscale' : 'loopback',
    claudeHooks: s.claudeHooks === 'on' ? 'on' : s.claudeHooks === 'off' ? 'off' : 'ask',
    skillDirs: Array.isArray(s.skillDirs) ? s.skillDirs.filter((d) => typeof d === 'string') : [],
    defaultShell: typeof s.defaultShell === 'string' ? s.defaultShell : '',
    /* 只留字母数字：它是白名单的**键**，脏值反正查不到表，
       但把长度和字符集卡住可以让日志和界面不至于出现一整条命令行 */
    editorCommand:
      typeof s.editorCommand === 'string' ? s.editorCommand.trim().slice(0, 20).replace(/[^A-Za-z0-9_-]/g, '') : '',
    brokers: Array.isArray(s.brokers)
      ? s.brokers
          .filter(
            (b) =>
              b &&
              typeof b.id === 'string' &&
              typeof b.name === 'string' &&
              (b.kind === 'ssh' || b.kind === 'postgres')
          )
          .map((b) => ({
            id: b.id.slice(0, 64),
            name: b.name.slice(0, 40),
            kind: b.kind,
            // 只读默认**开**：手改文件把它删掉时应该更严，不是更松
            readOnly: b.readOnly !== false
          }))
          .slice(0, 30)
      : [],
    /* 和 updateFeedUrl 一样只收 https，但**不回落任何默认值** ——
       「没配」在这里是完全正常的状态，而给一个默认地址等于替用户选了
       一个第三方服务并开始往那儿发东西。 */
    notifyUrl: sanitizeNotifyUrl(s.notifyUrl),
    notifyLevel: sanitizeNotifyLevel(s.notifyLevel)
  }
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

/* 写盘串行化：并发改两个开关时，共用一个固定 .tmp 会互相覆盖，
   甚至让后一次 rename 撞上 ENOENT（前一次已经把 tmp 改名走了）。 */
let writeChain: Promise<unknown> = Promise.resolve()

export function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const run = writeChain.then(async () => {
    const cur = await getSettings()
    const next = sanitize({ ...cur, ...patch })
    /* 先更新内存缓存再落盘：落盘失败时，用户在界面上关掉的开关**必须**已经生效。
       反过来（落盘成功才生效）意味着写盘一出错，界面显示"只读"而实际仍可写 ——
       安全开关只能往收紧的方向 fail。 */
    cache = next
    // 临时文件名带随机后缀，见上面的注释
    const tmp = `${file()}.${randomUUID().slice(0, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(next, null, 2))
    await rename(tmp, file())
    return next
  })
  // 链上一环失败不能卡死后续写入
  writeChain = run.catch(() => undefined)
  return run
}
