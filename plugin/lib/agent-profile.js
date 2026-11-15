// One assistant's profile for the 助理 page: who it is, what wakes it, what it reads every turn, what it runs on.
// Code only gathers what the system already knows; nothing here is written by a model. The wake lines are built from the
// same constants the wake policies use, so the page cannot drift from the code.

import { COORDINATOR, MIRA, EXECUTOR_ID, workerKey } from './store.js'
import { HUB_ID, MORNING_HOUR, EVENING_HOUR } from './hub.js'
import { URGENT_MS, BUSY_MS, QUIET_MS, BUSY_COUNT } from './mira.js'
import { SLEEP_START_HOUR, SLEEP_END_HOUR, DREAM_IDLE_MINUTES } from './dream.js'

const span = ms => ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`

/** What wakes one assistant, in the owner's words: a short name and one line of detail per trigger. */
export function wakesFor(projectId, member) {
  const w = (name, detail) => ({ name, detail })
  if (!projectId) return [
    w('对话', '你在个人助理对话里说话，包括从随手问发来的话'),
    w('早晚回顾', `每天早上 ${MORNING_HOUR} 点后写今天的重心，晚上 ${EVENING_HOUR} 点后写一天的回顾`),
    w('项目等你', '待拍板、待验收、执行失败'),
    w('飞书提醒', '主动提醒开着时，有人单聊或 @ 你半小时没回'),
    w('手动整理', '你点「现在整理」'),
    w('夜里', `${SLEEP_START_HOUR} 点到 ${SLEEP_END_HOUR} 点，电脑闲置 ${DREAM_IDLE_MINUTES} 分钟后单独想一轮、写日记，不进这个对话`),
  ]
  if (member.id === COORDINATOR) return [w('对话', '你在项目对话里说话'), w('任务动静', '任务交付、提问、失败，或执行者给它带话'), w('自动任务', '到点')]
  if (member.id === MIRA) return [
    w('急事', `${span(URGENT_MS)}内醒：等你拍板、你叫它、交付、失败`),
    w('新动静', `攒够 ${BUSY_COUNT} 条，${span(BUSY_MS)}后醒`),
    w('项目安静', `安静 ${span(QUIET_MS)}后整理一次`),
  ]
  return [w('派任务', '项目助理开任务交给它'), w('对话', '你在任务对话里说话'), w('带话', '项目助理给它带话'), w('交还', '你接手后把任务交还给它')]
}

const ROLE_LABEL = { coordinator: '项目助理', memory: '记忆助理', worker: '执行者' }
// The hub's own member record still carries the memory assistant's persona from when both were Mira; this is the personal one.
export const PERSONAL_PERSONA = '你的个人助理：看着你所有的项目和每天的动静，记得你说过的话，有事提醒你；你也可以直接交代它去办。'

/**
 * The profile of one assistant. `projectId` empty means the personal assistant. An executor has no prompt of its own
 * until it holds a task, so its instructions are shown for the task it touched last.
 */
export function agentProfile({ store, driver, hub }, { projectId, member: ref }) {
  const personal = !projectId
  const project = personal ? hub?.store.get(HUB_ID) : store.get(projectId)
  if (!project || (!personal && project.hub)) throw new Error('没有这个项目')
  const member = personal ? project.members.find(m => m.id === MIRA) : project.members.find(m => m.id === ref)
  if (!member || member.kind !== 'assistant') throw new Error('没有这个助理')
  const run = personal ? hub.driver : driver
  const worker = !personal && member.id !== COORDINATOR && member.id !== MIRA
  const example = worker ? [...project.threads.values()].filter(t => t.assignee === member.id).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? null : null
  const key = worker ? (example ? workerKey(example.id) : null) : member.id
  const read = fn => { try { return key === null ? '' : String(fn() ?? '') } catch { return '' } }
  return {
    projectId: personal ? null : project.id, projectName: personal ? null : project.name,
    member: member.id, name: personal ? '个人助理' : member.name,
    role: personal ? 'personal' : member.role, roleLabel: personal ? '个人助理' : ROLE_LABEL[member.role] ?? '执行者',
    persona: personal ? PERSONAL_PERSONA : member.persona ?? '', executor: member.id === EXECUTOR_ID || worker,
    wakes: wakesFor(personal ? null : project.id, member),
    instructions: read(() => run.text.rolePrompt(project, key)),
    live: read(() => run.text.liveContext?.(project, key)),
    example: example ? { id: example.id, title: example.title } : null,
    status: key === null ? 'idle' : run.status(project.id, key),
    lastTurn: key === null ? null : project.turns.get(key) ?? null,
    configured: member.modelSelection ?? null,
    running: (() => { try { return run.memberModel?.(project, member.id) ?? null } catch { return null } })(),
    harness: example ? run.external?.provider(project, key) ?? 'dsh' : 'dsh',
    strategy: project.modelStrategy ?? '',
  }
}
