import { Worker } from 'node:worker_threads'
import { join } from 'node:path'

export class NativeClient {
  private worker: Worker | null = null
  private nextId = 0
  private closing = false
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private start(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(join(__dirname, 'wcdb-worker.cjs'))
    this.worker = worker
    const fail = (message: string) => {
      if (this.worker !== worker) return
      for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new Error(message)) }
      this.pending.clear()
      if (this.worker === worker) this.worker = null
    }
    worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
      const task = this.pending.get(message.id)
      if (!task) return
      this.pending.delete(message.id)
      clearTimeout(task.timer)
      if (message.error) task.reject(new Error(message.error))
      else task.resolve(message.result)
    })
    worker.on('error', () => fail('微信读取组件异常，请重新连接；必要时检查 Visual C++ 运行库'))
    worker.on('exit', () => fail('微信读取组件已退出，请重新连接'))
    return worker
  }
  call<T>(type: 'connect' | 'sessions' | 'messages' | 'close' | 'openReader' | 'readBatch' | 'closeReader' | 'members' | 'voice' | 'imagePaths', payload: unknown = {}): Promise<T> {
    if (this.closing && type !== 'close') return Promise.reject(new Error('正在断开微信，请稍后重试'))
    const worker = this.start()
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        void worker.terminate()
      }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      worker.postMessage({ id, type, payload })
    })
  }
  async stop(): Promise<void> {
    const worker = this.worker
    if (!worker || this.closing) return
    this.closing = true
    try { await this.call('close') } catch {}
    this.worker = null
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new Error('读取已取消')) }
    this.pending.clear()
    try { await worker.terminate() } finally { this.closing = false }
  }
}
