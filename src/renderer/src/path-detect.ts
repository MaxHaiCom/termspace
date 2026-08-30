/**
 * 从终端一行文本里认出文件路径。
 *
 * 单独成文件是为了能单测 —— 这是整条「路径可点」链路上唯一有判断的地方，
 * 接线（registerLinkProvider）和打开（open-in-editor.ts，白名单 + 绝对路径 +
 * 存在性检查）都已经很薄。
 *
 * **判据是「宁可漏，不可错」**：漏认一个路径的代价是用户自己去点编辑器；
 * 错认的代价是终端里到处是假的下划线，把真链接淹掉。所以下面每条模式都要求
 * 有一个**结构性特征**（斜杠 / `~` 前缀 / 已知扩展名），不接受裸单词。
 */

export interface PathHit {
  /** 在这一行里的起止（0 起，end 不含）—— 用来算 xterm 的 range */
  start: number
  end: number
  /** 去掉 :行:列 之后的路径本身 */
  path: string
  line?: number
  col?: number
  /** 原始匹配文本（含 :行:列），显示用 */
  raw: string
}

/* 路径里允许的字符。**故意不含空格** —— 带空格的路径在终端输出里没有可靠边界，
   认了就会把后面的话一起吞进来（`见 src/a.ts 的第三行` → 整句变成一个链接）。
   末尾的标点单独剥（见 trimTrailing）。 */
const CHARS = String.raw`[A-Za-z0-9._~\-/@+#$%一-鿿]`

/* `:12` / `:12:34` 后缀。**跟在路径模式后面一起匹配** ——
   CHARS 里没有冒号(有的话 `12:30` 这种时间也会被吞进路径),
   所以行号必须在这里显式接上,否则正则在冒号处就断了、`:12` 永远拿不到。 */
const LINECOL = String.raw`(?::\d+){0,2}`

const PATTERNS: RegExp[] = [
  // 绝对路径 / ~ 开头：有结构性前缀，最可靠
  new RegExp(String.raw`(?:^|[\s'"\`(\[<])((?:~|/)${CHARS}*/${CHARS}+${LINECOL})`, 'g'),
  // ./ 或 ../ 开头
  new RegExp(String.raw`(?:^|[\s'"\`(\[<])(\.{1,2}/${CHARS}+${LINECOL})`, 'g'),
  // 裸相对路径:必须**含斜杠**且看着像个文件(有扩展名)。
  // 只要求含斜杠是不够的 —— `and/or`、`24/7` 都会中
  new RegExp(
    String.raw`(?:^|[\s'"\`(\[<])(${CHARS}+/${CHARS}*\.[A-Za-z][A-Za-z0-9]{0,9}${LINECOL})`,
    'g'
  )
]

/** 结尾的标点不属于路径：`见 src/a.ts。` / `(src/a.ts)` / `src/a.ts,` */
function trimTrailing(s: string): string {
  return s.replace(/[.,;:!?)\]}>'"`。，；：！？）】》]+$/u, '')
}

/**
 * `:12:3` / `:12` 后缀。
 *
 * ⚠️ **必须要求冒号后面直到结尾都是数字**（`$` 锚定），否则 `12:30` 这种时间、
 * `http://x` 里的端口都会被当成行号。而且要在 trimTrailing **之后**做 ——
 * `a.ts:12.` 的句号得先去掉。
 *
 * 导出是为了能按**它自己的契约**单测：上游 `LINECOL` 已经保证了传进来的后缀
 * 只可能是数字,所以从 `findPaths` 那一层根本喂不进畸形输入 —— 变异测试因此
 * 判这个 `$` 不承重。但「只接受纯数字后缀」是这个函数**自己**的契约,
 * 放宽它就是错的。测在这一层,而不是把 findPaths 的断言写花。
 */
export function splitLineCol(s: string): { path: string; line?: number; col?: number } {
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(s)
  if (!m) return { path: s }
  return { path: m[1], line: Number(m[2]), col: m[3] ? Number(m[3]) : undefined }
}

/*
 * **这里没有 URL 排除分支,是实测后删掉的,不是漏了。**
 * 三条模式都要求匹配紧跟在行首或空白/引号/括号之后,而 URL 里的 `/`
 * 前面永远是 `:` —— `https://x/a.js`、`file:///Users/x/a.ts` 实测都产出 []。
 * 加一条 `URLISH` 守卫是纯死代码:删掉它,19 条用例一条都不红。
 * 同理也不需要挡「光秃秃的 / 或 ~」:模式要求第二个斜杠后至少一个字符,
 * `cd /`、`cd ~/` 实测同样是 []。
 * 将来若放宽模式(比如允许空格、或不要求扩展名),这两条要重新评估。
 */
export function findPaths(text: string): PathHit[] {
  if (!text) return []
  const hits: PathHit[] = []
  const taken: [number, number][] = []
  const overlaps = (a: number, b: number): boolean =>
    taken.some(([x, y]) => a < y && b > x)

  for (const re of PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const raw = m[1]
      const start = m.index + m[0].length - raw.length
      const trimmed = trimTrailing(raw)
      if (!trimmed) continue
      const end = start + trimmed.length
      // 前一条模式已经认走的段不再重复认（绝对路径优先于裸相对）
      if (overlaps(start, end)) continue
      const { path, line, col } = splitLineCol(trimmed)
      if (!path) continue
      taken.push([start, end])
      hits.push({ start, end, path, line, col, raw: trimmed })
    }
  }
  return hits.toSorted((a, b) => a.start - b.start)
}

/**
 * 相对路径 → 绝对路径。
 *
 * **cwd 必须是 pane 此刻的目录**（`#{pane_current_path}`），不是建节点时那个 ——
 * 用户 `cd` 之后拿旧 cwd 拼出来的路径要么不存在（点了没反应），
 * 要么**指向另一个仓库里的同名文件**（点开了错的文件，而且看不出来）。
 * 拿不到实时 cwd 时返回 null，宁可不给链接。
 */
export function toAbsolute(p: string, cwd: string, home: string): string | null {
  if (p.startsWith('/')) return p
  if (p === '~') return home || null
  if (p.startsWith('~/')) return home ? `${home}/${p.slice(2)}` : null
  if (!cwd) return null
  return `${cwd}/${p.replace(/^\.\//, '')}`
}
