import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { normalizeWxid } from '../shared/data.js'

export function sessionDatabase(directory: string): string | undefined {
  return [join(directory, 'db_storage/session/session.db'), join(directory, 'db_storage/session.db')].find(file => existsSync(file) && statSync(file).size > 0)
}
export function accountDirectories(input: string, wxid?: string): string[] {
  let root = resolve(input)
  if (basename(root).toLowerCase() === 'db_storage') root = dirname(root)
  const candidates = sessionDatabase(root) ? [root] : existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => join(root, entry.name)).filter(directory => sessionDatabase(directory)) : []
  const normalized = wxid ? normalizeWxid(wxid) : ''
  return candidates.filter(directory => !normalized || normalizeWxid(basename(directory)) === normalized).sort((a, b) => {
    const exact = Number(basename(b) === wxid) - Number(basename(a) === wxid)
    return exact || statSync(sessionDatabase(b)!).mtimeMs - statSync(sessionDatabase(a)!).mtimeMs
  })
}
