/**
 * 屏幕文本裁剪 + 往回翻页。
 *
 * 翻页这件事唯一会真的害人的地方是**把历史当成现状**：手机上看到一屏
 * 「1. Yes, I trust this folder」按下去，答的却是当前那个完全不同的问题。
 * 所以下面既钉窗口算得对，也钉越界时**返回空**而不是悄悄绕回别的内容。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sliceScreen } from '../src/main/peek-text.ts'

const lines = (n: number): string =>
  Array.from({ length: n }, (_, i) => `line${i + 1}`).join('\n')

test('空输入 → 空文本且没有更多', () => {
  assert.deepEqual(sliceScreen('', 40), { text: '', more: false })
})

test('默认取尾部 n 行', () => {
  const r = sliceScreen(lines(100), 10)
  assert.equal(r.text, Array.from({ length: 10 }, (_, i) => `line${91 + i}`).join('\n'))
  assert.equal(r.more, true)
})

test('内容不足一屏 → 全给，且 more=false', () => {
  const r = sliceScreen(lines(5), 40)
  assert.equal(r.text, lines(5))
  assert.equal(r.more, false)
})

test('ANSI 转义要去掉 —— UI 是 <pre> 纯文本，留着会显示成乱码', () => {
  assert.equal(sliceScreen('\x1b[31m红字\x1b[0m', 10).text, '红字')
})

test('连续空行压成一个 —— TUI 重绘会留下大片空白', () => {
  assert.equal(sliceScreen('a\n\n\n\n\nb', 10).text, 'a\n\nb')
})

test('行尾空格去掉', () => {
  assert.equal(sliceScreen('a   \nb\t\t', 10).text, 'a\nb')
})

test('before 把窗口往前挪，且和不挪时不重叠', () => {
  const latest = sliceScreen(lines(100), 10, 0)
  const older = sliceScreen(lines(100), 10, 10)
  assert.equal(latest.text.split('\n')[0], 'line91')
  assert.equal(older.text.split('\n')[0], 'line81')
  assert.equal(older.text.split('\n').at(-1), 'line90')
})

test('翻到最开头时 more=false —— 「更早」按钮据此变灰', () => {
  const r = sliceScreen(lines(50), 10, 40)
  assert.equal(r.text.split('\n')[0], 'line1')
  assert.equal(r.more, false)
})

test('before 刚刚超过总行数 → 空文本，**不能倒出开头一大段**', () => {
  /* 这条钉的是 `end <= 0` 那道守卫，而**样本必须是"刚刚超过"**：
     没有守卫时 `slice(0, -5)` 会返回前 15 行 —— 一路点「更早」翻到头之后，
     屏幕上会突然冒出一大段内容，而且远多于请求的 10 行。

     ⚠️ 第一版这条用的是 before=500：那个数让负索引直接溢出成空数组，
     有没有守卫结果一模一样 —— 变异测试当场判它不承重。
     「删掉守卫仍然全绿」不是用例写弱了，是样本压根碰不到那行代码。 */
  const r = sliceScreen(lines(20), 10, 25)
  assert.equal(r.text, '')
  assert.equal(r.more, false)
})

test('before 远超总行数同样是空（另一条分支：负索引溢出）', () => {
  assert.deepEqual(sliceScreen(lines(20), 10, 500), { text: '', more: false })
})

test('lines 收敛到 1..200，脏值不让它变成 0 行或整份倒出来', () => {
  assert.equal(sliceScreen(lines(500), 0).text.split('\n').length, 1)
  assert.equal(sliceScreen(lines(500), -5).text.split('\n').length, 1)
  assert.equal(sliceScreen(lines(500), 9999).text.split('\n').length, 200)
  assert.equal(sliceScreen(lines(500), NaN).text.split('\n').length, 1)
})

test('before 的脏值当 0 处理，不会变成负数把窗口推到未来', () => {
  const base = sliceScreen(lines(100), 10, 0).text
  assert.equal(sliceScreen(lines(100), 10, -20).text, base)
  assert.equal(sliceScreen(lines(100), 10, NaN).text, base)
})
