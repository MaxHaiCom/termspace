/**
 * 终端文本里的路径识别。
 *
 * 判据是**宁可漏，不可错**：漏认的代价是用户自己去开编辑器；
 * 错认的代价是终端里到处假下划线，把真链接淹掉。
 * 所以下面「不该认」的用例比「该认」的多，这是有意的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findPaths, toAbsolute, splitLineCol } from '../src/renderer/src/path-detect.ts'

const paths = (s: string): string[] => findPaths(s).map((h) => h.path)

test('绝对路径', () => {
  assert.deepEqual(paths('见 /Users/x/proj/a.ts 那行'), ['/Users/x/proj/a.ts'])
})

test('~ 开头', () => {
  assert.deepEqual(paths('cat ~/.zshrc 看看'), ['~/.zshrc'])
})

test('./ 和 ../ 开头', () => {
  assert.deepEqual(paths('./src/a.ts 和 ../lib/b.js'), ['./src/a.ts', '../lib/b.js'])
})

test('裸相对路径要求含斜杠 + 扩展名', () => {
  assert.deepEqual(paths('改了 src/main/index.ts'), ['src/main/index.ts'])
})

test('行号列号拆出来，路径本身不含它们', () => {
  const h = findPaths('src/a.ts:12:34 报错')[0]
  assert.equal(h.path, 'src/a.ts')
  assert.equal(h.line, 12)
  assert.equal(h.col, 34)
  assert.equal(h.raw, 'src/a.ts:12:34')
})

test('只有行号也认', () => {
  const h = findPaths('at src/a.ts:99')[0]
  assert.equal(h.path, 'src/a.ts')
  assert.equal(h.line, 99)
  assert.equal(h.col, undefined)
})

test('结尾标点不属于路径（中英文都要剥）', () => {
  assert.deepEqual(paths('见 src/a.ts。'), ['src/a.ts'])
  assert.deepEqual(paths('(src/a.ts)'), ['src/a.ts'])
  assert.deepEqual(paths('src/a.ts, src/b.ts'), ['src/a.ts', 'src/b.ts'])
})

test('结尾的句点要剥 —— **句点在 CHARS 里,是唯一真正需要 trimTrailing 的字符**', () => {
  /* 「。」「)」「,」那几条其实用不着守卫:它们不在 CHARS 里,正则自己就停了。
     变异测试删掉 trimTrailing 时那几条照样绿 —— 不是用例写弱了,
     是样本压根碰不到那行代码。只有句点会被 CHARS 吞进去。 */
  assert.deepEqual(paths('见 src/a.ts.'), ['src/a.ts'])
  assert.deepEqual(paths('改了 /Users/x/a.ts.'), ['/Users/x/a.ts'])
})

test('标点先剥再拆行号 —— `a.ts:12.` 的句号要先去掉', () => {
  const h = findPaths('见 src/a.ts:12.')[0]
  assert.equal(h.path, 'src/a.ts')
  assert.equal(h.line, 12)
})

/* ── 以下是「不该认」—— 错认比漏认贵 ─────────────────── */

test('时间不认 —— `12:30` 不是 `文件:行号`', () => {
  assert.deepEqual(paths('构建于 12:30 完成'), [])
})

test('裸单词不认，哪怕有扩展名 —— 没有斜杠就没有结构性特征', () => {
  assert.deepEqual(paths('运行 index.ts 试试'), [])
  assert.deepEqual(paths('package.json 改了'), [])
})

test('`and/or`、`24/7` 这类含斜杠的词不认', () => {
  assert.deepEqual(paths('and/or 都行'), [])
  assert.deepEqual(paths('24/7 在线'), [])
})

test('同一段不重复认 —— 绝对路径优先，不会再被裸相对模式切一刀', () => {
  const hs = findPaths('/Users/x/src/a.ts')
  assert.equal(hs.length, 1)
  assert.equal(hs[0].path, '/Users/x/src/a.ts')
})

test('range 能对回原文', () => {
  const s = 'see src/a.ts here'
  const h = findPaths(s)[0]
  assert.equal(s.slice(h.start, h.end), 'src/a.ts')
})

/* ── toAbsolute ─────────────────────────────────────── */

test('绝对路径原样返回', () => {
  assert.equal(toAbsolute('/a/b', '/cwd', '/home'), '/a/b')
})

test('相对路径按**实时 cwd** 拼 —— 用旧 cwd 会开到另一个仓库的同名文件', () => {
  assert.equal(toAbsolute('src/a.ts', '/proj', '/home'), '/proj/src/a.ts')
  assert.equal(toAbsolute('./src/a.ts', '/proj', '/home'), '/proj/src/a.ts')
})

test('~ 用 home 展开', () => {
  assert.equal(toAbsolute('~/.zshrc', '/proj', '/home/me'), '/home/me/.zshrc')
  assert.equal(toAbsolute('~', '/proj', '/home/me'), '/home/me')
})

test('拿不到 cwd 时返回 null —— 宁可不给链接，也不拼一个可能指错的路径', () => {
  assert.equal(toAbsolute('src/a.ts', '', '/home'), null)
  assert.equal(toAbsolute('~/x', '/proj', ''), null)
})

/* ── splitLineCol 的自有契约 ────────────────────────────
   从 findPaths 那一层喂不进畸形输入（LINECOL 已保证后缀是数字），
   所以这几条必须打在这一层 —— 否则 `$` 锚定看起来永远不承重。 */

test('splitLineCol：纯数字后缀才算行列号', () => {
  assert.deepEqual(splitLineCol('a.ts:12:34'), { path: 'a.ts', line: 12, col: 34 })
  assert.deepEqual(splitLineCol('a.ts:12'), { path: 'a.ts', line: 12, col: undefined })
})

test('splitLineCol：后缀不是纯数字 → 整串都是路径，不拆', () => {
  // 没有 `$` 锚定的话,这几个会被切出一个假的行号
  assert.deepEqual(splitLineCol('a.ts:12:abc'), { path: 'a.ts:12:abc' })
  assert.deepEqual(splitLineCol('host:8080/x'), { path: 'host:8080/x' })
  assert.deepEqual(splitLineCol('a.ts:v2'), { path: 'a.ts:v2' })
})

test('splitLineCol 不负责判断「这是不是路径」', () => {
  /* `12:30` 在这一层**就该**拆成 path=12 / line=30 —— 它的契约只是
     「把 :行:列 从路径上摘下来」,调用方保证传进来的已经是路径。
     挡住时间戳的是 findPaths 那层(没斜杠就不是路径),不是这里。
     一开始我把这条也写进上面那个用例,结果是**断言错了而不是实现错了**。 */
  assert.deepEqual(splitLineCol('12:30'), { path: '12', line: 30, col: undefined })
})

test('splitLineCol：没有冒号就原样返回', () => {
  assert.deepEqual(splitLineCol('src/a.ts'), { path: 'src/a.ts' })
})
