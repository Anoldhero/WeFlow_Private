import { app, dialog, type BrowserWindow } from 'electron'
import { basename, join, normalize } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { ChatMessage, ChatSession, Dataset, LocalStatus } from '../shared/contracts.js'
import { normalizeMessage, normalizeWxid, parseImportedDataset, timestampSeconds } from '../shared/data.js'
import { inspectMessages, type DataChange, type GroupMember, type MessageQuery, type WeChatConnectOptions, type WeChatProfile, type WeFlowConnectOptions } from '../shared/workbench.js'
import { sampleDatasets } from '../shared/sample.js'
import { NativeClient } from './native-client.js'
import { WeFlowClient } from './weflow-client.js'
import { accountDirectories } from './account-directories.js'
import type { LocalVault } from './vault.js'
import type { TaskContext } from './task-manager.js'
import { REPORT_MAX_MESSAGES, reportPeriod, communitySampleDataset, type ReportRange, type ReportSource } from '../shared/group-report.js'

export interface WeChatConnection { id: string; accountDir: string; key: string; wxid: string; lastUsed: number; imageXorKey?: number; imageAesKey?: string }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export class DataSource {
  private datasets: Dataset[]
  private source: ChatSession['source'] | null
  private native = new NativeClient()
  private flow?: WeFlowClient
  private connecting = false
  private active?: WeChatConnection
  private revision = 0
  private remembered = new Map<string, ChatMessage>()
  private queryCache?: { key: string; at: number; messages: ChatMessage[]; roster: GroupMember[] }
  constructor(private vault: LocalVault, private window: () => BrowserWindow, private resources: string, private changed: (event: DataChange) => void) {
    this.datasets = vault.datasets()
    this.source = this.datasets.length ? 'import' : null
    const old = vault.secret<Omit<WeChatConnection, 'id' | 'lastUsed'>>('wechat')
    if (old && !vault.secret('wechatProfiles')) {
      vault.setSecret('wechatProfiles', [{ ...old, id: hash(normalize(old.accountDir).toLowerCase()).slice(0, 24), lastUsed: 0 }])
      vault.setSecret('wechat', null)
    }
  }
  identity(): string { return this.source === 'wechat' ? `wechat:${this.active?.id}` : this.source === 'weflow' ? `weflow:${this.flow?.port}:${this.flow?.owner || 'unknown'}:${hash(this.vault.secret<{ token: string }>('weflow')?.token || '').slice(0, 12)}` : this.source || '' }
  connection(): WeChatConnection | undefined { return this.source === 'wechat' ? this.active : undefined }
  status(): LocalStatus { return { connected: this.source !== null, source: this.source, accountName: this.active && this.source === 'wechat' ? this.active.wxid : undefined } }
  private invalidate(): void { this.revision++; this.remembered.clear(); this.queryCache = undefined; this.changed({ type: 'changed' }) }
  private remember(sessionId: string, messages: ChatMessage[]): ChatMessage[] {
    const transcripts = this.vault.transcripts()
    const result = messages.map(message => { const text = transcripts[this.transcriptKey(sessionId, message.id)]; return text ? { ...message, transcript: text, text: `[本地语音转写] ${text}` } : message })
    for (const message of result) this.remembered.set(`${sessionId}\0${message.id}`, message)
    while (this.remembered.size > 12000) this.remembered.delete(this.remembered.keys().next().value!)
    return result
  }
  transcriptKey(sessionId: string, messageId: string): string { return hash(`${this.identity()}\0${sessionId}\0${messageId}`) }
  saveTranscript(sessionId: string, messageId: string, text: string): void { this.vault.saveTranscript(this.transcriptKey(sessionId, messageId), text); this.queryCache = undefined; this.changed({ type: 'changed', sessionId }) }
  async findMessage(sessionId: string, messageId: string): Promise<ChatMessage> {
    const message = this.remembered.get(`${sessionId}\0${messageId}`) || (await this.messages(sessionId, 1000)).find(item => item.id === messageId)
    if (!message) throw new Error('消息已不在当前读取范围，请重新查询后操作')
    return message
  }
  async sessions(): Promise<ChatSession[]> {
    if (this.source === 'wechat') return this.native.call('sessions')
    if (this.source === 'weflow' && this.flow) {
      const result = await this.flow.request('/api/v1/sessions?limit=10000')
      if (!result.success || !Array.isArray(result.sessions)) throw new Error('WeFlow 数据库未连接，请先在 WeFlow 中连接微信')
      return result.sessions.map((item: any) => ({ id: String(item.username), name: String(item.displayName || item.username), kind: String(item.username).endsWith('@chatroom') ? 'group' : 'private', lastTimestamp: timestampSeconds(item.lastTimestamp || item.lastTime), preview: String(item.lastMessage || ''), source: 'weflow' }))
    }
    return this.datasets.map(dataset => dataset.session).sort((a, b) => b.lastTimestamp - a.lastTimestamp)
  }
  async messages(sessionId: string, limit: number): Promise<ChatMessage[]> {
    const revision = this.revision
    let messages: ChatMessage[]
    if (this.source === 'wechat') messages = await this.native.call('messages', { sessionId, limit })
    else if (this.source === 'weflow' && this.flow) {
      await this.flow.bindAccount(sessionId)
      const result = await this.flow.request(`/api/v1/messages?talker=${encodeURIComponent(sessionId)}&limit=${limit}&media=0`)
      if (!result.success || !Array.isArray(result.messages)) throw new Error('WeFlow 未返回有效的聊天记录')
      messages = result.messages.map((item: unknown, index: number) => normalizeMessage(item, index)).filter(Boolean).sort((a: ChatMessage, b: ChatMessage) => a.timestamp - b.timestamp)
    } else {
      const dataset = this.datasets.find(item => item.session.id === sessionId)
      if (!dataset) throw new Error('会话不存在，请重新选择')
      messages = dataset.messages.slice(-limit)
    }
    if (revision !== this.revision) throw new Error('数据来源已变化，请重新读取')
    return this.remember(sessionId, messages)
  }
  async readRange(sessionId: string, start: number, end: number, maximum = 100000, context?: TaskContext): Promise<ChatMessage[]> {
    const revision = this.revision
    let messages: ChatMessage[] = []
    if (end <= start) return []
    if (this.source === 'wechat') {
      const cursor = await this.native.call<number>('openReader', { sessionId, start, end })
      try {
        while (true) {
          await context?.checkpoint()
          const batch = await this.native.call<{ messages: ChatMessage[]; hasMore: boolean }>('readBatch', { cursor, sessionId })
          messages.push(...batch.messages)
          context?.progress(messages.length, Math.max(messages.length + (batch.hasMore ? 500 : 0), 1), `正在读取 ${messages.length.toLocaleString()} 条消息`)
          if (messages.length > maximum) throw new Error(`消息超过 ${maximum.toLocaleString()} 条，请缩小日期范围`)
          if (!batch.hasMore) break
        }
      } finally { await this.native.call('closeReader', { cursor }).catch(() => {}) }
    } else if (this.source === 'weflow' && this.flow) messages = await this.flow.readRange(sessionId, start, end, maximum, context?.checkpoint, context?.signal)
    else {
      const dataset = this.datasets.find(item => item.session.id === sessionId)
      if (!dataset) throw new Error('本机记录不存在，请重新导入')
      messages = dataset.messages.filter(message => message.timestamp >= start && message.timestamp < end)
    }
    if (messages.length > maximum) throw new Error(`消息超过 ${maximum.toLocaleString()} 条，请缩小日期范围`)
    if (revision !== this.revision) throw new Error('数据来源已变化，请重新读取')
    return this.remember(sessionId, messages.filter(message => message.timestamp >= start && message.timestamp < end).sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)))
  }
  async query(query: MessageQuery) {
    const key = `${this.identity()}\0${query.sessionId}:${query.start}:${query.end}`
    if (!this.queryCache || this.queryCache.key !== key || Date.now() - this.queryCache.at > 10000) {
      const messages = await this.readRange(query.sessionId, query.start, query.end)
      let roster: GroupMember[] = []
      if (query.sessionId.endsWith('@chatroom')) {
        if (this.source === 'wechat') roster = await this.native.call<GroupMember[]>('members', { sessionId: query.sessionId }).catch(() => [])
        else if (this.source === 'weflow' && this.flow) {
          const result = await this.flow.request(`/api/v1/group-members?chatroomId=${encodeURIComponent(query.sessionId)}`).catch(() => null)
          if (Array.isArray(result?.members)) roster = result.members.map((member: any) => ({ id: String(member.wxid), name: String(member.groupNickname || member.displayName || member.wxid), groupName: member.groupNickname, count: 0 }))
        }
      }
      this.queryCache = { key, at: Date.now(), messages, roster }
    }
    const page = inspectMessages(this.queryCache.messages, query, this.queryCache.roster)
    this.remember(query.sessionId, page.messages)
    return page
  }
  async reportSource(range: ReportRange): Promise<ReportSource> {
    const session = (await this.sessions()).find(item => item.id === range.sessionId)
    if (!session || session.kind !== 'group') throw new Error('请选择一个有效群聊')
    const period = reportPeriod(range.kind, range.date), capturedAt = Date.now()
    const messages = await this.readRange(session.id, period.start, Math.min(period.end, Math.floor(capturedAt / 1000) + 1), REPORT_MAX_MESSAGES)
    return { session, period, messages, capturedAt, complete: true }
  }
  weflowSettings() { const saved = this.vault.secret<{ port: number; token: string }>('weflow'); return { port: saved?.port || 5031, hasToken: Boolean(saved?.token) } }
  async connectWeFlow(options: WeFlowConnectOptions = { port: 5031 }): Promise<ChatSession[]> {
    const saved = this.vault.secret<{ port: number; token: string }>('weflow')
    const token = options.token ?? saved?.token ?? ''
    if (!token) throw new Error('请填写 WeFlow HTTP API 的访问 Token；它与模型 API Key 无关')
    const candidate = new WeFlowClient(options.port, token)
    const health = await candidate.request('/health')
    if (health.status !== 'ok') throw new Error('WeFlow 服务状态异常')
    const check = await candidate.request('/api/v1/sessions?limit=1')
    if (!check.success || !Array.isArray(check.sessions)) throw new Error('WeFlow 数据库未连接')
    if (check.sessions[0]?.username) await candidate.bindAccount(check.sessions[0].username)
    await this.native.stop(); this.flow?.stop()
    this.flow = candidate; this.source = 'weflow'; this.active = undefined
    this.vault.setSecret('weflow', { port: options.port, token }); this.invalidate()
    candidate.watch(event => { if (event.type === 'changed') this.queryCache = undefined; this.changed(event) })
    return this.sessions()
  }
  async importFile(): Promise<ChatSession | null> {
    const result = await dialog.showOpenDialog(this.window(), { title: '导入聊天记录', properties: ['openFile'], filters: [{ name: 'WeFlow / ChatLab 聊天记录', extensions: ['json', 'jsonl'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    const file = result.filePaths[0]
    if (statSync(file).size > 25 * 1024 * 1024) throw new Error('文件超过 25 MB，请按会话或日期拆分后导入')
    const dataset = parseImportedDataset(readFileSync(file, 'utf8'), basename(file))
    const next = [...this.vault.datasets(), dataset]
    this.vault.saveDatasets(next)
    await this.native.stop(); this.flow?.stop(); this.active = undefined
    this.datasets = next; this.source = 'import'; this.invalidate()
    return dataset.session
  }
  async sample(): Promise<ChatSession[]> {
    await this.native.stop(); this.flow?.stop(); this.active = undefined
    this.datasets = [communitySampleDataset(), ...sampleDatasets()]; this.source = 'sample'; this.invalidate()
    return this.sessions()
  }
  private savedProfiles(): WeChatConnection[] { return this.vault.secret<WeChatConnection[]>('wechatProfiles') || [] }
  profiles(): WeChatProfile[] { return this.savedProfiles().sort((a, b) => b.lastUsed - a.lastUsed).map(item => ({ id: item.id, name: item.wxid, directory: item.accountDir, lastUsed: item.lastUsed, active: this.source === 'wechat' && this.active?.id === item.id })) }
  async removeProfile(id: string): Promise<void> {
    if (this.active?.id === id && this.source === 'wechat') { await this.native.stop(); this.active = undefined; this.source = null; this.invalidate() }
    this.vault.setSecret('wechatProfiles', this.savedProfiles().filter(item => item.id !== id))
  }
  private keyService(): any { process.env.WX_KEY_DLL_PATH = join(this.resources, 'wx_key.dll'); const { KeyService } = require('./wechat-key.cjs'); return new KeyService() }
  async connectWeChat(options: WeChatConnectOptions = {}): Promise<ChatSession[]> {
    if (this.connecting) throw new Error('微信连接正在进行中')
    this.connecting = true
    const previous = this.active, oldSource = this.source
    const progress = (message: string) => { if (!this.window().isDestroyed()) this.window().webContents.send('connection:progress', message) }
    try {
      let connection = options.add || options.chooseDirectory ? undefined : options.profileId ? this.savedProfiles().find(item => item.id === options.profileId) : this.savedProfiles().sort((a, b) => b.lastUsed - a.lastUsed)[0]
      if (options.profileId && !connection) throw new Error('已保存的微信账号不存在')
      if (!connection) {
        const confirmation = await dialog.showMessageBox(this.window(), { type: 'info', title: '连接本机微信', message: '请先打开并登录微信 4.x', detail: '软件会读取当前微信进程的本机数据库访问资料。数据库和连接资料保存在你的电脑上。请在连接过程中保持微信打开。', buttons: ['取消', '开始连接'], defaultId: 1, cancelId: 0 })
        if (confirmation.response !== 1) throw new Error('已取消连接')
        let root = join(app.getPath('documents'), 'xwechat_files')
        if (options.chooseDirectory || !accountDirectories(root).length) {
          const choice = await dialog.showOpenDialog(this.window(), { title: '选择微信 xwechat_files 或账号目录', properties: ['openDirectory'] })
          if (choice.canceled || !choice.filePaths[0]) throw new Error('已取消连接')
          root = choice.filePaths[0]
        }
        const accounts = accountDirectories(root)
        if (!accounts.length) throw new Error('没有找到有效 session.db，请选择正在使用的微信账号目录')
        let accountDir = accounts[0]
        if (accounts.length > 1) {
          const choice = await dialog.showOpenDialog(this.window(), { title: '检测到多个微信账号，请选择当前登录账号的目录', defaultPath: root, properties: ['openDirectory'] })
          const selected = choice.filePaths[0] && accountDirectories(choice.filePaths[0])
          if (choice.canceled || !selected || selected.length !== 1 || !accounts.includes(selected[0])) throw new Error('请选择当前登录账号对应的数据目录')
          accountDir = selected[0]
        }
        const result = await this.keyService().autoGetDbKey(60000, progress)
        if (!result.success || !result.key) throw new Error(result.error || '无法连接微信，请完成登录后重试')
        connection = { id: hash(normalize(accountDir).toLowerCase()).slice(0, 24), accountDir, key: result.key, wxid: normalizeWxid(basename(accountDir)), lastUsed: Date.now() }
      }
      if (!existsSync(connection.accountDir)) throw new Error('该微信数据目录已移动，请用「选择数据目录」重新添加')
      progress('正在验证微信账号并加载会话…')
      await this.native.stop()
      await this.native.call('connect', { ...connection, resources: this.resources })
      const sessions = await this.native.call<ChatSession[]>('sessions')
      this.flow?.stop(); this.active = { ...connection, lastUsed: Date.now() }; this.source = 'wechat'
      this.vault.setSecret('wechatProfiles', [this.active, ...this.savedProfiles().filter(item => item.id !== connection!.id)])
      this.invalidate(); return sessions
    } catch (error) {
      if (previous && oldSource === 'wechat') {
        try { await this.native.call('connect', { ...previous, resources: this.resources }); this.active = previous; this.source = oldSource } catch { this.source = null; this.active = undefined }
      }
      throw error
    } finally { this.connecting = false }
  }
  async voice(sessionId: string, message: ChatMessage): Promise<Buffer> { if (this.source !== 'wechat') throw new Error('此来源请使用「选择语音文件」'); return Buffer.from(await this.native.call<string>('voice', { sessionId, message }), 'hex') }
  async imageKeys(): Promise<{ xorKey: number; aesKey?: string }> {
    const connection = this.connection()
    if (!connection) throw new Error('请先连接本机微信后读取加密图片')
    if (connection.imageXorKey !== undefined) return { xorKey: connection.imageXorKey, aesKey: connection.imageAesKey }
    const result = await this.keyService().autoGetImageKey(connection.accountDir, undefined, connection.wxid)
    if (!result.success || result.xorKey === undefined) throw new Error(result.error || '无法获取本机图片读取资料')
    if (result.verified === true) {
      connection.imageXorKey = result.xorKey; connection.imageAesKey = result.aesKey
      this.vault.setSecret('wechatProfiles', [connection, ...this.savedProfiles().filter(item => item.id !== connection.id)])
    }
    return { xorKey: result.xorKey, aesKey: result.aesKey }
  }
  async imagePaths(md5: string): Promise<unknown> { const connection = this.connection(); if (!connection) throw new Error('请先连接本机微信'); return this.native.call('imagePaths', { md5, accountDir: connection.accountDir }) }
  async disconnect(): Promise<void> { await this.native.stop(); this.flow?.stop(); this.datasets = []; this.source = null; this.active = undefined; this.vault.saveDatasets([]); this.invalidate() }
  async stop(): Promise<void> { this.flow?.stop(); await this.native.stop() }
}
