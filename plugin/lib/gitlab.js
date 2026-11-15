/** Per-thread GitLab delivery, with durable intents before every external action. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const execute = promisify(execFile)
const FIELDS = new Set(['url', 'project', 'remote', 'targetBranch', 'tokenEnv'])

export function normalizeGitlab(value) {
  if (value === undefined || value === null || value === false) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('GitLab 配置必须是对象')
  for (const key of Object.keys(value)) if (!FIELDS.has(key)) throw new Error(`GitLab 配置不接受 ${key} 字段；凭据只放环境变量`)
  const url = new URL(value.url)
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('GitLab 地址需使用 HTTPS，不得在 URL 中放凭据或查询参数')
  }
  const project = String(value.project ?? '').trim()
  if (!project || project.length > 240 || !/^[\w./-]+$/.test(project) || project.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('GitLab project 要填数字 id 或 group/project')
  const remote = value.remote ?? 'origin', targetBranch = value.targetBranch ?? 'main', tokenEnv = value.tokenEnv ?? 'GITLAB_TOKEN'
  if (!/^[a-zA-Z0-9][\w.-]{0,79}$/.test(remote)) throw new Error('Git remote 名称无效')
  if (typeof targetBranch !== 'string' || !/^[\w][\w./-]{0,199}$/.test(targetBranch) || targetBranch.includes('..') || targetBranch.endsWith('/') || targetBranch.endsWith('.lock')) throw new Error('目标分支名称无效')
  if (!/^(?:MIRA_)?GITLAB_[A-Z0-9_]+$/.test(tokenEnv)) throw new Error('GitLab 凭据变量名应以 GITLAB_ 或 MIRA_GITLAB_ 开头')
  return { url: url.href.replace(/\/$/, ''), project, remote, targetBranch, tokenEnv }
}

export class GitLabWorkflow {
  constructor(store, actions, options = {}) {
    this.store = store
    this.actions = actions
    actions.gitlabWorkflow = this
    this.env = options.env ?? process.env
    this.fetch = options.fetch ?? globalThis.fetch
    this.logger = options.logger ?? { warn() {} }
    this.queues = new Map()
    this.abort = new AbortController()
    this.stopped = false
    this.publishReadbackDelays = options.publishReadbackDelays ?? [200, 600, 1600, 3000]
  }

  clean(error, config) {
    const secret = this.env[config?.tokenEnv]
    let text = String(error?.message ?? error).replace(/(https?:\/\/)[^\s/@]+(?::[^@\s]+)?@/g, '$1[REDACTED]@')
    if (secret) text = text.split(secret).join('[REDACTED]')
    return text.slice(0, 700)
  }

  record(project, thread, type, fields = {}) {
    if (this.stopped) return
    return this.store.append(project.id, { type, threadId: thread.id, ...fields })
  }

  serial(projectId, threadId, task) {
    const key = `${projectId}|${threadId}`
    const pending = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(task)
    this.queues.set(key, pending)
    pending.finally(() => { if (this.queues.get(key) === pending) this.queues.delete(key) }).catch(() => {})
    return pending
  }

  context(projectId, threadId) {
    if (this.stopped) throw new Error('GitLab 服务已停止')
    const project = this.store.get(projectId), thread = project.threads.get(threadId)
    if (!thread) throw new Error('没有这个线程')
    if (!project.gitlab) throw new Error('项目尚未配置 GitLab')
    if (!thread.workspace || thread.workspace.status !== 'ready') throw new Error('GitLab 交付需要已经就绪的独立 worktree')
    return { project, thread, config: project.gitlab }
  }

  async git(directory, ...args) {
    try {
      const result = await execute('git', ['-C', directory, ...args], {
        encoding: 'utf8', timeout: 90_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, ...this.env, GIT_TERMINAL_PROMPT: '0' }, signal: this.abort.signal,
      })
      return result.stdout.trim()
    } catch (error) {
      const wrapped = new Error(String(error.stderr || error.message))
      wrapped.code = error.code
      throw wrapped
    }
  }

  async validateCheckout(thread) {
    const path = thread.workspace.path
    if (realpathSync(await this.git(path, 'rev-parse', '--show-toplevel')) !== realpathSync(path)
        || await this.git(path, 'symbolic-ref', '--short', 'HEAD') !== thread.workspace.branch) throw new Error('线程工作目录或分支已经变化，不能发布其他目录的代码')
    const actualCommon = resolve(path, await this.git(path, 'rev-parse', '--git-common-dir'))
    const expectedCommon = resolve(thread.workspace.repository, await this.git(thread.workspace.repository, 'rev-parse', '--git-common-dir'))
    if (realpathSync(actualCommon) !== realpathSync(expectedCommon)) throw new Error('线程工作目录所属仓库已变化')
  }

  async validateRemote(config, directory) {
    const metadata = await this.request(config, '')
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.url).hostname)
    const identity = value => {
      if (typeof value !== 'string' || !value) return null
      if (local && value.startsWith('/')) return 'local:' + resolve(value)
      const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value)
      try {
        const url = new URL(scp && !value.includes('://') ? `ssh://${scp[1]}/${scp[2]}` : value)
        if (!['ssh:', 'https:', ...(local ? ['http:'] : [])].includes(url.protocol) || url.search || url.hash) return null
        return `${url.host.toLowerCase()}/${url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')}`
      } catch { return null }
    }
    const expected = [metadata.http_url_to_repo, metadata.ssh_url_to_repo].map(identity).filter(Boolean)
    const destinations = (await this.git(directory, 'remote', 'get-url', '--push', '--all', config.remote)).split('\n').map(identity)
    if (!expected.length || !destinations.length || destinations.some(url => !url || !expected.includes(url))) throw new Error('Git remote 的推送地址与 GitLab 项目仓库不符，请检查 remote 和 pushurl')
  }

  async request(config, endpoint, method = 'GET', body) {
    const token = this.env[config.tokenEnv]
    if (!token) throw new Error(`DSH 环境缺少 ${config.tokenEnv}，未发送 GitLab 请求`)
    const response = await this.fetch(`${config.url}/api/v4/projects/${encodeURIComponent(config.project)}${endpoint}`, {
      method, redirect: 'error', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]),
      headers: { 'PRIVATE-TOKEN': token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`GitLab HTTP ${response.status}：${JSON.stringify(data.message ?? data.error ?? data).slice(0, 300)}`)
    return data
  }

  async publish(projectId, threadId) {
    return this.serial(projectId, threadId, () => this.publishNow(projectId, threadId))
  }

  async publishNow(projectId, threadId) {
    const { project, thread, config } = this.context(projectId, threadId)
    if (thread.state !== 'review_ready' || thread.resolved) throw new Error('只有待验收线程可以发布 MR')
    this.record(project, thread, 'mr.publish.requested', { branch: thread.workspace.branch, targetBranch: config.targetBranch })
    try {
      if (!this.env[config.tokenEnv]) throw new Error(`DSH 环境缺少 ${config.tokenEnv}`)
      await this.validateCheckout(thread)
      const path = thread.workspace.path
      await this.validateRemote(config, path)
      if (await this.git(path, 'status', '--porcelain')) {
        await this.git(path, 'add', '--all')
        let staged = false
        try { await this.git(path, 'diff', '--cached', '--quiet') } catch (error) { if (error.code !== 1) throw error; staged = true }
        if (staged) await this.git(path, '-c', 'user.name=Mira', '-c', 'user.email=mira@localhost', 'commit', '-m', `Mira: ${thread.title.replace(/[\r\n]/g, ' ')}`)
      }
      const sha = await this.git(path, 'rev-parse', 'HEAD')
      this.record(project, thread, 'mr.publish.started', { sha })
      if (thread.state !== 'review_ready' || thread.resolved) throw new Error('线程状态已变化，停止发布')
      await this.git(path, 'push', config.remote, `HEAD:refs/heads/${thread.workspace.branch}`)
      if (thread.state !== 'review_ready' || thread.resolved) throw new Error('线程已撤回交付，停止创建 MR')
      const matches = await this.request(config, `/merge_requests?state=all&source_branch=${encodeURIComponent(thread.workspace.branch)}&target_branch=${encodeURIComponent(config.targetBranch)}`)
      let mr = matches.filter(m => m.source_branch === thread.workspace.branch && m.target_branch === config.targetBranch).sort((a, b) => b.iid - a.iid)[0]
      const description = `${thread.brief}\n\n${thread.summary}\n\n项目：${project.name}\n线程：${thread.id}\n提交：${sha}`
      if (mr?.state === 'merged') throw new Error('此线程的 MR 已合并，后续工作请新开线程')
      if (mr) mr = await this.request(config, `/merge_requests/${mr.iid}`, 'PUT', { title: thread.title, description, ...(mr.state === 'closed' ? { state_event: 'reopen' } : {}) })
      else mr = await this.request(config, '/merge_requests', 'POST', { source_branch: thread.workspace.branch, target_branch: config.targetBranch, title: thread.title, description, remove_source_branch: false })
      const url = new URL(mr.web_url)
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== new URL(config.url).origin) throw new Error('GitLab 返回的 MR 链接与配置的服务地址不符')
      if (!Number.isInteger(mr.iid)) throw new Error('GitLab 未返回有效 MR 编号')
      for (const wait of this.publishReadbackDelays) {
        if (mr.sha === sha) break
        await delay(wait, undefined, { signal: this.abort.signal })
        mr = await this.request(config, `/merge_requests/${mr.iid}`)
      }
      if (mr.sha !== sha || mr.source_branch !== thread.workspace.branch || mr.target_branch !== config.targetBranch) throw new Error('GitLab 尚未反映本次交付的提交或分支，请稍后重试发布')
      this.record(project, thread, 'mr.published', { iid: mr.iid, url: url.href, sha, branch: thread.workspace.branch, targetBranch: config.targetBranch })
      return thread.gitlab
    } catch (error) {
      const message = this.clean(error, config)
      this.record(project, thread, 'mr.publish.failed', { error: message })
      throw new Error(message)
    }
  }

  async accept(projectId, threadId, expectedSha) {
    return this.serial(projectId, threadId, () => this.acceptNow(projectId, threadId, expectedSha))
  }

  async acceptMessage(projectId, threadId, messageId) {
    return this.serial(projectId, threadId, () => {
      const { project, thread } = this.context(projectId, threadId)
      if (!this.actions.acceptanceEvidence(project, thread, messageId)) throw new Error('没有用户针对本次交付的明确验收原话')
      return this.acceptNow(projectId, threadId, thread.gitlab?.sha, { messageId, resolved: false })
    })
  }

  async acceptNow(projectId, threadId, expectedSha, actor = {}) {
    const { project, thread, config } = this.context(projectId, threadId)
    if (thread.state === 'done' && thread.gitlab?.status === 'merged') return { ok: true, merged: true }
    if (thread.state !== 'review_ready' || thread.resolved) throw new Error('线程当前不是待验收状态')
    const review = thread.gitlab
    if (!review?.iid || !['ready', 'merge_error', 'merging'].includes(review.status)) throw new Error('MR 尚未就绪，先完成发布再验收')
    if (!expectedSha || review.sha !== expectedSha) throw new Error('验收的提交版本已变化，请重新查看当前 MR')
    await this.validateCheckout(thread)
    if (await this.git(thread.workspace.path, 'rev-parse', 'HEAD') !== expectedSha || await this.git(thread.workspace.path, 'status', '--porcelain')) throw new Error('工作目录有未验收的改动，请重新交付后再验收')
    const resolved = review.approvedSha === expectedSha ? review.approvalResolved ?? true : actor.resolved ?? true
    if (review.approvedSha !== expectedSha) this.record(project, thread, 'mr.accept.requested', { sha: expectedSha, iid: review.iid, resolved, by: { kind: 'human', id: 'owner' }, ...(actor.messageId ? { messageId: actor.messageId } : {}) })
    try {
      let mr = await this.request(config, `/merge_requests/${review.iid}`)
      if (mr.sha !== expectedSha || mr.source_branch !== thread.workspace.branch || mr.target_branch !== config.targetBranch) throw new Error('GitLab MR 的提交或分支已变化，停止合并')
      if (mr.state !== 'merged') {
        if (mr.state !== 'opened') throw new Error('GitLab MR 已关闭，不能合并')
        if (thread.state !== 'review_ready' || thread.resolved || await this.git(thread.workspace.path, 'rev-parse', 'HEAD') !== expectedSha || await this.git(thread.workspace.path, 'status', '--porcelain')) throw new Error('验收期间线程或代码发生变化，停止合并')
        mr = await this.request(config, `/merge_requests/${review.iid}/merge`, 'PUT', { sha: expectedSha, should_remove_source_branch: false })
      }
      if (mr.state !== 'merged') throw new Error('GitLab 尚未确认已合并，线程保持待验收')
      this.record(project, thread, 'mr.merged', { sha: expectedSha, iid: review.iid, url: review.url })
      if (thread.state === 'review_ready') this.actions.ownerUpdateThread({ projectId, threadId, state: 'done', resolved })
      return { ok: true, merged: true }
    } catch (error) {
      const message = this.clean(error, config)
      this.record(project, thread, 'mr.merge.failed', { error: message })
      throw new Error(message)
    }
  }

  async recover() {
    const tasks = []
    for (const project of this.store.projects.values()) {
      if (!project.gitlab) continue
      for (const thread of project.threads.values()) {
        if (thread.resolved && thread.state !== 'done' && thread.gitlab && !['closed', 'cancelled', 'merged'].includes(thread.gitlab.status)) {
          tasks.push(this.close(project.id, thread.id)); continue
        }
        if (thread.state !== 'review_ready' || thread.resolved) continue
        const state = thread.gitlab
        if (state?.approvedSha && state.approvedSha === state.sha) tasks.push(this.accept(project.id, thread.id, state.approvedSha))
        else if (!state || ['publishing', 'publish_error'].includes(state.status)) tasks.push(this.publish(project.id, thread.id))
      }
    }
    return Promise.allSettled(tasks)
  }

  async close(projectId, threadId) {
    return this.serial(projectId, threadId, async () => {
      const project = this.store.get(projectId), thread = project.threads.get(threadId), config = project.gitlab
      if (!thread || !config || !thread.resolved || thread.state === 'done' || thread.gitlab?.status === 'merged') return
      if (!thread.gitlab?.iid) { if (thread.gitlab) this.record(project, thread, 'mr.closed', { notCreated: true }); return }
      const iid = thread.gitlab.iid
      this.record(project, thread, 'mr.close.requested', { iid })
      try {
        let mr = await this.request(config, `/merge_requests/${iid}`)
        if (mr.state === 'merged') { this.record(project, thread, 'mr.merged', { iid, sha: mr.sha }); return }
        if (mr.state === 'opened') mr = await this.request(config, `/merge_requests/${iid}`, 'PUT', { state_event: 'close' })
        if (mr.state !== 'closed') throw new Error('GitLab 尚未确认 MR 已关闭')
        this.record(project, thread, 'mr.closed', { iid })
      } catch (error) {
        const message = this.clean(error, config)
        this.record(project, thread, 'mr.close.failed', { error: message })
        throw new Error(message)
      }
    })
  }

  start() {
    const off = this.store.onChange(event => {
      if (event?.type !== 'thread.updated') return
      const project = this.store.get(event.projectId)
      if (!project.gitlab) return
      const thread = project.threads.get(event.threadId)
      const task = event.patch?.resolved === true && thread.state !== 'done' ? this.close(project.id, thread.id)
        : event.patch?.state === 'review_ready' || (event.patch?.resolved === false && thread.state === 'review_ready') ? this.publish(project.id, thread.id) : null
      task?.catch(error => this.logger.warn('mira-projects: GitLab workflow', error.message))
    })
    this.recover().catch(error => this.logger.warn('mira-projects: GitLab recovery', error.message))
    return () => { this.stopped = true; off(); this.abort.abort() }
  }
}
