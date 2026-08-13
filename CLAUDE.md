# Termspace — 无限画布终端管理器

## 项目概述

终端不是叠 tab，是可拖拽节点铺在无限画布上（对标 nodeterm，从零自研，BUSL 无关）。
差异化方向：agent 状态发光边框（缩到全景看颜色分布即知哪个 agent 在等你）、太极协同可视化、中文市场。

- **当前阶段**: alpha（功能密度高，F1-F8 各有纵向切片；发布工程未就绪，不可外发）
- **技术栈**: Electron + electron-vite + React 19 + TS + Tailwind 4 + @xyflow/react 12 + @xterm/xterm 6 + node-pty
- **UI 规范**: 见 `DESIGN.md`（画布学 Figma、节点内部学 Warp、气质 Linear + 未来感 glow）

### 命名（TermBoard → Termscape → **Termspace**）

- **2026-07-25** TermBoard → Termscape（38 个候选里选的，域名与商标全空）
- **2026-07-28** Termscape → **Termspace**（用户定名。上一轮改名混在一句「全都做」里
  自动执行、没经用户确认，用户此后两天一直把它读作 Termspace —— 以此为准）

改名只覆盖**品牌面**：appId `dev.termspace.app`、productName、窗口/页面标题、`window.termspace` bridge、文档。

改名的安全判据是一条不变量，改动前后必须相等：**`termscape`/`termspace` 家族全改，
`termboard` 家族（36 `termboard` + 4 `Termboard` + 1 `TermBoard` + 94 `TERMBOARD`）一处不动**。
两个词没有公共子串，所以 sed 天然不会误伤 —— 但仍要逐形态计数核对，别只看总数。

以下 `termboard` 字面量**故意保留，不要"顺手统一"**——它们指向磁盘上已存在的数据或运行中的会话，改了就断：

| 保留项 | 改了会怎样 |
|--------|-----------|
| userData 目录 `~/Library/Application Support/termboard/` | 工作区/简报/凭证/预设全部孤儿化；活 tmux 会话里 `tb` 命令的 PATH 失效 |
| tmux socket `termboard` + 会话前缀 `tb-` | 所有续存中的会话瞬间变孤儿 |
| `TERMBOARD_*` 环境变量 | 已写进 `~/.claude/settings.json` 的 hook 命令与运行中会话的 env，改了 hook 全断 |
| `tb` 命令名、`.termboard-backup` 备份后缀、`x-termboard-token` 头 | 同上，都是已落地的外部契约 |

真要统一得配一次性迁移（重命名目录 + 重建 hook 配置 + 重建全部会话），目前不值。

## 结构

```
src/
  main/index.ts        # Electron 主进程 + PTY 管理（spawn/write/resize/kill via IPC）
  main/remote.ts       # 远程 API + 手机端静态托管（白名单，无路径拼接）
  main/net-iface.ts    # 绑定地址探测（回环 / Tailscale）+ Host 头白名单
  main/approval-policy.ts  # 审批规则引擎（纯代码，只出 require_human / deny）
  preload/index.ts     # contextBridge 暴露 window.termboard
  renderer/src/
    App.tsx            # ReactFlow 画布 + 工具栏
    nodes/TerminalNode.tsx  # 终端节点（xterm + fit + webgl + LOD + ResizeObserver）
    styles.css         # 设计 token + 节点/工具栏样式
mobile/                # 手机端 PWA：纯静态、无框架、无打包器，主进程按白名单直发
  index.html app.js style.css sw.js manifest.webmanifest icon.svg
```

## 命令

```bash
npm run dev        # 开发模式
npm run typecheck  # tsc --noEmit
npm test           # 派活准入 smoke test（Node 原生 type stripping，无框架依赖）
npm run rebuild    # node-pty 重编译（换 Electron 版本后必跑）
npm run dist       # 未签名双架构（CI 用，只验证能打出来）
npm run dist:local # 签名、跳过公证、**只出 arm64**、收尾自动 rebuild（本机自用走这个）
npm run dist:signed  # 签名 + 公证正式包（需下面四个环境变量）
TERMBOARD_SHOT=/tmp/shot.png npm run dev  # 自检：默认 6 秒后截图退出
TERMBOARD_SHOT_DELAY=30000                # ↑ 调长（账号发现那条链 6 秒跑不完）
TERMBOARD_PANEL=identities                # 自检：直接展开设置面板某分区
                                          # 合法值：general terminal presets identities
                                          #        hooks remote peers update
TERMBOARD_CLICK='text=添加账号或密钥|text=登录另一个订阅账号'  # 截图前依次点击
TERMBOARD_FITPROBE=1                      # 量终端 canvas 溢出内容区多少像素
```

## 关键决策 / 坑

- **vite 锁 7.x**（electron-vite 5 不支持 vite 8）、**@vitejs/plugin-react 锁 5.x**（6 要 vite 8）
- **不用 React StrictMode** — dev 双跑 effect 会 spawn+kill pty 两次
- 终端区域必须 `nodrag nowheel` class，否则 React Flow 抢拖拽/滚轮
- **缩放三档的判据（2026-08-13 重定，用户报「过早隐藏内容」）**：
  - 内容 → LOD：`fontSize × zoom < 2`，即**屏幕上的有效字号**，不是 zoom 本身。
    老判据 `zoom < 0.35` 一刀切，与节点多大、字号多少无关 —— 把节点拉大照样被收掉
  - LOD → 远景：`FAR_ZOOM` 0.14 → **0.075**。老值和 LOD 阈值几乎重合，中间没有过渡
  - LOD 占位与远景胶囊的正文都要 **×(1/zoom) 反缩放**，否则 canvas 坐标里的字号
    被画布缩放吃掉（实测 28px 标题在 zoom 0.11 只剩 5px）。⚠️ 是 `Math.max(1, …)`
    不是 `min` —— 写成 min 会把 4.6 夹回 1，整个反缩放静默失效
  - **远景的空闲态不填实心灰**：「空闲」没有语义，却因为节点多而在全景里最抢眼。
    只留极淡底 + 发丝描边；蓝/橙/红照旧实心 —— 与「glow 只给语义」同一条
- **`TERMBOARD_ZOOM` 会报实际缩放**：它按 1.2 倍离散点击实现，落点必然量化
  （请求 0.15 停在 0.156）。它以前不报，于是每次拿它做的测量都是拿请求值当实测值 ——
  定这几档阈值时我就这么误判过一轮。现在还会报标题/胶囊在**屏幕上**的像素高度
- **pty 已 tmux 续存**：socket `termboard`、会话 `tb-<nodeId>`、conf 在 userData（`destroy-unattached off` 是命根）。reload/HMR/app 退出=releasePty（会话活）；节点 ✕/换身份=destroyPty（kill-session）。调试残留：`tmux -L termboard ls / kill-server`
- deleteKeyCode=null：防误删节点杀 shell，删除走 ✕（已实现 destroy 语义）
- 启动状态推送必须走 renderer:ready 握手（首推早于订阅会竞态丢失）
- **workspace 落盘必须原子**：tmp+rename + `.bak` + 损坏隔离。裸 writeFile 写一半被杀 =
  JSON 截断 → load 当成首次启动 → 画布归零，且随后 reap 把所有 tmux 会话当孤儿杀光
- **删节点必须连带删连线**：连线是授权图，悬空连线 = 新节点白捡旧节点的授权
- **关标签页留下的 board 必须能被认领回来**（`reclaimBoardId` / `orphanBoardsToRecover`）。
  `closeProject` 有意保留画布和 tmux 会话，但 `addProject` 原来每次铸新 pid，
  于是"重新添加同目录即恢复"根本做不到。**症状不是报错也不是丢数据，是数据留得太好**：
  reap 认的是"所有 board 里出现过的节点 id"，孤儿 board 里的终端会一直活下去，
  界面上看不见、关不掉。本机实测躺着 4 个孤儿 board、两个活了三天的终端。
  → board 上存 `cwd`，同目录再加时认领原 pid（认 pid 不搬节点，pid 决定上下文文件名）；
  正在用的 board 不认领（同目录开两个标签页是合法的）；
  没有 cwd 的老孤儿在启动时直接给标签页，判据是**有没有 terminal/browser 节点**
  —— 只剩自动播种的 `ctx-hub` 不算，那是空画布且没有活进程要救
- **节点 id 不可复用**（`board-serde.ts` 的 `newNodeId`，形如 `t-7k3f9a`）。
  老实现是 `max+1`，删掉 `t7` 再建一个还叫 `t7` —— 而 nodeId 同时是 **tmux 会话名
  `tb-<id>`、scrollback 文件名、上下文文件名、hook token 文件名、pty 表的键、授权图的键**，
  一复用这六条链路一起串台。代码里为此写过四处补偿逻辑，前提都是"复用发生在删除之后"。
  ⚠️ **老工作区里的 `t1`/`b3` 还在**，那四处补偿要留着；改 id 格式时必须同步核对
  `src/main/index.ts` 的 `NODE_ID_RE`（两处必须一致，不一致 = 终端静默起不来）
  和 `tmux.ts` 的 `sessionName` 字符替换（被替换 = 两个 id 撞同一个会话）
- **pinch 缩放要用原生 non-passive wheel 监听**：React 的 wheel 是 passive 委托，
  合成事件里 `preventDefault()` 是空操作
- **WebGL context 上限已实测，不用再猜**：`TERMBOARD_WEBGL_STRESS=20 npm run dev`
  → 20 个终端里 16 个拿到 context、4 个直接走 DOM renderer；再打爆 → 16 次 contextlost
  → 全部落回 DOM 且**字还在**。这条路不用改。
  ⚠️ 复测时**必须等满 6 秒**：addon 收到 `webglcontextlost` 后会先等 3 秒看 context
  自己恢不恢复，之后才 fire `onContextLoss`。窗口短于 3s 会量出"降级失效"的假结论
- **`term.loadAddon()` 抛错后要显式 `dispose()`**：AddonManager 是 `_addons.push()`
  之后才 `activate()`，激活失败的 addon 仍留在列表里，`term.dispose()` 时还会被再调一次
- **ResizeObserver 里尺寸为 0 时不能 fit**：会把 cols/rows 算成 1×1 并真发给 pty，
  shell 照着重排一遍输出。元素 `display:none` / 折叠 / 未布局都会走到这条路
- **LOD 的账记在 GPU 上，不在 renderer 上**（`TERMBOARD_LOD_BENCH=16 npm run dev`）：
  16 个终端持续输出时，缩到 LOD 让 **GPU 6.1% → 1.1%**，而 **renderer 1.8% → 1.6% 几乎不动**
  —— `visibility:hidden` 省掉了合成绘制，但 xterm 照常解析和渲染。
  codex 建议做 WebGL lease pool（只给可见+活跃的 N 个上 WebGL），**先不做**：
  16 个终端满负荷才 2% renderer，没有要解决的问题。真到卡了再按这个数复量
- **`<webview>` 远缩时不能卸载**：摘出 DOM = 浏览器会话销毁 + 注册表留死引用。
  学 TerminalNode：保持挂载 + `visibility:hidden`
- **派活是最危险的一段**：注入 = 替用户敲回车。只接受当前活着的 agent 会话
  （靠 session_id 挡 SessionEnd 之后的迟到事件），状态判定 fail-closed，改动后跑 `npm test`
- **任务正文必须过 `sanitizeTask` 才能落笔**（在 delegate 里收口，所有调用方共用）。
  所有闸都在 `writeToPty` **之前**查，而载荷在 write **之后**起作用 —— 顺序天生错开：
  `\x03`/`\x04`/`\x1a` 是 agent TUI 的退出键，agent 一退，队列里剩下的字节就由
  重新拿回终端的 shell 读走。这不是提权（调用方本来就有 shell 权限），
  挡的是**上游 agent 被提示词注入**后，把「给一个有审批闸的 agent 发提示词」
  降级成「在目标终端裸跑 shell 命令」—— 而控制字符在授权弹窗里根本不可见
- **完成判定要认 transcript 文件有没有换**：换了 = 换了会话，这个 Stop 不是本轮的。
  老写法在文件变了时把偏移**归零**再读整份 —— 于是目标中途退出重开、新会话随便
  产生一个 Stop，就会**把新会话的回答当成本轮结果返回**。
  ⚠️ 判据用 path 不用 epoch：`SessionEnd` 自己也推进 epoch，而"答完就退出"
  是完全正常的一轮，判 epoch 会误杀合法答案
- **检查和落笔之间只要还有 await，就得在落笔那一刻再查一遍**：授权复查在
  前台探测和 stat **之前**，这两步各一个 await，足够 agent 退出 —— 那时 pane 里是
  光秃秃的 shell，`writeToPty` 就是直接执行命令。同类的还有 remote.ts 的"读 body
  是异步的，开关要在 await 之后重查"。
  `DelegateDeps.finalGate` 就是为此存在（跨机那条链路的开关在这里再查一次）；
  **`finalGate` 到 `writeToPty` 之间不许再出现任何 await**
- **敏感文件的权限必须在创建那一刻就给**，不能"先写完再 chmod"：`writeFile` 用默认
  权限（umask 022 → 0644），rename 之后到 chmod 之前那个文件是**全局可读**的。
  `bin/tb-peer` 的正文里带着完整 peer token、`nodetokens/*` 能伪造 SessionStart
  （而 SessionStart 在 delegate 的状态机里先于墓碑、无条件置活）。
  窗口只有几毫秒，但监听目录事件就能守到
- **必须有单实例锁**（`app.requestSingleInstanceLock`）：dev 和打包版共用同一个
  userData（有意为之，换目录会让所有 tmux 会话变孤儿），同时开两个就会 workspace.json
  互相整份覆盖、reap 把对方的会话当孤儿杀光、hook/远程端口抢不到。
  用 `app.exit()` 不用 `app.quit()` —— quit 要等 will-quit，这中间 whenReady
  会先建出第二个窗口，而窗口一挂载就开始读 workspace 并起防抖保存

## 同机多订阅账号（2026-07-26）

同一条 `codex` / `claude` 命令，两个终端节点登两个不同的订阅号 —— 靠 identity env 包：

| CLI | 隔离开关 | 实测 |
|-----|---------|------|
| codex | `CODEX_HOME` | 换目录后 `codex login status` → `Not logged in` |
| claude | `CLAUDE_CONFIG_DIR` | 换目录后 `claude -p` → `Not logged in · Please run /login` |

流程：凭证面板点模板 → 保存 → 节点凭证下拉里选 → 在那个终端跑一次 `codex login`。

三个坑，都已在代码里处理，改动前先看：

- **`KEY=`（空值）语义是删掉这个变量**，不是设成空串。用户 shell 里 export 的
  `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 会被 app 继承，CLI 优先走按量计费 ——
  订阅号白开且账单不吭声。真 unset 用 `/usr/bin/env -u`（tmux 的 `-e KEY=` 只给空串，实测）
- **tmux server 长寿共享，没给 `-e` 的变量继承 server 启动时的环境**。所以转发范围
  必须是「identity 显式声明的键 ∪ provider 前缀」，**不能只按前缀猜** ——
  `OPENAI_*` 一度不在前缀表里，identity 里配 `OPENAI_API_KEY` 开着 tmux 就静默不生效
- **env 值不过 shell**，`~/` 和 `$HOME/` 要自己展开，否则 codex 会真建一个叫 `~` 的目录
- identity env **不许覆盖 `TERMBOARD_*`**（会让该节点的状态/派活哑掉）；若它改写了 `PATH`，
  要把 `tb` 的目录重新顶回最前

## 额度采集（2026-07-27）

`src/main/quota/` —— **一个账号一个采集器**，全局单例拉一次广播给所有节点（额度是账号级的，
绝不每节点各拉）。5 分钟一轮。完整调研见 `docs/QUOTA.md`。

- **Claude**：`GET https://api.anthropic.com/api/oauth/usage`，token 从钥匙串取。
  必须 `execFile('/usr/bin/security')` —— 那条记录的 ACL 信任的是 security 这个二进制本身，
  走 keytar 之类的原生绑定会弹授权框。**拿不到 token 就绝不发请求**：匿名请求返回的是
  429 + `retry-after: 1460`（IP 级封 24 分钟），不是 401。也不做 refresh_token（会和
  Claude Code 抢写钥匙串）
- **Codex**：`codex app-server --stdio` 的 JSON-RPC `account/rateLimits/read`。
  三个坑：① 二进制在 `~/.npm-global/bin`，Electron 从 Finder 启动不继承登录 shell 的 PATH，
  必须走绝对路径否则把"装了的用户"显示成"未安装"；② `initialize` 的 params 形状错了
  服务端**静默退出**，一行错都不报；③ 未登录时该方法会**静默挂 25s**，必须硬超时
- **窗口语义只能从 `windowDurationMins` 推，绝不按数组位置认 5h/周**。实测本机 codex
  账号只有 10080min（周）一个窗口、`secondary` 是 null —— 按位置认会凭空多出一行 5h
- `~/.claude/claude-usage.json` 是用户自己的 statusline tee 脚本产物，**不是官方文件**，
  换机就没有 → 只做最后兜底，且一律标 stale（实测能和真值差 30 多个百分点）
- **采集期间来的 `setAccounts` 不能丢**：一轮采集要几秒（codex 未登录时硬超时 25s），
  用户正好在这段时间改了凭证的隔离目录，那次刷新会被 `if (running) return` 吃掉；
  而正在跑的那轮用的是**旧账号列表**（`Promise.all` 的入参在 await 之前就求值完了），
  它结束时还会把新配置的显示盖回去。要 pending 补跑
- **计费方式只有一个判据：`identity-env.ts` 的 `billingKind`** —— 最终生效的环境里
  有没有 API key。登录态和额度**必须共用它**：曾经一个用"有 key 且没隔离目录"、
  另一个用"有隔离目录"，于是两样都配的凭证会去查那个目录，把里面**另一个订阅号**的
  "已登录 + 还剩 70%"显示在这个凭证名下，而每次调用都在出账单。
  看 `probeEnv` 不看 identity 自己的 `set`：用户 shell 里 export 的 key 会被继承，
  那也真的会生效；identity 用 `KEY=` 删掉的则已经不在里面了
- state 分五档。**「查不到」「未登录」「用了 0%」必须是三种东西** —— 未登录能自己修
  （去跑一次 login），查不到只能等。所以 `unconfigured` 只藏"自动探测的系统号且没人在用"，
  **用户自建的凭证即使未登录也必须占位**，否则那个号在界面上就是凭空消失
- **窗口标签从小到大判**：老写法第一条是 `mins >= 10000 → '周'`，于是 43200（月）也成了"周"。
  和 `quota2.sh` 把周窗口标成 5h 是同一类错
- **别信 `~/scripts/quota2.sh` 的数**：它读的是 session jsonl / statusline 快照，都是
  **上一次落盘的历史值**，进程一停就冻住。实测真值 0% 时它报 8%（10 小时前的数）。
  Termspace 走实时 API，以 app 里的为准
- codex 的 `credits.balance` 是**余额字符串**（可能是 `"$766.76"`），不是上限；
  `Number()` 直接吃会得到 NaN。`QuotaSpend` 的 `usedMinor` 和 `remainingMinor` 是两个
  方向相反的数，缺哪个留 undefined，**绝不拿 0 顶上**
- 每个采集器都要 `windows.length ? 'ok' : 'unknown-shape'`；Hub 的 `setAccounts` 要比
  **指纹**（含 name / env）而不是 accountId —— 换了 `CODEX_HOME` 而 id 不变时会继续显示旧号

## tmux server 的环境是**快照**，不是**视图**（2026-08-13）

`show-environment -g` 里的东西 = **第一个客户端**启动那一刻的整份环境，
此后活到 `kill-server` 为止再也不变。本机实测那份快照来自 **7/24 22:36 的一次
`npm run dev` 自检**，于是 20 天里新建的每个终端都在继承它：
`CLAUDECODE=1` + 一个早已结束的 `CLAUDE_CODE_SESSION_ID` + `CLAUDE_CODE_CHILD_SESSION=1`
（新起的 claude CLI 以为自己是那个会话的子会话）、`TERM_PROGRAM=WarpTerminal`、
`TERMBOARD_NODE_ID`/`CONTEXT_FILE`/`AGENT_ID`（本该每会话 `-e` 独有）、`ELECTRON_*`/`npm_*`。

`tmuxClientEnv` 从**客户端**环境摘掉这些是对的，但它**只管下一个 server**。
所以必须能**就地清**（`scrubServerEnv` → `set-environment -g -u`，每次 app 启动一次），
否则唯一修法是杀光用户所有续存会话。只影响此后新建的会话 —— 已起来的 pane
tmux 不回溯改写，这是对的：正在跑的活不该被脚下换环境。

- **判据是「这个键描述某一次进程/会话的身份」**，不是「它看起来没用」。
  `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 必须留 —— 删掉 = 绑了凭证的会话**静默**退回系统默认账号。
  所以 deny 表逐条写死，**绝不写成「凡 CLAUDE_ 开头都删」**
- **故意不清密钥和代理**（`OPENAI_API_KEY` / `GITHUB_TOKEN` / `HTTP_PROXY`）：
  那些是用户 shell 里本来就 export 的，终端继承是既定行为（要删走 identity 的 `env -u`）。
  在这里顺手删 = 悄悄改掉用户终端的行为，那是另一件事
- 排查同类问题时**先看 server 起于何时**（`ps -o lstart`），别看 app 起于何时

## 采集"跑了但失败" ≠ "空手而归"（2026-08-13）

`pickQuota` 的老顺序「有窗口 → 用；否则 api-key → 兜底；否则用 r」，
让 `kind === 'api-key'` 的账号只要**采集失败**（超时/提前退出/找不到二进制），
采集器带回的诊断就被 `apiKeyUnavailable` 整个替换成 `admin_only` →
界面写 **「仅管理员可查询」**。

三重错：codex 额度根本不是 admin-only（手跑同一接口拿得到周窗）；
把**瞬时**超时说成**永久**权限限制；真因被丢掉，用户没线索去修。
且本机是常态不是边角 —— 登录 shell export 了 `OPENAI_API_KEY` → `system:codex`
判成 api-key，而 `mayProbe` 对 `system:*` 一律放行 → **系统默认账号永远走采集，
一失败就永远掉进兜底**。

`r` 非 null 就一律用它；兜底只留给 `r === null`（`mayProbe` 拒了 / 没有采集器）。
「api-key 不该显示订阅额度」由 `mayProbe` 在**采集之前**保证，不靠这里兜。
上一轮「只有采集器确实空手而归才退回按量计费」只修到了 `r === null` 那一半。

⚠️ 老用例叫「只有在采集器**空手**时才退回」，传的却是个**非空**的 `r` ——
**名字和断言对不上的用例，钉住的往往正是那个 bug**。

## 变异测试的第三种形状：守卫根本不承重（2026-08-13）

给 `serverEnvKeysToScrub` 写了条「`-KEY`（已标记移除）不再重复 unset」的用例，
样本用 `-DISPLAY`。**把守卫删掉，全绿** —— 因为 deny 规则全是 `^` 锚定的，
`-DISPLAY` 本来就匹配不上，有没有守卫结果一模一样。

这不是「用例写弱了」，是**被测的那行代码在当前规则集下不可能改变输出**。
补了一条本就该有的非锚定规则 `_SESSION_ID$`、样本换成 `-CODEX_COMPANION_SESSION_ID`，
守卫才真正承重，删掉必红。

> 修假绿的正确方向常常是**让实现变得可证伪**，而不是把断言写得更花。

## 凭证的三态 envOps（2026-07-29 取代空字符串重载）

存的不再是 `Record<string,string>`，而是

```ts
envOps: [{ key, action: 'set', value } | { key, action: 'unset' }]
```

老格式里 `KEY: ''` 的语义是**删掉这个变量**（防订阅号被继承来的 API key 顶走），
靠空串重载 —— UI 只能让用户自己猜，而**迁错一次用户不会看到报错，
只会在月底账单上看到**。所以 `identity-model.ts` 的 `migrateIdentity` 是
`value === '' ? unset : set`，且解密后立即原子重写；重写前留一份
`identities.bin.pre-envops.bak`（单向转换，凭证比画布更值钱）。

- 渲染层只拿 `{key, action}`，**已保存的明文永不回传**；编辑只有「保留原值/替换/删除」
- 危险键黑名单在 `identity-env.ts`：`TERMBOARD_*`/`PATH`/`TMUX`/`HOME` 之外还要挡
  `DYLD_* LD_* NODE_OPTIONS BASH_ENV ENV ZDOTDIR PROMPT_COMMAND SSH_ASKPASS
  GIT_SSH_COMMAND PERL5OPT PYTHONSTARTUP` —— 否则「添加任意 env key」**同时就是一个
  代码执行入口**
- provider 清单是**随应用发布的版本化 manifest**（`src/shared/provider-manifest.ts`），
  绝不从网络下发可执行探测命令。`loginHint` 必须写**具体命令**，
  因为各家形状不一样、用户猜不到：claude 是**进 TUI 之后的 `/login`**、不是 shell 命令；
  gemini / antigravity **没有 login 子命令**，首次运行自己弹 OAuth。本机逐个 `--help` 核过

## 凭证节点（2026-07-26）

账号在画布上的实体。`credential` 节点 → 终端的连线 = 该终端用这个账号。
三条约束是设计的一部分，别当成可以放宽的细节：

- **连线优先，节点头部的下拉被锁掉**（`data.credBound`）。同一件事两个入口必然打架
- **拉线会杀会话重开**（identityId 变更即 destroy + respawn），所以拉线前弹确认。
  拉一根线是很轻的手势，后果却是重启用户正在跑的活
- **连线 ≠ 自动登录**。`CODEX_HOME` / `CLAUDE_CONFIG_DIR` 只负责隔离，
  指向新目录时那个号是空的，第一次仍要在终端里跑一次 `codex login`。
  所以节点上显示登录态：codex 用 `codex login status` 真查（只读、~1s、不花额度）；
  **Claude 没有等价命令**（穷举过 `--help`），如实报 unknown，别猜
- 节点上**只列 envKeys 不列值**。渲染层本来就拿不到值，别改成能拿到
- 一个终端只能有一个凭证：连新线时先摘掉旧的凭证连线

## 手机端（2026-07-26）

`mobile/` 是纯静态页，由主进程的远程 API 用**固定白名单表**直发（`STATIC` in `remote.ts`），
不拼路径 → 从根上没有目录穿越。打包时靠 `electron-builder.yml` 的 `files: mobile/**/*`
收进 asar，运行时 `path.join(app.getAppPath(), 'mobile')` 读得到（已实测签名包）。

- **绑定只有两个选项：回环 / Tailscale 网卡。永远不要加 0.0.0.0。**
- **只判 CGNAT 网段是不够的（差点酿成 P0）**：100.64.0.0/10 是**共享**段，酒店/校园/
  运营商 DHCP 会直接把 100.71.x.x 发给物理网卡，而 `os.networkInterfaces()` 里 en0
  稳定排在 utun 前面 → 服务被绑到公共 Wi-Fi 上，界面还写着"只有你自己的设备看得见"。
  判据必须是 **CGNAT + /32 掩码 + 全零 MAC**（tun 口的形态），再用 `tailscale ip -4`
  在多张 tun 网卡时消歧。接口名不能用（utunN 的 N 每次变）
- Tailscale 没起来时**退回回环**并在设置里如实标「没找到」，绝不退到 en0
- **`http://100.x.x.x:7333` 不是浏览器的安全上下文** → `navigator.serviceWorker` 直接不存在。
  离线壳 / 安卓安装拿不到；iOS「添加到主屏幕」不受影响。要完整 PWA 得 Tailscale 后台开
  HTTPS 证书 + `tailscale serve --bg 7333`（那条路还更安全：本进程可以只绑回环）
- **手机端画布用「地图针」模型**：坐标跟缩放、节点尺寸不跟。照搬桌面的整体 scale 在
  390px 屏上缩放比会掉到 0.05，节点变成看不见的点 —— 画布的全部价值就是扫一眼看颜色
- 轮询而不是 SSE：`EventSource` 设不了 `Authorization` 头，硬用就得把 token 塞 query string
- 轮询回来要**比对签名再决定重不重建 DOM**：无脑重建会把用户的平移/缩放和「二次确认」
  的上膛态一起清掉
- 远程写操作只有两类（写终端 / 批准工具调用），各自独立开关，**没有 spawn/kill/destroy 路由**
- **脱敏只能有一个出口**：`approval-dto.ts` 的 `toPublicApproval()`。审批记录有两条外发路径
  （实时 publish / 快照 listApprovals），各写一份脱敏就漏了一条 —— 完整 `tool_input`
  曾因此进了 renderer 并从 `/api/events` 出网。逐字段构造，不是 spread-then-delete
- **开关要在 await 之后再查一遍**：读 body 是异步的，客户端可以在开关还开着时发头、
  拖住 body，等用户关掉之后再补完。落笔前必须重查
- **安全开关只能往收紧的方向失败**：关掉开关要**先**改内存再落盘。等落盘成功才生效的话，
  写盘一失败界面显示"只读"、实际 gate 仍是 true
- **手机端任何 await 之后都不能再读全局 `currentId`**：慢网下 A 的迟到响应会画到 B 上，
  用户看着 A 的问题、答案发进 B。目标 id 必须在发请求那一刻钉住并显式传下去

## 打包签名（已就绪，2026-07-26）

证书 `Developer ID Application: Nanjing Lonely Island Network Technology Co., Ltd. (85V88J2F3F)`
已装进登录钥匙串，有效期至 2031-07。公证走 App Store Connect API 密钥。

```bash
export APPLE_API_KEY=~/.appstoreconnect/private_keys/AuthKey_APPLE_KEY_ID.p8
export APPLE_API_KEY_ID=APPLE_KEY_ID
export APPLE_API_ISSUER=APPLE_ISSUER_ID
export APPLE_TEAM_ID=85V88J2F3F
npm run dist:signed
```

**自用出包走 `npm run dist:local`**（签名但跳过公证）：
- Apple 的公证队列**说慢就慢**，实测排过 40 分钟还是 `In Progress`，而
  electron-builder 等不到就报一条**空错误**（`Failed with unexpected result:` 后面什么都没有）。
  看到它别急着查代码，先 `xcrun notarytool history` 看真实状态
- 公证是给**别人下载**用的：quarantine 属性只有浏览器/AirDrop 会加，
  本机构建出来的包和 `scp` 传过去的包都没有，直接 `cp` 到 `/Applications` 就能跑。
  `spctl --assess` 会报 `rejected`，那是预期的，不代表装不上

坑：
- **hardened runtime 必须配 entitlements**（`build/entitlements.mac.plist`），
  放行 V8 的 JIT 和 node-pty，否则签完能过公证但**一启动就崩**
- electron-builder 26 的 `notarize` 只收布尔值，teamId 走环境变量（写成对象直接 schema 报错）
- DMG 要单独 `notarytool submit` + `stapler staple`，electron-builder 只公证 .app
- 验收三连：`codesign --verify --deep --strict` / `spctl --assess --type execute`
  （要看到 `source=Notarized Developer ID`）/ `stapler validate`

## 跨机派活（2026-07-27）

`tb ask <ssh别名>:<节点> <任务>` —— 走用户已有的免密 ssh，**不新增任何网络暴露面**
（两边 hook server 照旧只绑 127.0.0.1，ssh 隧道进来的源地址本身就是回环）。
（当初的评审全文是过程产物，未随仓库发布。）

- **不要改成给 `remote.ts` 加 `/api/delegate`**（这是最初的方案，被否了）：字面上不是
  exec，安全语义上是 RCE-by-proxy —— 往一个有 Bash 权限的 agent 里注入提示词。
  ssh 那条路上，能连进来的人本来就有完整 shell 权限，没有新增能力
- **alias 白名单是安全判据不是配置便利**：alias 原样进 `ssh` 的 argv，
  `-oProxyCommand=…` 这种"机器名"会在**本机**执行任意命令。格式校验（`peer.ts`
  的 `isPeerAlias`）+ 白名单两道，settings 读盘时也滤一次 —— 判据必须共用同一个，
  各写一份正则改一处漏一处
- **对端授权不走 `authorizeLink`**：那个函数比对画布连线 `boardLinks`，而 peer 不是
  画布上的节点，比对永远不成立 —— 只会弹一个远端没人看的窗，还留下匹配不上的幽灵 grant。
  跨机的判据是设置里的开关，且要在 `authorize` 回调里再查一遍（注入前最后一个可控点）
- **helper 留在被派活那一侧**：hook 端口每次启动都变、token 只在本机文件里，
  对面既拿不到也不该拿。跨机链路上只传任务本身
- **任务正文走 stdin，绝不进 argv** —— `ps` 对同机所有用户可见
- **helper 路径要用双引号**：macOS 的 userData 路径含空格（`Application Support`），
  不引的话对端 shell 会拆成三个参数；用双引号而非单引号是因为 `$HOME` 要在对端展开
- **超时必须逐层严格递增**：240（远端 delegate）< 270（helper curl）< 300（ssh）
  < 320（tb 的 curl）。持平就等于"内层刚注入完、外层已经放弃" —— 曾经 helper 和 ssh
  都是 260s 正是这样。而且 delegate **返回之前还要干活**（1.5s 轮询 + 1.2s 等落盘
  + 读整个 transcript），helper 只多几秒的话正常完成的派活会被自己人掐断。
  用例要断言**整条阶梯**递增，只断言最外 > 最内看不出持平
- **不自动重试**：注入不可撤回，重试就是往对面 agent 里注两遍。断线只能理解成 detach。
  人工重发也挡得住 —— 远端有张十分钟的幂等表，键**从内容派生**
  （`peerRequestId`；随机 id 在重试时是另一个值，等于没有幂等）。
  ⚠️ 拼串式哈希有歧义（`"a"+sep+"b c"` 撞 `"a b"+sep+"c"`），用 `JSON.stringify`；
  **别用裸 NUL 当分隔符** —— 无歧义但源码里完全不可见，一次复制粘贴就变回空格。
  被拒的派活要 `abandon` 登记，否则开关打开后同一个任务十分钟内都派不出去
- task 有 32 KiB 上限（**按字节** —— 中文一个字三字节）：整段会被一次 `writeToPty`
  打进 pty，靠 1 MiB 的 HTTP body 兜是不够的
- **已端到端实测通过**（两个方向都跑过）：普通 shell 被拒且什么都没执行、
  真 agent 会话 7 秒返回答案、重发同一任务挡住并回上次结果、开关关掉时拒绝、
  乱 token 403、40KB 任务 400。**从 ssh 起对端的 GUI app 用 `open -a`** ——
  `launchctl asuser` 要 root，会报 `Could not switch to audit session`

## 自动更新（2026-07-27）

`src/main/updater.ts`，electron-updater + Squirrel.Mac。后台检测 → 后台下载 →
提示 → **用户点了才装**。

- **不自动装是刻意的**：终端里跑着用户的活，自动重启会把正在跑的那一轮 agent
  对话掐掉（tmux 会话本身能续存，对话不能）。`autoInstallOnAppQuit` 也要关 ——
  默认那个会在退出时静默替换掉 app，用户下次打开发现版本变了且没人问过他
- **mac target 必须有 zip**：Squirrel 只认 zip，dmg 是给人手动装的。
  少了它能查到新版本但下载不下来
- **更新源只收 https**（`update-url.ts`，有独立用例）：更新包下下来是要替换掉
  整个 app 的，明文 http 意味着路上任何人都能换掉它。Squirrel 的签名同源校验
  是第二道防线，不该拿它当第一道
- **feed URL 在设置里，不焊进打包配置**：`electron-builder.yml` 里那个是占位，
  运行期 `setFeedURL` 覆盖 —— 换发布源不用重新打包。每次 check 都要重设一遍
  （autoUpdater 是单例，feed 只在 setFeedURL 时更新）
- **必须有 publish 配置**（哪怕是占位）：没有的话 electron-builder 不生成
  `app-update.yml`，electron-updater 一启动就找不到配置文件
- dev 下整个降级成 no-op（没有 `app-update.yml`，否则直接抛）
- `update:install` 只认主窗口的调用 —— 装 = 重启 app
- 发布流程：`npm run dist:signed` → 把 `latest-mac.yml` 和 `*.zip`
  （dmg 可选，给人手动下）传到那个 HTTPS 目录

**这条链路到底保证了什么**（注释里别写含糊的话，codex 逐条纠过）：

| | |
|---|---|
| Squirrel.Mac 的签名校验 | 只保证候选包满足**当前 app 签名导出的 designated requirement**。**不**保证来自官方目录、yml 为真、版本更新、过了公证、私钥没泄漏 |
| `latest-mac.yml` 的 sha512 | **下载完整性**，不是发布者认证 —— 控制了发布目录就能给恶意包算一个匹配的 |
| https | 只保证"连上了你填的那台服务器"，不保证那台服务器可信 |

所以信任根是**发布目录的控制权**，代码签名是最后一道而不是第一道。
feed URL 做成用户可改的是有代价的（能被诱导改源），现在靠 UI 上的显著警告 +
显示当前生效域名兜着；等有了正式发布渠道应当焊死官方源。

- `allowDowngrade = false` 要**显式写**：默认就是它，但签名不提供版本单调性，
  防降级全靠这一层，将来启用 prerelease / channel 时很容易无意改掉
- `checking` / `downloading` 期间要拒绝新一轮 check：electron-updater 的 check
  promise 在**自动下载完成之前**就 resolve，此时再 check 会让两轮事件交错。
  **例行检查还要额外挡住 `available` / `ready`**：包已下好等安装时，一次失败的检查会把
  phase 冲成 `error`，而 install 有 `phase !== 'ready'` 门禁 —— 用户从此装不了那个
  已经在磁盘上的包，只能重启 app
- 版本号要单独存，**不能从展示状态反推**：第一次 `download-progress` 之后
  phase 已是 `downloading`，再按 `phase === 'available'` 取就只剩空串
- macOS 上 `quitAndInstall` 的两个参数**不按 BaseUpdater 语义解释**（MacUpdater 重写了它）
- `publishAutoUpdate: true` 是"生成更新元数据"，**不是**"自动上传"

## 授权模型（同 UID 前提，务必如实描述）

**每一条能碰到外部资源的链路都要过同一套闸**：`authorizeLink` + `withLedger`。
`tb ask` / `tb browser` / `tb ask <peer>` / **`tb db` / `tb ssh`** 全在内。
（2026-07-29 补上最后两条 —— 此前 `tb browser` 读个网页要弹窗授权，
而 `tb db` 拿生产库连接串跑 SQL 反而不用，自相矛盾。）

三条判据，缺一条就是白做：

- **授权 key 必须带类型**：`broker:${kind}:${name}`。同名不同类型（`db:prod` / `ssh:prod`）
  是合法配置，key 只用 name 的话，给**只读** db:prod 勾的「本次不再询问」
  会把**可写**的 ssh:prod 一起放行
- **`withLedger` 要包住 authorize**，不能只包执行 —— 「agent 想动生产库、我拦了」
  恰恰是这本账最该记的一条
- **非 delegate 的链路必须自带 `classify`**：`classifyDelegateResult` 认的是
  `派活被拒`/`派活失败` 这几个**前缀**，那是 delegate 的话术。broker 说「执行失败：」
  一个字都对不上 → 全部落到 `done`，账本"失败优先排序"对这条链路**静默失效**

跨节点动作（`tb ask` / `tb browser`）走「连线即授权」+ 弹窗兜底。但所有终端与 app 同 UID，
任何进程都能 `tmux -L termboard send-keys` 直接驱动会话绕过全部检查 —— 所以这是**产品护栏
不是安全边界**。写文档、写注释、答用户都要这么说，别把它说成安全机制。

## 外部输入的信任边界（2026-07-28，codex 整体评审查出的两条 P0）

- **导入外部工作区必须先净化**（`workspace-import.ts`）。`SavedNode.command` 会在终端
  第一次起会话时直接进登录 shell —— 不摘掉，"打开别人发来的画布"就等于执行文件里的
  任意命令，而确认框只说了"替换画布/结束孤儿会话"。**用户选择打开 ≠ 同意执行**。
  同时摘 `identityId`（别人的画布会静默绑上你的账号并按它计费）、丢掉未知 type
  （`fromSaved` 的兜底分支是 terminal，未来类型在旧版本里会变成一个真会 spawn 的终端）。
  本机自己的 `workspace.json` **不走这条路** —— 那是用户自己敲的命令，信任级别不同
- **`<webview>` 必须一节点一个 partition**。不给 partition 时用 app 默认 session，
  所有浏览器节点共享 Cookie —— 而授权是**按节点**发的，agent 拿到自己节点的授权后
  只要导航到你在别的节点登录过的站就白拿登录态。执法点在主进程
  `will-attach-webview`：形状不对一律落到**一次性** session，绝不退回默认 session。
  代价：节点间登录态不再互通，删节点留下孤儿 profile（暂不清理）
- **远程总开关点掉要立刻断服务**（不是"下次重启生效"）：点关通常是在应急撤权。
  `stopRemote()` 先 dispose 再落盘，并把两个能力 gate 一起压死 ——
  否则 `remoteAllowInput = next.remoteAllowInput` 会把磁盘里那份 true 原样恢复回来
- **切/关项目都要先 `snapshot()` 再切板**。`switchProject`/`addProject` 有，
  `closeProject` 曾漏 —— 落盘是 500ms 防抖的，关标签页会清掉 timer 并把下一次快照
  写给**新的** active project。症状不是报错：项目认领得回来，但最后几步改动没了

## 五个新功能的判据（2026-07-28，按 codex 的 ROI 表做完）

| 功能 | 一句话判据 | 最容易写错的 |
|------|-----------|-------------|
| **⌘K 检索**（`palette.ts`） | 零输入按紧急度、有输入按相关度，**两套排序** | 长路径要 JS 截断，`direction:rtl` 会把中英混排的标点重排 |
| **任务账本**（`task-ledger.ts`） | JSONL 追加写，一个任务写两次，**合并在读取侧** | parse 阶段别要求 `startedAt` —— 结束记录是补丁，要求它就等于把所有结束态丢掉 |
| **diff 摘要**（`worktree.ts`） | 必须含**未跟踪文件**（`git diff` 看不见它们） | 二进制的 numstat 是 `-`，`Number()` 得 NaN；重命名的紧凑式别用贪婪正则 |
| **布局模板**（`layout-template.ts`） | 无凭证、相对 cwd、**命令字段改名** | `suggestedCommand` ≠ `command` 是有意的：忘了处理时默认不跑 |
| **代理连接**（`broker.ts`） | 连接串只进不出，**没有读回渲染层的 IPC** | psql 的连接串走 `PGDATABASE`（不是 `DATABASE_URL`，那不是 libpq 读的） |

三条跨功能的通用判据：

- **凡是"外部来的东西"，命令都不许自动执行**。workspace 导入摘 `command`、
  布局模板换字段名 —— 两处的默认结果都必须是"不跑"
- **凡是把用户可控字符串交给子进程，先白名单**。编辑器命令、ssh 别名、
  代理连接目标都是。白名单只挡第一个词是不够的（`ls; rm -rf /`）
- **凡是带密码的东西，走 env 或 stdin，绝不进 argv**。`ps -Ao args` 同机所有用户可见。
  验证手法：用一个假的二进制把 argv 和 env 抓出来断言（`test/broker.test.ts`）

## 打包（2026-07-28 补）

- **`scripts/codesign-retry` 必须在 PATH 最前**，三个 `dist*` 脚本已内置。
  Apple 的时间戳服务偶发返回 `The timestamp service is not available`，
  签 4000 个文件里撞上一次就整个构建失败，而重来一次要 20 分钟。
  它**只在时间戳错误时重试**，证书/entitlements 错误立刻失败 ——
  区分"扛住外部抖动"和"把失败重试到通过"
- ⚠️ 这个包装器写完当天没接进 npm scripts，于是又白死了一次构建。
  **写完立刻接上并当场验 `command -v codesign` 指向它**

## 观测压过推断（2026-07-29，一天之内踩了三次）

**能直接测到的事实，永远优先于从环境推出来的结论。** 三个实例都在额度面板，
共同点是**不报错、typecheck 全绿、测试全绿，只是安静地显示错误的东西**：

| 推断 | 观测 | 推断赢了会怎样 |
|------|------|---------------|
| `billingKind(env)` 说这是 api-key 账号 | 采集器真的返回了订阅额度窗口 | 真实的 `pro` + 周窗 1% 被三行"查不到"顶掉，**面板从有数据变成没数据** |
| presence 还是默认的「等待确认」 | 额度接口带着这个账号的凭据答出话了 | 卡片上同时出现「已查到 1%」和「等待确认」 |
| 节点建出来时没定 `provider` | 进程树里真的有 `codex` 在跑 | 账号卡说「4 个终端」，下面画布列表只列 1 个 |

第一条尤其阴：本机登录 shell 里 export 着 `OPENAI_API_KEY`（Electron **会继承**），
于是 `system:codex` 被判成按量计费，那条分支**在调用采集器之前就 return 了**。
而 codex CLI 实际走 OAuth 订阅 —— 订阅和 API key 完全可以同时存在。
判定顺序必须是：**先跑采集器，只有它确实空手而归才退回按量计费那句话。**

⚠️ 这类 bug **单元测试结构上抓不到** —— 它依赖本机真实环境（某个环境变量存不存在、
某个 CLI 登没登录），而 fixture 永远是干净的。**只有真跑 + 看截图**。
配套的第二条纪律：**截图窗口不够长时先怀疑窗口再怀疑实现** ——
第一次 dogfood 拍到"Antigravity 不出现"，其实只是 6 秒没跑完
「进程扫描 → 重扫 → 采集 → 推送」四步，差点据此去改正确的代码。

## `.xterm` 的 padding 合同（2026-07-29 实测定案）

**内边距必须长在 `.xterm` 上，不能长在它父元素上。** FitAddon 的合同是
`可用高度 = getComputedStyle(.xterm.parentElement).height − .xterm 自己的 padding`，
而 Tailwind preflight 给全局上了 `box-sizing: border-box`，
**Chromium 在 border-box 下的 `getComputedStyle().height` 返回 border box**
（我照 CSSOM 判成 content box，实测打脸 —— 是 codex 的诊断对）。
padding 放父元素上时父高度里含着它、addon 又只扣 `.xterm` 的（那是 0）→ 虚高 20px。

实测（`TERMBOARD_FITPROBE=1`）：`bodyComputedH 340.5 / 真实内容区 320.5 /
canvas 画到 333.1` → 溢出 12.6px ≈ 0.76 行被 `overflow:hidden` 切掉。
改完 `+11.5px → −6.1px`（余量不足一个 cell，`floor` 的正常余数）。

顺带记下**当前复现不出来、先不动**的一件：`@xterm/addon-webgl` 0.19 的
`GlyphRenderer._bindAtlasPageTexture` 调 `gl.generateMipmap`，而整个 addon
**从没设过 `TEXTURE_MIN_FILTER`** —— WebGL2 默认 `NEAREST_MIPMAP_LINEAR` 会真去
采样 mip 层，对字形图集就是相邻字形渗色。上游已修（取消 mipmap + 显式 LINEAR）
排在 7.0。

## 历史清洗：扫形状，不扫已知串（2026-07-29，七轮 filter-repo）

转公开前洗了一次 git 历史。**codex 两轮对手方审查都判 BLOCK**，共逮到我漏掉的
四类真值 —— 而四类的漏法是同一个：**我扫的是「我预料到的值」，不是「值的形状」**。

| 我扫的 | 实际长什么样 | 为什么打不中 |
|--------|-------------|-------------|
| 已知串清单 | 真实 Gmail、Apple relay 邮箱 | 不在清单里 |
| `/Users/<名>` 字面 | `-Users-<名>-Desktop-…` | 编码形式（Claude 临时目录名） |
| `前缀@域名` | `前缀@…`（省略号） | 正则要求 `@` 后跟域名 |
| 邮箱**域**放行 | 任何新的真实 Gmail | 域级豁免 = 整类放行 |

最难堪的一条：为了补「域级放行」的洞，我加了条「禁止这几个已知真人前缀」的规则
—— **那条规则本身把真值写进了检查脚本**。改成全地址锚定后黑名单整条删掉，
脚本里不再需要出现任何真实值。

其余几条同类：

- **审计报告自己是下一个泄漏点**。它按定义要引用原值，且用的是**正则转义形式**
  （`name@domain\.com`），字面替换打不中。报告必须单独脱敏并从历史整个移除后重加
- **「一半合成一半真实」最容易被放过**：`/Users/me/Desktop/<真实客户名>/…` ——
  用户名是合成的，路径里的客户名和内部目录是真的。判定要落到**每个组成部分**
- **改内容不够，要从历史移除后重新加入**：截图、锁文件、审计报告都是这样处理的，
  否则旧 blob 仍可按 SHA 取到
- **不要重写扫描器的内置规则**。试过「精确化」gitleaks 的 generic-api-key ——
  灵敏度变了，原来命中的三条不再命中，却冒出另外两条。豁免只用 allowlist（加法、
  可数、每条能写理由）
- **filter-repo 之前必须先删 `refs/remotes/*` 和 reflog**：它默认按 `--all` 走，
  旧远程分支会被一并重写并**留下来**（`rev-list --all` 286 而 `main` 155）

放行门（两个都跑才算过，缺一类查不到另一类）：

```bash
scripts/verify-clean.sh <仓库>        # 个人信息形状：邮箱/MAC/私网IP/家目录/UUID…
gitleaks git --log-opts=--all --redact # 凭证熵值
```

`verify-clean.sh` 的四条设计判据，改它之前先读：
① 允许清单必须是**完整锚定值**，不能是域或类别；
② commit message 走**和 blob 完全相同**的规则（上一轮证明它会独立泄漏）；
③ unreachable 对象**非空即失败**，不能只打印数量；
④ 报红时输出 blob SHA + 路径，否则没法复核也没法正确加豁免。
它自己被证伪过：塞四类泄漏进干净仓库，blob 与 message 两侧都红、退出码非 0。

**发布方案选的是新建空仓库**，不是 force-push 旧的：force-push 之后 GitHub 侧
旧对象仍可能通过 SHA / PR ref / cache 访问，需要联系 Support 才能真正清除。
旧仓库改名 `termspace-pre-scrub-private` 保持私有原样，作为回滚。
本机镜像备份含全部原始信息，**永远不要 push 它**。

## 判据不要按用途做类型白名单（2026-07-29，下载页死链）

`publish.sh` 里这条注释当时是对的：

```
# yml 里列的 zip 必须都在本地 —— 否则等于对外宣告一个下不到的文件。
# 反过来不必查：dmg 也在 files 里，但 updater 只挑 zip，不影响。
```

「dmg 不影响」成立的前提是**只有自动更新、没有下载页**。做完官网之后，
下载页的主按钮就是从这份 yml 里挑 dmg —— 于是 0.3.0 发布后两个 dmg
从没上传过、线上 404，而发布脚本一路绿灯、yml 完全正确。
**唯一的发现者是点下载的人。**

改法不是补一条 dmg 分支，是取消白名单：**yml 广播了什么，就传什么、验什么。**
用途还会变，白名单不会跟着变。（仍然专属 zip 的两条保留 —— sha512 校验和
「双架构都在 files 里」，它们的理由是 MacUpdater 按 `process.arch` 过滤，与用途无关。）

配套的两条：

- **发布脚本的验收要覆盖它对外宣告的全部东西**，不是它自己关心的那部分
- **`curl -w '%{http_code}'` 连不上时会打印 `000`**，再写 `|| echo 000` 就变成
  `"000000"` —— 于是 `!= "000"` 成立，重试循环第一次就退出。
  判成功只认 `200|206`，别用「不等于失败值」做判据

## 假绿的第五、第六种形状（2026-07-29 三轮对手方审查逮到）

前四种在下一节。这两种更阴，因为**用例看起来完全正常**：

**⑤ 用例里的数字和它声称的场景对不上。**
`place-node` 那条叫「凭证不会完整落进已有终端内部」，用的却是 `420×320` ——
而凭证节点真实是 `220×132`。420 恰好能过、220 过不了（实测落点 `(-42, 2)`，
一个像素都露不出来）。**凑一个能过的尺寸等于没测。**
写完用例回头核一遍：这些常数是从代码/实测里来的，还是我为了让它过而挑的？

**⑥ 测试里重写了一遍生产判定。**
`quota-decorate.test.ts` 曾自己写 `hasRealWindows(r) ? decorate(...) : fallback(...)`，
而生产的 `collectOne` 是未导出闭包、里面还是**内联条件**。把 bug 原样改回去，8/8 全绿。
`provider-manifest.test.ts` 同病：自己重写了一遍 `rows → envOps`。
→ 判定必须**抽成可 import 的纯函数**（`pickQuota` / `mayProbe` / `withLedger` 都是为此抽的），
测试调它，不是照它再写一遍。

配套：**变异测试是唯一能分开「假绿」和「覆盖缺口」的手段。**
把实现改坏跑一遍 —— 红了就是覆盖缺口（补一条用例即可），
绿了才是假绿（用例本身要重写）。两者优先级差一档，别混为一谈。

## `tb db` 的连接串：只有一个字段能进 PGDATABASE

`PGDATABASE` **不展开 conninfo**（psql 17.5 实测：会连本机 socket、把整条 URI 当库名，
报错还带着密码且截断到 63 字节，"整串精确替换"的脱敏匹配不上）。
必须解析成逐字段 `PG*`（见 `pg-conninfo.ts`），密码走 `PGPASSWORD`（env 不进 argv）。

三条容易漏的：
- **查询参数里也能指定连接目标**：`postgresql:///db?host=%2Fcustom%2Fsocket` 是合法的，
  真 psql 认。丢掉它 = 连默认 socket，而**可写 broker 会写错库且不报错**。
  认不出的连接目标参数（`service=` / `passfile=`）一律 **fail-closed**
- 多主机 `h1:5432,h2:5433` 合法，但 WHATWG `new URL` 拒收 —— 要自己解析 authority
- 只读的 `PGOPTIONS` 要**追加**在用户的 options 后面，整体覆盖会把用户的选项吃掉

## 静默失效的四种形状（2026-07-28 codex 对手方审 diff 逮到的，都出自我自己的改动）

写完一段自认严谨的代码之后，按这四条自查一遍 —— 它们的共同点是**不报错**：

| 形状 | 实例 | 怎么防 |
|------|------|--------|
| **字段放错层** | `parentId`/`extent` 写进了 `data`（它们是 React Flow 顶层字段）→ typecheck 全绿，"新终端进组"从没生效 | 往框架对象上加字段时，去它的类型定义里确认层级，别照着相邻字段抄 |
| **假绿测试** | `assert.equal(probe.repoRoot, cond ? probe.repoRoot : '')` 等价于 `assert.equal(x, x)`；另一条只跑 `Object.keys` 压根没调被测函数 | 每条用例都要能回答"实现坏成什么样它会红"。答不上来就是假绿 |
| **注释里的断言有反例** | 写了"两者永不相等"，而 `worktreeDirName('feat/x')` 的输出本身是合法分支名、原样返回 → 撞 | 断言"永不"之前，先把输出当输入喂回去 |
| **effect 假装重做了** | `ctxIds` 挂在 spawn effect 依赖上，但 cleanup 走 releasePty、respawn 用 `-A` 接回同一会话 —— 启动命令根本不再跑 | 依赖变化 ≠ 副作用重做。问一句"这一轮真正重新执行的是什么" |

配套纪律：**大块改动后让 codex 当对手方审 diff**（见记忆 `codex-adversarial-diff-review`），
点名要它找「哪条用例即使实现坏掉也会通过」—— 这一项收益最高。

## 路线图（真实状态见下表；更细的「明确未做」在 https://termspace.app/features/ ）

M1–M6 与 F1–F8 均有可用实现；签名公证、手机端、三家额度采集、崩溃日志、工作区导出导入
均已完成。**发布工程已就绪**（2026-07-28）：x64 包、oxlint、CI skeleton、应用图标、
GitHub 私有仓库（`Hardboiled98k/termspace`）、Cloudflare R2 更新源
（`updates.termspace.app`，见 `docs/RELEASE.md`）。明确未做的：

| 未做 | 为什么 |
|------|--------|
| **MCP 形态** | F7/F8 现在走 `tb` + 回环 HTTP，够用 |
| `tb agents` 列远端节点 | 目标 id 现在得去对面画布上看。逐台 ssh 查会拖慢默认命令，等真觉得烦了再做 `tb agents <peer>` |
| **公开仓库** | **历史已清洗完（2026-07-29）**，仓库仍是私有 —— 转 public 是单独一步，留给人来点。清洗过程与两道验证门见下面「历史清洗」一节 |
| **手机端完整 PWA / 后台推送** | 受安全上下文与 Web Push 限制（见上） |
| **手机端按设备可撤销 token** | 单用户单机时轮换那把 token 就是撤销，够了 |
| **记忆系统统筹** | 还没想清形态 |
| 非订阅 provider 的额度 | 可查的清单与不可查的原因见 `docs/QUOTA.md` |

## 参考

- `ARCHITECTURE-NOTES.md` — nodeterm 架构调研提炼（持久化/tmux/状态系统），M2-M4 按此校准
- 参考仓库 `~/Desktop/code/_reference/nodeterm`（BUSL-1.1，只读思路，禁止抄代码）
