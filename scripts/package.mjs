import { build, Platform } from 'electron-builder'
import { buildProject } from './build.mjs'
import { resolve, sep, join } from 'node:path'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { assertNode24, publicClientUrl } from './runtime-config.mjs'
import { validateClientConfig } from '../shared/service-url.mjs'

assertNode24()
const preview = process.argv.includes('--preview')
const outputIndex = process.argv.indexOf('--out-dir')
if (outputIndex >= 0 && (!process.argv[outputIndex + 1] || process.argv[outputIndex + 1].startsWith('--'))) throw new Error('--out-dir 后需要指定 release 下的输出目录')
const releaseRoot = resolve('release')
const output = outputIndex >= 0 ? resolve(process.argv[outputIndex + 1]) : releaseRoot
if (output.toLowerCase() !== releaseRoot.toLowerCase() && !output.toLowerCase().startsWith(`${releaseRoot}${sep}`.toLowerCase())) throw new Error('打包目录必须位于本项目 release 中')
const cloudUrl = publicClientUrl() || (preview ? 'http://127.0.0.1:4310' : '')
validateClientConfig({ url: cloudUrl, preview })
const require = createRequire(import.meta.url)
for (const dependency of ['sherpa-onnx-node', 'silk-wasm']) {
  try { require.resolve(dependency) } catch { throw new Error(`缺少离线语音依赖 ${dependency}，请先用 Node 24 执行 pnpm install，再生成安装包`) }
}
if (!existsSync(join('node_modules', 'sherpa-onnx-win-x64', 'package.json'))) throw new Error('缺少 Windows x64 离线语音运行库，请完成 pnpm install 后再打包')
await buildProject({ cloudUrl, preview })
await build({ targets: Platform.WINDOWS.createTarget(process.argv.includes('--dir') ? 'dir' : 'nsis'), publish: 'never', config: { directories: { output }, ...(preview ? { artifactName: 'Zhiliao-Preview-${version}-${arch}-Setup.${ext}' } : {}) } })
