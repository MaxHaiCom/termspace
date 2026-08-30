/**
 * 把 `tmux capture-pane` 的原始输出裁成能给 UI 看的纯文本。
 *
 * 单独成文件是为了能被 `node --test` 直接跑 —— index.ts 依赖 electron。
 *
 * 有 `before` 这个参数是因为手机端只有一屏：agent 答了两百行，
 * 你在手机上只能看到最后 40 行，而滚上去看的那段恰恰是它的推理过程。
 * capture-pane 本来就抓了 800 行历史（见 tmux.ts），这里只是把窗口往前挪。
 */

export interface Screen {
  text: string
  /** 还有更早的内容 —— 手机端据此决定「更早」按钮要不要变灰 */
  more: boolean
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

export const MAX_LINES = 200

/**
 * @param lines  要几行（1..200）
 * @param before 从尾部往前跳过几行。0 = 最新一屏
 */
export function sliceScreen(raw: string, lines: number, before = 0): Screen {
  if (!raw) return { text: '', more: false }
  const all = raw
    .replace(ANSI, '') // 去掉 ANSI 转义，给 UI 用纯文本
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== '')) // 压掉连续空行

  const n = Math.max(1, Math.min(MAX_LINES, Math.floor(lines) || 1))
  const skip = Math.max(0, Math.floor(before) || 0)
  /* 窗口右边界。跳过量超过总行数时 end 会 <= 0 —— 此时给空文本且 more=false，
     而不是让 slice 的负数索引把最新那几行又翻出来（那会让「一直点更早」
     绕回开头，看起来像内容在循环）。 */
  const end = all.length - skip
  if (end <= 0) return { text: '', more: false }
  const start = Math.max(0, end - n)
  return {
    text: all.slice(start, end).join('\n').trim(),
    more: start > 0
  }
}
