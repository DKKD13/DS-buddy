import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore, workerKey } from '../lib/store.js'
import { Actions } from '../lib/actions.js'
import { Driver } from '../lib/driver.js'
import { ThreadWorkspaces, landingNote } from '../lib/worktrees.js'
import { rolePrompt, renderCard } from '../lib/protocol.js'

const git = (path, ...args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function setup(t, subfolder = false) {
  const root = mkdtempSync(join(tmpdir(), 'mira-worktrees-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'); mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Mira test'); git(repo, 'config', 'user.email', 'mira@example.test')
  mkdirSync(join(repo, 'plugin')); writeFileSync(join(repo, 'plugin/file.txt'), 'base\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base')
  const store = new ProjectStore(join(root, 'data'), { warn() {} }); store.load()
  const actions = new Actions(store, { deliver() {} })
  const { projectId } = actions.createProject({ name: '隔离开发', cwd: subfolder ? join(repo, 'plugin') : repo })
  const project = store.get(projectId)
  const open = () => actions.openThread(project, { title: '改文件', brief: '改 file.txt', assignee: '工程师' }).threadId
  return { root, repo, store, actions, project, open, workspaces: new ThreadWorkspaces(store) }
}

test('two threads edit separate worktrees; main checkout, uncommitted files and the other thread stay intact', t => {
  const env = setup(t)
  writeFileSync(join(env.repo, 'scratch.txt'), 'uncommitted')
  const one = env.project.threads.get(env.open()), two = env.project.threads.get(env.open())
  env.workspaces.ensure(env.project, one); env.workspaces.ensure(env.project, two)
  assert.notEqual(one.workspace.path, two.workspace.path)
  assert.match(one.workspace.branch, /^codex\/mira\//)
  assert.equal(git(one.workspace.path, 'branch', '--show-current'), one.workspace.branch)
  writeFileSync(join(one.workspace.path, 'plugin/file.txt'), 'thread one\n')
  assert.equal(readFileSync(join(two.workspace.path, 'plugin/file.txt'), 'utf8'), 'base\n')
  assert.equal(readFileSync(join(env.repo, 'plugin/file.txt'), 'utf8'), 'base\n')
  assert.equal(readFileSync(join(env.repo, 'scratch.txt'), 'utf8'), 'uncommitted')
  assert.equal(existsSync(join(one.workspace.path, 'scratch.txt')), false)
  assert.ok(rolePrompt(env.project, workerKey(one.id)).includes(one.workspace.cwd))
  assert.ok(renderCard(env.project, one).includes(one.workspace.branch))
  assert.equal(env.project.events.filter(e => e.type === 'thread.workspace.ready').length, 2)
})

test('replay and repeated wakes reuse a thread worktree; a missing checkout recovers its committed branch', t => {
  const env = setup(t)
  const thread = env.project.threads.get(env.open())
  env.workspaces.ensure(env.project, thread)
  const expected = { ...thread.workspace }
  writeFileSync(join(expected.path, 'plugin/file.txt'), 'saved\n')
  git(expected.path, 'add', '.'); git(expected.path, 'commit', '-m', 'thread change')
  const committed = git(expected.path, 'rev-parse', 'HEAD')
  const replay = new ProjectStore(env.store.root, { warn() {} }); replay.load()
  const project = replay.get(env.project.id), reloaded = project.threads.get(thread.id)
  const workspaces = new ThreadWorkspaces(replay)
  workspaces.ensure(project, reloaded)
  assert.equal(reloaded.workspace.path, expected.path)
  assert.equal(git(expected.path, 'rev-parse', 'HEAD'), committed)
  git(env.repo, 'worktree', 'remove', expected.path)
  workspaces.ensure(project, reloaded)
  assert.equal(readFileSync(join(expected.path, 'plugin/file.txt'), 'utf8'), 'saved\n')
  assert.equal(git(expected.path, 'rev-parse', 'HEAD'), committed)
})

test('a conflicting target directory is reported and preserved; a retry can adopt the planned checkout', t => {
  const env = setup(t)
  const thread = env.project.threads.get(env.open())
  const planned = env.workspaces.plan(env.project, thread)
  mkdirSync(planned.path, { recursive: true }); writeFileSync(join(planned.path, 'keep.txt'), 'keep')
  assert.throws(() => env.workspaces.ensure(env.project, thread), /工作目录|worktree/)
  assert.equal(readFileSync(join(planned.path, 'keep.txt'), 'utf8'), 'keep')
  assert.equal(thread.workspace.status, 'failed')
  rmSync(planned.path, { recursive: true })
  git(env.repo, 'worktree', 'add', '-b', planned.branch, planned.path, planned.baseCommit)
  env.workspaces.ensure(env.project, thread)
  assert.equal(thread.workspace.status, 'ready')
})

test('shared mode and ordinary folders retain their working directory; a repository subfolder is preserved', t => {
  const env = setup(t, true)
  const thread = env.project.threads.get(env.open())
  env.workspaces.ensure(env.project, thread)
  assert.equal(thread.workspace.cwd, join(thread.workspace.path, 'plugin'))
  const sharedId = env.actions.createProject({ name: '共享', cwd: env.repo, workspaceMode: 'shared' }).projectId
  const shared = env.store.get(sharedId)
  const sharedThread = shared.threads.get(env.actions.openThread(shared, { title: '共享', brief: '共享', assignee: '工程师' }).threadId)
  assert.equal(env.workspaces.ensure(shared, sharedThread), env.repo)
  const plain = join(env.root, 'plain'); mkdirSync(plain)
  const plainId = env.actions.createProject({ name: '普通', cwd: plain }).projectId
  const project = env.store.get(plainId)
  const plainThread = project.threads.get(env.actions.openThread(project, { title: '普通', brief: '普通', assignee: '工程师' }).threadId)
  assert.equal(env.workspaces.ensure(project, plainThread), plain)
  assert.throws(() => env.actions.createProject({ name: '必须隔离', cwd: plain, workspaceMode: 'worktree' }), /Git/)
})

test('the DSH worker session starts in its thread worktree and retains that path after session recreation', async t => {
  const env = setup(t, true)
  const thread = env.project.threads.get(env.open())
  const agents = new Map(), requests = []
  const ctx = { logger: { warn() {} }, agents: { get: id => agents.get(id) }, get: () => undefined }
  const driver = new Driver(ctx, env.store, content => ({ content }))
  driver.controller = {
    async create(request) { requests.push(request); agents.set(request.sessionId, { id: request.sessionId }); return { sessionId: request.sessionId } },
    async resolveAgent(id) { return agents.has(id) ? { agent: agents.get(id) } : { error: new Error('lost') } },
  }
  const first = await driver.ensureAgent(env.project, workerKey(thread.id))
  assert.equal(requests[0].cwd, thread.workspace.cwd)
  assert.notEqual(requests[0].cwd, env.project.cwd)
  agents.delete(first.agent.id)
  await driver.ensureAgent(env.project, workerKey(thread.id))
  assert.equal(requests[1].cwd, requests[0].cwd)
  rmSync(thread.workspace.path, { recursive: true })
  await driver.ensureAgent(env.project, workerKey(thread.id))
  assert.equal(existsSync(thread.workspace.cwd), true, 'a live session also revalidates its missing cwd')
})

test('auto mode explains an unborn repository or untracked subfolder; required isolation rejects both before opening a thread', t => {
  const env = setup(t)
  const unborn = join(env.root, 'unborn'); mkdirSync(unborn); git(unborn, 'init', '-b', 'main')
  for (const cwd of [unborn, join(env.repo, 'not-committed')]) {
    mkdirSync(cwd, { recursive: true })
    const id = env.actions.createProject({ name: '尚未就绪', cwd }).projectId
    assert.equal(env.store.get(id).workspace.mode, 'shared')
    assert.ok(env.store.get(id).workspace.reason)
    assert.throws(() => env.actions.createProject({ name: '必须隔离', cwd, workspaceMode: 'worktree' }), /提交|子目录/)
  }
})

test('a file occupying the target path is preserved and reported as a directory conflict', t => {
  const env = setup(t), thread = env.project.threads.get(env.open())
  const plan = env.workspaces.plan(env.project, thread)
  mkdirSync(join(env.store.root, env.project.id, 'worktrees'), { recursive: true })
  writeFileSync(plan.path, 'keep this file')
  assert.throws(() => env.workspaces.ensure(env.project, thread), /目录.*占用|不是目录/)
  assert.equal(readFileSync(plan.path, 'utf8'), 'keep this file')
})

// Dogfood 2026-11-07: every accepted task in a non-GitLab project left its change uncommitted in the task worktree, and
// the executor said 「需要提交或合入时告诉我」. Acceptance now commits on the task branch; the owner's checkout is not touched.
test('accepting a task without GitLab commits its worktree on the task branch and leaves the main checkout alone', t => {
  const env = setup(t, true)
  // K1's dogfood clone has no Git identity at all; the commit must not depend on one.
  git(env.repo, 'config', '--unset', 'user.name'); git(env.repo, 'config', '--unset', 'user.email')
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM }
  process.env.GIT_CONFIG_GLOBAL = join(env.root, 'no-global-config'); process.env.GIT_CONFIG_NOSYSTEM = '1'
  t.after(() => { for (const [key, name] of [['global', 'GIT_CONFIG_GLOBAL'], ['nosystem', 'GIT_CONFIG_NOSYSTEM']]) saved[key] === undefined ? delete process.env[name] : process.env[name] = saved[key] })
  const thread = env.project.threads.get(env.open())
  env.workspaces.ensure(env.project, thread)
  const ws = thread.workspace, mainHead = git(env.repo, 'rev-parse', 'HEAD')
  writeFileSync(join(ws.path, 'plugin/file.txt'), 'accepted change\n')
  writeFileSync(join(ws.path, 'plugin/new.txt'), 'new file\n')
  env.actions.updateCard(env.project, workerKey(thread.id), { state: 'review_ready', summary: '改了 file.txt，加了 new.txt' })
  env.actions.ownerUpdateThread({ projectId: env.project.id, threadId: thread.id, resolved: true, state: 'done' })

  const landed = thread.workspace.landed
  assert.equal(landed.status, 'committed')
  assert.equal(git(ws.path, 'status', '--porcelain'), '', 'nothing is left uncommitted in the task worktree')
  assert.equal(git(ws.path, 'rev-parse', 'HEAD'), landed.sha)
  assert.equal(git(ws.path, 'log', '-1', '--format=%s'), '改文件')
  assert.equal(git(ws.path, 'log', '-1', '--format=%an'), 'Mira')
  assert.deepEqual(landed.files.sort(), ['plugin/file.txt', 'plugin/new.txt'])
  assert.equal(landed.merge, `git -C ${ws.repository} merge ${ws.branch}`)
  // The owner's checkout and branch are exactly as they were: merging is theirs.
  assert.equal(git(env.repo, 'rev-parse', 'HEAD'), mainHead)
  assert.equal(git(env.repo, 'branch', '--show-current'), 'main')
  assert.equal(readFileSync(join(env.repo, 'plugin/file.txt'), 'utf8'), 'base\n')
  // Everyone who reads the outcome is told the same fact: committed on the branch, not merged.
  assert.match(landingNote(thread), new RegExp(`已提交在任务分支 ${ws.branch}（${landed.sha.slice(0, 7)}，2 个文件），没合并`))
  assert.match(renderCard(env.project, thread), /landed="committed"/)
  assert.match(rolePrompt(env.project, workerKey(thread.id)), /验收后平台会把本线程改动提交在这个分支上/)

  // Replay keeps the record; accepting again commits nothing more.
  const replay = new ProjectStore(env.store.root, { warn() {} }); replay.load()
  assert.equal(replay.get(env.project.id).threads.get(thread.id).workspace.landed.sha, landed.sha)
  env.actions.ownerUpdateThread({ projectId: env.project.id, threadId: thread.id, resolved: true, state: 'done' })
  assert.equal(env.project.events.filter(e => e.type === 'thread.workspace.landed').length, 1)
})

test('an executor marking its task done after the owner says 验收通过 lands it the same way; no change lands as empty', t => {
  const env = setup(t)
  const changed = env.project.threads.get(env.open()), untouched = env.project.threads.get(env.open())
  env.workspaces.ensure(env.project, changed); env.workspaces.ensure(env.project, untouched)
  writeFileSync(join(changed.workspace.path, 'plugin/file.txt'), 'worker change\n')
  env.actions.updateCard(env.project, workerKey(changed.id), { state: 'done' })
  assert.equal(changed.workspace.landed.status, 'committed')
  assert.deepEqual(changed.workspace.landed.files, ['plugin/file.txt'])
  env.actions.updateCard(env.project, workerKey(untouched.id), { state: 'done' })
  assert.equal(untouched.workspace.landed.status, 'empty')
  assert.match(landingNote(untouched), /没有改动/)
  // A commit that cannot happen never blocks the acceptance; the record says it did not commit.
  const lost = env.project.threads.get(env.open())
  env.workspaces.ensure(env.project, lost)
  rmSync(lost.workspace.path, { recursive: true })
  env.actions.ownerUpdateThread({ projectId: env.project.id, threadId: lost.id, resolved: true, state: 'done' })
  assert.equal(lost.state, 'done')
  assert.equal(lost.workspace.landed.status, 'failed')
  assert.match(landingNote(lost), /自动提交没成功（.+），改动还在任务工作目录里，没提交也没合并/)
  // A shared-directory project has no task branch: nothing is committed, and the note says where the change is.
  const sharedId = env.actions.createProject({ name: '共享', cwd: env.repo, workspaceMode: 'shared' }).projectId
  const shared = env.store.get(sharedId)
  const sharedThread = shared.threads.get(env.actions.openThread(shared, { title: '共享', brief: '共享', assignee: '工程师' }).threadId)
  env.actions.ownerUpdateThread({ projectId: sharedId, threadId: sharedThread.id, resolved: true, state: 'done' })
  assert.equal(sharedThread.workspace, undefined)
  assert.match(landingNote(sharedThread), /直接在项目目录里/)
})

test('a checkout removed outside Git recovers its own registration without pruning other worktrees', t => {
  const env = setup(t), thread = env.project.threads.get(env.open()), other = env.project.threads.get(env.open())
  env.workspaces.ensure(env.project, thread); env.workspaces.ensure(env.project, other)
  writeFileSync(join(thread.workspace.path, 'plugin/file.txt'), 'committed before loss')
  git(thread.workspace.path, 'add', '.'); git(thread.workspace.path, 'commit', '-m', 'save')
  rmSync(thread.workspace.path, { recursive: true })
  env.workspaces.ensure(env.project, thread)
  assert.equal(readFileSync(join(thread.workspace.path, 'plugin/file.txt'), 'utf8'), 'committed before loss')
  assert.equal(readFileSync(join(other.workspace.path, 'plugin/file.txt'), 'utf8'), 'base\n')
})
