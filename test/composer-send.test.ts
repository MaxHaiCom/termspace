/**
 * 底部输入框的发送校验。
 *
 * 会真害人的只有一件事：**用户当成一条消息打的多行，被逐行当命令执行**。
 * 下面钉的是这条的各个侧面，外加"拒发时不能悄悄改用户的文本"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkComposerSend, explainReject } from '../src/renderer/src/composer-send.ts'

const on = { bracketed: true, submit: true }
const off = { bracketed: false, submit: true }
const ok = (r: ReturnType<typeof checkComposerSend>): string => {
  assert.equal(r.ok, true, `期望通过，实际被拒: ${r.ok ? '' : r.reason}`)
  return r.ok ? r.bytes : ''
}
const rej = (r: ReturnType<typeof checkComposerSend>): string => {
  assert.equal(r.ok, false, '期望被拒，实际通过了')
  return r.ok ? '' : r.reason
}

test('空 / 纯空白 → empty', () => {
  assert.equal(rej(checkComposerSend('', on)), 'empty')
  assert.equal(rej(checkComposerSend('   \n  ', on)), 'empty')
})

test('单行 + 开括号粘贴：包起来，回车在括号外', () => {
  assert.equal(ok(checkComposerSend('ls', on)), '\x1b[200~ls\x1b[201~\r')
})

test('单行 + 没开：不包，直接发 —— 单行逐行执行就是它本来的意思', () => {
  assert.equal(ok(checkComposerSend('ls', off)), 'ls\r')
})

test('换行必须转成 \\r，不能留 \\n —— 真终端粘贴发的是 CR，留 LF 是自造方言', () => {
  const b = ok(checkComposerSend('a\nb', on))
  assert.equal(b, '\x1b[200~a\rb\x1b[201~\r')
  assert.equal(b.includes('\n'), false)
})

test('多行 + 没开括号粘贴 → 拒发（这条是整个模块存在的理由）', () => {
  assert.equal(rej(checkComposerSend('a\nb', off)), 'multiline-unsafe')
})

test('CRLF / 裸 CR 先归一，再按多行判 —— 否则 CRLF 文本能绕过上面那条', () => {
  assert.equal(rej(checkComposerSend('a\r\nb', off)), 'multiline-unsafe')
  assert.equal(rej(checkComposerSend('a\rb', off)), 'multiline-unsafe')
})

test('正文含结束标记 → 拒发，**不是静默摘掉**（摘掉 = 篡改用户文本）', () => {
  assert.equal(rej(checkComposerSend('x\x1b[201~y', on)), 'paste-end')
})

test('带 intermediate byte 的 `ESC[201 ~` 不是结束标记，不许误杀', () => {
  // 合规解析器不认它；按"长得像"删会毁掉合法文本
  assert.equal(rej(checkComposerSend('x\x1b[201 ~y', on)), 'control-chars') // 因裸 ESC 被拒，不是 paste-end
})

test('裸控制字符拒发：Ctrl-C / Ctrl-D / NUL / 裸 ESC', () => {
  for (const c of ['\x03', '\x04', '\x00', '\x1b']) {
    assert.equal(rej(checkComposerSend(`a${c}b`, on)), 'control-chars', `漏了 ${JSON.stringify(c)}`)
  }
})

test('TAB 和换行放行 —— 那两个是真会手打的', () => {
  assert.equal(ok(checkComposerSend('a\tb', on)), '\x1b[200~a\tb\x1b[201~\r')
})

test('submit=false 不补回车', () => {
  assert.equal(ok(checkComposerSend('ls', { bracketed: true, submit: false })), '\x1b[200~ls\x1b[201~')
})

test('非 BMP 字符原样通过，不被拆坏', () => {
  const s = '修好了 🎉👨‍👩‍👧‍👦'
  assert.equal(ok(checkComposerSend(s, on)), `\x1b[200~${s}\x1b[201~\r`)
})

test('每种拒发都有给人看的话，且不是空的', () => {
  for (const r of ['multiline-unsafe', 'control-chars', 'paste-end'] as const) {
    assert.ok(explainReject(r).length > 10, `${r} 的说明太短`)
  }
  assert.equal(explainReject('empty'), '') // 空文本不该弹提示
})
