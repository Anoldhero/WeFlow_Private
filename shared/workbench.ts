import { z } from 'zod'
import type { ChatMessage } from './contracts.js'

export const messageQuerySchema = z.object({
  sessionId: z.string().min(1).max(512), start: z.number().int().nonnegative(), end: z.number().int().positive().max(4102444800),
  senderId: z.string().max(512).optional(), keyword: z.string().max(200).default(''),
  offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(500).default(100)
}).strict().refine(value => value.end > value.start, '结束时间必须晚于开始时间')
export type MessageQuery = z.infer<typeof messageQuerySchema>
export interface GroupMember { id: string; name: string; groupName?: string; count: number; first?: number; last?: number }
export interface MessagePage { messages: ChatMessage[]; total: number; hasMore: boolean; members: GroupMember[]; days: Array<{ date: string; count: number }>; mediaCount: number }
export const memberIdentity = (message: ChatMessage) => message.self ? '__self__' : message.senderId || message.sender
export function selectMessages(messages: ChatMessage[], query: Pick<MessageQuery, 'start' | 'end' | 'senderId' | 'keyword'>): ChatMessage[] {
  const keyword = query.keyword.trim().toLocaleLowerCase()
  return messages.filter(message => message.timestamp >= query.start && message.timestamp < query.end && (!query.senderId || memberIdentity(message) === query.senderId) && (!keyword || message.text.toLocaleLowerCase().includes(keyword)))
}
export function inspectMessages(messages: ChatMessage[], query: MessageQuery, roster: GroupMember[] = []): MessagePage {
  const members = new Map(roster.map(member => [member.id, { ...member, count: 0, first: undefined as number | undefined, last: undefined as number | undefined }]))
  for (const message of selectMessages(messages, { ...query, senderId: undefined, keyword: '' })) {
    if (message.type === 'system') continue
    const id = memberIdentity(message)
    const member = members.get(id) || { id, name: message.sender, count: 0, first: undefined, last: undefined }
    member.count++; member.first = Math.min(member.first ?? message.timestamp, message.timestamp); member.last = Math.max(member.last ?? 0, message.timestamp)
    members.set(id, member)
  }
  const matches = selectMessages(messages, query)
  const days = new Map<string, number>()
  for (const message of matches) { const date = new Date((message.timestamp + 28800) * 1000).toISOString().slice(0, 10); days.set(date, (days.get(date) || 0) + 1) }
  return { messages: matches.slice(query.offset, query.offset + query.limit), total: matches.length, hasMore: query.offset + query.limit < matches.length, members: [...members.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)), days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })), mediaCount: matches.filter(message => ['voice', 'image', 'video'].includes(message.type)).length }
}

export interface WeChatProfile { id: string; name: string; directory: string; lastUsed: number; active: boolean }
export const wechatConnectSchema = z.object({ profileId: z.string().max(80).optional(), add: z.boolean().optional(), chooseDirectory: z.boolean().optional() }).strict()
export type WeChatConnectOptions = z.infer<typeof wechatConnectSchema>
export const weflowConnectSchema = z.object({ port: z.number().int().min(1024).max(65535).default(5031), token: z.string().trim().max(2048).optional() }).strict()
export type WeFlowConnectOptions = z.infer<typeof weflowConnectSchema>
export interface WeFlowSettings { port: number; hasToken: boolean }
export interface DataChange { type: 'changed' | 'status'; sessionId?: string; message?: string; connected?: boolean }

export const exportFormats = ['json', 'jsonl', 'md', 'sql'] as const
export type ChatExportFormat = typeof exportFormats[number]
export const chatExportSchema = z.object({ query: messageQuerySchema, format: z.enum(exportFormats) }).strict()
export type ChatExportRequest = z.infer<typeof chatExportSchema>
export type TaskState = 'queued' | 'running' | 'pause_requested' | 'paused' | 'cancel_requested' | 'completed' | 'failed' | 'canceled' | 'interrupted'
export interface BackgroundTask { id: string; title: string; kind: 'export' | 'report' | 'analysis' | 'media' | 'model'; state: TaskState; createdAt: number; updatedAt: number; current: number; total: number; message: string; canPause: boolean; files: string[]; error?: string; scheduleId?: string }
export type TaskAction = 'pause' | 'resume' | 'cancel'
export const activeTask = (task: BackgroundTask) => ['queued', 'running', 'pause_requested', 'paused', 'cancel_requested'].includes(task.state)

export const scheduleInputSchema = z.object({
  id: z.string().uuid().optional(), name: z.string().trim().min(1).max(80), sessionId: z.string().min(1).max(512), format: z.enum(exportFormats),
  intervalHours: z.number().int().min(1).max(8760), recentDays: z.number().int().min(1).max(366), firstRunAt: z.number().int().positive(),
  endAt: z.number().int().positive().optional(), maxRuns: z.number().int().min(1).max(10000).optional(), skipUnchanged: z.boolean(), enabled: z.boolean(),
  senderId: z.string().max(512).optional(), keyword: z.string().max(200).default('')
}).strict().refine(value => !value.endAt || value.endAt > value.firstRunAt, '结束时间必须晚于首次执行时间')
export type ScheduleInput = z.infer<typeof scheduleInputSchema>
export interface ExportSchedule extends Omit<ScheduleInput, 'id'> { id: string; sourceId: string; sessionName: string; directory: string; nextRunAt: number; runs: number; lastRunAt?: number; lastMessage?: string; fingerprint?: string; activeTaskId?: string }
export function nextScheduledTime(schedule: Pick<ExportSchedule, 'nextRunAt' | 'intervalHours'>, now: number): number {
  const interval = schedule.intervalHours * 3600000
  return schedule.nextRunAt + Math.max(1, Math.floor((now - schedule.nextRunAt) / interval) + 1) * interval
}
export function scheduleDue(schedule: ExportSchedule, now: number, sourceId: string): boolean {
  return schedule.enabled && !schedule.activeTaskId && schedule.sourceId === sourceId && schedule.nextRunAt <= now && (!schedule.endAt || now < schedule.endAt) && (!schedule.maxRuns || schedule.runs < schedule.maxRuns)
}
export interface MediaStatus { modelReady: boolean; modelBytes: number; modelDirectory: string; engineAvailable: boolean }
export type MediaRequest = { sessionId: string; messageId: string; action: 'transcribe' | 'image'; chooseFile?: boolean }
export type MediaResult = { text?: string; image?: string; cached: boolean }
export interface LocalWorkbenchAPI {
  wechatProfiles(): Promise<WeChatProfile[]>
  removeWeChatProfile(id: string): Promise<void>
  weflowSettings(): Promise<WeFlowSettings>
  onDataChange(callback: (event: DataChange) => void): () => void
  queryMessages(query: MessageQuery): Promise<MessagePage>
  exportChat(request: ChatExportRequest): Promise<string | null>
  tasks(): Promise<BackgroundTask[]>
  taskAction(id: string, action: TaskAction): Promise<void>
  onTasks(callback: (tasks: BackgroundTask[]) => void): () => void
  revealTaskFile(id: string): Promise<void>
  schedules(): Promise<ExportSchedule[]>
  saveSchedule(input: ScheduleInput): Promise<ExportSchedule | null>
  deleteSchedule(id: string): Promise<void>
  mediaStatus(): Promise<MediaStatus>
  prepareMediaModel(mode: 'download' | 'folder'): Promise<string | null>
  processMedia(request: MediaRequest): Promise<MediaResult>
}
