/**
 * 画布外观偏好：背景样式、工具栏折不折叠。
 *
 * 和 `hud-prefs.ts` 同一套理由 —— 纯展示偏好，不值得多一条 IPC 往返，
 * 也不该在主进程重启时参与任何逻辑。**必须落盘**：用户折叠工具栏或
 * 关掉背景点阵，正是因为嫌它占地方 / 嫌它吵，而这不会因为重启就消失。
 */

const KEY = 'tb.canvas.prefs.v1'

/** 'dots' 点阵（默认）· 'grid' 网格 · 'plain' 纯黑（什么都不画） */
export type CanvasBg = 'dots' | 'grid' | 'plain'

export interface CanvasPrefs {
  bg: CanvasBg
  /** 左上角工具栏收起来了吗 */
  toolbarCollapsed: boolean
}

const DEFAULTS: CanvasPrefs = { bg: 'dots', toolbarCollapsed: false }

/** 白名单，不是「非空即用」—— 磁盘上的脏值会变成一个渲染不出来的背景 */
const isBg = (v: unknown): v is CanvasBg => v === 'dots' || v === 'grid' || v === 'plain'

export function loadCanvasPrefs(store: Pick<Storage, 'getItem'> = localStorage): CanvasPrefs {
  try {
    const raw = store.getItem(KEY)
    if (!raw) return DEFAULTS
    const v = JSON.parse(raw) as Partial<CanvasPrefs>
    // 逐字段兜底，不整份信任：存坏了不能让整个画布起不来
    return {
      bg: isBg(v.bg) ? v.bg : DEFAULTS.bg,
      toolbarCollapsed:
        typeof v.toolbarCollapsed === 'boolean' ? v.toolbarCollapsed : DEFAULTS.toolbarCollapsed
    }
  } catch {
    return DEFAULTS
  }
}

export function saveCanvasPrefs(
  p: CanvasPrefs,
  store: Pick<Storage, 'setItem'> = localStorage
): void {
  try {
    store.setItem(KEY, JSON.stringify(p))
  } catch {
    /* 隐私模式 / 配额满：记不住外观偏好不是错误，别让它冒泡 */
  }
}

/** 点一下换下一档。三档循环比开个下拉快 —— 这是随手调的东西 */
export function nextBg(cur: CanvasBg): CanvasBg {
  return cur === 'dots' ? 'grid' : cur === 'grid' ? 'plain' : 'dots'
}

export const BG_LABEL: Record<CanvasBg, string> = {
  dots: '点阵',
  grid: '网格',
  plain: '纯黑'
}
