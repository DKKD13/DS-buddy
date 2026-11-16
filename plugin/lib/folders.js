// Where a project works when the owner gave it no folder.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** A folder name for the project's default workspace; its last segment is the sidebar title. */
export function folderName(project) {
  const name = (project.initialName ?? project.name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().slice(0, 60)
  return name === '' || name === '.' || name === '..' ? project.id : name
}

/**
 * Where a project without a folder of its own works. It used to be a folder inside the project's data directory, one
 * step from the project's own event log, and an executor read that log (fresh-install run, 2026-11-16). New projects
 * get a folder apart from every log; a project that already has the old folder keeps it, with its files.
 */
export function defaultFolder(store, project) {
  const old = join(store.root, project.id, folderName(project))
  return existsSync(old) ? old : join(store.root, '_folders', project.id, folderName(project))
}
