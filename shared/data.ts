import { analysisSchema, MAX_CONTEXT_CHARACTERS, MAX_CONTEXT_MESSAGES, type AnalysisInput, type AnalysisMode, type ChatMessage, type Dataset } from './contracts.js'
import { exactId, parseLosslessJson, parseMessageContent } from './message-content.js'

const mediaLabels: Record<number, [ChatMessage['type'], string]> = {
  0: ['text', ''], 1: ['text', ''], 3: ['image', '[图片]'], 34: ['voice', '[语音]'],
  43: ['video', '[视频]'], 47: ['image', '[表情]'], 49: ['file', '[文件或链接]'], 10000: ['system', '[系统消息]']
}

export function normalizeWxid(directoryName: string): string {
  const value = directoryName.trim()
  if (/^wxid_/i.test(value)) return value.match(/^(wxid_[^_]+)/i)?.[1] || value
  return value.replace(/_[a-zA-Z0-9]{4}$/, '')
}

export function timestampSeconds(value: unknown): number {
  const number = typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value) ? Date.parse(value) / 1000 : Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  const seconds = Math.floor(number > 10000000000 ? number / 1000 : number)
  return seconds <= 4102444800 ? seconds : 0
}

export function textFromContent(value: unknown): string {
  return parseMessageContent(value).text
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function normalizeMessage(value: unknown, index: number, options: { chatlab?: boolean; owner?: string; names?: Map<string, string> } = {}): ChatMessage | null {
  const row = object(value)
  if (!['text', 'content', 'parsedContent', 'message_content', 'rawContent', 'createTime', 'create_time', 'timestamp'].some(key => key in row)) return null
  const senderId = String(row.senderId ?? row.senderUsername ?? row.sender_username ?? row.sender ?? row.talker ?? '')
  const timestamp = timestampSeconds(row.createTime ?? row.create_time ?? row.timestamp ?? row.time)
  const numericType = Number(row.localType ?? row.local_type ?? row.type ?? (options.chatlab ? 0 : 1))
  const chatlabTypes: Record<number, ChatMessage['type']> = { 0: 'text', 1: 'image', 2: 'voice', 3: 'video', 4: 'file', 5: 'image', 80: 'system' }
  const type = typeof row.type === 'string' && ['text', 'image', 'voice', 'video', 'file', 'system', 'other'].includes(row.type) ? row.type as ChatMessage['type'] : options.chatlab ? chatlabTypes[numericType] || 'other' : mediaLabels[numericType]?.[0] || 'other'
  const parsed = parseMessageContent(row.rawContent ?? row.message_content ?? row.content ?? row.text ?? row.parsedContent)
  const rawText = parsed.quote || parsed.forwarded ? parsed.text : textFromContent(row.parsedContent ?? row.text ?? row.content ?? row.message_content ?? row.rawContent)
  const typeLabels = { text: '[空消息]', image: '[图片]', voice: '[语音]', video: '[视频]', file: '[文件]', system: '[系统消息]', other: '[其他消息]' }
  const text = rawText || typeLabels[type]
  if (Object.keys(row).length === 0 || !text) return null
  const self = row.self === true || row.isSend === true || row.isSend === 1 || row.is_send === 1 || row.computed_is_send === 1 || (Boolean(options.owner) && senderId === options.owner)
  const serverId = exactId(row.serverIdRaw ?? row.serverId ?? row.server_id ?? row.svr_id ?? row.platformMessageId)
  const localId = exactId(row.localId ?? row.local_id)
  return {
    id: exactId(row.id) || (serverId ? `svr:${serverId}` : `${timestamp}:${localId ?? index}`),
    serverId, localId,
    timestamp,
    sender: self ? '我' : String(row.accountName ?? row.senderDisplayName ?? row.senderName ?? (typeof row.senderId === 'string' && typeof row.sender === 'string' ? row.sender : undefined) ?? options.names?.get(senderId) ?? senderId ?? '联系人').slice(0, 128) || '联系人',
    senderId: senderId || undefined,
    self,
    text,
    type,
    quote: parsed.quote || (typeof row.quote === 'object' && row.quote && typeof (row.quote as any).text === 'string' ? row.quote as ChatMessage['quote'] : undefined),
    forwarded: parsed.forwarded || (Array.isArray(row.forwarded) ? row.forwarded.filter((item: any) => typeof item?.text === 'string').map((item: any) => ({ text: item.text, sender: typeof item.sender === 'string' ? item.sender : undefined })) : undefined),
    link: parsed.link || (typeof row.link === 'string' && /^https?:\/\//i.test(row.link) ? row.link : undefined), imageMd5: parsed.imageMd5 || (typeof row.imageMd5 === 'string' && /^[a-f\d]{32}$/i.test(row.imageMd5) ? row.imageMd5 : undefined),
    transcript: typeof row.transcript === 'string' ? row.transcript : undefined
  }
}

export function parseImportedDataset(text: string, fileName: string): Dataset {
  if (new TextEncoder().encode(text).byteLength > 25 * 1024 * 1024) throw new Error('文件超过 25 MB，请按会话或日期分别导入')
  let parsed: unknown
  try { parsed = parseLosslessJson(text.replace(/^\uFEFF/, '')) } catch {
    if (!fileName.toLowerCase().endsWith('.jsonl')) throw new Error('文件不是有效的 JSON，支持 WeFlow JSON 和 ChatLab 格式')
    const lines = text.split(/\r?\n/).filter(line => line.trim())
    if (lines.length > 200000) throw new Error('JSONL 文件记录过多，请按会话或日期拆分')
    try {
      const entries = lines.map(line => parseLosslessJson(line))
      const header = object(entries[0])
      const content = header.chatlab || header.meta ? entries.slice(1) : entries
      parsed = {
        ...(header.chatlab || header.meta ? header : { chatlab: {} }),
        members: [...(Array.isArray(header.members) ? header.members : []), ...content.filter(item => item?._type === 'member')],
        messages: content.filter(item => !item?._type || item._type === 'message')
      }
    } catch { throw new Error('JSONL 文件包含无效记录') }
  }
  const root = object(parsed)
  if (object(root.weflow).format === 'arkme-json') throw new Error('暂不支持 Arkme 紧凑格式，请在 WeFlow 中选择 JSON 或 ChatLab 导出')
  const meta = object(root.meta ?? root.session ?? root.chat)
  const rows = Array.isArray(parsed) ? parsed : root.messages ?? object(root.data).messages
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('文件中没有可导入的 messages 消息列表')
  if (rows.length > 100000) throw new Error('单次最多导入 100,000 条消息')
  const names = new Map<string, string>()
  if (Array.isArray(root.members)) for (const member of root.members) {
    const item = object(member)
    names.set(String(item.platformId ?? item.id ?? ''), String(item.accountName ?? item.name ?? '联系人'))
  }
  const seen = new Set<string>()
  const messages = rows.map((row, index) => normalizeMessage(row, index, { chatlab: Boolean(root.chatlab), owner: String(meta.ownerId ?? root.myWxid ?? ''), names }))
    .filter((message): message is ChatMessage => Boolean(message))
    .filter(message => { if (seen.has(message.id)) return false; seen.add(message.id); return true })
    .sort((a, b) => a.timestamp - b.timestamp)
  if (messages.length === 0) throw new Error('没有识别到有效的聊天记录')
  return {
    session: {
      id: `import:${crypto.randomUUID()}`,
      name: String(meta.name ?? meta.displayName ?? root.sessionName ?? fileName.replace(/\.(jsonl?|txt)$/i, '')).slice(0, 100),
      kind: meta.type === 'group' || meta.isGroup === true || String(meta.id ?? meta.username ?? meta.talker ?? '').endsWith('@chatroom') ? 'group' : 'private',
      lastTimestamp: messages.at(-1)!.timestamp,
      preview: messages.at(-1)!.text.slice(0, 100),
      count: messages.length,
      source: 'import'
    },
    messages
  }
}

export function redactText(text: string): string {
  return text
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, '[手机号]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱]')
    .replace(/wxid_[a-zA-Z0-9_-]+/g, '[微信号]')
}

export function prepareAnalysis(options: { messages: ChatMessage[]; mode: AnalysisMode; question: string; sessionName: string; anonymize: boolean; consent: boolean }): {
  input: AnalysisInput; references: Record<string, string>; shortened: number
} {
  if (!options.consent) throw new Error('请先确认允许将所选内容发送至云端分析')
  if (options.messages.length > MAX_CONTEXT_MESSAGES) throw new Error(`单次最多分析 ${MAX_CONTEXT_MESSAGES} 条消息`)
  const aliases = new Map<string, string>()
  for (const message of options.messages) if (!message.self && !aliases.has(message.sender)) aliases.set(message.sender, `联系人 ${aliases.size + 1}`)
  const anonymizeText = (value: string) => {
    let text = redactText(value)
    for (const [name, alias] of aliases) if (name.length >= 2) text = text.split(name).join(alias)
    return text
  }
  const references: Record<string, string> = {}
  let shortened = 0
  const messages = options.messages.map((message, index) => {
    const id = `M${index + 1}`
    references[id] = message.id
    let text = message.text
    if (options.anonymize) text = anonymizeText(text)
    if (text.length > 4000) { shortened++; text = `${text.slice(0, 3960)}\n[此条消息过长，后续内容未发送]` }
    return { id, timestamp: message.timestamp, sender: message.self ? '我' : options.anonymize ? aliases.get(message.sender)! : message.sender.slice(0, 64), text }
  })
  if (messages.reduce((sum, message) => sum + message.text.length + message.sender.length, 0) > MAX_CONTEXT_CHARACTERS) throw new Error('所选文本超过 48,000 字符，请缩小消息范围')
  return {
    input: analysisSchema.parse({ requestId: crypto.randomUUID(), mode: options.mode, question: options.anonymize ? anonymizeText(options.question) : options.question, sessionName: options.anonymize ? '用户选定会话' : options.sessionName, consent: true, messages }),
    references,
    shortened
  }
}
