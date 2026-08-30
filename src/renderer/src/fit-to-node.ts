/**
 * 终端字号随节点尺寸等比缩放 —— 纯函数，独立成文件才跑得到测试
 * （`.tsx` 里的 JSX 过不了 Node 的 type stripping）。
 */
const FONT_MIN = 8

/**
 * **节点放大 = 字变大，不是多几行几列。**
 *
 * 老行为是"字号固定、列数随宽度涨"：把节点拉到两倍大，终端里的字还是那么小，
 * 只是多出一堆空列 —— 用户报的就是这个（放大等于没放大）。而画布上放大一个节点
 * 的意图从来是"我要看清这一个"，不是"我要 200 列"。
 *
 * 所以判据换成**格子数恒定、字号随尺寸走**：
 *
 * - 参照系是 `REF_COLS × REF_ROWS`（80×24，agent TUI 按 80 列画）在 `REF_FONT` 下的样子
 * - 用户设的字号是**相对刻度**：调大 = 参照格子变少（20px → 52×16），
 *   于是同一个节点里字更大、能看的内容更少 —— 这正是字号旋钮该有的语义。
 *   注意这里 base 不能约掉：若目标格子恒为 80×24，`font = 宽 / (80·k)`，
 *   base 会被完全约掉，⌥滚轮就成了死键
 * - 取**列与行两个方向的较小值**：只把节点拉宽时，字号不会涨到把行数压成三行
 * - 一次成型不迭代（列数 ∝ 1/字号，一步就能解出来），所以拖拽时不抖；
 *   每次都从 base 重新量，所以缩小后再拉大回得来
 * - `FONT_MIN` 是下限，缩不下去就让格子少于目标，不缩成看不见的字
 *
 * 返回**实际生效的字号** —— 调用方拿它判 LOD（判据是"屏幕上的有效字号"，
 * 而这里的有效字号已经和用户设的 `data.fontSize` 不是一回事了）。
 */
const REF_FONT = 13
const REF_COLS = 80
const REF_ROWS = 24
const MIN_COLS = 20
const MIN_ROWS = 6

export function fitToNode(
  term: { options: { fontSize?: number }; cols: number; rows: number },
  fit: { fit: () => void },
  base: number
): number {
  // 先以用户设定量一次：这一步让"改尺寸后回得来"自然成立
  term.options.fontSize = base
  fit.fit()
  const scale = REF_FONT / base
  const targetCols = Math.max(MIN_COLS, Math.round(REF_COLS * scale))
  const targetRows = Math.max(MIN_ROWS, Math.round(REF_ROWS * scale))
  // floor 而非 round：宁可字号小一点、格子多一点，也不要少于目标列数把 TUI 折行
  const want = Math.max(
    FONT_MIN,
    Math.min(
      Math.floor((base * term.cols) / targetCols),
      Math.floor((base * term.rows) / targetRows)
    )
  )
  if (want === base) return base
  term.options.fontSize = want
  fit.fit()
  return want
}
