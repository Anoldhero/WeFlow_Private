import { createRequire } from 'node:module'
import { copyFileSync, existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

export function prepareElectronRuntime() {
  const require = createRequire(import.meta.url)
  const executable = require('electron')
  if (process.platform !== 'win32') return executable
  const directory = realpathSync(dirname(executable))
  if (!directory.toLowerCase().startsWith(`${resolve('node_modules')}${sep}`.toLowerCase())) throw new Error('Electron 运行时必须位于本项目 node_modules 中')
  for (const name of ['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) {
    const destination = join(directory, name)
    if (!existsSync(destination)) copyFileSync(join('resources/native', name), destination)
  }
  return executable
}
