/**
 * 底部输入框按下发送时，那段文本能不能发、发什么字节。
 *
 * **这个模块只服务输入框，不服务粘贴。** 粘贴走 xterm 自带的
 * `term.paste()`（它已经做了换行归一 + 括号粘贴，且读的是自己解析出来的
 * 模式）—— 我们没有理由比上游做得更好，重写一遍只会引入分歧。
 * 两条路的语义本来就该不同，见下面 `multiline-unsafe`。
 *
 * ── 括号粘贴（bracketed paste）──
 * 包上 `ESC[200~ … ESC[201~` 之后，接收方把整段当**一次粘贴**而不是
 * 一串按键，里面的换行是正文而不是 Enter。判据是 `?2004h` ——
 * xterm 解析对端字节得出的**观测值**，不是我们猜的。
 *
 * 换行必须转成 `\r`，不能留 `\n`：真终端粘贴发的就是 CR，
 * xterm 的 `prepareTextForTerminal` 也是这么转的。留 `\n` 是自造方言。
 *
 * ── 为什么输入框要比粘贴严 ──
 * 粘贴时用户脑子里是「把剪贴板塞进去」，逐行执行是他见过的行为。
 * 输入框里打了三行，用户脑子里是**一条消息**；对端没开括号粘贴时
 * 照发就是三条命令依次执行 —— 那不是降级，是做了他没要求的事。
 * 所以这里**拒发并保留草稿**，让他自己决定。
 */

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

export type SendCheck =
  | { ok: true; bytes: string }
  | { ok: false; reason: 'empty' | 'multiline-unsafe' | 'control-chars' | 'paste-end' }

export interface ComposerOpts {
  /** 对端开没开括号粘贴。来自 `term.modes.bracketedPasteMode` */
  bracketed: boolean
  /** 末尾补回车（= 替用户按 Enter）。false 只把文本放进对方的输入行 */
  submit: boolean
}

/** 除了 TAB 和换行，C0/C1 控制字符都不该从一个文本框里出现 */
const BAD_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/

export function checkComposerSend(raw: string, opts: ComposerOpts): SendCheck {
  const text = raw.replace(/\r\n?/g, '\n')
  if (!text.trim()) return { ok: false, reason: 'empty' }

  /* **精确的结束标记没有转义办法** —— 它一旦出现在正文里就必然提前闭合括号，
     把后面的内容从"粘贴"降级成"按键"。上一版是静默摘掉，那是**篡改用户文本**：
     他要发的东西和实际发出去的不一样，而屏幕上看不出来。拒发并说明才对。
     （`ESC[201 ~` 这类带 intermediate byte 的不算 —— 合规解析器不认它是
     结束标记，按"长得像"去删反而会毁掉合法文本。） */
  if (text.includes(PASTE_END)) return { ok: false, reason: 'paste-end' }

  /* 裸 ESC / Ctrl-C / Ctrl-D / NUL 在没开括号粘贴时会直接变成终端控制输入。
     人在文本框里打字打不出这些，出现即意味着来源不是键盘（粘了一段带控制序列
     的东西）。TAB 和换行放行 —— 那两个是真会手打的。 */
  if (BAD_CONTROL.test(text)) return { ok: false, reason: 'control-chars' }

  const multiline = text.includes('\n')
  if (multiline && !opts.bracketed) return { ok: false, reason: 'multiline-unsafe' }

  const cr = text.replace(/\n/g, '\r')
  const body = opts.bracketed ? PASTE_START + cr + PASTE_END : cr
  return { ok: true, bytes: opts.submit ? body + '\r' : body }
}

/** 拒发时给用户看的话。**要说清为什么和怎么办**，不能只说"不行" */
export function explainReject(reason: Exclude<SendCheck, { ok: true }>['reason']): string {
  switch (reason) {
    case 'empty':
      return ''
    case 'multiline-unsafe':
      return '这个终端现在没开括号粘贴，多行会被当成多条命令逐行执行。改成一行再发，或先回到 agent 的输入界面。'
    case 'control-chars':
      return '文本里有控制字符（可能是从别处粘来的）。清掉再发 —— 它们会直接变成终端按键。'
    case 'paste-end':
      return '文本里含粘贴结束标记，发出去会让后半段变成按键。清掉再发。'
  }
}
