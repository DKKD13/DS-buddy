import { randomBytes } from 'node:crypto'

const FIELDS = new Set(['id', 'name', 'role', 'persona', 'modelSelection', 'runtimeSelection'])
const RESERVED = new Set(['owner', '我', '用户', 'user'])

export function normalizeMembers(input, previous) {
  // v4: executors are added per task, so a project may have none yet.
  if (!Array.isArray(input) || input.length < 2 || input.length > 12) throw new Error('成员需要包含项目助理和记忆助理，最多 12 位助理')
  const ids = new Set(), names = new Set(), old = new Map(previous.map(m => [m.id, m]))
  const members = input.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('成员格式无效')
    for (const key of Object.keys(raw)) if (!FIELDS.has(key)) throw new Error(`成员不接受 ${key} 字段`)
    const existing = raw.id ? old.get(raw.id) : null
    if (raw.id && (!existing || existing.kind !== 'assistant' || existing.active === false)) throw new Error('不存在或已移除的成员不能覆盖；请添加新成员')
    const id = existing?.id ?? 'a_' + randomBytes(5).toString('hex')
    if (ids.has(id)) throw new Error('成员 id 不能重复')
    const role = existing?.role ?? 'worker'
    if (raw.role !== undefined && raw.role !== role) throw new Error('成员职责不能更换；新增成员只能是执行者')
    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 40 || /[@\r\n<>]/.test(raw.name)) throw new Error('成员名需要 1–40 字，不含 @、换行或尖括号')
    const typed = raw.name.trim(), name = id === 'mira' && typed === 'Mira' ? existing.name : typed, normalized = name.toLowerCase()
    if (RESERVED.has(normalized) || names.has(normalized)) throw new Error('成员名不能重复或使用用户名称')
    if (id === 'mira' && name !== existing.name) throw new Error('记忆助理的名称不能改')
    if (typeof raw.persona !== 'string' || raw.persona.length > 4000) throw new Error('成员职责说明最多 4000 字')
    let modelSelection = null
    if (raw.modelSelection !== null && raw.modelSelection !== undefined) {
      const value = raw.modelSelection
      if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['provider', 'model'].includes(k))) throw new Error('模型配置只接受 provider 和 model')
      for (const key of ['provider', 'model']) if (typeof value[key] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./:@+-]{0,159}$/.test(value[key])) throw new Error('模型配置需要有效的 provider 和 model')
      modelSelection = { provider: value.provider, model: value.model }
    }
    let runtimeSelection = null
    if (raw.runtimeSelection !== null && raw.runtimeSelection !== undefined) {
      const value = raw.runtimeSelection
      if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['provider', 'deviceId'].includes(k))) throw new Error('运行配置只接受 provider 和 deviceId')
      if (!['dsh', 'claude', 'codex'].includes(value.provider)) throw new Error('运行方式只能是 DSH、Claude Code 或 Codex')
      if ((value.deviceId ?? 'local') !== 'local') throw new Error('外部 runtime 目前只能放在 DSH 所在机器')
      if (role !== 'worker' && value.provider !== 'dsh') throw new Error('只有执行者可以切换外部 runtime')
      if (value.provider !== 'dsh') runtimeSelection = { provider: value.provider, deviceId: 'local' }
    }
    ids.add(id);names.add(normalized)
    return { ...existing, id, kind: 'assistant', role, name, persona: raw.persona.trim(), modelSelection, runtimeSelection, active: true }
  })
  if (!members.some(m => m.id === 'coordinator' && m.role === 'coordinator') || !members.some(m => m.id === 'mira' && m.role === 'memory')) throw new Error('必须保留项目助理和记忆助理')
  if (members.some(m => members.some(other => other.id !== m.id && other.id.toLowerCase() === m.name.toLowerCase()))) throw new Error('成员名不能与其他成员的 id 冲突')
  // Keep historical names and identities; removed workers cannot be addressed or reassigned.
  return [previous.find(m => m.id === 'owner'), ...members, ...previous.filter(m => m.kind === 'assistant' && !ids.has(m.id)).map(m => ({ ...m, active: false }))].filter(Boolean)
}

/** An active assistant of a project, by id or by name (either case). */
export function findAssistant(project, ref) {
  const wanted = String(ref ?? '').trim().toLowerCase()
  const active = project.members.filter(m => m.kind === 'assistant' && m.active !== false)
  const found = active.find(m => m.id.toLowerCase() === wanted || m.name.toLowerCase() === wanted)
  if (!found) throw new Error(`没有这个成员：${ref ?? ''}；可选：${active.map(m => m.name).join('、')}`)
  return found
}

/**
 * A model DSH offers, from its model catalog: `default` (or nothing) follows DSH's default; otherwise a model id,
 * with the provider when more than one provider offers that id. Anything else is refused, never guessed.
 */
export function pickModel(catalog, { provider, model }) {
  const wanted = typeof model === 'string' ? model.trim() : ''
  if (wanted === '' || wanted === 'default') return null
  const groups = (catalog?.groups ?? []).filter(g => (!provider || g.id === provider) && g.models.some(m => m.id === wanted))
  if (groups.length === 0) throw new Error(`模型不可用：${provider ? provider + '/' : ''}${wanted}；只能从 DSH 已接入的模型里选`)
  if (groups.length > 1) throw new Error(`${wanted} 在多个服务商下都有，请写明 provider：${groups.map(g => g.id).join('、')}`)
  return { provider: groups[0].id, model: wanted }
}

/** A model's display name from the catalog, falling back to its ids. */
export function modelLabel(catalog, selection) {
  if (!selection) return 'DSH 默认模型'
  const group = (catalog?.groups ?? []).find(g => g.id === selection.provider)
  const model = group?.models.find(m => m.id === selection.model)
  return model ? (model.name || model.id) : `${selection.provider}/${selection.model}`
}
