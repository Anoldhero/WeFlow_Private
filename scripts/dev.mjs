import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { assertNode24, readEnvFile, resolveDevOptions, clientEnvironment } from './runtime-config.mjs'
import { startDevControl } from './dev-control.mjs'

const children = []
let stopping = false, vite, control, stopPromise
async function stop(code = 0) {
  if (stopPromise) return stopPromise
  stopping = true; control?.setState('stopping')
  stopPromise = (async () => {
    const waits = children.map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
      const timer = setTimeout(() => { child.kill(); resolve() }, 5000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      if (child.connected) child.send({ type: 'shutdown' }, error => { if (error) child.kill() })
      else child.kill()
    }))
    await Promise.all(waits)
    await vite?.close()
    await control?.close()
    process.exit(code)
  })()
  return stopPromise
}
function launch(args, env, ipc = false) {
  const child = spawn(process.execPath, args, { env, stdio: ipc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit', windowsHide: true })
  children.push(child)
  child.on('error', error => { console.error(`开发进程启动失败：${error.message}`); void stop(1) })
  child.on('exit', code => { if (!stopping) { console.error('本机云端服务已退出'); void stop(code || 1) } })
  return child
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop() })

try {
  assertNode24()
  const root = process.cwd(), stateRoot = resolve(process.env.ZHILIAO_DEV_STATE_DIR || root), options = resolveDevOptions(process.argv.slice(2), process.env, root)
  control = await startDevControl(stateRoot, { mode: options.mode, webUrl: options.webUrl, cloudUrl: options.endpoint, localApiPort: options.cloud ? null : options.apiPort }, () => stop())
  if (!options.cloud) {
    const env = { ...readEnvFile(resolve(root, '.env')), ...process.env, HOST: '127.0.0.1', PORT: String(options.apiPort), ...(options.demo ? { AI_PROVIDER: 'demo', NODE_ENV: 'development', DATABASE_PATH: resolve(stateRoot, 'data/demo.sqlite') } : {}) }
    const child = launch(['--import', 'tsx', 'server/index.ts'], env, true)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('本机云端服务启动超时')), 20000)
      child.on('message', message => { if (message?.type === 'cloud-ready') { clearTimeout(timer); resolve() } })
      child.once('exit', () => { clearTimeout(timer); reject(new Error('本机云端服务启动失败')) })
    })
  }
  if (stopping) throw new Error('已取消启动')
  const { createServer } = await import('vite')
  vite = await createServer({ server: { host: '127.0.0.1', port: options.webPort, strictPort: true, proxy: { '/cloud': { target: options.endpoint, changeOrigin: true, rewrite: path => path.replace(/^\/cloud/, '') } } } })
  vite.watcher.on('error', error => { console.error(`文件监听异常：${error.message}`); void stop(1) })
  await vite.listen(); vite.printUrls()
  if (options.desktop) {
    const { buildDesktop } = await import('./build.mjs')
    const { prepareElectronRuntime } = await import('./electron-runtime.mjs')
    await buildDesktop()
    if (stopping) throw new Error('已取消启动')
    const env = clientEnvironment(process.env, options.endpoint, options.webUrl, resolve(stateRoot, options.demo ? 'data/desktop-demo' : 'data/desktop'))
    const electron = spawn(prepareElectronRuntime(), ['.'], { stdio: 'inherit', env, windowsHide: true })
    children.push(electron)
    electron.on('error', error => { console.error(`桌面端启动失败：${error.message}`); void stop(1) })
    electron.on('exit', () => { if (!stopping) void stop() })
  }
  control.setState('ready')
  console.log(`运行模式：${options.mode}；服务地址：${options.endpoint}`)
  console.log('停止当前环境：Ctrl+C，或在本项目另一终端执行 pnpm stop。')
} catch (error) { console.error(error.message); await stop(1) }
