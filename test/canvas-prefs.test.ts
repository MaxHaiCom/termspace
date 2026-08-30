/**
 * 画布外观偏好。
 *
 * 会真害人的只有一件：**存坏了把整个画布拖下水**。localStorage 里的东西
 * 用户能手改、上一版能留下别的形状，所以逐字段兜底而不是整份信任。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadCanvasPrefs, saveCanvasPrefs, nextBg, BG_LABEL } from '../src/renderer/src/canvas-prefs.ts'

const store = (raw: string | null): Pick<Storage, 'getItem'> => ({ getItem: () => raw })

test('没存过 → 默认点阵、工具栏展开', () => {
  assert.deepEqual(loadCanvasPrefs(store(null)), { bg: 'dots', toolbarCollapsed: false })
})

test('读回存进去的值', () => {
  const raw = JSON.stringify({ bg: 'plain', toolbarCollapsed: true })
  assert.deepEqual(loadCanvasPrefs(store(raw)), { bg: 'plain', toolbarCollapsed: true })
})

test('bg 是白名单 —— 不认识的值退回默认，不是原样用', () => {
  // 原样用的话会得到一个渲染不出来的背景，而且不报错
  for (const bad of ['"neon"', '123', 'null', '{}']) {
    const raw = `{"bg":${bad},"toolbarCollapsed":true}`
    const r = loadCanvasPrefs(store(raw))
    assert.equal(r.bg, 'dots', `bg=${bad} 没被挡住`)
    assert.equal(r.toolbarCollapsed, true, `bg=${bad} 时把另一个字段也带坏了`)
  }
})

test('toolbarCollapsed 非布尔退回默认，且不影响 bg', () => {
  const r = loadCanvasPrefs(store('{"bg":"grid","toolbarCollapsed":"yes"}'))
  assert.deepEqual(r, { bg: 'grid', toolbarCollapsed: false })
})

test('整份坏掉（不是 JSON）→ 默认值，不抛', () => {
  assert.deepEqual(loadCanvasPrefs(store('{{{')), { bg: 'dots', toolbarCollapsed: false })
})

test('getItem 自己抛（隐私模式）→ 默认值，不冒泡', () => {
  const boom: Pick<Storage, 'getItem'> = {
    getItem: () => {
      throw new Error('SecurityError')
    }
  }
  assert.deepEqual(loadCanvasPrefs(boom), { bg: 'dots', toolbarCollapsed: false })
})

test('setItem 抛（配额满）不冒泡 —— 记不住外观不是错误', () => {
  assert.doesNotThrow(() =>
    saveCanvasPrefs({ bg: 'plain', toolbarCollapsed: true }, {
      setItem: () => {
        throw new Error('QuotaExceeded')
      }
    })
  )
})

test('nextBg 三档循环回到原点', () => {
  assert.equal(nextBg('dots'), 'grid')
  assert.equal(nextBg('grid'), 'plain')
  assert.equal(nextBg('plain'), 'dots')
  assert.equal(nextBg(nextBg(nextBg('dots'))), 'dots')
})

test('每档都有中文标签 —— 按钮上要显示它', () => {
  for (const k of ['dots', 'grid', 'plain'] as const) {
    assert.ok(BG_LABEL[k].length > 0, `${k} 没有标签`)
  }
})
