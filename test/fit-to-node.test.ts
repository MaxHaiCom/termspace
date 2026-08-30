/**
 * 终端字号随节点尺寸等比缩放。
 *
 * 钉的是用户报的：**把终端节点拉大，里面的字还是那么小，只是多出一堆空列** ——
 * 于是"放大"等于没放大。画布上放大一个节点的意图是"看清这一个"。
 *
 * 三个只在拖拽时才暴露、静态看代码看不出来的失败模式：
 *
 * 1. **抖动**：迭代式"缩一点再量一次"会在拖拽过程中来回跳字号。
 * 2. **回不来**：若在**当前**字号上再算，节点改回原尺寸后字号回不到原值。
 * 3. **只拉宽把行数压垮**：字号只按宽度算，横向拉一下就只剩三行。
 *
 * 还有一个纯静态但最阴的：目标格子若写死 80×24 而不随 base 变，
 * `font = 宽 / (80·k)` 里 base 会被完全**约掉** —— ⌥滚轮成死键，
 * 而屏幕上一切正常。最后一条用例专门钉它。
 *
 * 这里用假的 term/fit 把"宽高 → 列行"的关系模拟出来（列 ∝ 宽/字号，行 ∝ 高/字号）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitToNode } from '../src/renderer/src/fit-to-node.ts'

/** 假终端：列 = 宽/(字号·0.6)、行 = 高/(字号·1.25)，和真实等宽字体+行高接近 */
function fakeTerm(widthPx: number, heightPx: number) {
  const term = { options: { fontSize: 13 } as { fontSize?: number }, cols: 0, rows: 0 }
  const fit = {
    fit: (): void => {
      const f = term.options.fontSize ?? 13
      term.cols = Math.max(1, Math.floor(widthPx / (f * 0.6)))
      term.rows = Math.max(1, Math.floor(heightPx / (f * 1.25)))
    }
  }
  return { term, fit }
}

/** 参照尺寸：13px 下正好 80×24 */
const REF_W = 80 * 13 * 0.6
const REF_H = 24 * 13 * 1.25

test('参照尺寸下就是用户设的字号', () => {
  const { term, fit } = fakeTerm(REF_W, REF_H)
  assert.equal(fitToNode(term, fit, 13), 13)
  assert.equal(term.cols, 80)
  assert.equal(term.rows, 24)
})

test('**节点放大一倍 → 字号放大一倍，格子数不变**（这是这个文件存在的理由）', () => {
  const { term, fit } = fakeTerm(REF_W * 2, REF_H * 2)
  const eff = fitToNode(term, fit, 13)
  assert.equal(eff, 26, `放大后字号该跟着涨，实际 ${eff}`)
  assert.equal(term.cols, 80, '列数该守住，多出来的像素给字号')
  assert.equal(term.rows, 24)
})

test('节点缩小 → 字号跟着缩，列行仍守在参照格子附近', () => {
  const { term, fit } = fakeTerm(REF_W * 0.75, REF_H * 0.75)
  const eff = fitToNode(term, fit, 13)
  assert.ok(eff < 13, `缩小后字号该变小，实际 ${eff}`)
  assert.ok(term.cols >= 80, `列数不该掉到 80 以下（agent TUI 按 80 列画），实际 ${term.cols}`)
})

test('**只拉宽不拉高时字号不涨** —— 否则行数会被压垮', () => {
  const { term, fit } = fakeTerm(REF_W * 2, REF_H)
  assert.equal(fitToNode(term, fit, 13), 13)
  assert.equal(term.rows, 24, '行数该守住')
})

test('只拉高不拉宽同理', () => {
  const { term, fit } = fakeTerm(REF_W, REF_H * 2)
  assert.equal(fitToNode(term, fit, 13), 13)
  assert.equal(term.cols, 80)
})

test('缩到下限就停，不会缩成看不见的字', () => {
  const { term, fit } = fakeTerm(60, 40)
  assert.equal(fitToNode(term, fit, 13), 8, '下限是 FONT_MIN=8')
})

test('**同一尺寸重复调用结果稳定**（拖拽时不抖）', () => {
  const { term, fit } = fakeTerm(REF_W * 2, REF_H * 2)
  const first = fitToNode(term, fit, 13)
  for (let i = 0; i < 10; i++) assert.equal(fitToNode(term, fit, 13), first, '重复调用越算越偏 = 拖拽时会抖')
})

test('**节点改回原尺寸后字号回到原值**（放大缩小要可逆）', () => {
  const big = fakeTerm(REF_W * 2, REF_H * 2)
  assert.equal(fitToNode(big.term, big.fit, 13), 26)

  /* 关键：同一个 term 换了尺寸。判据若是"在当前字号上再算"，这里就回不去。 */
  const back = {
    fit: (): void => {
      const f = big.term.options.fontSize ?? 13
      big.term.cols = Math.max(1, Math.floor(REF_W / (f * 0.6)))
      big.term.rows = Math.max(1, Math.floor(REF_H / (f * 1.25)))
    }
  }
  assert.equal(fitToNode(big.term, back, 13), 13, '缩回去没还原 = 字越用越大/越小')
})

test('**用户调大字号仍然有效**：同一节点里字更大、格子更少', () => {
  const a = fakeTerm(REF_W * 2, REF_H * 2)
  const b = fakeTerm(REF_W * 2, REF_H * 2)
  const small = fitToNode(a.term, a.fit, 13)
  const large = fitToNode(b.term, b.fit, 20)
  assert.ok(large > small, `调大字号该真的更大：13→${small} vs 20→${large}`)
  assert.ok(b.term.cols < a.term.cols, `字更大 = 一屏看得更少，实际 ${b.term.cols} vs ${a.term.cols}`)
})
