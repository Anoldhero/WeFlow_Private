import type { ChatMessage, ChatSession } from './contracts.js'
import type { ChatExportFormat } from './workbench.js'

export function safeFileName(name: string): string {
  let value = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 80) || '聊天记录'
  if (/^(?:CON|PRN|AUX|NUL|COM\d|LPT\d)(?:\.|$)/i.test(value)) value = `_${value}`
  return value
}
const sql = (text: string | undefined) => text === undefined ? 'NULL' : `'${text.replace(/\x00/g, '').replace(/'/g, "''")}'`
const markdown = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}[\]#|])/g, '\\$1')
export function exportHeader(session: ChatSession, format: ChatExportFormat): string {
  const meta = { name: session.name, type: session.kind, id: session.id }
  if (format === 'json') return `${JSON.stringify({ meta }).slice(0, -1)},"messages":[\n`
  if (format === 'jsonl') return `${JSON.stringify({ _type: 'header', meta })}\n`
  if (format === 'md') return `# ${markdown(session.name)}\n\n以下为所选范围内的原始消息。时间为北京时间。\n\n`
  return 'BEGIN TRANSACTION;\nCREATE TABLE IF NOT EXISTS messages (session_id TEXT, id TEXT, server_id TEXT, timestamp INTEGER, sender_id TEXT, sender TEXT, type TEXT, text TEXT, PRIMARY KEY(session_id,id));\n'
}
export function exportMessage(message: ChatMessage, sessionId: string, format: ChatExportFormat, index: number): string {
  if (format === 'json') return `${index ? ',\n' : ''}${JSON.stringify(message)}`
  if (format === 'jsonl') return `${JSON.stringify({ _type: 'message', ...message })}\n`
  if (format === 'md') {
    const date = new Date(message.timestamp * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    return `### ${markdown(message.sender)} · ${date}\n\n${markdown(message.text)}\n\n消息编号：${markdown(message.serverId || message.id)}\n\n`
  }
  return `INSERT OR REPLACE INTO messages VALUES (${sql(sessionId)},${sql(message.id)},${sql(message.serverId)},${message.timestamp},${sql(message.senderId)},${sql(message.sender)},${sql(message.type)},${sql(message.text)});\n`
}
export const exportFooter = (format: ChatExportFormat) => format === 'json' ? '\n]}\n' : format === 'sql' ? 'COMMIT;\n' : ''
