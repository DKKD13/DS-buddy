/** Explicit filesystem or S3 blob backend selection and shared quota locks. */
import { lstat, readFile } from 'node:fs/promises'
import { FileBlobs } from './files.js'
import { S3FileBlobs } from './s3-files.js'

export function postgresBlobLock(pool, name) {
  return async run => {
    const client = await pool.connect()
    let locked = false
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', ['mira-files/' + name]);locked = true
      try { return await run() }
      finally { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', ['mira-files/' + name]) }
    } finally { client.release() }
  }
}

async function privateConfig(path) {
  if (typeof path !== 'string' || !path) throw new Error('S3需要显式私有配置 MIRA_S3_CONFIG')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('S3配置必须是当前用户持有的600私有文件')
  return JSON.parse(await readFile(path, 'utf8'))
}

export async function createFileBlobs({ backend = 'fs', root, quotaBytes, lock, configPath, s3 = {} }) {
  if (backend === 'fs') {
    const blobs = new FileBlobs(root, { quotaBytes, lock });await blobs.initialize();return blobs
  }
  if (backend !== 's3') throw new Error('文件后端只支持 fs 或 s3')
  const config = { ...await privateConfig(configPath), ...s3 }
  const blobs = new S3FileBlobs(root, { ...config, quotaBytes, sharedLock: lock });await blobs.initialize();return blobs
}
