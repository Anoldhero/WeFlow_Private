import { parentPort } from 'node:worker_threads'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decompress } from 'fzstd'
import { normalizeMessage, normalizeWxid } from '../shared/data.js'
import { parseLosslessJson } from '../shared/message-content.js'
import type { GroupMember } from '../shared/workbench.js'
import type { ChatMessage, ChatSession } from '../shared/contracts.js'

const koffi = require('koffi')
let library: any
let api: Record<string, (...args: any[]) => any> = {}
let accountHandle: number | null = null
let wxid = ''
let initialized = false
const readers = new Set<number>()

function initialize(resources: string): void {
  if (!library) {
    for (const name of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_1.dll', 'WCDB.dll', 'SDL2.dll']) {
      const file = join(resources, name)
      if (existsSync(file)) koffi.load(file)
    }
    library = koffi.load(join(resources, 'wcdb_api.dll'))
    const definitions = {
      init: 'int32 wcdb_init()', shutdown: 'int32 wcdb_shutdown()',
      open: 'int32 wcdb_open_account(const char* path, const char* key, _Out_ int64* handle)',
      free: 'void wcdb_free_string(void* ptr)',
      sessions: 'int32 wcdb_get_sessions(int64 handle, _Out_ void** outJson)',
      names: 'int32 wcdb_get_display_names(int64 handle, const char* usernamesJson, _Out_ void** outJson)',
      openCursor: 'int32 wcdb_open_message_cursor(int64 handle, const char* sessionId, int32 batchSize, int32 ascending, int32 beginTimestamp, int32 endTimestamp, _Out_ int64* outCursor)',
      fetch: 'int32 wcdb_fetch_message_batch(int64 handle, int64 cursor, _Out_ void** outJson, _Out_ int32* outHasMore)',
      closeCursor: 'int32 wcdb_close_message_cursor(int64 handle, int64 cursor)'
    }
    for (const [name, signature] of Object.entries(definitions)) api[name] = library.func(signature)
    try { api.setWxid = library.func('int32 wcdb_set_my_wxid(int64 handle, const char* wxid)') } catch {}
    for (const [name, signature] of Object.entries({ members: 'int32 wcdb_get_group_members(int64 handle, const char* chatroomId, _Out_ void** outJson)', groupNames: 'int32 wcdb_get_group_nicknames(int64 handle, const char* chatroomId, _Out_ void** outJson)', voice: 'int32 wcdb_get_voice_data(int64 handle, const char* sessionId, int32 createTime, int32 localId, int64 svrId, const char* candidatesJson, _Out_ void** outHex)', imagePaths: 'int32 wcdb_resolve_image_hardlink(int64 handle, const char* md5, const char* accountDir, _Out_ void** outJson)' })) {
      try { api[name] = library.func(signature) } catch {}
    }
  }
  if (!initialized) { if (api.init() !== 0) throw new Error('数据库读取组件初始化失败'); initialized = true }
}

function findSessionDb(directory: string, depth = 0): string | null {
  if (depth > 5) return null
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase() === 'session.db') return join(directory, entry.name)
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) {
    const match = findSessionDb(join(directory, entry.name), depth + 1)
    if (match) return match
  }
  return null
}

function readJson(method: (...args: any[]) => number, ...args: any[]): any {
  const output = [null]
  const code = method(...args, output)
  if (code !== 0 || !output[0]) throw new Error(`读取微信数据失败（错误码 ${code}）`)
  try { return parseLosslessJson(koffi.decode(output[0], 'char', -1)) } finally { api.free(output[0]) }
}

function close(): void {
  readers.clear()
  if (initialized) api.shutdown()
  initialized = false
  accountHandle = null
}

function connect(payload: { resources: string; accountDir: string; key: string; wxid: string }): boolean {
  if (!/^[a-fA-F0-9]{64}$/.test(payload.key)) throw new Error('数据库密钥格式无效')
  close()
  initialize(payload.resources)
  const dbDirectory = existsSync(join(payload.accountDir, 'db_storage')) ? join(payload.accountDir, 'db_storage') : payload.accountDir
  const sessionDb = findSessionDb(dbDirectory)
  if (!sessionDb) throw new Error('所选目录中没有找到微信 session.db')
  const handle = [0]
  const code = api.open(sessionDb, payload.key, handle)
  if (code !== 0 || handle[0] <= 0) throw new Error('无法打开微信数据库，请确认选择了当前登录账号的数据目录')
  accountHandle = handle[0]
  wxid = normalizeWxid(payload.wxid)
  api.setWxid?.(accountHandle, wxid)
  return true
}

function sessions(): ChatSession[] {
  if (!accountHandle) throw new Error('请先连接微信')
  const rows = readJson(api.sessions, accountHandle)
  if (!Array.isArray(rows)) throw new Error('微信会话数据格式不受支持')
  const ids = rows.map(row => String(row.username || row.user_name || row.talker || '')).filter(Boolean)
  let names: Record<string, string> = {}
  try { names = readJson(api.names, accountHandle, JSON.stringify(ids)) } catch {}
  return rows.map(row => {
    const id = String(row.username || row.user_name || row.talker || '')
    return { id, name: names[id] || id, kind: id.endsWith('@chatroom') ? 'group' as const : 'private' as const, lastTimestamp: Number(row.last_timestamp || row.sort_timestamp || 0), preview: String(row.summary || row.digest || '').slice(0, 100), source: 'wechat' as const }
  }).filter(row => row.id && !row.id.startsWith('placeholder_')).sort((a, b) => b.lastTimestamp - a.lastTimestamp)
}

function decode(raw: unknown): string {
  if (!raw) return ''
  let bytes: Buffer | null = Buffer.isBuffer(raw) || raw instanceof Uint8Array ? Buffer.from(raw) : null
  if (typeof raw === 'string' && raw.length > 16) {
    if (/^(?:[a-fA-F0-9]{2})+$/.test(raw)) bytes = Buffer.from(raw, 'hex')
    else if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw) && raw.length % 4 === 0) bytes = Buffer.from(raw, 'base64')
  }
  if (bytes) {
    try {
      if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0xfd2fb528) {
        const data = decompress(bytes)
        return data.length <= 1024 * 1024 ? Buffer.from(data).toString('utf8') : '[消息过长]'
      }
      const text = bytes.toString('utf8')
      if (!text.includes('\ufffd') && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return text
    } catch { return '[无法解码的消息]' }
  }
  return typeof raw === 'string' ? raw : ''
}

function messages(payload: { sessionId: string; limit: number; start?: number; end?: number; complete?: boolean }): ChatMessage[] {
  if (!accountHandle) throw new Error('请先连接微信')
  const cursor = [0]
  if (api.openCursor(accountHandle, payload.sessionId, Math.min(payload.limit, 500), payload.complete ? 1 : 0, payload.start || 0, payload.end ? payload.end - 1 : 0, cursor) !== 0 || !cursor[0]) throw new Error('读取消息失败，请重新连接微信')
  const rows: Record<string, unknown>[] = []
  try {
    while (rows.length < payload.limit) {
      const output = [null]
      const more = [0]
      if (api.fetch(accountHandle, cursor[0], output, more) !== 0 || !output[0]) throw new Error('消息读取中断，请重新加载')
      let batch: Record<string, unknown>[]
      try { batch = parseLosslessJson(koffi.decode(output[0], 'char', -1)) } finally { api.free(output[0]) }
      if (!Array.isArray(batch)) throw new Error('微信消息格式不受支持')
      rows.push(...batch)
      if (payload.complete && (rows.length > payload.limit || (more[0] && rows.length >= payload.limit))) throw new Error('本期消息超过 12,000 条，请先生成日报或缩小分析范围')
      if (payload.complete && more[0] && batch.length === 0) throw new Error('微信返回的分页状态不完整，请重新读取本期记录')
      if (!more[0] || batch.length === 0) break
    }
  } finally { api.closeCursor(accountHandle, cursor[0]) }
  return mapRows(rows.slice(0, payload.limit), payload.sessionId).filter(message => (!payload.start || message.timestamp >= payload.start) && (!payload.end || message.timestamp < payload.end)).sort((a, b) => a.timestamp - b.timestamp)
}

function mapRows(rows: Record<string, unknown>[], sessionId: string): ChatMessage[] {
  const senderIds = [...new Set(rows.map(row => String(row.sender_username || row.senderUsername || '')).filter(Boolean))]
  let names: Record<string, string> = {}
  try { names = readJson(api.names, accountHandle, JSON.stringify(senderIds)) } catch {}
  if (sessionId.endsWith('@chatroom') && api.groupNames) try { names = { ...names, ...readJson(api.groupNames, accountHandle, sessionId) } } catch {}
  return rows.map((row, index) => normalizeMessage({ ...row, content: decode(row.compress_content) || decode(row.message_content), isSend: Number(row.computed_is_send ?? row.is_send ?? 0) }, index, { owner: wxid, names: new Map(Object.entries(names).filter(([, name]) => Boolean(name))) })).filter((message): message is ChatMessage => Boolean(message))
}
function openReader(payload: { sessionId: string; start: number; end: number }): number {
  if (!accountHandle) throw new Error('请先连接微信')
  const cursor = [0]
  if (api.openCursor(accountHandle, payload.sessionId, 500, 1, payload.start, payload.end - 1, cursor) !== 0 || !cursor[0]) throw new Error('无法打开微信消息游标')
  readers.add(cursor[0]); return cursor[0]
}
function closeReader(cursor: number): void { if (readers.delete(cursor) && accountHandle) api.closeCursor(accountHandle, cursor) }
function readBatch(payload: { cursor: number; sessionId: string }): { messages: ChatMessage[]; hasMore: boolean } {
  if (!accountHandle || !readers.has(payload.cursor)) throw new Error('消息游标已关闭')
  const out = [null], more = [0]
  const code = api.fetch(accountHandle, payload.cursor, out, more)
  if (code !== 0 || !out[0]) throw new Error('消息分页读取失败')
  try {
    const rows = parseLosslessJson(koffi.decode(out[0], 'char', -1))
    if (!Array.isArray(rows) || (more[0] && !rows.length)) throw new Error('微信分页数据不完整')
    return { messages: mapRows(rows, payload.sessionId), hasMore: Boolean(more[0]) }
  } finally { api.free(out[0]) }
}
function members(sessionId: string): GroupMember[] {
  if (!accountHandle || !api.members) return []
  const rows = readJson(api.members, accountHandle, sessionId)
  if (!Array.isArray(rows)) return []
  const ids = rows.map(item => typeof item === 'string' ? item : String(item.username || item.wxid || ''))
  const names = readJson(api.names, accountHandle, JSON.stringify(ids))
  let groupNames: Record<string, string> = {}
  if (api.groupNames) try { groupNames = readJson(api.groupNames, accountHandle, sessionId) } catch {}
  return ids.filter(Boolean).map(id => ({ id: id === wxid ? '__self__' : id, name: id === wxid ? '我' : groupNames[id] || names[id] || id, groupName: groupNames[id], count: 0 }))
}
function voice(payload: { sessionId: string; message: ChatMessage }): string {
  if (!accountHandle || !api.voice) throw new Error('当前组件不能直接读取语音，可选择本机语音文件')
  const output = [null], m = payload.message
  if (api.voice(accountHandle, payload.sessionId, m.timestamp, Number(m.localId || 0), BigInt(m.serverId || '0'), JSON.stringify([m.senderId, wxid, payload.sessionId].filter(Boolean)), output) !== 0 || !output[0]) throw new Error('本机语音数据未找到，请选择已导出的语音文件')
  try { const value = String(koffi.decode(output[0], 'char', -1)); if (!/^[a-f\d]+$/i.test(value) || value.length > 40 * 1024 * 1024) throw new Error('语音数据无效或过大'); return value } finally { api.free(output[0]) }
}

let queue = Promise.resolve()
parentPort?.on('message', (message: { id: number; type: string; payload: any }) => {
  queue = queue.then(() => {
    try {
      const result = message.type === 'connect' ? connect(message.payload) : message.type === 'sessions' ? sessions() : message.type === 'messages' ? messages(message.payload) : message.type === 'close' ? close() : message.type === 'openReader' ? openReader(message.payload) : message.type === 'readBatch' ? readBatch(message.payload) : message.type === 'closeReader' ? closeReader(message.payload.cursor) : message.type === 'members' ? members(message.payload.sessionId) : message.type === 'voice' ? voice(message.payload) : message.type === 'imagePaths' && api.imagePaths ? readJson(api.imagePaths, accountHandle, message.payload.md5, message.payload.accountDir) : (() => { throw new Error('当前组件不支持此数据操作') })()
      parentPort?.postMessage({ id: message.id, result })
    } catch (error) { parentPort?.postMessage({ id: message.id, error: error instanceof Error ? error.message : '微信读取失败' }) }
  })
})
