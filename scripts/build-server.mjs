import { build } from 'esbuild'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function buildServer() {
  const result = await build({ entryPoints: { index: 'server/index.ts', invite: 'server/invite.ts', backup: 'server/backup.ts' }, outdir: 'dist-server', outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external', metafile: true })
  const unexpected = Object.keys(result.metafile.inputs).filter(file => /^(?:electron|src|resources|vendor)\//.test(file.replace(/\\/g, '/')))
  if (unexpected.length) throw new Error(`云端构建混入本机模块：${unexpected.join(', ')}`)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildServer()
