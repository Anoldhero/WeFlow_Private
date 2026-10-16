import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { prepareElectronRuntime } from './electron-runtime.mjs'

mkdirSync('.cache', { recursive: true })
await build({ entryPoints: ['tests/electron-report-smoke.ts'], outfile: '.cache/report-export-check.cjs', bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'] })
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const result = spawnSync(prepareElectronRuntime(), ['.cache/report-export-check.cjs', ...process.argv.slice(2)], { env: environment, stdio: 'inherit', windowsHide: true, timeout: 90000 })
if (result.error) console.error(result.error.message)
process.exitCode = result.status ?? 1
