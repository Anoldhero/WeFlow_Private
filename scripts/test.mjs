import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const tests = readdirSync('tests').filter(name => name.endsWith('.test.ts')).map(name => `tests/${name}`)
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests], { stdio: 'inherit' })
process.exit(result.status ?? 1)
