import test from 'node:test'
import assert from 'node:assert/strict'
import { signInError } from '../lib/external-runtime.js'

// E2E #17: a signed-out Codex or Claude Code showed its own English error in 进展, with no way out.
test('a signed-out runner fails with what happened and the way out; other failures keep their own text', () => {
  const codex = signInError('codex', new Error('Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.'))
  assert.equal(codex.message, '这台机器上的 Codex 没登录或登录已过期。在这台机器上运行 codex login 重新登录后再试，或者在任务里把执行方式换回 DSH。')
  assert.match(codex.cause.message, /refresh token was revoked/, 'the original text stays on the error for the logs')
  const claude = signInError('claude', new Error('Failed to authenticate: OAuth session expired and could not be refreshed'))
  assert.equal(claude.message, '这台机器上的 Claude Code 没登录或登录已过期。在这台机器上重新登录 Claude Code 后再试，或者在任务里把执行方式换回 DSH。')
  const missing = new Error('spawn codex ENOENT')
  assert.equal(signInError('codex', missing), missing)
  const native = new Error('401 from a tool')
  assert.equal(signInError('dsh', native), native, 'only the outside runners are mapped')
})
