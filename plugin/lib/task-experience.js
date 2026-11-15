/** Read models for the product. Business completion never follows a runtime's idle signal. */
import { deviceNotice, deviceRequestState } from './device-state.js'
export function sessionHistory(project, key) {
  const sessions = new Map()
  for (const event of project.events) {
    if (event.type !== 'session.bound' || event.key !== key) continue
    sessions.set(event.sessionId, {
      id: event.sessionId, generation: event.generation ?? 1,
      node: event.node ?? 'local', boundAt: event.at, continuity: event.continuity === true,
      runtime: event.runtime ?? 'dsh',
    })
  }
  return [...sessions.values()]
}

export function taskExperience(thread, runtime, decisions) {
  const children = runtime.children ?? []
  const devices = (runtime.devices ?? []).map(deviceRequestState)
  const notice = deviceNotice(devices)
  const unconfirmed = devices.some(d => d.phase === 'unconfirmed')
  const waiting = devices.some(d => d.pending && ['queued', 'waiting_device', 'starting'].includes(d.phase))
  const activeChildren = children.filter(c => c.running || c.status === 'stopping').length
  const stopping = runtime.status === 'stopping' || children.some(c => c.status === 'stopping') || devices.some(d => d.phase === 'stopping')
  const active = (runtime.status === 'running' && !waiting && !unconfirmed) || stopping || activeChildren > 0 || devices.some(d => d.phase === 'running')
  const phase = stopping ? 'stopping' : active ? 'running' : unconfirmed ? 'unconfirmed'
    : devices.some(d => d.phase === 'waiting_device') ? 'waiting_device'
    : devices.some(d => d.phase === 'starting') ? 'starting'
    : runtime.status === 'queued' || devices.some(d => d.phase === 'queued') ? 'queued' : 'idle'
  const execution = {
    active, phase, activeChildren, held: unconfirmed || devices.some(d => d.phase === 'stopping'), devices,
    label: stopping ? '正在停止' : activeChildren ? `${activeChildren} 个子执行者运行中`
      : notice?.label ?? (runtime.status === 'running' ? '正在执行' : phase === 'queued' ? '排队中' : '当前无执行'),
  }
  const pending = (thread.decisionIds ?? []).map(id => decisions.get(id)).find(d => d && d.chosen === null && !d.withdrawn)
  const reason = thread.state === 'done' ? '已验收' : thread.resolved ? '已归档'
    : pending ? '等你拍板' : notice ? notice.label : thread.state === 'blocked' ? '等待补充'
    : thread.state === 'review_ready' ? '待验收'
    : thread.state === 'failed' || runtime.lastTurn?.failed ? '执行失败'
    : phase === 'queued' ? '排队中' : active ? execution.label : '等待继续'
  const group = thread.state === 'done' ? 'resolved' : thread.resolved ? 'archived' : active ? 'executing' : 'unresolved'
  const next = thread.state === 'done' ? '已验收，后续工作可另开关联任务'
    : thread.resolved ? '已归档，保留任务记录'
    : pending?.question ?? notice?.next ?? (thread.state === 'review_ready' ? '查看交付并验收'
      : thread.checklist?.find(item => !item.done)?.text ?? (phase === 'queued' ? '等待执行资源'
        : active ? '等待执行结果' : reason === '执行失败' ? '查看执行记录，确认恢复方式' : '在对话里补充要求或继续这件事'))
  return {
    group, reason, execution,
    summary: { goal: thread.brief || thread.title, constraints: thread.note || null, progress: thread.summary || null, next },
  }
}
