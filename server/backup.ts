import { DatabaseSync, backup } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { mkdir, chmod, link, unlink, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export async function backupDatabase(source: string, destination: string): Promise<{ path: string; bytes: number }> {
  const input = resolve(source), output = resolve(destination)
  if (!existsSync(input)) throw new Error('云端数据库不存在，请核对 DATABASE_PATH')
  if (input === output || existsSync(output)) throw new Error('备份目标已存在，请使用新的文件名')
  await mkdir(dirname(output), { recursive: true })
  const temporary = `${output}.${randomUUID()}.tmp`
  const database = new DatabaseSync(input, { readOnly: true })
  try {
    await backup(database, temporary)
    await chmod(temporary, 0o600)
    const verification = new DatabaseSync(temporary, { readOnly: true })
    try { if (verification.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('SQLite 备份完整性检查失败') } finally { verification.close() }
    await link(temporary, output)
    return { path: output, bytes: (await stat(output)).size }
  } finally { database.close(); await unlink(temporary).catch(() => {}) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 2 || args[0] !== '--out' || !args[1]) throw new Error('使用 node dist-server/backup.mjs --out <新的备份文件.sqlite>')
    console.log(JSON.stringify(await backupDatabase(process.env.DATABASE_PATH || './data/cloud.sqlite', args[1]), null, 2))
  } catch (error) { console.error(error instanceof Error ? error.message : '备份失败'); process.exitCode = 1 }
}
