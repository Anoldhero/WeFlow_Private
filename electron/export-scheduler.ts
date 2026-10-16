import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { safeFileName } from '../shared/chat-export.js'
import { activeTask, nextScheduledTime, scheduleDue, selectMessages, type ExportSchedule, type MessageQuery } from '../shared/workbench.js'
import type { DataSource } from './data-source.js'
import type { LocalVault } from './vault.js'
import type { TaskManager } from './task-manager.js'
import { writeChatExport } from './chat-export.js'

export class ExportScheduler {
  private items: ExportSchedule[]
  private ticking = false
  private timer?: ReturnType<typeof setInterval>
  constructor(private source: DataSource, private tasks: TaskManager, private vault: LocalVault) {
    this.items = vault.schedules().map(item => item.activeTaskId ? { ...item, activeTaskId: undefined, lastMessage: '上次任务因退出中断，等待下一次计划' } : item)
  }
  list(): ExportSchedule[] { return this.items.map(item => ({ ...item, fingerprint: undefined })) }
  save(schedule: ExportSchedule): void {
    const old = this.get(schedule.id)
    const unchanged = old && (['sourceId', 'sessionId', 'format', 'recentDays', 'senderId', 'keyword'] as const).every(key => old[key] === schedule[key])
    this.items = [{ ...schedule, fingerprint: unchanged ? old.fingerprint : undefined }, ...this.items.filter(item => item.id !== schedule.id)]
    this.persist()
  }
  remove(id: string): void { if (this.items.find(item => item.id === id)?.activeTaskId) throw new Error('请先取消该计划正在执行的任务'); this.items = this.items.filter(item => item.id !== id); this.persist() }
  get(id: string): ExportSchedule | undefined { return this.items.find(item => item.id === id) }
  private persist(): void { this.vault.saveSchedules(this.items) }
  start(): void { if (!this.timer) this.timer = setInterval(() => { void this.tick().catch(error => { for (const item of this.items.filter(item => item.enabled && item.nextRunAt <= Date.now())) item.lastMessage = error instanceof Error ? error.message : '计划执行失败' }) }, 15000) }
  stop(): void { clearInterval(this.timer); this.timer = undefined }
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const schedule of this.items.filter(item => scheduleDue(item, now, this.source.identity()))) {
        if (this.tasks.list().filter(activeTask).length >= 20) break
        schedule.nextRunAt = nextScheduledTime(schedule, now)
        const runAt = now, end = Math.floor(runAt / 1000) + 1
        const query: MessageQuery = { sessionId: schedule.sessionId, start: end - schedule.recentDays * 86400, end, senderId: schedule.senderId, keyword: schedule.keyword, offset: 0, limit: 100 }
        const task = this.tasks.enqueue({ title: `定时导出 · ${schedule.name}`, kind: 'export', scheduleId: schedule.id }, async context => {
          if (this.source.identity() !== schedule.sourceId) throw new Error('当前数据来源与计划不一致，请连接原账号')
          const session = (await this.source.sessions()).find(item => item.id === schedule.sessionId)
          if (!session) throw new Error('计划中的会话不存在')
          const messages = selectMessages(await this.source.readRange(query.sessionId, query.start, query.end, 100000, context), query)
          const fingerprint = createHash('sha256').update(JSON.stringify(messages.map(message => [message.id, message.text]))).digest('hex')
          if (schedule.skipUnchanged && (!messages.length || fingerprint === schedule.fingerprint)) { context.progress(1, 1, '没有新增或变更内容，已跳过'); return { fingerprint, message: '没有新增或变更内容，已跳过' } }
          await context.checkpoint(); await mkdir(schedule.directory, { recursive: true })
          const filename = `${safeFileName(schedule.name)}-${new Date(runAt).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.${schedule.format}`
          await writeChatExport(join(schedule.directory, filename), session, messages, schedule.format, context)
          return { fingerprint, message: `已导出 ${messages.length} 条消息` }
        })
        schedule.activeTaskId = task.id; this.persist()
        void task.done.then(result => { schedule.fingerprint = result.fingerprint; schedule.lastMessage = result.message; schedule.runs++ }).catch(error => { schedule.lastMessage = error instanceof Error ? error.message : '导出失败' }).finally(() => { schedule.activeTaskId = undefined; schedule.lastRunAt = Date.now(); if (schedule.maxRuns && schedule.runs >= schedule.maxRuns) schedule.enabled = false; this.persist() })
      }
    } finally { this.ticking = false; this.persist() }
  }
}
