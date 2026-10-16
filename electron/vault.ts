import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Dataset, SavedReport } from '../shared/contracts.js'
import type { BackgroundTask, ExportSchedule } from '../shared/workbench.js'
import { defaultReportTemplates, reportTemplatesSchema, savedGroupReportSchema, type ReportTemplates, type SavedGroupReport } from '../shared/group-report.js'

export class LocalVault {
  private secrets: Record<string, unknown> = {}
  constructor(private directory: string) {
    mkdirSync(directory, { recursive: true })
    const file = join(directory, 'credentials.bin')
    if (existsSync(file) && safeStorage.isEncryptionAvailable()) {
      try { this.secrets = JSON.parse(safeStorage.decryptString(readFileSync(file))) } catch { this.secrets = {} }
    }
  }
  private write(name: string, content: string | Buffer): void {
    const path = join(this.directory, name)
    writeFileSync(`${path}.tmp`, content, { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  }
  private read<T>(name: string, fallback: T): T {
    try { return JSON.parse(readFileSync(join(this.directory, name), 'utf8')) as T } catch { return fallback }
  }
  secret<T>(name: string): T | null { return this.secrets[name] as T ?? null }
  setSecret(name: string, value: unknown): void {
    if (value === null) delete this.secrets[name]
    else this.secrets[name] = value
    if (safeStorage.isEncryptionAvailable()) this.write('credentials.bin', safeStorage.encryptString(JSON.stringify(this.secrets)))
  }
  datasets(): Dataset[] { const value = this.read<Dataset[]>('imports.json', []); return Array.isArray(value) ? value : [] }
  saveDatasets(datasets: Dataset[]): void {
    if (datasets.reduce((sum, data) => sum + data.messages.length, 0) > 100000) throw new Error('本机导入缓存最多保存 100,000 条消息，请先断开并清理导入缓存')
    this.write('imports.json', JSON.stringify(datasets))
  }
  tasks(): BackgroundTask[] { const value = this.read<BackgroundTask[]>('tasks.json', []); return Array.isArray(value) ? value.filter(task => typeof task?.id === 'string' && Array.isArray(task.files)) : [] }
  saveTasks(tasks: BackgroundTask[]): void { this.write('tasks.json', JSON.stringify(tasks)) }
  schedules(): ExportSchedule[] { const value = this.read<ExportSchedule[]>('schedules.json', []); return Array.isArray(value) ? value.filter(item => typeof item?.id === 'string' && typeof item.sourceId === 'string' && Number.isFinite(item.nextRunAt)) : [] }
  saveSchedules(schedules: ExportSchedule[]): void { this.write('schedules.json', JSON.stringify(schedules)) }
  transcripts(): Record<string, string> { return this.read('transcripts.json', {}) }
  saveTranscript(id: string, text: string): void { const items = this.transcripts(); delete items[id]; items[id] = text; this.write('transcripts.json', JSON.stringify(Object.fromEntries(Object.entries(items).slice(-10000)))) }
  private reportFile(owner: string): string { return `reports-${createHash('sha256').update(owner).digest('hex').slice(0, 24)}.json` }
  reports(owner: string): SavedReport[] {
    if (!owner) return []
    const result = this.read<SavedReport[]>(this.reportFile(owner), [])
    return Array.isArray(result) ? result : []
  }
  saveReport(owner: string, report: SavedReport): void {
    if (!owner) throw new Error('请先登录后保存分析结果')
    this.write(this.reportFile(owner), JSON.stringify([report, ...this.reports(owner).filter(item => item.id !== report.id)].slice(0, 100)))
  }
  deleteReport(owner: string, id: string): void { this.write(this.reportFile(owner), JSON.stringify(this.reports(owner).filter(item => item.id !== id))) }
  reportTemplates(): ReportTemplates {
    const parsed = reportTemplatesSchema.safeParse(this.read('report-templates.json', null))
    return parsed.success ? parsed.data : defaultReportTemplates()
  }
  saveReportTemplates(templates: ReportTemplates): void { this.write('report-templates.json', JSON.stringify(reportTemplatesSchema.parse(templates))) }
  groupReports(owner: string): SavedGroupReport[] {
    if (!owner) return []
    const result = this.read<SavedGroupReport[]>(`group-${this.reportFile(owner)}`, [])
    return Array.isArray(result) ? result.filter(report => savedGroupReportSchema().safeParse(report).success) : []
  }
  saveGroupReport(owner: string, report: SavedGroupReport): void {
    if (!owner) throw new Error('请先登录后保存社群报告')
    this.write(`group-${this.reportFile(owner)}`, JSON.stringify([report, ...this.groupReports(owner).filter(item => item.id !== report.id)].slice(0, 60)))
  }
  deleteGroupReport(owner: string, id: string): void { this.write(`group-${this.reportFile(owner)}`, JSON.stringify(this.groupReports(owner).filter(item => item.id !== id))) }
}
