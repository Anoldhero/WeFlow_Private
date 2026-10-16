import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, '../WeFlow-New')
const revision = execFileSync('git', ['-c', `safe.directory=${source.replace(/\\/g, '/')}`, '-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (revision !== 'e5b7067aa0554151d2762c6f889dd47bc1bf2f46') throw new Error('WeFlow-New 版本已变化，请先复核新组件再更新固定版本')
const items = [
  ['electron/services/keyService.ts', 'vendor/weflow/keyService.ts'],
  ['LICENSE', 'vendor/weflow/LICENSE'],
  ...['wcdb_api.dll', 'WCDB.dll', 'SDL2.dll'].map(name => [`resources/wcdb/win32/x64/${name}`, `resources/native/${name}`]),
  ['resources/key/win32/x64/wx_key.dll', 'resources/native/wx_key.dll'],
  ['resources/wedecrypt/win32/x64/weflow-image-native-win32-x64.node', 'resources/native/weflow-image-native-win32-x64.node'],
  ...['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'].map(name => [`resources/runtime/win32/${name}`, `resources/native/${name}`])
]
const previous = existsSync(join(root, 'vendor/weflow/manifest.json')) ? JSON.parse(readFileSync(join(root, 'vendor/weflow/manifest.json'), 'utf8')) : { files: [] }
const manifest = []
for (const [from, to] of items) {
  const input = join(source, from)
  const output = join(root, to)
  const data = readFileSync(input)
  const sha256 = createHash('sha256').update(data).digest('hex')
  if (existsSync(output)) {
    const existingHash = createHash('sha256').update(readFileSync(output)).digest('hex')
    if (existingHash !== sha256) {
      if (!previous.files.some(file => file.path === to && file.sha256 === existingHash)) throw new Error(`目标包含未记录的改动，停止覆盖：${to}`)
      const backup = join(root, '.backups/2026-09-17-upstream', to)
      if (!existsSync(backup)) { mkdirSync(dirname(backup), { recursive: true }); copyFileSync(output, backup) }
      copyFileSync(input, output)
    }
  } else {
    mkdirSync(dirname(output), { recursive: true })
    copyFileSync(input, output)
  }
  manifest.push({ source: from, path: to, sha256 })
}
writeFileSync(join(root, 'vendor/weflow/manifest.json'), JSON.stringify({ repository: 'https://github.com/jacklilyhello/WeFlow', upstream: 'https://github.com/hicccc77/WeFlow', revision, license: 'CC-BY-NC-SA-4.0', files: manifest }, null, 2) + '\n')
console.log(`已核对 ${manifest.length} 个 WeFlow 组件并保留许可及来源记录。`)
