/**
 * tmux 启动参数拼装（纯函数）。
 *
 * 单独成文件是为了可测：tmux.ts 依赖 electron，进不了 `node --test`，
 * 而"identity 的变量到底有没有真的传进会话"正是会静默失败的那一类 ——
 * 界面上凭证配得好好的，开着 tmux 就是不生效，从表面完全看不出来。
 */

export const TMUX_SOCKET = 'termboard'

/** 该节点 identity 显式声明的变量：keys = 要设的，unset = 要删的 */
export interface IdentityEnvSpec {
  keys: string[]
  unset: string[]
}

/**
 * 交给 tmux **客户端进程**的环境。
 *
 * ⚠️ 这是多钥匙隔离的命根子，**别把它简化成"直接把 env 传下去"**：
 * tmux server 是长寿共享的，而且**第一个客户端的环境会变成 server 的全局环境**。
 * 于是「凭证 A 的终端先起 → server 带着 A 的私钥活着 → 凭证 B 的终端后起」时，
 * B 的 pane 会从 server 继承到 A 的私钥 —— 两个账号的密钥就串了。
 *
 * 实测（tmux -L leaktest，两个 session）：
 *   A 的客户端环境带 LEAK_A_SECRET → B 里 `new-window` 打印出 `sk-AAAA`
 *   改成客户端干净、身份只走 `-e` → B 里打印 `NONE`，A 自己照常拿得到
 *
 * 注意 tmux 的 `set-environment -u` **盖不住这个** —— 那些变量只在 server 的
 * 全局环境里（`show-environment -g` 看得到、`-t <session>` 看不到），
 * 会话级的 `-u` 对它无效。所以只能从源头拦。
 *
 * unset 的键也要一并从基础环境里删掉：否则本节点虽然用 `env -u` 包住了自己的 shell，
 * 那个键还是会被带进 server，成为后来所有会话的全局继承。
 */
export function tmuxClientEnv(
  env: Record<string, string>,
  identity?: IdentityEnvSpec
): Record<string, string> {
  const out = { ...env }
  for (const k of identity?.keys ?? []) delete out[k]
  for (const k of identity?.unset ?? []) delete out[k]
  // TERMBOARD_* 全部走 -e 下发。留在基础环境里会让 server 记住**第一个节点**的
  // NODE_ID / HOOK_TOKEN，用户在会话里手开一个 window 就会顶着别人的身份上报
  for (const k of Object.keys(out)) if (k.startsWith('TERMBOARD_')) delete out[k]
  return out
}

/**
 * 不该留在 tmux **server 全局环境**里的键。
 *
 * 起因（2026-08-13 实测）：本机的 tmux server 是 **7/24 22:36** 起的，
 * 而 `show-environment -g` 里躺着那一刻的整份快照 —— `TERMBOARD_SHOT`、
 * `ELECTRON_RENDERER_URL`、`npm_*`（一次 dev 自检运行），外加一个 20 天前的
 * `CLAUDE_CODE_SESSION_ID` + `CLAUDE_CODE_CHILD_SESSION=1` + `CLAUDECODE=1`。
 * 于是**今天新建的每个终端**都继承这份快照，里面跑的 claude CLI 会认为自己是
 * 某个早已结束的会话的子会话。
 *
 * `tmuxClientEnv` 已经从**客户端**环境里摘掉了这些，但那只对**将来**要起的 server 有效 ——
 * server 一旦起来就活到 kill-server 为止，全局环境再也不跟着变。所以必须能**就地清**
 * （`set-environment -g -u`），否则唯一的修法是杀掉所有会话。
 *
 * 判据是「这个键描述的是**某一次进程/会话的身份**」，不是「它看起来没用」：
 * - `TERMBOARD_*`：本该每会话 `-e` 下发，全局残留会让手开的 window 顶着别的节点身份
 * - `CLAUDE_CODE_* / CLAUDECODE / AI_AGENT / CODEX_COMPANION_SESSION_ID`：某次 agent 会话的身份
 * - `ELECTRON_* / npm_* / NODE_ENV* / INIT_CWD`：起 server 那次 `npm run dev` 的残留
 * - `WARP_* / TERM_PROGRAM*`：起 server 的那个终端模拟器是谁 —— 在 Termspace 里一律是错的
 *
 * **故意不含密钥和代理**：`OPENAI_API_KEY` / `GITHUB_TOKEN` / `HTTP_PROXY` 这些
 * 是用户 shell 里本来就 export 的东西，终端继承它们是既定行为（identity 要删的走
 * `env -u`，见 assembleSpawnArgs）。在这里顺手删掉 = 悄悄改掉用户终端的行为，
 * 那是另一件事，得用户自己决定。
 */
const SERVER_ENV_DENY: RegExp[] = [
  /^TERMBOARD_/,
  /^CLAUDE_CODE_/,
  /^CLAUDECODE$/,
  /^CLAUDE_(PID|BINARY|EFFORT|PLUGIN_DATA)$/,
  /* 非锚定 —— 任何 `*_SESSION_ID` 都是"某一次会话"的身份。
     它同时让上面那道前导减号守卫真正承重：`-CODEX_COMPANION_SESSION_ID`
     在没有守卫时会被这条打中。全锚定的规则集里那道守卫是测不出来的。 */
  /_SESSION_ID$/,
  /^AI_AGENT$/,
  /^ELECTRON_/,
  /^npm_/,
  /^NODE_ENV/,
  /^INIT_CWD$/,
  /^WARP_/,
  /^TERM_PROGRAM/
]

/**
 * `show-environment -g` 的输出 → 要清掉的键。
 *
 * ⚠️ 输入里 `-KEY`（前导减号）表示"这个键在全局环境里被标记为移除"，
 * 它**本来就已经不生效了**，再去 `-u` 一遍纯属白跑子进程。
 */
export function serverEnvKeysToScrub(showEnvironmentOutput: string): string[] {
  const out: string[] = []
  for (const line of showEnvironmentOutput.split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('-')) continue
    const key = s.split('=')[0]
    /* `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 必须留下 —— 它们是身份隔离的载体，
       删掉等于把绑了凭证的会话退回系统默认账号。deny 表里逐条写死正是为此，
       别改成「凡是 CLAUDE_ 开头的都删」。 */
    if (key && SERVER_ENV_DENY.some((re) => re.test(key))) out.push(key)
  }
  return out
}

/**
 * 这个键的值是不是密钥。
 *
 * 密钥**不能走 `tmux -e`** —— 那会把值原样写进 tmux 客户端的 argv，
 * 而客户端进程和终端同寿。实测 `ps -Ao args` 全程看得到，同机其他用户也读得到
 * （macOS 不像 Linux 有 hidepid）。
 *
 * 路径类（CODEX_HOME / CLAUDE_CONFIG_DIR）不是秘密，照常走 `-e` ——
 * 这样用户在会话里手开 window 也还是同一个账号。
 */
/** POSIX shell 单引号转义 —— 值里有引号/空格/换行时不能拼裸字符串 */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
const shq = shellQuote

export const isSecretEnvKey = (k: string): boolean => /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k)

/**
 * identity **显式声明**的值是不是密钥。
 *
 * 和上面那条的区别是**默认方向反过来**：identity 里的值是用户为了让某个账号生效
 * 而填进来的，默认按密钥处理，只有下面这几个路径类的键例外。
 *
 * 按名字正则猜会漏一大片 —— `DATABASE_URL`、`AUTH_HEADER`、`COOKIE`、
 * 带签名的下载 URL 都不匹配 `(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)`，
 * 漏掉的那些会原样写进 tmux 客户端 argv，而客户端进程和终端同寿。
 *
 * 例外的这几个是**路径**：指向哪个账号目录不是秘密，而且它们必须走 `-e` ——
 * 那样用户在会话里手开一个 window 才还是同一个账号。
 */
const IDENTITY_PUBLIC_KEYS = new Set([
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'GEMINI_CLI_HOME',
  'GEMINI_CONFIG_DIR'
])
export const identityValueIsSecret = (k: string): boolean => !IDENTITY_PUBLIC_KEYS.has(k)

export function assembleSpawnArgs(
  tmux: string | null,
  session: string,
  conf: string,
  shell: string,
  cwd: string,
  env: Record<string, string>,
  identity?: IdentityEnvSpec,
  /** 密钥落盘文件的路径（0600）。会话的 shell 先 source 它再 exec，值不进 argv */
  secretFile?: string
): { file: string; args: string[] } {
  const unset = identity?.unset ?? []
  /* 真 unset 只能靠 `env -u`：tmux 的 `-e KEY=` 只把值设成空串（实测），
     而 tmux server 是长寿共享的，**没给 -e 的变量会继承 server 启动时的环境** ——
     用户 shell 里 export 过的 OPENAI_API_KEY / ANTHROPIC_API_KEY 就是这么漏进
     每个会话的，让 CLI 绕过订阅走按量计费，账单还不吭声。 */
  const stripped = unset.length ? ['/usr/bin/env', ...unset.flatMap((k) => ['-u', k])] : []

  if (!tmux) {
    return stripped.length
      ? { file: stripped[0], args: [...stripped.slice(1), shell, '-l'] }
      : { file: shell, args: ['-l'] }
  }

  const args = ['-L', TMUX_SOCKET, '-f', conf, 'new-session', '-A', '-D']
  /* env 不能靠继承 → -e 显式注入。
     已存在的 session attach 时 -e 被忽略 = 会话保持自己的身份，语义正确。

     转发范围 = identity 显式声明的键 ∪ 几个已知 provider 前缀。
     **不能只按前缀猜**：OPENAI_* 一度不在前缀表里，于是 identity 里写
     `OPENAI_API_KEY=...` 在开着 tmux 时静默不生效。 */
  const explicit = new Set(identity?.keys ?? [])
  const providerPrefix = /^(ANTHROPIC_|CLAUDE_|CODEX_|GEMINI_|OPENAI_)/
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('TERMBOARD_') || k === 'TERM' || k === 'COLORTERM') continue // TERM 由 tmux 管
    /* 密钥**永远不进 argv**，不管这次有没有落盘文件。
       以前条件是 `secretFile && …` —— 而接回已存在的会话时不会新建文件
       （值早就在会话环境里了），于是那一次密钥就原样进了 argv。
       identity 显式声明的值按 identityValueIsSecret 判（默认即密钥），
       继承来的环境按名字正则判。 */
    if (explicit.has(k) ? identityValueIsSecret(k) : isSecretEnvKey(k)) continue
    if (explicit.has(k) || providerPrefix.test(k)) args.push('-e', `${k}=${v}`)
  }
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('TERMBOARD_')) continue
    /* **HOOK_TOKEN 绝不进 argv。** 上面那个循环判密钥之前就 `continue` 掉了
       所有 `TERMBOARD_*`，这里再无条件推回去 —— 于是这把 token 整条出现在
       `ps -Ao args` 里，同机任何用户都读得到。而它能伪造该节点的 SessionStart，
       **SessionStart 在 delegate 的状态机里先于墓碑、无条件置活**
       （所以它才按 0600 落盘、创建那刻就给权限，见 hooks.ts）。

       这个 `-e` 本来就是冗余的：endpoint 文件会按 `TERMBOARD_NODE_ID`
       从 token 目录**现读**这把 token，而 hook 脚本和 tb 脚本都是 source 完再用 ——
       跨 app 重启接回老会话时也只有现读这条路管用。删掉它两条脚本路径都不受影响。 */
    if (k === 'TERMBOARD_HOOK_TOKEN') continue
    args.push('-e', `${k}=${v}`)
  }
  args.push('-c', cwd, '-s', session)
  if (secretFile) {
    /* shell 先 source 密钥文件、当场删掉它，再 exec 真正的登录 shell。
       argv 里只有路径，值一个字都不出现。文件是 0600 且用完即删，
       落盘窗口只有几毫秒。 */
    const inner = `. ${shq(secretFile)} 2>/dev/null; rm -f ${shq(secretFile)}; exec ${shq(shell)} -l`
    args.push(...stripped, '/bin/sh', '-c', inner)
  } else {
    args.push(...stripped, shell, '-l')
  }
  return { file: tmux, args }
}
