import { readConfig } from './config.js'
import { createCloudApp, seedDemoAccount } from './app.js'

let service: ReturnType<typeof createCloudApp> | undefined
let stopping = false
async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  const timeout = setTimeout(() => { console.error('服务未能在期限内退出'); process.exit(1) }, 10000)
  timeout.unref()
  try { await service?.stop(); process.exit(0) } catch { process.exit(1) }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop() })
process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown') void stop() })
try {
  const config = readConfig()
  service = createCloudApp(config)
  service.store.recoverInterrupted()
  if (config.provider === 'demo') await seedDemoAccount(service.store)
  if (!stopping) {
    await service.app.listen({ host: config.host, port: config.port })
    console.log(`知聊服务已启动：http://${config.host}:${config.port} (${config.provider === 'demo' ? '本地演示环境' : '云端 AI 接入'})`)
    process.send?.({ type: 'cloud-ready' })
  }
} catch (error) { console.error(error instanceof Error ? error.message : '云端启动失败'); await service?.stop(); process.exitCode = 1 }
