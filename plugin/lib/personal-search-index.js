/** Rebuildable, private search projection. Journals remain the citation authority. */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { constants, mkdirSync, lstatSync, realpathSync, readFileSync, readSync, openSync, closeSync, writeFileSync, fsyncSync, chmodSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const APPLICATION_ID = 0x4d495253, VERSION = 1
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const unsafe = value => !value.isWellFormed() || value.includes('\0')
export const searchText = source => `${source.projectName || ''}\n${source.threadTitle || ''}\n${source.deviceName || ''}\n${source.title}\n${source.text}`.toLowerCase()
const fields = ['ref', 'log_id', 'seq', 'project_id', 'happened', 'personal', 'unsafe', 'slot', 'searchable', 'source_hash']
const serialize = row => JSON.stringify(fields.map(k => row[k]))
const absent = file => { try { return lstatSync(file) } catch (e) { if (e.code === 'ENOENT') return null;throw e } }
const regular = file => { const s = absent(file);if (s && (!s.isFile() || s.isSymbolicLink())) throw Error('索引文件无效');return s }
const corrupt = e => [11, 26].includes((e.errcode ?? -1) & 255)

export class PersonalSearchIndex {
  constructor(personal) {
    this.personal = personal
    this.directory = join(personal.hubStore.root, '_personal-index')
    this.file = join(this.directory, 'search.sqlite')
    this.catalog = new Map()
    this.metrics = { writes: 0, lastProcessedEvents: 0, lastCandidates: 0 }
    this.closed = false
  }

  stats() { return { ...this.metrics } }
  close() { this.db?.close();this.db = null;this.catalog.clear();this.closed = true }

  prepareDirectory() {
    mkdirSync(this.personal.hubStore.root, { recursive: true })
    if (!absent(this.directory)) mkdirSync(this.directory, { mode: 0o700 })
    if (!lstatSync(this.directory).isDirectory() || lstatSync(this.directory).isSymbolicLink()) throw Error('索引目录无效')
    chmodSync(this.directory, 0o700)
    const ownerFile = join(this.directory, 'owner.json')
    const expected = { component: 'mira-personal-search', version: VERSION,
      hubRoot: realpathSync(this.personal.hubStore.root), projectsRoot: realpathSync(this.personal.projects.root) }
    if (regular(ownerFile)) {
      if (JSON.stringify(JSON.parse(readFileSync(ownerFile, 'utf8'))) !== JSON.stringify(expected)) throw Error('索引缓存不属于当前资料源')
      chmodSync(ownerFile, 0o600)
    } else {
      // An existing unclaimed file is never adopted or deleted as a cache.
      if (['', '-journal', '-wal', '-shm'].some(suffix => absent(this.file + suffix))) throw Error('索引缓存没有归属记录')
      const fd = openSync(ownerFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { writeFileSync(fd, JSON.stringify(expected));fsyncSync(fd) } finally { closeSync(fd) }
      this.syncDirectory()
    }
    for (const suffix of ['', '-journal', '-wal', '-shm']) regular(this.file + suffix)
  }

  syncDirectory() {
    const fd = openSync(this.directory, constants.O_RDONLY)
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }

  open() {
    if (this.closed) throw Error('检索索引已关闭')
    if (this.db) return
    this.prepareDirectory()
    const connect = () => {
      if (!regular(this.file)) {
        const fd = openSync(this.file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        closeSync(fd);this.syncDirectory()
      }
      // A stale marker must not authorize erasing a different SQLite database
      // copied into this location, even when its schema/pages are damaged.
      const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW)
      let header
      try { const bytes = Buffer.alloc(100);header = bytes.subarray(0, readSync(fd, bytes, 0, 100, 0)) } finally { closeSync(fd) }
      if (header.length >= 72 && header.subarray(0, 16).toString('latin1') === 'SQLite format 3\0' &&
        header.readUInt32BE(68) !== APPLICATION_ID) throw Error('检索缓存位置存在其他数据库')
      chmodSync(this.file, 0o600)
      this.db = new DatabaseSync(this.file)
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL')
      const app = this.db.prepare('PRAGMA application_id').get().application_id
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
      if (app !== APPLICATION_ID && (app !== 0 || tables.length)) throw Error('检索缓存位置存在其他数据库')
      if (app === APPLICATION_ID && (this.db.prepare('PRAGMA user_version').get().user_version !== VERSION ||
        tables.some(t => !['docs', 'checkpoints', 'source_fts', 'source_fts_data', 'source_fts_idx', 'source_fts_content', 'source_fts_docsize', 'source_fts_config'].includes(t)))) throw Error('检索索引版本或归属无效')
      const integrity = this.db.prepare('PRAGMA quick_check').all()
      if (integrity.some(row => row.quick_check !== 'ok')) { const error = Error('索引损坏');error.errcode = 11;throw error }
      this.db.exec(`BEGIN IMMEDIATE;
        PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${VERSION};
        CREATE TABLE IF NOT EXISTS docs(
          ref TEXT PRIMARY KEY, log_id TEXT NOT NULL, seq INTEGER NOT NULL, project_id TEXT,
          happened REAL, personal INTEGER NOT NULL, unsafe INTEGER NOT NULL, slot TEXT,
          searchable TEXT NOT NULL, source_hash TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS docs_log ON docs(log_id);
        CREATE INDEX IF NOT EXISTS docs_scope ON docs(project_id,happened);
        CREATE INDEX IF NOT EXISTS docs_slot ON docs(slot);
        CREATE TABLE IF NOT EXISTS checkpoints(log_id TEXT PRIMARY KEY, count INTEGER, last_seq INTEGER, metadata TEXT, digest TEXT);
        CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(ref UNINDEXED,searchable,tokenize='trigram case_sensitive 1');
        COMMIT;`)
    }
    try { connect() } catch (error) {
      try { this.db?.close() } catch {}
      this.db = null
      if (!corrupt(error)) throw error
      // Only a file in our claimed directory with a valid ownership marker reaches here.
      for (const suffix of ['', '-journal', '-wal', '-shm']) if (regular(this.file + suffix)) unlinkSync(this.file + suffix)
      this.syncDirectory();connect()
    }
    this.statements = {
      insert: this.db.prepare(`INSERT INTO docs(${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`),
      ftsInsert: this.db.prepare('INSERT INTO source_fts(ref,searchable) VALUES (?,?)'),
      remove: this.db.prepare('DELETE FROM docs WHERE ref=?'),
      ftsRemove: this.db.prepare('DELETE FROM source_fts WHERE ref=?'),
      slot: this.db.prepare('SELECT ref FROM docs WHERE slot=?'),
      checkpoint: this.db.prepare('INSERT OR REPLACE INTO checkpoints VALUES (?,?,?,?,?)'),
    }
    this.catalog.clear()
    this.validateFts = true
    this.retentionEpoch = undefined
  }

  metadata(project) {
    return hash({ name: project.name, threads: [...project.threads].map(([id, t]) => [id, t.title]),
      decisions: [...project.decisions].map(([id, d]) => [id, d.threadId, d.question, d.options?.map(o => o.label)]),
      ...(project.hub ? { names: [...this.personal.projects.projects].map(([id, p]) => [id, p.name]),
        observations: Boolean(this.personal.observations), connectors: Boolean(this.personal.connectors) } : {}) })
  }

  record(project, event) {
    const slot = event.type === 'connector.record' ? JSON.stringify([project.id, 'connector', event.connectorId, event.externalId])
      : event.type === 'observation.summary' ? JSON.stringify([project.id, 'summary', event.windowId])
      : event.type === 'pc.activity' ? JSON.stringify([project.id, 'activity', event.windowKey]) : null
    const source = this.personal.materialize(project, event)
    if (!source) return slot ? { slot, row: null, token: [slot, event.seq, 'removed'] } : null
    const text = searchText(source), isUnsafe = unsafe(text)
    const row = { ref: source.ref, log_id: project.id, seq: event.seq, project_id: source.projectId,
      happened: source.happenedAt ?? null, personal: project.hub && event.type === 'message.posted' ? 1 : 0,
      unsafe: isUnsafe ? 1 : 0, slot, searchable: isUnsafe ? '' : text, source_hash: hash(text) }
    return { slot, row, token: fields.map(k => row[k]) }
  }

  scan(project, start = 0, previousDigest = '') {
    const records = [], events = project.events
    let digest = previousDigest
    for (let i = start; i < events.length; i++) {
      const event = events[i], record = this.record(project, event)
      if (!record) continue
      digest = hash([digest, record.token])
      records.push({ ...record, current: this.personal.searchable(project, event) })
    }
    return { records, digest }
  }

  remove(ref) {
    this.statements.remove.run(ref);this.statements.ftsRemove.run(ref);this.metrics.writes++
  }
  put({ slot, row, current }) {
    if (slot) for (const r of this.statements.slot.all(slot)) this.remove(r.ref)
    if (!row || !current) return
    this.statements.insert.run(...fields.map(k => row[k]))
    this.statements.ftsInsert.run(row.ref, row.searchable)
    this.metrics.writes++
  }

  sync() {
    try { this.open();this.synchronize() } catch {
      // A failed/ambiguous commit never advances the in-memory watermarks.
      try { this.db?.exec('ROLLBACK') } catch {}
      this.catalog.clear()
      try { this.db?.close() } catch {}
      this.db = null
      throw Error('检索索引暂不可用，请重试；原始资料未受影响')
    }
  }

  synchronize() {
    const projects = [...this.personal.projects.projects.values(), this.personal.hub]
    const next = new Map(), changes = []
    this.metrics.lastProcessedEvents = 0
    // Changes made by another connection require source validation before reuse.
    this.db.exec('BEGIN IMMEDIATE')
    const dataVersion = this.db.prepare('PRAGMA data_version').get().data_version
    if (this.dataVersion !== undefined && this.dataVersion !== dataVersion) { this.catalog.clear();this.validateFts = true;this.retentionEpoch = undefined }
    this.dataVersion = dataVersion
    for (const project of projects) {
      const prior = this.catalog.get(project.id), metadata = this.metadata(project)
      const unchangedPrefix = prior && prior.events === project.events && prior.count <= project.events.length &&
        (!prior.count || project.events[prior.count - 1] === prior.tail) && prior.metadata === metadata
      if (unchangedPrefix && prior.count === project.events.length) { next.set(project.id, prior);continue }
      const { records, digest } = this.scan(project, unchangedPrefix ? prior.count : 0, unchangedPrefix ? prior.digest : '')
      this.metrics.lastProcessedEvents += project.events.length - (unchangedPrefix ? prior.count : 0)
      let reconcile
      if (!unchangedPrefix) {
        const expected = new Map(), slots = new Map()
        for (const r of records) {
          if (r.slot) { const ref = slots.get(r.slot);if (ref) expected.delete(ref);slots.set(r.slot, r.row?.ref) }
          if (r.row && r.current) expected.set(r.row.ref, r.row)
        }
        const actual = this.db.prepare('SELECT * FROM docs WHERE log_id=? ORDER BY ref').all(project.id)
        const existing = new Map(actual.map(r => [r.ref, r]))
        // Validate the entire source on reopen, while retaining unchanged rows
        // even when a journal has an unindexed tail or one cached row is bad.
        reconcile = {
          remove: actual.filter(r => !expected.has(r.ref) || serialize(r) !== serialize(expected.get(r.ref))).map(r => r.ref),
          put: [...expected.values()].filter(r => !existing.has(r.ref) || serialize(r) !== serialize(existing.get(r.ref))),
        }
      }
      changes.push({ project, records, reconcile, incremental: Boolean(unchangedPrefix), digest, metadata })
      next.set(project.id, { events: project.events, count: project.events.length, tail: project.events.at(-1), metadata, digest })
    }
    for (const { log_id } of this.db.prepare('SELECT DISTINCT log_id FROM docs').all()) {
      if (next.has(log_id)) continue
      for (const { ref } of this.db.prepare('SELECT ref FROM docs WHERE log_id=?').all(log_id)) this.remove(ref)
      this.db.prepare('DELETE FROM checkpoints WHERE log_id=?').run(log_id)
    }
    for (const c of changes) {
      if (c.incremental) for (const r of c.records) this.put(r)
      else {
        for (const ref of c.reconcile.remove) this.remove(ref)
        for (const row of c.reconcile.put) this.put({ row, slot: row.slot, current: true })
      }
      this.statements.checkpoint.run(c.project.id, c.project.events.length, c.project.events.at(-1)?.seq ?? 0, c.metadata, c.digest)
    }
    if (this.validateFts) {
      const docs = this.db.prepare('SELECT ref,searchable FROM docs ORDER BY ref').all()
      const fts = this.db.prepare('SELECT ref,searchable FROM source_fts ORDER BY ref').all()
      let rebuild = JSON.stringify(docs) !== JSON.stringify(fts)
      try { this.db.exec("INSERT INTO source_fts(source_fts) VALUES('integrity-check')") } catch (e) { if (!corrupt(e)) throw e;rebuild = true }
      if (rebuild) {
        // DELETE consults the inverted segments and can itself fail when those
        // segments are damaged. Recreate just this owned virtual table instead.
        this.db.exec("DROP TABLE source_fts; CREATE VIRTUAL TABLE source_fts USING fts5(ref UNINDEXED,searchable,tokenize='trigram case_sensitive 1')")
        this.statements.ftsInsert = this.db.prepare('INSERT INTO source_fts(ref,searchable) VALUES (?,?)')
        this.statements.ftsRemove = this.db.prepare('DELETE FROM source_fts WHERE ref=?')
        for (const row of docs) this.statements.ftsInsert.run(row.ref, row.searchable)
        this.metrics.writes += docs.length
      }
    }
    const retentionEpoch = this.personal.retention?.epoch() ?? 0
    if (this.retentionEpoch !== retentionEpoch && this.db.prepare('SELECT count FROM checkpoints WHERE log_id=?').get('@source-retention')?.count !== retentionEpoch)
      this.statements.checkpoint.run('@source-retention', retentionEpoch, retentionEpoch, 'source-retention', '')
    this.db.exec('COMMIT')
    this.catalog = next;this.validateFts = false;this.retentionEpoch = retentionEpoch
  }

  candidates({ terms, projectId, start, end, includePersonal }) {
    this.sync()
    const filters = [], values = []
    if (projectId) { filters.push('project_id=?');values.push(projectId) }
    if (start !== undefined) { filters.push('(happened IS NULL OR happened>=?)');values.push(start) }
    if (end !== undefined) { filters.push('(happened IS NULL OR happened<?)');values.push(end) }
    if (!includePersonal) filters.push('personal=0')
    // Unsafe queries (including half a surrogate pair) must use original JS matching.
    const long = terms.some(unsafe) ? [] : terms.filter(t => [...t].length >= 3)
    if (long.length) {
      filters.push('(unsafe=1 OR ref IN (SELECT ref FROM source_fts WHERE source_fts MATCH ?))')
      values.push(long.map(t => '"' + t.replaceAll('"', '""') + '"').join(' AND '))
    }
    // FTS cannot narrow one/two-codepoint words. For well-formed, NUL-free
    // strings instr is a safe substring candidate filter; unsafe rows remain
    // included and all final matching still uses the original UTF-16 text.
    if (!terms.some(unsafe)) for (const term of terms.filter(t => [...t].length < 3)) {
      filters.push('(unsafe=1 OR instr(searchable,?)>0)');values.push(term)
    }
    const statement = this.db.prepare('SELECT ref FROM docs' + (filters.length ? ' WHERE ' + filters.join(' AND ') : ''))
    return statement.iterate(...values)
  }
}

/** Call only after closing every application reader of this source's cache. */
export function discardPersonalSearchCache(hubStore, projects) {
  const index = new PersonalSearchIndex({ hubStore, projects })
  if (!absent(index.directory)) return
  try {
    index.open() // Verify the component marker and actual database identity before deletion.
    index.close()
    for (const suffix of ['', '-journal', '-wal', '-shm']) if (regular(index.file + suffix)) unlinkSync(index.file + suffix)
    index.syncDirectory()
  } finally { index.close() }
}
