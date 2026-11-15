/** Bounded filesystem/command helper, always spawned as the device user. */
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { spawn } from 'node:child_process'

const MAX = 128 * 1024, C = fs.constants, hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => { const error = new Error(code);error.code = code;throw error }
const input = JSON.parse(await new Promise(resolve => { let value = '';process.stdin.setEncoding('utf8');process.stdin.on('data', b => value += b);process.stdin.on('end', () => resolve(value)) }))
function pathParts(value, directory = false) {
  if (directory && value === '.') return []
  if (typeof value !== 'string' || !value || value.length > 512 || !value.isWellFormed() || /[\\\u0000-\u001f]/.test(value) || value.startsWith('/') || value.endsWith('/') || posix.normalize(value) !== value || value.split('/').some(v => v === '.' || v === '..')) fail('INVALID_PATH')
  return value.split('/')
}
function directory(parts) {
  const handles = [fs.openSync('/device', C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW)]
  try { for (const part of parts) handles.push(fs.openSync(`/proc/self/fd/${handles.at(-1)}/${part}`, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW));return handles }
  catch (error) { handles.reverse().forEach(fd => fs.closeSync(fd));throw error }
}
function bytes(path) {
  const fd = fs.openSync(path, C.O_RDONLY | C.O_NONBLOCK | C.O_NOFOLLOW)
  try {
    const info = fs.fstatSync(fd, { bigint: true })
    if (!info.isFile() || info.size > BigInt(MAX) || info.nlink !== 1n) fail('INVALID_FILE')
    const data = Buffer.alloc(MAX + 1);let size = 0
    while (size <= MAX) { const n = fs.readSync(fd, data, size, MAX + 1 - size, null);if (!n) break;size += n }
    if (size > MAX) fail('FILE_TOO_LARGE')
    return { data: data.subarray(0, size), info }
  } finally { fs.closeSync(fd) }
}
function text(data) { try { return new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { fail('BINARY_FILE') } }
function current() { if (Date.now() >= input.grant.expiresAt) fail('GRANT_EXPIRED') }
async function execute() {
  current()
  const { op, args, grant } = input
  if (op === 'exec') {
    if (grant.kind !== 'exec' || typeof args.command !== 'string' || !args.command.trim() || args.command.length > 16384 || !args.command.isWellFormed() || args.command.includes('\0')) fail('FORBIDDEN')
    const handles = directory(pathParts(args.cwd ?? '.', true))
    try {
      process.chdir('/proc/self/fd/' + handles.at(-1));current()
      return await new Promise((resolve, reject) => {
        const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', args.command], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/tmp', TMPDIR: '/tmp' } })
        const stdout = [], stderr = [];let size = 0
        const capture = chunks => value => { size += value.length;if (size > 2 * MAX) { reject(Object.assign(new Error('OUTPUT_LIMIT'), { code: 'OUTPUT_LIMIT' }));return }chunks.push(value) }
        child.stdout.on('data', capture(stdout));child.stderr.on('data', capture(stderr));child.on('error', reject)
        child.on('close', (code, signal) => resolve({ exitCode: code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }))
      })
    } finally { handles.reverse().forEach(fd => fs.closeSync(fd)) }
  }
  if (grant.kind !== 'folder' || !['fs.list', 'fs.read', 'fs.write'].includes(op) || (op === 'fs.write' && grant.access !== 'write')) fail('FORBIDDEN')
  const parts = pathParts(args.path ?? '.', op === 'fs.list'), name = op === 'fs.list' ? null : parts.pop(), handles = directory(parts)
  const parent = '/proc/self/fd/' + handles.at(-1)
  try {
    if (op === 'fs.list') {
      const names = fs.readdirSync(parent, { encoding: 'buffer' });if (names.length > 200) fail('DIRECTORY_TOO_LARGE')
      return { entries: names.map(raw => {
        const name = text(raw), info = fs.lstatSync(parent + '/' + name)
        return { name, kind: info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', bytes: info.isFile() ? info.size : null }
      }).sort((a, b) => a.name.localeCompare(b.name)) }
    }
    const target = parent + '/' + name
    if (op === 'fs.read') {
      const read = bytes(target), value = text(read.data), offset = args.offset ?? 0, limit = args.limit ?? MAX
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX) fail('INVALID_INPUT')
      return { text: value.slice(offset, offset + limit), sha256: hash(read.data), bytes: read.data.length, totalChars: value.length, nextOffset: offset + limit < value.length ? offset + limit : null }
    }
    if (typeof args.text !== 'string' || !args.text.isWellFormed() || Buffer.byteLength(args.text) > MAX || !(args.expectedSha256 === null || /^[a-f0-9]{64}$/.test(args.expectedSha256 ?? ''))) fail('INVALID_INPUT')
    let old
    try { old = bytes(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if ((old ? hash(old.data) : null) !== args.expectedSha256) fail('FILE_CONFLICT')
    const temp = parent + '/.mira-' + randomUUID(), data = Buffer.from(args.text);let fd
    try {
      fd = fs.openSync(temp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);fs.writeFileSync(fd, data);fs.fsyncSync(fd);fs.closeSync(fd);fd = undefined
      current()
      let latest
      try { latest = bytes(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if ((latest ? hash(latest.data) : null) !== args.expectedSha256 || (old && (latest.info.dev !== old.info.dev || latest.info.ino !== old.info.ino))) fail('FILE_CONFLICT')
      if (old) fs.renameSync(temp, target)
      else { try { fs.linkSync(temp, target) } catch (error) { if (error.code === 'EEXIST') fail('FILE_CONFLICT');throw error }fs.unlinkSync(temp) }
      fs.fsyncSync(handles.at(-1))
      return { sha256: hash(data), bytes: data.length }
    } finally { if (fd !== undefined) fs.closeSync(fd);try { fs.unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw error } }
  } finally { handles.reverse().forEach(fd => fs.closeSync(fd)) }
}
try { console.log(JSON.stringify({ ok: true, value: await execute(), uid: process.getuid() })) }
catch (error) {
  const known = ['INVALID_PATH','INVALID_FILE','FILE_TOO_LARGE','BINARY_FILE','INVALID_INPUT','FORBIDDEN','GRANT_EXPIRED','FILE_CONFLICT','DIRECTORY_TOO_LARGE','OUTPUT_LIMIT','ENOENT','ELOOP','ENOTDIR','EACCES','EPERM'].includes(error.code) ? error.code : 'DEVICE_IO'
  console.log(JSON.stringify({ ok: false, code: known }))
}
// The root guardian exits when this helper exits; PID namespace shutdown also
// stops background/setsid descendants. No local shell can stop that guardian.
process.exit(0)
