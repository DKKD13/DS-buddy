/** Durable work-directory allocation: one Git branch and checkout per thread. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

function git(directory, ...args) {
  try {
    return execFileSync('git', ['-C', directory, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim()
  } catch (error) {
    throw new Error(`Git 工作目录操作失败：${String(error.stderr || error.message).slice(0, 500)}`)
  }
}

/**
 * What changed in a work folder since a known commit, counted by Git rather than recalled by a model. Used when a
 * task changes hands. null when the folder is not a Git checkout with a commit, so nothing can be counted.
 * `commits` is null when the earlier commit is unknown or no longer exists (a rebase or reset removed it).
 */
export function workspaceChanges(directory, since) {
  let head
  try { head = git(directory, 'rev-parse', '--verify', 'HEAD') } catch { return null }
  const lines = output => output.split('\n').map(line => line.trim()).filter(Boolean)
  let commits = null, files = []
  if (since === head) commits = 0
  else if (since) {
    try {
      commits = Number(git(directory, 'rev-list', '--count', `${since}..HEAD`))
      files = lines(git(directory, '-c', 'core.quotePath=false', 'diff', '--name-only', since, 'HEAD'))
    } catch { commits = null; files = [] }
  }
  let dirty = []
  // Porcelain lines are "XY path"; the status letters are dropped, the path (or "old -> new") is kept.
  try { dirty = lines(git(directory, '-c', 'core.quotePath=false', 'status', '--porcelain')).map(line => line.replace(/^\S+\s+/, '')) } catch { /* counted as none */ }
  return { head, commits, files: files.slice(0, 20), fileCount: files.length, dirty: dirty.slice(0, 20), dirtyCount: dirty.length }
}

/** Explain why a folder cannot yet be checked out independently. */
export function repositoryAt(directory) {
  let root
  try { root = git(directory, 'rev-parse', '--show-toplevel') } catch { return null }
  let baseCommit
  try { baseCommit = git(root, 'rev-parse', '--verify', 'HEAD') } catch { return { unavailable: 'Git 仓库还没有提交，创建独立工作目录前先提交初始版本' } }
  const subdirectory = relative(realpathSync(root), realpathSync(directory))
  if (subdirectory) {
    try {
      if (git(root, 'cat-file', '-t', `${baseCommit}:${subdirectory.split(sep).join('/')}`) !== 'tree') throw new Error('not a directory')
    } catch { return { unavailable: '项目子目录尚未进入 Git 提交，不能从 HEAD 创建独立工作目录' } }
  }
  return { root: realpathSync(root), subdirectory, baseCommit }
}

function commonDirectory(directory) {
  return realpathSync(resolve(directory, git(directory, 'rev-parse', '--git-common-dir')))
}

function registrations(repository) {
  const entries = []
  // Older Git (including K1's) has porcelain but no -z. Decode its C-quoted paths.
  const decode = value => value.startsWith('"') ? value.slice(1, -1).replace(/\\([0-7]{1,3}|[\\"abfnrtv])/g, (_match, code) => /^[0-7]/.test(code) ? String.fromCharCode(parseInt(code, 8)) : ({ a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"' })[code]) : value
  for (const field of git(repository, '-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain').split('\n')) {
    if (field.startsWith('worktree ')) entries.push({ path: decode(field.slice(9)) })
    else if (field.startsWith('branch ') && entries.length) entries.at(-1).branch = field.slice(7)
    else if (field.startsWith('locked') && entries.length) entries.at(-1).locked = true
  }
  return entries
}

const shellPath = path => /^[\w./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`

/**
 * What acceptance did to a task's code, in one line for whoever reports it (Mira, the executor). Without GitLab
 * nothing merges: a task worktree's change is committed on its own branch, and merging stays the owner's.
 */
export function landingNote(thread) {
  const landed = thread.workspace?.landed
  if (!landed) return thread.workspace?.path ? '改动在任务工作目录里，平台没提交也没合并' : '改动直接在项目目录里，平台没提交也没合并'
  if (landed.status === 'committed') return `改动已提交在任务分支 ${thread.workspace.branch}（${landed.sha.slice(0, 7)}，${landed.fileCount} 个文件），没合并；合入命令：${landed.merge}`
  if (landed.status === 'empty') return '任务分支上没有改动，没有提交，也没合并'
  return `自动提交没成功（${landed.error}），改动还在任务工作目录里，没提交也没合并`
}

export class ThreadWorkspaces {
  constructor(store) { this.store = store }

  /**
   * The owner accepted a task in a project without GitLab: commit what its worktree holds on the task's own branch.
   * Dogfood 2026-11-07: every accepted task left its change uncommitted, and the executor waited to be asked. Only
   * that branch moves; the owner's checkout and branches are never touched. Hooks are skipped: this is the platform's
   * commit on its own branch, the server cannot wait on a long hook, and the owner's own merge and push still run theirs.
   */
  land(project, thread) {
    const ws = thread.workspace
    if (project.gitlab || project.workspace?.mode !== 'worktree' || ws?.status !== 'ready' || ws.type || ws.landed) return null
    let landed
    try {
      if (git(ws.path, 'symbolic-ref', '--short', 'HEAD') !== ws.branch) throw new Error('任务工作目录不在任务分支上')
      git(ws.path, 'add', '-A')
      let committed = false
      if (git(ws.path, 'status', '--porcelain')) {
        // K1's dogfood clone has no Git identity; a missing one must not block acceptance.
        const has = key => { try { return Boolean(git(ws.path, 'config', key)) } catch { return false } }
        const identity = has('user.name') && has('user.email') ? [] : ['-c', 'user.name=Mira', '-c', 'user.email=mira@local.invalid']
        const message = [thread.title, thread.summary, `Mira 任务 ${thread.id}，验收后由平台提交。`].filter(Boolean).join('\n\n')
        git(ws.path, ...identity, 'commit', '-q', '--no-verify', '-m', message)
        committed = true
      }
      const sha = git(ws.path, 'rev-parse', 'HEAD')
      const files = git(ws.path, '-c', 'core.quotePath=false', 'diff', '--name-only', ws.baseCommit, sha).split('\n').filter(Boolean)
      landed = { status: files.length ? 'committed' : 'empty', sha, committed, files: files.slice(0, 20), fileCount: files.length,
        merge: `git -C ${shellPath(ws.repository)} merge ${ws.branch}` }
    } catch (error) {
      landed = { status: 'failed', error: String(error.message).replace(/\s+/g, ' ').trim().slice(0, 300) }
    }
    this.store.append(project.id, { type: 'thread.workspace.landed', threadId: thread.id, landed })
    return landed
  }

  plan(project, thread) {
    if (!/^p_[a-f0-9]{10}$/.test(project.id) || !/^t_[a-f0-9]{10}$/.test(thread.id)) throw new Error('工作目录的项目或线程 id 无效')
    if (thread.workspace?.path) {
      const prior = thread.workspace
      // A failed or interrupted setup keeps its original branch and base commit.
      return { path: prior.path, cwd: prior.cwd, branch: prior.branch, baseCommit: prior.baseCommit, repository: prior.repository }
    }
    const config = project.workspace
    const path = join(this.store.root, project.id, 'worktrees', thread.id)
    return { path, cwd: join(path, config.subdirectory || ''), branch: `codex/mira/${project.id}/${thread.id}`,
      baseCommit: git(config.repository, 'rev-parse', '--verify', 'HEAD'), repository: config.repository }
  }

  ensure(project, thread) {
    if (project.workspace?.mode !== 'worktree') return project.cwd
    const plan = this.plan(project, thread)
    const wasReady = thread.workspace?.status === 'ready'
    const restoring = !existsSync(plan.path)
    if (!wasReady) this.store.append(project.id, { type: 'thread.workspace.preparing', threadId: thread.id, workspace: { ...plan, status: 'preparing' } })
    try {
      const expected = resolve(this.store.root, project.id, 'worktrees', thread.id)
      const inside = plan.cwd ? relative(expected, resolve(plan.cwd)) : '..'
      if (!isAbsolute(plan.path) || resolve(plan.path) !== expected || !plan.cwd || isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep)) {
        throw new Error('线程工作目录与项目分配的目录不符')
      }
      if (!existsSync(plan.path)) {
        mkdirSync(dirname(plan.path), { recursive: true })
        let branchExists = false
        try { git(plan.repository, 'show-ref', '--verify', `refs/heads/${plan.branch}`); branchExists = true } catch { /* new branch */ }
        const prior = registrations(plan.repository).find(entry => resolve(entry.path) === expected)
        if (prior && (prior.locked || prior.branch !== `refs/heads/${plan.branch}`)) throw new Error('原工作目录的 Git 注册已被锁定或属于其他分支，请先核对')
        // Only replace this exact missing registration. Do not prune other users' checkouts.
        if (branchExists) git(plan.repository, 'worktree', 'add', ...(prior ? ['--force'] : []), plan.path, plan.branch)
        else git(plan.repository, 'worktree', 'add', '-b', plan.branch, plan.path, plan.baseCommit)
      }
      if (!statSync(plan.path).isDirectory()) throw new Error('工作目录被文件占用，不是目录；已保留原文件')
      // Adopt only the checkout allocated to this thread. Never overwrite another folder.
      if (realpathSync(git(plan.path, 'rev-parse', '--show-toplevel')) !== realpathSync(plan.path)
          || commonDirectory(plan.path) !== commonDirectory(plan.repository)
          || git(plan.path, 'symbolic-ref', '--short', 'HEAD') !== plan.branch) {
        throw new Error('已存在的工作目录不属于这个线程的 Git worktree')
      }
      if (!statSync(plan.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error('线程在仓库中的项目子目录不存在')
      if (!wasReady || restoring) this.store.append(project.id, { type: 'thread.workspace.ready', threadId: thread.id, workspace: { ...plan, status: 'ready' } })
      return plan.cwd
    } catch (error) {
      this.store.append(project.id, { type: 'thread.workspace.failed', threadId: thread.id, workspace: { ...plan, status: 'failed', error: String(error.message).slice(0, 600) } })
      throw error
    }
  }
}
