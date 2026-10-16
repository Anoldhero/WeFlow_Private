import { build as bundle } from 'esbuild'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { buildServer } from './build-server.mjs'
import { assertNode24, publicClientUrl } from './runtime-config.mjs'
import { validateClientConfig } from '../shared/service-url.mjs'

export async function buildProject({ serverOnly = false, cloudUrl, preview } = {}) {
  assertNode24()
  await buildServer()
  if (serverOnly) return
  const configured = cloudUrl ?? publicClientUrl()
  const clientConfig = validateClientConfig({ url: configured || 'http://127.0.0.1:4310', preview: preview ?? !configured })
  if (!existsSync('vendor/weflow/keyService.ts')) throw new Error('缺少 WeFlow 原生组件，请先运行 node scripts/sync-weflow.mjs')
  const { build: viteBuild } = await import('vite')
  await viteBuild()
  await buildDesktop()
  mkdirSync('.generated', { recursive: true })
  writeFileSync('.generated/cloud-config.json', JSON.stringify(clientConfig, null, 2) + '\n')
}

export async function buildDesktop() {
  const result = await bundle({
    entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts', 'wcdb-worker': 'electron/wcdb-worker.ts', 'export-worker': 'electron/export-worker.ts', 'media-worker': 'electron/media-worker.ts' },
    outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron', 'koffi', 'sherpa-onnx-node', 'silk-wasm', './wechat-key.cjs'], sourcemap: false, metafile: true
  })
  if (Object.keys(result.metafile.inputs).some(file => /^server\//.test(file.replace(/\\/g, '/')))) throw new Error('桌面构建不能依赖云端实现')
  await bundle({ entryPoints: ['vendor/weflow/keyService.ts'], outfile: 'dist-electron/wechat-key.cjs', bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron', 'koffi'], drop: ['console'] })
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/scripts/build.mjs')) await buildProject({ serverOnly: process.argv.includes('--server-only') })
