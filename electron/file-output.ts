import { existsSync } from 'node:fs'
import { writeFile, rename, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export async function writeFilesAtomically(files: Array<{ path: string; data: Uint8Array }>): Promise<void> {
  const batch = randomUUID()
  const entries = files.map(file => ({ ...file, temporary: `${file.path}.${batch}.tmp`, backup: `${file.path}.${batch}.bak`, backed: false, installed: false }))
  if (new Set(entries.map(item => item.path.toLowerCase())).size !== entries.length) throw new Error('导出文件名重复')
  try {
    for (const entry of entries) {
      if (existsSync(entry.path) && !(await stat(entry.path)).isFile()) throw new Error('导出目标不是文件，请换一个保存位置')
      await writeFile(entry.temporary, entry.data, { flag: 'wx' })
    }
    for (const entry of entries) {
      if (existsSync(entry.path)) { await rename(entry.path, entry.backup); entry.backed = true }
      await rename(entry.temporary, entry.path); entry.installed = true
    }
  } catch (error) {
    const recovery: string[] = []
    for (const entry of [...entries].reverse()) {
      try { if (entry.installed) await rm(entry.path, { force: true }); if (entry.backed) await rename(entry.backup, entry.path) }
      catch { if (entry.backed) recovery.push(entry.backup) }
    }
    if (recovery.length) throw new Error(`导出失败，原文件备份保存在：${recovery.join('；')}`)
    throw error
  } finally { await Promise.all(entries.map(entry => rm(entry.temporary, { force: true }).catch(() => {}))) }
  await Promise.all(entries.filter(entry => entry.backed).map(entry => rm(entry.backup, { force: true }).catch(() => {})))
}
