# 终端体验调研 —— Warp / Wave / Ghostty 拆到机制层

**日期**: 2026-08-30
**问题**: Termspace 的终端只能是「原生终端」吗？能不能用 Warp / Ghostty 那样的终端？能不能自研？

---

## 0. 先把前提摆正

Termspace 用 `@xterm/xterm 6` + WebGL + `node-pty`。**这已经是自研终端模拟器** ——
ANSI 解析、buffer 管理、字形渲染全是我们这侧的代码。Terminal.app 一行都没参与。

所以问题不是「能不能自研」，是**「Warp 有什么我们没有，以及为什么」**。

---

## 1. 三家在做的其实是三件事

| | 卖点 | 与 Termspace 的关系 |
|---|------|-------------------|
| **Warp** | 在 shell 之上加一层 IDE：blocks、真输入编辑器、AI | 功能重叠最多，**是主要参照物** |
| **Wave** | 每个块是独立 widget（文件预览 / 浏览器 / AI chat），平铺工作区 | **模型和 Termspace 撞了** —— 见 §5 |
| **Ghostty / kitty / WezTerm** | 快 + 协议完备（kitty graphics、OSC 133、kitty keyboard） | 提供**协议标准**，不提供可嵌入的实现 |

关键判断：**Warp 的价值 90% 不在终端模拟器里，在 shell 集成之上那层。**
模拟器本身（画字多快）Termspace 早就够用了 —— WebGL 上限实测过（20 个终端 16 个拿到
context，打爆后落回 DOM 且字还在）。

---

## 2. 为什么 Warp / Ghostty 嵌不进来

三条，从软到硬：

| | |
|---|---|
| Warp | 闭源。终端核心从来不是库，没有嵌入 API |
| Ghostty | 开源（Zig），`libghostty` 在做，但给出的是**原生 surface**（Metal layer）。要用得写 native addon + 把 NSView 盖在 BrowserWindow 上 |
| **无限画布** | ← **真正的杀手** |

画布上每个节点都活在 CSS transform 里（缩放 / 平移 / LOD 塌成占位 / 远景胶囊）。
**原生视图参与不了 CSS 变换** —— 只能开子 NSWindow 手动追坐标，然后 z-order、
缩放插值、截图、`visibility:hidden` 那套 LOD 全部失效。项目里 `<webview>` 已经
踩过同族的边（远缩时不能卸载，只能 `visibility:hidden`）。

**结论：为了 Ghostty 的渲染速度放弃画布 = 放弃产品本身。这条路封死，别再评估。**

---

## 3. 机制层：Warp 的 blocks 到底怎么来的

### 3.1 靠 shell 集成，不靠猜

Warp 在 rc 文件尾部注入一段，打印一个 **DCS 握手**：

```
printf '\eP$f{"hook": "SourcedRcFileForWarp", "value": { "shell": "zsh"}}\x9c'
```

Warp 收到后**在那个会话里执行一段 setup 脚本**，装上 precmd/preexec 之类的钩子，
此后每条命令的「提示符开始 / 命令开始 / 输出开始 / 输出结束+退出码」都有标记 ——
blocks 就是这四个标记切出来的。这套叫 **Warpify**，也是它能让 blocks 穿透
子 shell / docker / ssh 的原因。

### 3.2 业界标准等价物 = OSC 133

Warp 用私有握手，但同一件事有公开标准 **OSC 133**（FinalTerm / FTCS）：

| 标记 | 含义 |
|------|------|
| `OSC 133;A` | 提示符开始 |
| `OSC 133;B` | 用户输入开始 |
| `OSC 133;C` | 命令输出开始 |
| `OSC 133;D;<exit_code>` | 输出结束 + 退出码 |

Ghostty / kitty / WezTerm / iTerm2 / VS Code 全都认。**该走这条，不该自造私有协议。**

### 3.3 ⚠️ tmux 会吃掉它 —— 已实测

Termspace 的 shell 跑在 tmux 里，tmux 夹在中间。**实测**（`tmux 3.5a`，
Python pty 起 tmux、抓外层 master fd 的原始字节）：

| 发法 | 外层收到 |
|------|---------|
| 裸 `\e]133;A\e\\` | ❌ **被 tmux 吃掉** |
| `set -g allow-passthrough on` + DCS 信封 `\ePtmux;<每个 ESC 写两遍>\e\\` | ✅ **透传到外层** |

这不是查文档得来的，是跑出来的 —— 文档只说「tmux 不转发」，没说包起来行不行。

**为什么这条对 Termspace 成立而对别家不成立**：Warp 面对的是用户自己的 tmux，
改不了配置；而 **Termspace 自己写 tmux conf**（`src/main/tmux.ts` 的 `conf()`，
专用 socket，不碰 `~/.tmux.conf`）**且自己往会话里注 env 和 hook**。
两边都在我们手里 = Warpify 那条路对我们是开的，而且比 Warp 干净。

### 3.4 xterm.js 这侧的接口都在，一个都还没用

```
term.parser.registerOscHandler(133, cb)   // 收 blocks 标记
term.parser.registerOscHandler(9 / 777, cb)  // 收通知
term.parser.registerDcsHandler(...)       // 收 tmux 信封
term.registerLinkProvider(...)            // 路径可点
```

`grep -rn "registerOsc\|registerLink\|registerDcs" src/renderer/src/` → **无**。
这是块完全没开垦的地。

---

## 4. 逐条对照：Warp 有什么，我们是什么状态

### 已有，且多数比 Warp 强

| Warp | Termspace |
|------|-----------|
| 会话恢复 | ✅ **tmux 续存 —— 进程真的活着**，不是重放 scrollback |
| Git worktrees | ✅ `worktree.ts`，画布一个组 = 一棵树，并行 agent 物理隔离 |
| 命令面板 ⌘P | ✅ ⌘K（`palette.ts`，零输入按紧急度、有输入按相关度两套排序） |
| Workflows（参数化命令） | ✅ 布局模板 + 预设（且模板命令**故意不自动执行**） |
| 桌面通知（长命令完成） | ✅ **`notify.ts` 是出网到手机**，比桌面通知强一档 |
| AI | ✅✅ agent 状态发光边框 / 派活 / 审批 / 额度，远超 |
| 主题 / 字号 | ✅ 字号还随节点尺寸自适应（`fit-to-node.ts`） |
| 选中复制 | ⚠️ 部分：右键复制有，块级复制没有 |

### 缺，且值得做

| Warp 功能 | 拦路的 | 备注 |
|-----------|--------|------|
| **Blocks** | OSC 133 + tmux 信封 | **地基**，解锁下面一整串 |
| **底部真输入框**（多行 / ⇧↩ / 原生选中删除 / undo） | 无 | **用户点名要的**。见 §6 |
| 路径可点开编辑器 | `registerLinkProvider` | `open-in-editor.ts` 已存在，只差前端接线 |
| ~~OSC 9 / OSC 777 通知~~ | — | 🔴 **砍掉，见 §8** |
| OSC 8 超链接 | 同上 | |
| 块间跳转 ⌘↑↓ / sticky header / 复制块输出 | 依赖 blocks | |
| ⌃R 命令搜索 | 依赖 blocks（历史从块里来） | |
| ~~同步输入~~ | — | ⚠️ **已经有了**（`GroupNode.tsx:315` 群发：只发 idle 终端、列出跳过的、发前确认）。缺的是**加固**（裸 `${cmd}\r`、不查对端括号粘贴模式、无回执），不是新功能 |
| 内联图片 | `@xterm/addon-image` 0.9（SIXEL + iTerm IIP） | 一个 addon 的事，但要先确认有人要 |
| 连字 | `@xterm/addon-ligatures` 0.10 | 一行 |
| 终端内查找 | `@xterm/addon-search` 0.16 | 一行 |

### 明确不做

| | 为什么 |
|---|-------|
| 嵌 Ghostty / 自研 GPU 渲染 | 与画布互斥（§2）。**已封死** |
| 内置代码编辑器 / LSP / 文件树 | 有 VS Code，别重造。Termspace 的角色是**编排**不是编辑 |
| Tab 补全 / 命令纠错 / autosuggestion | 要接管 readline —— 一接管就要自己实现补全、`⌃R`、TUI 逃生，且在 vim/agent TUI 里全线崩。**收益归 shell，代价归我们** |
| Vim 模式 / 多光标 | 输入框用原生 `<textarea>` 就把 90% 拿到了（见 §6） |
| 主题商店 / 透明度 / pane 变暗 | `DESIGN.md` 已定调，不跟 |

---

## 5. Wave Terminal：模型撞车，但粒度不同（重要）

Wave 也是「块 + 平铺 + AI」，**和 Termspace 是同一个大方向**。差别在粒度：

- Wave：**一条命令 = 一个块 = 工作区里一个可拖拽 widget**
- Termspace：**一个会话 = 一个节点**，块在节点内部

**别学 Wave 把块提升成画布节点。** 一个 agent 跑一晚上产生几百个块，
画布会被淹掉；而 Termspace 的画布语义是「一个 agent = 一个节点，看颜色分布知道谁在等你」
—— 节点数必须和**人要关注的东西**同阶，不是和输出量同阶。

这条是设计判据，写下来防止以后有人觉得「Wave 那样更酷」。

---

## 6. 用户真正点名的那条：底部输入栏

截图里指的是 Warp 底部那条 bar（`+` / 麦克风 / diff 计数 / cwd / 分支 / Rich Input），
配合原话「可以快捷复制、选中删除、输入之类的」。拆开是两件事：

**(a) 真输入编辑器。** Warp 的做法是接管 readline 重画提示符行。**我们不该学** ——
代价见 §4「明确不做」。

**便宜得多的等价物**：节点底部加一个原生 `<textarea>`。它是**加法不是接管** ——
终端照旧工作，输入框只是第二条输入通路。而 macOS 原生文本编辑（⌘A / ⌥←→ /
选中删除 / undo / 输入法 / 拼写）**全部免费**，这正是「用着顺手」的来源。
主要用例（往 agent TUI 里打一大段中文）本来就不需要补全和 `⌃R`。

送出去时的关键机制是**括号粘贴**：包 `ESC[200~ … ESC[201~` 之后，
接收方把整段当一次粘贴而不是一串按键，多行不会被逐行执行。
且**只有对方开了才能包** —— 判据是 `term.modes.bracketedPasteMode`（观测，不是猜）。

> 顺带查出一个既有缺陷：现在右键粘贴是 `write(id, 剪贴板)` **裸发**，
> 多行剪贴板会被逐行执行。已抽成 `src/renderer/src/pty-send.ts`，两个调用方共用。

**(b) 状态 chips（cwd / 分支 / diff 计数）。** `gitProbeRepo` / `gitDiffSummary`
早就通到 preload 了，纯接线。

---

## 7. 建议顺序

| | 做什么 | 为什么排这里 |
|---|--------|-------------|
| **P0** | 底部输入栏（textarea + 括号粘贴 + chips） | 用户点名；不依赖任何地基；当天可用 |
| **P0** | OSC 9/777 → `notify.ts` | 十几行，立刻让任何脚本能推手机 |
| **P1** | OSC 133 shell 集成 + tmux DCS 信封 | **地基**。透传已实测通 |
| **P1** | 路径可点 → `open-in-editor.ts` | 已有后端，只差 linkProvider |
| **P2** | blocks 之上：块间跳转 / sticky header / 复制块输出 / 手机端按块翻历史 | 手机端现在按**行**翻，会截断在命令中间 |
| **P2** | 同步输入（画布多选一起发） | Termspace 独有形态，比 Warp 强 |
| 随手 | `addon-search` / `addon-ligatures` | 各一行 |

**blocks 落地后白得的四件事**：手机端按块翻历史、状态判定多一路硬证据
（现在靠 hook + 前台进程探测）、跳到上一条命令、失败块标红（`D;<exit_code>`）。

---

## 参考

- Warp 文档：[Warpify / subshells](https://docs.warp.dev/terminal/warpify/subshells)、[Blocks](https://docs.warp.dev/terminal/blocks)、[键位](https://docs.warp.dev/getting-started/keyboard-shortcuts)、[通知](https://docs.warp.dev/terminal/more-features/notifications)、[文件与链接](https://docs.warp.dev/terminal/more-features/files-and-links)、[同步输入](https://docs.warp.dev/terminal/entry/synchronized-inputs/)
- OSC 133：[Contour 的规范页](https://contour-terminal.org/vt-extensions/osc-133-shell-integration/)、[tmux #3064](https://github.com/tmux/tmux/issues/3064)、[tmux #5237](https://github.com/tmux/tmux/issues/5237)
- [Wave Terminal](https://github.com/wavetermdev/waveterm)、[Ghostty features](https://ghostty.org/docs/features)

---

## 8. 交叉评审后的修正（2026-08-30，Codex 对手方审 + 本机实测）

上面 §4–§7 有三处结论是错的。**保留原文并在此更正**，因为错法本身是判据。

### 8.1 🔴 OSC 9 / OSC 777 → `notify.ts`：砍掉，不是降级

`notify.ts` 文件头第 1 条判据是「正文只有节点标题和状态，绝不含终端内容」。
而 OSC 777 的正文是**终端里任意进程给的任意文本**。这两条直接冲突，
我原来判成「可以放宽」——**错了**。

杀手用例不是 agent（它本来就有 shell + 网络），是**读文件**：

```
cat 一个内嵌 OSC 777 的文件  →  向第三方推送服务出网，正文攻击者可控
```

一次 `cat`、一次 `less`、一次 ssh 到别人的机器，都变成了出网。这是 confused
deputy：一个**只能往终端写字**的进程，借 Electron 的网络权限和**用户私有的
推送频道**把数据带出去。远端进程可能根本没有网络出口，现在有了。

- 不放宽 `notify.ts` 的判据
- 不做 OSC → 通知
- 真要「脚本能叫我」，做 `tb notify` ——**用户显式调用的控制通道**，
  不需要解析任意终端输出，正文仍由我们固定

### 8.2 OSC 133 / blocks：降到 P2，且只服务普通 shell

原文说 blocks 落地「白得四件事」。**其中两件是假的**：

| 我说的 | 实际 |
|--------|------|
| 手机端按块翻历史 | ❌ 手机历史走**主进程 `tmux capture-pane`**，renderer 里 xterm 的 block 元数据根本到不了手机，要另做一整条链路 |
| 状态判定多一路硬证据 | ❌ agent TUI 跑几小时**整个是一个块**。而 `hooks.ts` 的 `UserPromptSubmit`/`PreToolUse`/`Stop`/`PermissionRequest` 已经给出**精确到轮**的边界，比 OSC 133 细得多 |
| 跳到上一条命令 | ✅ 但只对普通 shell |
| 失败块标红 | ⚠️ 只拿得到整个 TUI 的最终退出码 |

外加一条我没算的成本：**`allow-passthrough on` 会放开所有 pane 输出到外层终端的
协议面**（OSC 52 写剪贴板、DCS 等），不只是 OSC 133。开之前要单独评估。

→ blocks 对 Termspace 的主用例（跑 agent）价值很低。降 P2，只当普通 shell 的功能。

### 8.3 「缺同步输入」：错，已经有了

`GroupNode.tsx:315` 的群发早就实现了：只发 idle 终端、发前列出目标和跳过项、
明确警告「agent 若已退出到 shell，这串字就是一条命令」。

需要的是**加固**（走括号粘贴、要回执、别 `trim()` 用户正文），不是新功能。
而且**不要把普通 React Flow 多选复用成发送授权** —— 框选很容易带上离屏节点、
裸 shell、vim、审批界面；同一个回车在它们那儿分别是「提交 prompt」「执行命令」
「确认危险操作」。真要自由广播必须是独立、显式武装的模式。

### 8.4 我自己造的假绿（第七种形状）

`pty-send.ts` 写完、9 条测试全绿、三处守卫变异测试都承重 ——
**但它从没接进生产代码**。右键粘贴和 ⌘V 照旧裸发。

> **守卫承重 ≠ 守卫在岗。** 变异测试只证明「测试盯着实现」，
> 不证明「实现盯着生产」。前六种形状都在问「实现坏了用例会不会红」，
> 这一种要问的是**「这段代码到底有没有人调用」**。

且那个实现本身还不如上游：它保留 `\n`，而 xterm 的 `prepareTextForTerminal`
转的是 `\r`（真终端粘贴发的就是 CR）。**我重写了一个更差的轮子。**

→ 删掉，粘贴路径改用 `term.paste()`（自带换行归一 + 按实际 `?2004h` 决定包不包）。

### 8.5 chips 不是「纯接线」

`data.cwd` 是 **spawn 时**传入的初始目录，用户 `cd` / `git switch` 之后它不变。
拿它查 git = 持续显示**旧目录、旧仓库、旧分支**，而且不报错。

要真值必须查 tmux 的 `#{pane_current_path}`；查不到就**如实标成「启动目录」**，
不许冒充实时。且常驻轮询只能用便宜的 `git status --porcelain`（dirty 计数），
完整 `+新增/-删除` 摘要太贵，只在用户点击时查。

### 8.6 实测补充（本机，`tmux 3.5a`）

| 探针 | 结果 |
|------|------|
| Claude Code 2.1.251 开 `?2004h` | ✅ 直连 / 套 tmux 都开 |
| codex 开 `?2004h` | ✅ 同上 |
| 多行括号粘贴进 Claude Code 输入框 | ✅ **三行都进了输入框，没有被提交** |
| OSC 9 / 777 / 8 裸发过 tmux | ❌ 全被吃 |
| OSC 9 / 777 + `allow-passthrough` + DCS 信封 | ✅ 透传 |

第三条是输入框方案的命门，已用 pty 探针实拍到屏幕内容确认。

### 8.7 修正后的 P0

**输入框（已做）**：原生 `<textarea>` + 校验 + 回执。
- 校验在 `composer-send.ts`（纯函数，13 条用例，六处守卫变异测试全部承重）
- **多行 + 对端没开括号粘贴 → 拒发并保留草稿**。照发就是逐行执行，
  那不是降级，是做了用户没要求的事
- 含裸控制字符 / 结束标记 → **拒发，不静默摘掉**（摘掉 = 篡改用户文本）
- 提交走**带回执**的 `pty:sendInput`：`pty:write` 超限会静默丢弃，
  先清后发 = 用户打了一大段、按了发送、什么都没发生且稿子没了
- **草稿只在 renderer 内存**（`draftStore`），不进 `SavedNode` ——
  没发出去的 prompt 里可能有密钥/客户名，而工作区会落盘、备份、被「导出画布」
- IME：`isComposing` 必须先判，否则中文按回车发出去的是半截拼音

**chips（未做）**：等 `#{pane_current_path}` 那条查询做完再上，见 §8.5。
