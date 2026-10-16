import { z } from 'zod'
import type { LocalWorkbenchAPI, WeChatConnectOptions, WeFlowConnectOptions } from './workbench.js'
import type { ReportRange, ReportSource, GroupReportInput, GroupReportEvent, SavedGroupReport, ReportTemplates } from './group-report.js'

export const MAX_CONTEXT_MESSAGES = 300
export const MAX_CONTEXT_CHARACTERS = 48000
export const analysisModes = ['summary', 'actions', 'question'] as const
export type AnalysisMode = typeof analysisModes[number]

export interface ChatMessage {
  id: string
  timestamp: number
  sender: string
  senderId?: string
  serverId?: string
  localId?: string
  quote?: { text: string; sender?: string; senderId?: string; serverId?: string }
  forwarded?: Array<{ sender?: string; text: string }>
  link?: string
  imageMd5?: string
  transcript?: string
  self: boolean
  text: string
  type: 'text' | 'image' | 'voice' | 'video' | 'file' | 'system' | 'other'
}

export interface ChatSession {
  id: string
  name: string
  kind: 'private' | 'group'
  lastTimestamp: number
  preview: string
  count?: number
  source: 'wechat' | 'import' | 'sample' | 'weflow'
}

export interface Dataset { session: ChatSession; messages: ChatMessage[] }
export interface UserInfo { id: string; username: string; displayName: string }
export interface QuotaInfo { limit: number; used: number; pending: number; remaining: number; resetsAt: string }
export interface AccountInfo { user: UserInfo; quota: QuotaInfo; offline?: boolean }
export interface HealthInfo { status: 'ok'; version: string; aiReady: boolean; mode: 'cloud' | 'demo' }

export const loginSchema = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_-]+$/),
  password: z.string().min(10).max(128)
}).strict()
export const registerSchema = loginSchema.extend({
  displayName: z.string().trim().min(1).max(32),
  inviteCode: z.string().trim().min(8).max(128)
})
export type LoginInput = z.infer<typeof loginSchema>
export type RegisterInput = z.infer<typeof registerSchema>

export const contextMessageSchema = z.object({
  id: z.string().regex(/^M[1-9]\d{0,3}$/),
  timestamp: z.number().int().nonnegative().max(4102444800),
  sender: z.string().min(1).max(64),
  text: z.string().min(1).max(4000)
}).strict()

export const analysisSchema = z.object({
  requestId: z.string().uuid(),
  mode: z.enum(analysisModes),
  question: z.string().trim().max(1000),
  sessionName: z.string().trim().min(1).max(100),
  consent: z.literal(true),
  messages: z.array(contextMessageSchema).min(1).max(MAX_CONTEXT_MESSAGES)
}).strict().superRefine((value, ctx) => {
  if (value.mode === 'question' && !value.question) ctx.addIssue({ code: 'custom', message: '请填写要询问的问题', path: ['question'] })
  if (value.messages.reduce((sum, message) => sum + message.text.length + message.sender.length, 0) > MAX_CONTEXT_CHARACTERS) {
    ctx.addIssue({ code: 'custom', message: '所选内容过长，请缩小范围', path: ['messages'] })
  }
  if (new Set(value.messages.map(message => message.id)).size !== value.messages.length) {
    ctx.addIssue({ code: 'custom', message: '消息引用编号不能重复', path: ['messages'] })
  }
})

export type AnalysisInput = z.infer<typeof analysisSchema>
export type AnalysisEvent =
  | { type: 'start'; requestId: string }
  | { type: 'delta'; text: string }
  | { type: 'complete'; requestId: string; quota: QuotaInfo; inputTokens: number; outputTokens: number; demo: boolean; truncated: boolean }
  | { type: 'error'; code: string; message: string }

export interface SavedReport {
  id: string
  title: string
  mode: AnalysisMode
  createdAt: number
  sourceName: string
  messageCount: number
  content: string
  demo: boolean
  evidence?: Array<{ id: string; sender: string; timestamp: number; text: string }>
}

export interface LocalStatus { connected: boolean; source: ChatSession['source'] | null; accountName?: string }
export interface DesktopAPI extends LocalWorkbenchAPI {
  platform: 'desktop'
  health(): Promise<HealthInfo>
  login(input: LoginInput): Promise<AccountInfo>
  register(input: RegisterInput): Promise<AccountInfo>
  account(): Promise<AccountInfo | null>
  logout(): Promise<void>
  localStatus(): Promise<LocalStatus>
  sessions(): Promise<ChatSession[]>
  messages(sessionId: string, limit: number): Promise<ChatMessage[]>
  importFile(): Promise<ChatSession | null>
  sample(): Promise<ChatSession[]>
  connectWeChat(options?: WeChatConnectOptions): Promise<ChatSession[]>
  connectWeFlow(options?: WeFlowConnectOptions): Promise<ChatSession[]>
  disconnect(): Promise<void>
  analyze(input: AnalysisInput): Promise<void>
  cancelAnalysis(): Promise<void>
  onAnalysis(callback: (event: AnalysisEvent) => void): () => void
  reports(): Promise<SavedReport[]>
  saveReport(report: SavedReport): Promise<void>
  deleteReport(id: string): Promise<void>
  exportReport(report: SavedReport): Promise<boolean>
  copyText(text: string): Promise<void>
  reportSource(range: ReportRange): Promise<ReportSource>
  generateGroupReport(input: GroupReportInput): Promise<void>
  onGroupReport(callback: (event: GroupReportEvent) => void): () => void
  groupReports(): Promise<SavedGroupReport[]>
  saveGroupReport(report: SavedGroupReport): Promise<void>
  deleteGroupReport(id: string): Promise<void>
  reportTemplates(): Promise<ReportTemplates>
  saveReportTemplates(templates: ReportTemplates): Promise<void>
  exportGroupReport(report: SavedGroupReport, format: 'png' | 'png-pages' | 'pdf' | 'html'): Promise<{ saved: boolean; files: number }>
  onConnectionProgress(callback: (message: string) => void): () => void
}
