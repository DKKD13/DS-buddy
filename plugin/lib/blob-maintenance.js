/** Reference-aware retention and quota checks for immutable blob backends. */
import { FileError } from './files.js'

const fail = (message, code = 'STORAGE_MAINTENANCE') => { throw new FileError(message, code) }

export function liveBlobKeysFromStore(store, blobs) {
  const live = new Set()
  // A deleted project can be restored, so its files stay live while it sits in the trash.
  for (const project of [...store.projects.values(), ...store.trash.values()]) {
    for (const event of project.events) {
      if (event.type === 'file.published') live.add(blobs.location(project.id, event.sha256))
      if (event.type === 'repository.imported') live.add(blobs.location(project.id, event.repository.sha256))
    }
  }
  return live
}

export function liveBlobKeysFromRows(rows, blobs) {
  const live = new Set()
  for (const row of rows) {
    const event = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
    const projectId = row.project_id ?? event.projectId
    if (event.type === 'file.published') live.add(blobs.location(projectId, event.sha256))
    if (event.type === 'repository.imported') live.add(blobs.location(projectId, event.repository.sha256))
  }
  return live
}

export class BlobMaintenance {
  constructor(blobs, { liveKeys, quotaBytes, retentionMs = 24 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
    if (typeof liveKeys !== 'function') fail('垃圾回收需要实时事件引用清单')
    if (blobs.requiresSharedLock && !blobs.sharedLock) fail('S3配额或GC需要共享锁', 'STORAGE_LOCK_REQUIRED')
    if (quotaBytes !== undefined && (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1) || !Number.isSafeInteger(retentionMs) || retentionMs < 1) fail('存储配额或保留期无效')
    this.blobs = blobs;this.liveKeys = liveKeys;this.quotaBytes = quotaBytes;this.retentionMs = retentionMs;this.now = now
    blobs.maintenance = this
  }

  async collectUnlocked() {
    const live = new Set(await this.liveKeys())
    if (!(live instanceof Set)) fail('事件引用清单格式无效')
    const objects = await this.blobs.listObjects(), cutoff = this.now() - this.retentionMs
    let deletedObjects = 0, deletedBytes = 0
    for (const object of objects) {
      if (!Number.isSafeInteger(object.size) || object.size < 0 || !Number.isFinite(object.mtimeMs)) fail('存储对象元数据无效，停止清理')
      if (live.has(object.key) || object.mtimeMs >= cutoff) continue
      await this.blobs.deleteObject(object)
      deletedObjects++;deletedBytes += object.size
    }
    // All writers and this collection share the same lock. Compute the result
    // from this exact snapshot instead of issuing another full S3 listing.
    const usage = objects.reduce((sum, object) => sum + object.size, 0) - deletedBytes
    return { scannedObjects: objects.length, deletedObjects, deletedBytes, usage }
  }

  async collect() { return this.blobs.withLock(() => this.collectUnlocked()) }

  async assertCapacityUnlocked(incomingBytes = 0) {
    if (this.quotaBytes === undefined) return
    await this.collectUnlocked()
    const usage = await this.blobs.usage()
    if (usage + incomingBytes > this.quotaBytes) fail(`项目文件存储配额已满：${usage + incomingBytes}/${this.quotaBytes} 字节`, 'FILE_QUOTA_EXCEEDED')
  }
}
