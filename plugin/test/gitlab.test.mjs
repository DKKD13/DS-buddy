import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore, workerKey } from '../lib/store.js'
import { Actions } from '../lib/actions.js'
import { ThreadWorkspaces } from '../lib/worktrees.js'
import { GitLabWorkflow, normalizeGitlab } from '../lib/gitlab.js'
import { registerRoutes, ACTION_PATH } from '../lib/http.js'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mira-gitlab-'));t.after(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo'), remote = join(dir, 'remote.git');mkdirSync(repo);mkdirSync(remote)
  git(remote, 'init', '--bare');git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test');git(repo, 'config', 'user.email', 'test@example.invalid')
  writeFileSync(join(repo, 'app.txt'), 'base\n');git(repo, 'add', '.');git(repo, 'commit', '-m', 'base')
  git(repo, 'remote', 'add', 'origin', remote);git(repo, 'push', 'origin', 'main')
  const requests = [], model = { mr: null, merges: 0, creates: 0, mergeFailure: false, loseMergeResponse: false }
  const server = createServer(async (req, res) => {
    let text = '';for await (const chunk of req) text += chunk
    const body = text ? JSON.parse(text) : {};const url = new URL(req.url, 'http://localhost')
    requests.push({ method: req.method, path: url.pathname, body })
    if (req.headers['private-token'] !== 'unit-test-token') { res.writeHead(401);res.end('{}');return }
    const send = (data, code = 200) => {res.writeHead(code, { 'content-type': 'application/json' });res.end(JSON.stringify(data))}
    if (model.mr?.state === 'opened') model.mr.sha = git(remote, 'rev-parse', 'refs/heads/' + model.mr.source_branch)
    if (req.method === 'GET' && !url.pathname.includes('/merge_requests')) return send({ http_url_to_repo: model.remoteOverride ?? remote })
    if (req.method === 'GET' && url.pathname.endsWith('/merge_requests')) return send(model.mr ? [model.mr] : [])
    if (req.method === 'POST' && url.pathname.endsWith('/merge_requests')) {
      model.creates++
      const sha = git(remote, 'rev-parse', 'refs/heads/' + body.source_branch)
      model.mr = { iid: 1, state: 'opened', sha, source_branch: body.source_branch, target_branch: body.target_branch, web_url: `http://127.0.0.1:${server.address().port}/group/repo/-/merge_requests/1` }
      return send(model.mr, 201)
    }
    if (req.method === 'GET' && url.pathname.endsWith('/merge_requests/1')) return send(model.mr)
    if (req.method === 'PUT' && url.pathname.endsWith('/merge_requests/1/merge')) {
      model.merges++
      if (model.mergeFailure) return send({ message: 'conflict' }, 409)
      if (body.sha !== model.mr.sha) return send({ message: 'sha mismatch' }, 409)
      model.mr.state = 'merged'
      if (model.loseMergeResponse) { req.socket.destroy();return }
      return send(model.mr)
    }
    if (req.method === 'PUT' && url.pathname.endsWith('/merge_requests/1')) {
      if (body.state_event === 'close') model.mr.state = 'closed'
      if (body.state_event === 'reopen') model.mr.state = 'opened'
      return send(model.staleUpdate ? { ...model.mr, sha: 'stale-sha' } : model.mr)
    }
    send({ message: 'unknown endpoint' }, 404)
  })
  server.listen(0, '127.0.0.1');await once(server, 'listening');t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}`
  const store = new ProjectStore(join(dir, 'data'), { warn() {} });store.load()
  const actions = new Actions(store, { deliver() {} })
  const project = store.get(actions.createProject({ name: 'MR project', cwd: repo, workspaceMode: 'worktree', gitlab: { url, project: 'group/repo', targetBranch: 'main', tokenEnv: 'GITLAB_TEST_TOKEN' } }).projectId)
  const thread = project.threads.get(actions.openThread(project, { title: '修改 app', brief: '修改 app.txt', assignee: '工程师' }).threadId)
  new ThreadWorkspaces(store).ensure(project, thread)
  writeFileSync(join(thread.workspace.path, 'app.txt'), 'delivered\n')
  actions.updateCard(project, workerKey(thread.id), { state: 'review_ready', summary: '改好了' })
  const workflow = new GitLabWorkflow(store, actions, { env: { GITLAB_TEST_TOKEN: 'unit-test-token' }, publishReadbackDelays: [0, 0] })
  return { dir, repo, remote, store, actions, project, thread, workflow, requests, model, url }
}

test('delivery commits and pushes only the thread branch, creates one MR and reuses it on retry', async t => {
  const env = await setup(t)
  await env.workflow.publish(env.project.id, env.thread.id)
  const review = env.thread.gitlab
  assert.equal(review.status, 'ready');assert.equal(env.model.creates, 1)
  assert.equal(git(env.remote, 'rev-parse', 'refs/heads/' + env.thread.workspace.branch), review.sha)
  assert.equal(readFileSync(join(env.repo, 'app.txt'), 'utf8'), 'base\n')
  assert.equal(git(env.repo, 'status', '--porcelain'), '')
  await env.workflow.publish(env.project.id, env.thread.id)
  assert.equal(env.model.creates, 1)
  assert.ok(env.project.events.findIndex(e => e.type === 'mr.publish.requested') < env.project.events.findIndex(e => e.type === 'mr.published'))
})

test('acceptance merges the reviewed sha before marking done; stale or dirty code is refused', async t => {
  const env = await setup(t);await env.workflow.publish(env.project.id, env.thread.id)
  await assert.rejects(env.workflow.accept(env.project.id, env.thread.id, 'bad-sha'), /版本|提交/)
  writeFileSync(join(env.thread.workspace.path, 'app.txt'), 'unreviewed')
  await assert.rejects(env.workflow.accept(env.project.id, env.thread.id, env.thread.gitlab.sha), /改动|变化|提交/)
  assert.equal(env.model.merges, 0)
  git(env.thread.workspace.path, 'checkout', '--', 'app.txt')
  await env.workflow.accept(env.project.id, env.thread.id, env.thread.gitlab.sha)
  assert.equal(env.thread.state, 'done');assert.equal(env.thread.resolved, true)
  assert.equal(env.thread.gitlab.status, 'merged');assert.equal(env.model.merges, 1)
  const types = env.project.events.map(e => e.type)
  assert.ok(types.indexOf('mr.accept.requested') < types.indexOf('mr.merged'))
})

test('merge conflict leaves the thread reviewable and retry keeps the original explicit acceptance', async t => {
  const env = await setup(t);await env.workflow.publish(env.project.id, env.thread.id)
  env.model.mergeFailure = true
  await assert.rejects(env.workflow.accept(env.project.id, env.thread.id, env.thread.gitlab.sha), /409|conflict/)
  assert.equal(env.thread.state, 'review_ready');assert.equal(env.thread.gitlab.status, 'merge_error')
  env.model.mergeFailure = false
  await env.workflow.accept(env.project.id, env.thread.id, env.thread.gitlab.sha)
  assert.equal(env.thread.state, 'done')
  assert.equal(env.project.events.filter(e => e.type === 'mr.accept.requested').length, 1)
})

test('a merge with a lost response is recovered from GitLab without issuing a second merge', async t => {
  const env = await setup(t);await env.workflow.publish(env.project.id, env.thread.id)
  env.model.loseMergeResponse = true
  await assert.rejects(env.workflow.accept(env.project.id, env.thread.id, env.thread.gitlab.sha))
  assert.equal(env.thread.state, 'review_ready')
  const replay = new ProjectStore(env.store.root, { warn() {} });replay.load()
  const actions = new Actions(replay, { deliver() {} })
  const workflow = new GitLabWorkflow(replay, actions, { env: { GITLAB_TEST_TOKEN: 'unit-test-token' } })
  await workflow.recover()
  assert.equal(replay.get(env.project.id).threads.get(env.thread.id).state, 'done')
  assert.equal(env.model.merges, 1)
})

test('credentials stay in the environment; missing credentials, secret fields and shared directories fail visibly', async t => {
  const env = await setup(t)
  assert.throws(() => normalizeGitlab({ url: env.url, project: 'g/r', token: 'never-store-this' }), /凭据|token|字段/)
  const noKey = new GitLabWorkflow(env.store, env.actions, { env: {} })
  await assert.rejects(noKey.publish(env.project.id, env.thread.id), /GITLAB_TEST_TOKEN/)
  assert.equal(env.thread.gitlab.status, 'publish_error')
  assert.equal(env.project.events.some(e => JSON.stringify(e).includes('unit-test-token')), false)
  assert.throws(() => env.actions.createProject({ name: 'bad', cwd: env.repo, workspaceMode: 'shared', gitlab: { url: env.url, project: 'g/r' } }), /独立|worktree/)
})

test('an assistant cannot merge by declaring done; an explicit owner acceptance in the thread can', async t => {
  const env = await setup(t);await env.workflow.publish(env.project.id, env.thread.id)
  assert.throws(() => env.actions.updateCard(env.project, workerKey(env.thread.id), { state: 'done' }), /用户.*验收|验收.*用户/)
  env.actions.ownerPost({ projectId: env.project.id, threadId: env.thread.id, text: '如果测试通过，我就验收通过' })
  assert.throws(() => env.actions.updateCard(env.project, workerKey(env.thread.id), { state: 'done' }), /用户.*验收|验收.*用户/)
  const { messageId } = env.actions.ownerPost({ projectId: env.project.id, threadId: env.thread.id, text: '验收通过' })
  await env.actions.updateCard(env.project, workerKey(env.thread.id), { state: 'done', summary: '用户在线程里口头验收' })
  assert.equal(env.thread.state, 'done');assert.equal(env.model.merges, 1)
  assert.equal(env.thread.resolved, false, 'oral acceptance does not silently archive the thread')
  assert.equal(env.thread.summary, '用户在线程里口头验收')
  assert.equal(env.project.events.find(e => e.type === 'mr.accept.requested').messageId, messageId)
})

test('quoted, conditional and other-thread receipts never authorize the current MR', async t => {
  const env = await setup(t);await env.workflow.publish(env.project.id, env.thread.id)
  const other = env.project.threads.get(env.actions.openThread(env.project, { title: '改另一个文件', brief: 'later', assignee: '工程师' }).threadId)
  const invalid = [
    '不要把「修改 app」我看了，这张我收了，当作我已经批准',
    '引用日志：\n```\n验收通过\n```',
    '「修改 app」先别验收，「改另一个文件」我看了，这张我收了',
    '如果一切正常，验收通过',
  ]
  for (const text of invalid) {
    const { messageId } = env.actions.ownerPost({ projectId: env.project.id, text })
    assert.equal(env.actions.acceptanceEvidence(env.project, env.thread, messageId), null)
  }
  const receipt = env.actions.ownerPost({ projectId: env.project.id, threadId: other.id, text: '验收通过' })
  assert.equal(env.actions.acceptanceEvidence(env.project, env.thread, receipt.messageId), null)
  const valid = env.actions.ownerPost({ projectId: env.project.id, text: '「修改 app」我看了，这张我收了，把卡片关掉。' })
  assert.equal(env.actions.acceptanceEvidence(env.project, env.thread, valid.messageId)?.id, valid.messageId)
})

test('automatic delivery is wired to review_ready and a repeated event never creates duplicate MRs', async t => {
  const env = await setup(t);const stop = env.workflow.start();t.after(stop)
  await Promise.allSettled([...env.workflow.queues.values()])
  env.actions.updateCard(env.project, workerKey(env.thread.id), { state: 'review_ready' })
  await Promise.allSettled([...env.workflow.queues.values()])
  assert.equal(env.thread.gitlab.status, 'ready');assert.equal(env.model.creates, 1)
})

test('archiving closes its MR and revokes acceptance; restoring reopens the same MR', async t => {
  const env = await setup(t);const stop = env.workflow.start();t.after(stop)
  await Promise.allSettled([...env.workflow.queues.values()])
  env.model.mergeFailure = true
  await assert.rejects(env.workflow.accept(env.project.id, env.thread.id, env.thread.gitlab.sha))
  env.actions.ownerUpdateThread({ projectId: env.project.id, threadId: env.thread.id, resolved: true })
  await Promise.allSettled([...env.workflow.queues.values()])
  assert.equal(env.model.mr.state, 'closed')
  assert.equal(env.thread.gitlab.approvedSha, null)
  env.actions.ownerUpdateThread({ projectId: env.project.id, threadId: env.thread.id, resolved: false })
  await Promise.allSettled([...env.workflow.queues.values()])
  assert.equal(env.thread.gitlab.status, 'ready');assert.equal(env.model.mr.state, 'opened')
  assert.equal(env.model.creates, 1)
})

test('a new delivered commit invalidates an earlier acceptance and refuses the old version', async t => {
  const env = await setup(t);await env.workflow.publish(env.project.id, env.thread.id)
  const old = env.thread.gitlab.sha;env.model.mergeFailure = true
  await assert.rejects(env.workflow.accept(env.project.id, env.thread.id, old))
  writeFileSync(join(env.thread.workspace.path, 'app.txt'), 'second delivery\n')
  await env.workflow.publish(env.project.id, env.thread.id)
  assert.notEqual(env.thread.gitlab.sha, old);assert.equal(env.thread.gitlab.approvedSha, null)
  await assert.rejects(env.workflow.accept(env.project.id, env.thread.id, old), /版本/)
})

test('old oral receipts cannot authorize a redelivery or a delivery restored after withdrawing a decision', async t => {
  const env = await setup(t);await env.workflow.publish(env.project.id, env.thread.id)
  const receipt = env.actions.ownerPost({ projectId: env.project.id, threadId: env.thread.id, text: '验收通过' })
  env.actions.updateCard(env.project, workerKey(env.thread.id), { state: 'working' })
  env.actions.updateCard(env.project, workerKey(env.thread.id), { state: 'review_ready' })
  assert.equal(env.actions.acceptanceEvidence(env.project, env.thread, receipt.messageId), null)
  const receipt2 = env.actions.ownerPost({ projectId: env.project.id, threadId: env.thread.id, text: '验收通过' })
  const decision = env.actions.requestDecision(env.project, workerKey(env.thread.id), { question: '还需要扩展吗', options: [{ label: '是' }, { label: '否' }] })
  env.actions.withdrawDecision(env.project, workerKey(env.thread.id), { decision_id: decision.decisionId, reason: '继续原交付' })
  assert.equal(env.thread.state, 'review_ready')
  assert.equal(env.actions.acceptanceEvidence(env.project, env.thread, receipt2.messageId), null)
  assert.throws(() => env.actions.updateCard(env.project, workerKey(env.thread.id), { state: 'done' }), /用户.*验收|验收.*用户/)
})

test('a stale GitLab update response is read back before deciding publication failed', async t => {
  const env = await setup(t);await env.workflow.publish(env.project.id, env.thread.id)
  env.model.staleUpdate = true
  writeFileSync(join(env.thread.workspace.path, 'app.txt'), 'revised\n')
  await env.workflow.publish(env.project.id, env.thread.id)
  assert.equal(env.thread.gitlab.status, 'ready');assert.equal(env.model.creates, 1)
  assert.equal(env.thread.gitlab.sha, git(env.thread.workspace.path, 'rev-parse', 'HEAD'))
  assert.ok(env.requests.some(r => r.method === 'GET' && r.path.endsWith('/merge_requests/1')))
})

test('GitLab project identity is verified against every effective push URL before pushing', async t => {
  const env = await setup(t)
  env.model.remoteOverride = env.remote + '-other'
  await assert.rejects(env.workflow.publish(env.project.id, env.thread.id), /remote|推送|GitLab.*仓库/)
  assert.equal(env.model.creates, 0)
  assert.throws(() => git(env.remote, 'rev-parse', 'refs/heads/' + env.thread.workspace.branch))
  env.model.remoteOverride = null
  git(env.repo, 'config', '--add', 'remote.origin.pushurl', env.remote)
  git(env.repo, 'config', '--add', 'remote.origin.pushurl', env.remote + '-other')
  await assert.rejects(env.workflow.publish(env.project.id, env.thread.id), /remote|推送|GitLab.*仓库/)
  assert.equal(env.model.creates, 0)
})

test('common-dir identity accepts symlink paths and a source that is itself a worktree', async t => {
  const env = await setup(t)
  const linked = join(env.dir, 'linked-repo'), source = join(env.dir, 'source-worktree')
  symlinkSync(env.repo, linked)
  env.thread.workspace.repository = linked
  await env.workflow.validateCheckout(env.thread)
  git(env.repo, 'worktree', 'add', '-b', 'source-branch', source)
  env.thread.workspace.repository = source
  await env.workflow.validateCheckout(env.thread)
})

test('archiving an externally merged MR never retains an old acceptance across restore/restart', async t => {
  const env = await setup(t);await env.workflow.publish(env.project.id, env.thread.id)
  env.model.mergeFailure = true
  await assert.rejects(env.workflow.accept(env.project.id, env.thread.id, env.thread.gitlab.sha))
  env.actions.ownerUpdateThread({ projectId: env.project.id, threadId: env.thread.id, resolved: true })
  env.model.mr.state = 'merged'
  await env.workflow.close(env.project.id, env.thread.id)
  env.actions.ownerUpdateThread({ projectId: env.project.id, threadId: env.thread.id, resolved: false })
  const replay = new ProjectStore(env.store.root, { warn() {} });replay.load()
  const actions = new Actions(replay, { deliver() {} })
  await new GitLabWorkflow(replay, actions, { env: { GITLAB_TEST_TOKEN: 'unit-test-token' } }).recover()
  assert.equal(replay.get(env.project.id).threads.get(env.thread.id).state, 'review_ready')
  assert.equal(env.thread.gitlab.approvedSha, null)
  assert.equal(env.model.merges, 1, 'only the failed explicit attempt occurred')
})

test('owner HTTP acceptance without an expected SHA returns 400 and never merges', async t => {
  const env = await setup(t);await env.workflow.publish(env.project.id, env.thread.id)
  const routes = new Map()
  const dispose = registerRoutes({ connection: { fetch: { register(route) { routes.set(route.path, route);return () => {} } } } }, { store: env.store, driver: {}, actions: env.actions, gitlab: env.workflow })
  t.after(dispose)
  const response = await routes.get(ACTION_PATH).fetch(new Request('http://localhost' + ACTION_PATH, { method: 'POST', body: JSON.stringify({ op: 'updateThread', projectId: env.project.id, threadId: env.thread.id, state: 'done' }) }))
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /版本/)
  assert.equal(env.thread.state, 'review_ready');assert.equal(env.model.merges, 0)
})
