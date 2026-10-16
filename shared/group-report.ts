import { z } from 'zod'
import type { ChatMessage, ChatSession, Dataset, QuotaInfo } from './contracts.js'
import { redactText } from './data.js'

export const REPORT_MAX_MESSAGES = 12000
export const REPORT_MAX_CHARACTERS = 600000
export const reportKinds = ['daily', 'weekly'] as const
export type ReportKind = typeof reportKinds[number]
export const reportStyles = ['cards', 'briefing', 'editorial'] as const
export type ReportStyle = typeof reportStyles[number]
export const REPORT_COLUMNS = [
  { id: 'overview', title: '一分钟速览', instruction: '用少量要点概括本期最值得知道的讨论，避免泛泛而谈。' },
  { id: 'topics', title: '热点话题', instruction: '归并重复话题，提炼主题、关键结论和讨论分歧。不得捏造热度或排序依据。' },
  { id: 'insights', title: '讨论精华', instruction: '保留有解释力的经验、方法、实践案例，说明适用条件。' },
  { id: 'resources', title: '资源链接', instruction: '整理原文中实际出现的链接和资源用途；不访问链接，不臆测网页内容。' },
  { id: 'opinions', title: '观点交锋', instruction: '客观概括不同观点及理由，不把个人意见写成群体共识。' },
  { id: 'questions', title: '待解答问题', instruction: '列出截至周期结束仍未得到明确答案的问题，不把后来已经解决的问题列为未解决。' },
  { id: 'timeline', title: '话题脉络', instruction: '按本期消息时间梳理话题如何发展，周报应跨天归并；没有上期数据时不得编造环比。' },
  { id: 'quotes', title: '值得回看的原话', instruction: '挑选有信息量的原话，准确引用并保留上下文，不生成不存在的金句。' },
  { id: 'activity', title: '社群活跃概览', instruction: '本机统计栏目，无需模型生成。' }
] as const

const columnSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), title: z.string().trim().min(1).max(36), instruction: z.string().trim().min(1).max(300), enabled: z.boolean() }).strict()
export const reportTemplateSchema = z.object({
  columns: z.array(columnSchema).min(1).max(12),
  style: z.enum(reportStyles),
  font: z.enum(['system', 'serif']).optional(),
  density: z.enum(['standard', 'comfortable', 'compact']).optional(),
  tone: z.enum(['objective', 'friendly', 'professional']),
  length: z.enum(['short', 'standard', 'detailed']),
  showStats: z.boolean(), showSources: z.boolean(), hideEmpty: z.boolean()
}).strict().refine(value => new Set(value.columns.map(column => column.id)).size === value.columns.length, '栏目编号不能重复')
export type ReportTemplate = z.infer<typeof reportTemplateSchema>
export const reportTemplatesSchema = z.object({ daily: reportTemplateSchema, weekly: reportTemplateSchema }).strict()
export type ReportTemplates = z.infer<typeof reportTemplatesSchema>

export function defaultReportTemplate(kind: ReportKind): ReportTemplate {
  const enabled = kind === 'daily' ? ['overview', 'topics', 'insights', 'resources', 'questions'] : ['overview', 'topics', 'insights', 'opinions', 'resources', 'timeline']
  return { columns: REPORT_COLUMNS.map(column => ({ ...column, enabled: enabled.includes(column.id) })), style: 'cards', tone: 'objective', length: 'standard', showStats: true, showSources: false, hideEmpty: true }
}
export function defaultReportTemplates(): ReportTemplates { return { daily: defaultReportTemplate('daily'), weekly: defaultReportTemplate('weekly') } }

const DAY = 86400
export function localDate(seconds: number): string { return new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 10) }
export function defaultReportDate(kind: ReportKind, now = Date.now()): string {
  const yesterday = Math.floor(now / 1000) - DAY
  if (kind === 'daily') return localDate(yesterday)
  const today = new Date(`${localDate(now / 1000)}T00:00:00+08:00`)
  const weekday = new Date(today.getTime() + 8 * 3600000).getUTCDay()
  return localDate(today.getTime() / 1000 - ((weekday + 6) % 7 + 7) * DAY)
}
export interface ReportPeriod { kind: ReportKind; date: string; start: number; end: number; label: string }
export function reportPeriod(kind: ReportKind, date: string): ReportPeriod {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('请选择有效日期')
  let start = Date.parse(`${date}T00:00:00+08:00`) / 1000
  if (!Number.isFinite(start) || start < 0 || localDate(start) !== date) throw new Error('请选择有效日期')
  if (kind === 'weekly') {
    const weekday = new Date((start + 8 * 3600) * 1000).getUTCDay()
    start -= ((weekday + 6) % 7) * DAY
  }
  const end = start + (kind === 'daily' ? 1 : 7) * DAY
  return { kind, date: localDate(start), start, end, label: kind === 'daily' ? localDate(start) : `${localDate(start)} — ${localDate(end - 1)}` }
}
export const reportRangeSchema = z.object({ sessionId: z.string().min(1).max(512), kind: z.enum(reportKinds), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict()
export type ReportRange = z.infer<typeof reportRangeSchema>
export interface ReportSource { session: ChatSession; period: ReportPeriod; messages: ChatMessage[]; capturedAt: number; complete: true }

export function datasetReportSource(dataset: Dataset, range: ReportRange, now = Date.now()): ReportSource {
  if (dataset.session.id !== range.sessionId || dataset.session.kind !== 'group') throw new Error('请选择一个群聊')
  const period = reportPeriod(range.kind, range.date)
  const end = Math.min(period.end, Math.floor(now / 1000) + 1)
  const messages = dataset.messages.filter(message => message.timestamp >= period.start && message.timestamp < end).sort((a, b) => a.timestamp - b.timestamp)
  if (messages.length > REPORT_MAX_MESSAGES) throw new Error('本期消息超过 12,000 条，请先生成日报或拆分导入记录')
  return { session: dataset.session, period, messages, capturedAt: now, complete: true }
}

export const reportMessageSchema = z.object({ id: z.string().regex(/^M[1-9]\d{0,4}$/), timestamp: z.number().int().nonnegative().max(4102444800), sender: z.string().min(1).max(128), actor: z.string().regex(/^P\d+$/).optional(), text: z.string().min(1).max(12000), type: z.enum(['text', 'image', 'voice', 'video', 'file', 'system', 'other']) }).strict()
export type ReportMessage = z.infer<typeof reportMessageSchema>
export const groupReportInputSchema = z.object({
  requestId: z.string().uuid(), kind: z.enum(reportKinds), date: z.string(),
  sessionName: z.string().min(1).max(100), consent: z.literal(true),
  template: reportTemplateSchema,
  messages: z.array(reportMessageSchema).min(1).max(REPORT_MAX_MESSAGES)
}).strict().superRefine((value, context) => {
  let period: ReportPeriod
  try { period = reportPeriod(value.kind, value.date) } catch { context.addIssue({ code: 'custom', message: '报告日期无效' }); return }
  if (value.messages.some(message => message.timestamp < period.start || message.timestamp >= period.end)) context.addIssue({ code: 'custom', message: '存在不属于所选报告周期的消息' })
  if (new Set(value.messages.map(message => message.id)).size !== value.messages.length) context.addIssue({ code: 'custom', message: '消息引用编号不能重复' })
  if (value.messages.reduce((sum, message) => sum + message.text.length, 0) > REPORT_MAX_CHARACTERS) context.addIssue({ code: 'custom', message: '本期文字超过 60 万字符，请先分日报生成' })
  if (!value.template.columns.some(column => column.enabled && column.id !== 'activity')) context.addIssue({ code: 'custom', message: '请至少选择一个分析栏目' })
})
export type GroupReportInput = z.infer<typeof groupReportInputSchema>

export function prepareGroupReport(source: ReportSource, template: ReportTemplate, anonymize: boolean, consent: boolean): { input: GroupReportInput; originals: ReportMessage[] } {
  if (!consent) throw new Error('请确认允许将所选周期的文字发送到云端')
  if (source.session.kind !== 'group') throw new Error('请选择群聊')
  if (!source.complete) throw new Error('聊天记录尚未完整读取')
  const names = new Map<string, string>()
  const identity = (message: ChatMessage) => message.self ? '__self__' : message.senderId || message.sender
  for (const message of source.messages) if (!message.self && !names.has(identity(message))) names.set(identity(message), `成员 ${names.size + 1}`)
  const ids = new Map([...names.keys()].map((key, index) => [key, `P${index + 1}`]))
  const replacements = new Map<string, string>()
  for (const message of source.messages) if (!message.self) {
    const alias = names.get(identity(message))!
    replacements.set(message.sender, replacements.has(message.sender) && replacements.get(message.sender) !== alias ? '同名成员' : alias)
  }
  const originals = source.messages.map((message, index) => ({ id: `M${index + 1}`, timestamp: message.timestamp, sender: message.sender, actor: message.self ? 'P0' : ids.get(identity(message))!, text: message.text, type: message.transcript ? 'text' as const : message.type }))
  const aliases = [...replacements].filter(([name]) => name.length >= 2).sort((a, b) => b[0].length - a[0].length)
  const pattern = aliases.length ? new RegExp(aliases.map(([name]) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null
  const messages = originals.map((message, index) => ({ ...message, sender: anonymize ? (source.messages[index].self ? '我' : names.get(identity(source.messages[index]))!) : message.sender, text: anonymize ? redactText(pattern ? message.text.replace(pattern, name => replacements.get(name)!) : message.text) : message.text }))
  const parsed = groupReportInputSchema.safeParse({ requestId: crypto.randomUUID(), kind: source.period.kind, date: source.period.date, sessionName: anonymize ? '所选社群' : source.session.name, template, messages, consent: true })
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || '报告配置无效')
  return { input: parsed.data, originals }
}

export const reportSectionSchema = z.object({ id: z.string().max(48), items: z.array(z.object({ title: z.string().max(100), text: z.string().min(1).max(1500), refs: z.array(z.string().regex(/^M[1-9]\d{0,4}$/)).min(1).max(8) }).strict()).max(8) }).strict()
export type ReportSection = z.infer<typeof reportSectionSchema>
export interface ReportStats { messages: number; participants: number; textMessages: number; mediaMessages: number; days: Array<{ date: string; count: number }> }
export function reportStats(messages: ReportMessage[], period: ReportPeriod): ReportStats {
  const days = Array.from({ length: period.kind === 'daily' ? 1 : 7 }, (_, index) => ({ date: localDate(period.start + index * DAY), count: 0 }))
  const counts = new Map(days.map(day => [day.date, day]))
  for (const message of messages) { const day = counts.get(localDate(message.timestamp)); if (day) day.count++ }
  return { messages: messages.length, participants: new Set(messages.filter(message => message.type !== 'system').map(message => message.actor || message.sender)).size, textMessages: messages.filter(message => !['image', 'voice', 'video'].includes(message.type)).length, mediaMessages: messages.filter(message => ['image', 'voice', 'video'].includes(message.type)).length, days }
}

export interface GroupReportResult { sections: ReportSection[]; stats: ReportStats; period: ReportPeriod; demo: boolean; inputTokens: number; outputTokens: number }
export interface SavedGroupReport extends GroupReportResult { id: string; title: string; sourceId: string; sourceName: string; createdAt: number; collectedAt?: number; template: ReportTemplate; evidence: ReportMessage[] }
export type GroupReportEvent = { type: 'start'; requestId: string } | { type: 'progress'; message: string; current: number; total: number } | { type: 'complete'; requestId: string; result: GroupReportResult; quota: QuotaInfo } | { type: 'error'; code: string; message: string }

export function savedGroupReportSchema() {
  return z.object({
    id: z.string().uuid(), title: z.string().min(1).max(120), sourceId: z.string().max(512), sourceName: z.string().max(100), createdAt: z.number().finite(), collectedAt: z.number().finite().nonnegative().optional(), template: reportTemplateSchema,
    period: z.object({ kind: z.enum(reportKinds), date: z.string(), start: z.number().int(), end: z.number().int(), label: z.string().max(50) }).strict(),
    sections: z.array(reportSectionSchema).max(12), demo: z.boolean(), inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(),
    stats: z.object({ messages: z.number().int().nonnegative(), participants: z.number().int().nonnegative(), textMessages: z.number().int().nonnegative(), mediaMessages: z.number().int().nonnegative(), days: z.array(z.object({ date: z.string(), count: z.number().int().nonnegative() })).max(7) }),
    evidence: z.array(reportMessageSchema).max(1000)
  }).strict()
}

export function saveableGroupReport(input: GroupReportInput, result: GroupReportResult, originals: ReportMessage[], source: { id: string; name: string; capturedAt?: number }, title: string): SavedGroupReport {
  const period = reportPeriod(input.kind, input.date)
  if (result.period.start !== period.start || result.period.end !== period.end || result.period.kind !== period.kind) throw new Error('报告响应不属于所选周期')
  const references = new Set(result.sections.flatMap(section => section.items.flatMap(item => item.refs)))
  const evidence = originals.filter(message => references.has(message.id))
  if (references.size !== evidence.length) throw new Error('报告引用与本次聊天记录不匹配')
  return savedGroupReportSchema().parse({ ...result, id: input.requestId, title, sourceId: source.id, sourceName: source.name.slice(0, 100), createdAt: Date.now(), collectedAt: source.capturedAt ?? Date.now(), template: input.template, evidence })
}

export function demoGroupReport(input: { kind: ReportKind; date: string; template?: ReportTemplate }): SavedGroupReport {
  const period = reportPeriod(input.kind, input.date)
  const template = input.template || defaultReportTemplate(input.kind)
  const texts = [
    '本周大家讨论了如何让 AI 工具真正融入日常工作：先选一个重复任务，设定可验证的结果，再逐步扩大范围。',
    '经验分享：整理群聊时先把资源、观点和问题分开；报告中保留消息引用，读者才能回到讨论现场。',
    '值得继续讨论的是本地模型与云端模型的取舍：设备条件、数据范围和响应速度需要一起考虑。',
    '资源整理建议：保留链接的来源消息和分享理由，不能只依据网址猜测内容。示例链接：https://example.com/community-guide',
    '大家对报告长度有不同偏好：有人希望一分钟读完，也有人希望保留细节。可以用可配置栏目满足不同读者。',
    '待解答：怎样衡量一份社群报告是否有用？后续可以观察资源点击、追问和讨论是否继续。'
  ]
  const evidence = texts.map((text, index) => ({ id: `M${index + 1}`, sender: `成员 ${index % 3 + 1}`, timestamp: period.start + (input.kind === 'weekly' ? index * DAY : 0) + 36000, text, type: 'text' as const }))
  const sections = template.columns.filter(column => column.id !== 'activity').map((column, index) => ({ id: column.id, items: [{ title: column.id === 'overview' ? '有价值的讨论，应该更容易被看见' : column.title, text: texts[index % texts.length], refs: [`M${index % texts.length + 1}`] }] }))
  return { id: crypto.randomUUID(), title: input.kind === 'daily' ? '今天的社群，值得回看' : '这一周，把讨论串成线索', sourceId: 'sample:community', sourceName: '行业观察与交流社群', createdAt: Date.now(), template, period, sections, evidence, stats: reportStats(evidence, period), demo: true, inputTokens: 0, outputTokens: 0 }
}

export function communitySampleDataset(now = Date.now()): Dataset {
  const today = reportPeriod('daily', localDate(now / 1000)).start
  const sample = demoGroupReport({ kind: 'daily', date: localDate(today - DAY) }).evidence
  const messages: ChatMessage[] = []
  for (let day = 14; day >= 1; day--) for (let index = 0; index < sample.length; index++) {
    const original = sample[index]
    messages.push({ id: `community-${day}-${index}`, timestamp: today - day * DAY + 10 * 3600 + index * 2400, sender: ['林可', '周远', '许宁'][index % 3], senderId: `sample-member-${index % 3}`, self: false, text: original.text, type: 'text' })
  }
  return { session: { id: 'sample:community', name: '行业观察与交流社群', kind: 'group', lastTimestamp: messages.at(-1)!.timestamp, preview: 'AI 实践、资源分享与社群讨论 · 虚构示例', count: messages.length, source: 'sample' }, messages }
}
