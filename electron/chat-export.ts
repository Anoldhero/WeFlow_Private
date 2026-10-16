import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatSession } from '../shared/contracts.js'
import type { ChatExportFormat } from '../shared/workbench.js'
import type { TaskContext } from './task-manager.js'

export async function writeChatExport(destination: string, session: ChatSession, messages: ChatMessage[], format: ChatExportFormat, context: TaskContext, workerFile?: string): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`
  const worker = new Worker(workerFile || join(__dirname, 'export-worker.cjs'), { workerData: { temporary, destination, format, session } })
  let sequence = 0
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
  let failure: Error | undefined
  const fail = (error: Error) => { failure = error; for (const item of pending.values()) item.reject(error); pending.clear() }
  worker.on('error', fail); worker.on('exit', code => fail(new Error(`导出进程已退出（${code}）`)))
  worker.on('message', (message: { ready?: boolean; id?: number; error?: string }) => { const id = message.ready ? 0 : message.id!; const task = pending.get(id); pending.delete(id); if (message.error) task?.reject(new Error(message.error)); else task?.resolve() })
  const ready = new Promise<void>((resolve, reject) => pending.set(0, { resolve, reject }))
  const send = (payload: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
    if (failure) { reject(failure); return }
    const id = ++sequence; pending.set(id, { resolve, reject }); worker.postMessage({ id, ...payload })
  })
  const timer = setTimeout(() => fail(new Error('导出工作进程启动超时')), 30000)
  try {
    await ready; clearTimeout(timer)
    for (let offset = 0; offset < messages.length; offset += 500) {
      await context.checkpoint()
      await send({ messages: messages.slice(offset, offset + 500) })
      context.progress(Math.min(offset + 500, messages.length), messages.length, `已写入 ${Math.min(offset + 500, messages.length).toLocaleString()} / ${messages.length.toLocaleString()} 条消息`)
    }
    await context.checkpoint(); await send({ finish: true }); context.files([destination]); context.progress(1, 1, '聊天记录已导出')
  } finally { clearTimeout(timer); await worker.terminate(); await rm(temporary, { force: true }) }
}
