/** Public device progress contains identities and verified phases, never tool inputs or receipts. */
export function deviceRequestState(value) {
  const phases = ['queued', 'waiting_device', 'starting', 'running', 'stopping', 'unconfirmed', 'stopped']
  const phase = phases.includes(value.phase) && (value.phase !== 'stopped' || value.stopped === true) ? value.phase : 'unconfirmed'
  const outcome = ['ok', 'error', 'unknown'].includes(value.outcome) ? value.outcome : phase === 'stopped' ? 'unknown' : undefined
  return { requestId: value.requestId, deviceId: value.deviceId, phase,
    pending: value.pending === true, stopped: phase === 'stopped' && value.stopped === true,
    ...(typeof value.online === 'boolean' ? { online: value.online } : {}),
    ...(outcome ? { outcome } : {}) }
}

export function deviceNotice(devices) {
  for (const [phase, label, next] of [
    ['stopping', '正在停止设备操作', '等待设备确认停止，不要重跑原操作'],
    ['unconfirmed', '等待设备停止确认', '先取得设备停止回执，不要重跑原操作'],
    ['waiting_device', '等待设备', '等待已授权设备连接；不会唤醒关机或休眠的电脑'],
    ['queued', '设备排队中', '等待设备接收当前请求'],
    ['starting', '准备设备执行', '等待设备实际开始执行'],
  ]) if (devices.some(d => d.phase === phase)) return { label, next }
  if (devices.some(d => d.stopped && d.outcome === 'unknown')) return {
    label: '设备结果待确认', next: '设备操作已停止，结果仍待确认；查看实际文件或执行记录后继续',
  }
  if (devices.some(d => d.phase === 'running')) return { label: '设备执行中', next: '等待设备执行结果和停止回执' }
  return null
}
