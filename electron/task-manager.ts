import { randomUUID } from 'node:crypto'
import { activeTask, type BackgroundTask, type TaskAction } from '../shared/workbench.js'

export interface TaskContext { signal: AbortSignal; checkpoint(): Promise<void>; progress(current: number, total: number, message: string): void; files(paths: string[]): void }
type Runner = { run: (context: TaskContext) => Promise<unknown>; controller: AbortController; resume?: () => void; resolve: (value: any) => void; reject: (error: Error) => void }
export class TaskManager {
  private records: BackgroundTask[]
  private runners = new Map<string, Runner>()
  private running = false
  private stopped = false
  private lastSave = 0
  constructor(saved: BackgroundTask[], private persist: (tasks: BackgroundTask[]) => void, private changed: (tasks: BackgroundTask[]) => void) {
    this.records = saved.slice(0, 100).map(task => activeTask(task) ? { ...task, state: 'interrupted', message: '软件退出后任务中断，请重新发起', updatedAt: Date.now() } : task)
  }
  list(): BackgroundTask[] { return this.records.map(task => ({ ...task, files: [...task.files] })) }
  busy(): boolean { return this.records.some(activeTask) }
  private emit(force = true): void {
    if (force || Date.now() - this.lastSave > 500) { this.persist(this.list()); this.changed(this.list()); this.lastSave = Date.now() }
  }
  enqueue<T>(options: Pick<BackgroundTask, 'title' | 'kind'> & { canPause?: boolean; scheduleId?: string }, run: (context: TaskContext) => Promise<T>): { id: string; done: Promise<T> } {
    if (this.stopped) throw new Error('软件正在退出')
    if (this.records.filter(activeTask).length >= 20) throw new Error('待处理任务过多，请等待已有任务完成')
    const id = randomUUID(), now = Date.now()
    this.records.unshift({ ...options, canPause: options.canPause ?? true, id, state: 'queued', createdAt: now, updatedAt: now, current: 0, total: 1, message: '等待执行', files: [] })
    this.records = [...this.records.filter(activeTask), ...this.records.filter(task => !activeTask(task)).slice(0, 100)].sort((a, b) => b.createdAt - a.createdAt)
    const done = new Promise<T>((resolve, reject) => this.runners.set(id, { run, controller: new AbortController(), resolve, reject }))
    void done.catch(() => {})
    this.emit(); void this.pump()
    return { id, done }
  }
  async control(id: string, action: TaskAction): Promise<void> {
    const task = this.records.find(task => task.id === id), runner = this.runners.get(id)
    if (!task || !runner || !activeTask(task)) throw new Error('任务已结束或不存在')
    if (action === 'cancel') {
      const queued = task.state === 'queued' || (task.state === 'paused' && !runner.resume)
      task.state = queued ? 'canceled' : 'cancel_requested'; task.message = queued ? '已取消' : '正在取消并清理临时文件'
      runner.controller.abort(new Error('任务已取消')); runner.resume?.()
      if (queued) { this.runners.delete(id); runner.reject(new Error('任务已取消')) }
    } else if (action === 'pause') {
      if (!task.canPause) throw new Error('此任务只能取消，不能暂停')
      if (!['queued', 'running'].includes(task.state)) return
      task.state = task.state === 'queued' ? 'paused' : 'pause_requested'; task.message = task.state === 'paused' ? '已暂停' : '将在当前读取或写入完成后暂停'
    } else {
      if (!['paused', 'pause_requested'].includes(task.state)) return
      task.state = runner.resume || task.state === 'pause_requested' ? 'running' : 'queued'; task.message = '继续执行'; runner.resume?.()
    }
    task.updatedAt = Date.now(); this.emit(); void this.pump()
  }
  private async pump(): Promise<void> {
    if (this.running || this.stopped) return
    const task = [...this.records].reverse().find(task => task.state === 'queued')
    if (!task) return
    const runner = this.runners.get(task.id)!
    this.running = true; task.state = 'running'; task.message = '开始执行'; this.emit()
    const checkpoint = async () => {
      runner.controller.signal.throwIfAborted()
      if (task.state === 'pause_requested') {
        task.state = 'paused'; task.message = '已暂停'; this.emit()
        await new Promise<void>(resolve => { runner.resume = resolve })
        runner.resume = undefined
      }
      runner.controller.signal.throwIfAborted()
    }
    try {
      const result = await runner.run({ signal: runner.controller.signal, checkpoint, progress: (current, total, message) => { task.current = current; task.total = Math.max(1, total); task.message = message; task.updatedAt = Date.now(); this.emit(false) }, files: paths => { task.files = paths; this.emit() } })
      runner.controller.signal.throwIfAborted()
      task.state = 'completed'; task.current = task.total; if (!task.message || task.message === '开始执行') task.message = '已完成'; runner.resolve(result)
    } catch (error) {
      task.state = runner.controller.signal.aborted ? 'canceled' : 'failed'; task.error = task.state === 'failed' ? error instanceof Error ? error.message : '任务失败' : undefined
      task.message = task.state === 'canceled' ? '已取消' : task.error!; runner.reject(error instanceof Error ? error : new Error(task.message))
    } finally { task.updatedAt = Date.now(); this.runners.delete(task.id); this.running = false; this.emit(); void this.pump() }
  }
  shutdown(): void {
    this.stopped = true
    for (const task of this.records.filter(activeTask)) { const runner = this.runners.get(task.id); runner?.controller.abort(new Error('软件正在退出')); runner?.resume?.(); task.state = 'interrupted'; task.message = '软件退出，任务未完成'; runner?.reject(new Error(task.message)) }
    this.emit()
  }
}
