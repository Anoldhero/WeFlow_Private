import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { validateClientConfig } from '../shared/service-url.mjs'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'))
const asar = libraryRequire('@electron/asar')
const directory = process.argv[2] || 'release/win-unpacked'
const archive = join(directory, 'resources/app.asar')
const files = asar.listPackage(archive).map(path => path.replace(/\\/g, '/'))
const version = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8')).version
if (version !== JSON.parse(readFileSync('package.json', 'utf8')).version) throw new Error('客户端产物版本与项目版本不一致')
const forbidden = files.filter(path => /^\/(?:server|dist-server|data|tests|deploy|backups|\.backups|\.env|\.pnpm-store|\.cache)(?:[/.]|$)/.test(path))
if (forbidden.length) throw new Error(`安装包包含不应分发的文件：${forbidden.join(', ')}`)
for (const path of ['/dist/index.html', '/dist-electron/main.cjs', '/dist-electron/preload.cjs', '/dist-electron/wcdb-worker.cjs', '/dist-electron/wechat-key.cjs', '/dist-electron/export-worker.cjs', '/dist-electron/media-worker.cjs', '/vendor/weflow/LICENSE', '/THIRD-PARTY-NOTICES.md']) {
  if (!files.includes(path)) throw new Error(`缺少客户端文件：${path}`)
}
const manifest = JSON.parse(readFileSync('vendor/weflow/manifest.json', 'utf8'))
for (const item of manifest.files.filter(file => file.path.startsWith('resources/native/'))) {
  const name = item.path.split('/').at(-1)
  const data = readFileSync(join(directory, 'resources/resources', name))
  if (createHash('sha256').update(data).digest('hex') !== item.sha256) throw new Error(`原生组件哈希不匹配：${name}`)
}
for (const name of ['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) if (!existsSync(join(directory, name))) throw new Error(`缺少运行库：${name}`)
const cloud = validateClientConfig(JSON.parse(readFileSync(join(directory, 'resources/cloud-config.json'), 'utf8')))
const main = asar.extractFile(archive, 'dist-electron/main.cjs').toString('utf8')
for (const marker of ['data:reportSource', 'groupReport:generate', 'groupReport:saveTemplates', 'groupReport:export', 'data:profiles', 'data:query', 'tasks:action', 'schedules:save', 'media:process']) if (!main.includes(marker)) throw new Error(`客户端缺少功能：${marker}`)
for (const marker of ['LLM_API_KEY', 'TEST_PROVIDER_SECRET', 'PRIVATE_EVIDENCE_ONLY']) if (main.includes(marker)) throw new Error(`客户端混入服务端或测试内容：${marker}`)
for (const name of ['sherpa-onnx-node', 'sherpa-onnx-win-x64', 'silk-wasm']) if (!files.some(file => file.includes(`/node_modules/${name}/`))) throw new Error(`缺少本地语音依赖：${name}`)
console.log(JSON.stringify({ valid: true, version, clientFiles: files.length, excluded: ['服务端程序', '.env', '本机数据', '测试代码'], nativeFilesVerified: manifest.files.filter(file => file.path.startsWith('resources/native/')).length, preview: cloud.preview, cloudUrl: cloud.url }, null, 2))
