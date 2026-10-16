import { parentPort, workerData } from 'node:worker_threads'
import { open, rename, rm } from 'node:fs/promises'
import { exportFooter, exportHeader, exportMessage } from '../shared/chat-export.js'
import type { ChatMessage } from '../shared/contracts.js'

async function main() {
let index = 0
const { temporary, destination, format, session } = workerData
const file = await open(temporary, 'wx', 0o600)
await file.write(exportHeader(session, format))
parentPort?.postMessage({ ready: true })
let queue = Promise.resolve()
parentPort?.on('message', (request: { id: number; messages?: ChatMessage[]; finish?: boolean; cancel?: boolean }) => {
  queue = queue.then(async () => {
    try {
      if (request.cancel) { await file.close(); await rm(temporary, { force: true }) }
      else if (request.finish) { await file.write(exportFooter(format)); await file.sync(); await file.close(); await rename(temporary, destination) }
      else if (request.messages) await file.write(request.messages.map(message => exportMessage(message, session.id, format, index++)).join(''))
      parentPort?.postMessage({ id: request.id })
    } catch (error) { parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : '导出写入失败' }) }
  })
})
}
void main().catch(error => { parentPort?.postMessage({ ready: true, error: error instanceof Error ? error.message : '导出工作进程启动失败' }) })
