import type { ChatMessage } from './contracts.js'

export function parseLosslessJson(text: string): any {
  return JSON.parse(text, ((key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (context?.source && /^-?\d+$/.test(context.source)) return context.source
      throw new Error(`数值 ${key} 超出安全整数范围，请使用字符串保存消息 ID`)
    }
    return value
  }) as Parameters<typeof JSON.parse>[1])
}
export function exactId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() && value !== '0') return value.trim()
  if (typeof value === 'bigint') return value > 0n ? String(value) : undefined
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return undefined
}
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    if (entity[0] === '#') { const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity.toLowerCase() as 'amp'] || whole
  })
}
function xmlElements(xml: string, name: string): Array<{ body: string; full: string }> {
  const result: Array<{ body: string; full: string }> = []
  const pattern = new RegExp(`<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|<!--[\\s\\S]*?-->|<\\/?${name}\\b[^>]*>`, 'gi')
  let depth = 0, start = 0, body = 0
  for (const match of xml.matchAll(pattern)) {
    const token = match[0]
    if (token.startsWith('<!') || token.endsWith('/>')) continue
    if (token.startsWith('</')) { if (depth > 0 && --depth === 0) result.push({ body: xml.slice(body, match.index), full: xml.slice(start, match.index + token.length) }) }
    else if (depth++ === 0) { start = match.index; body = match.index + token.length }
  }
  return result
}
export function xmlValue(xml: string, name: string): string {
  const value = xmlElements(xml, name)[0]?.body || ''
  return decodeEntities(value.replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/, '$1')).trim()
}
const clean = (text: string) => decodeEntities(text.replace(/<[^>]+>/g, '')).trim()
export function parseMessageContent(value: unknown, depth = 0): { text: string; quote?: ChatMessage['quote']; forwarded?: ChatMessage['forwarded']; link?: string; imageMd5?: string } {
  if (typeof value !== 'string') return { text: '' }
  let xml = value.replace(/\x00/g, '').trim()
  if (/^&lt;(?:\?xml|msg|appmsg|sysmsg)/i.test(xml)) xml = decodeEntities(xml)
  if (!/^(?:<\?xml|<msg[\s>]|<appmsg[\s>]|<sysmsg[\s>])/i.test(xml)) return { text: xml }
  if (xml.length > 1024 * 1024 || depth > 8) return { text: '[内容过长或转发层级过深]' }
  const quoted = xmlElements(xml, 'refermsg')[0]
  const quotedXml = quoted?.body
  let quote: ChatMessage['quote']
  if (quotedXml) {
    const content = xmlValue(quotedXml, 'content')
    let selected = ['selectedcontent', 'selectedtext', 'quotetext', 'quotecontent', 'excerpt'].map(tag => xmlValue(quotedXml, tag)).find(Boolean)
    const start = xmlValue(quotedXml, 'startindex'), end = xmlValue(quotedXml, 'endindex')
    if (!selected && /^\d+$/.test(start) && /^\d+$/.test(end) && Number(end) >= Number(start)) selected = Array.from(content).slice(Number(start), Number(end) + 1).join('')
    const startChar = xmlValue(quotedXml, 'start'), endChar = xmlValue(quotedXml, 'end')
    if (!selected && startChar && endChar) { const a = content.indexOf(startChar); const b = content.indexOf(endChar, a + startChar.length - 1); if (a >= 0 && b >= a) selected = content.slice(a, b + endChar.length) }
    quote = { text: selected || parseMessageContent(content, depth + 1).text || '[引用消息]', sender: xmlValue(quotedXml, 'displayname') || undefined, senderId: xmlValue(quotedXml, 'fromusr') || undefined, serverId: exactId(xmlValue(quotedXml, 'svrid')) }
  }
  const outer = quoted ? xml.replace(quoted.full, '') : xml
  const forwarded: NonNullable<ChatMessage['forwarded']> = []
  if (xmlValue(outer, 'type') === '19' || /<recorditem/.test(outer)) {
    const record = xmlValue(outer, 'recorditem') || outer
    for (const match of xmlElements(record, 'dataitem')) {
      if (forwarded.length >= 1000) { forwarded.push({ text: '[其余转发内容未展开]' }); break }
      const body = match.body, nested = xmlValue(body, 'recordxml')
      const text = nested && depth < 8 ? parseMessageContent(`<msg><appmsg><type>19</type><recorditem>${nested}</recorditem></appmsg></msg>`, depth + 1).text : xmlValue(body, 'datadesc') || xmlValue(body, 'datatitle') || '[媒体消息]'
      forwarded.push({ sender: xmlValue(body, 'sourcename') || undefined, text: clean(text) })
    }
  }
  const values = (forwarded.length ? ['title', 'des'] : ['title', 'des', 'content', 'replacemsg']).map(field => clean(xmlValue(outer, field))).filter(Boolean)
  const url = xmlValue(outer, 'url')
  const link = /^https?:\/\//i.test(url) ? url : undefined
  if (link) values.push(link)
  if (quote) values.push(`引用${quote.sender ? ` ${quote.sender}` : ''}：${quote.text}`)
  if (forwarded.length) values.push('[合并转发]', ...forwarded.map(item => `${item.sender ? `${item.sender}：` : ''}${item.text}`))
  const imageMd5 = /<img\b[^>]*\bmd5=["']([a-f\d]{32})["']/i.exec(xml)?.[1]
  return { text: [...new Set(values)].join('\n'), quote, forwarded: forwarded.length ? forwarded : undefined, link, imageMd5 }
}
