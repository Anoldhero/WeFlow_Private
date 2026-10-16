import { normalizeMessage } from '../shared/data.js'
import { parseLosslessJson } from '../shared/message-content.js'
import { readSse } from '../shared/sse.js'
import type { ChatMessage } from '../shared/contracts.js'
import type { DataChange } from '../shared/workbench.js'

export class WeFlowClient {
  owner = ''
  private stream?: AbortController
  private timer?: ReturnType<typeof setTimeout>
  private generation = 0
  private cache = new Map<string, { start: number; end: number; at: number; messages: ChatMessage[] }>()
  constructor(readonly port: number, private token: string, private fetcher: typeof fetch = fetch) {}
  async request(path: string, signal?: AbortSignal): Promise<any> {
    try {
      const response = await this.fetcher(`http://127.0.0.1:${this.port}${path}`, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000), redirect: 'error' })
      if ([401, 403].includes(response.status)) throw new Error('WeFlow Token 无效或尚未配置，请填写 WeFlow「HTTP API」中的访问令牌')
      if (!response.ok) throw new Error(`WeFlow 接口请求失败（HTTP ${response.status}）`)
      const text = await response.text()
      if (text.length > 50 * 1024 * 1024) throw new Error('WeFlow 单次响应过大，请缩小读取范围')
      const data = parseLosslessJson(text)
      if (typeof data.meta?.ownerId === 'string' && data.meta.ownerId) {
        if (this.owner && this.owner !== data.meta.ownerId) throw new Error('WeFlow 中的微信账号已切换，请重新连接后继续')
        this.owner = data.meta.ownerId
      }
      return data
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      if (error instanceof Error && error.message.startsWith('WeFlow')) throw error
      throw new Error('无法连接本机 WeFlow，请确认 HTTP API 已开启，端口和 Token 正确')
    }
  }
  invalidate(): void { this.generation++; this.cache.clear() }
  async bindAccount(sessionId: string): Promise<void> { await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?limit=1`) }
  async readRange(sessionId: string, start: number, end: number, maximum: number, checkpoint: () => Promise<void> = async () => {}, signal?: AbortSignal): Promise<ChatMessage[]> {
    const generation = this.generation
    const key = `${sessionId}:${start}`
    const cached = this.cache.get(key)
    const reusable = cached && cached.end <= end && Date.now() - cached.at < 30000
    if (reusable && cached.end === end) {
      if (cached.messages.length > maximum) throw new Error(`消息超过 ${maximum.toLocaleString()} 条，请缩小日期范围`)
      return cached.messages
    }
    const since = reusable ? Math.max(start, cached.end - 1) : start
    const messages = new Map((reusable ? cached.messages.filter(message => message.timestamp < since) : []).map(message => [message.id, message]))
    let offset = 0
    while (true) {
      await checkpoint()
      const data = await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?since=${since}&end=${end - 1}&limit=500&offset=${offset}`, signal)
      if (!Array.isArray(data.messages) || typeof data.sync?.hasMore !== 'boolean') throw new Error('WeFlow 未提供 ChatLab 完整分页信息，请使用新版 HTTP API 或导入聊天记录')
      const names = new Map<string, string>((Array.isArray(data.members) ? data.members : []).map((member: any) => [String(member.platformId), String(member.accountName || member.platformId)]))
      for (const [index, row] of data.messages.entries()) {
        const message = normalizeMessage(row, offset + index, { chatlab: true, owner: String(data.meta?.ownerId || ''), names })
        if (message && message.timestamp >= start && message.timestamp < end) messages.set(message.id, message)
      }
      if (messages.size > maximum) throw new Error(`消息超过 ${maximum.toLocaleString()} 条，请缩小日期范围`)
      if (!data.sync.hasMore) break
      const next = data.sync.nextOffset
      if (!data.messages.length || !Number.isSafeInteger(next) || next !== offset + data.messages.length || next > 100000) throw new Error('WeFlow 分页游标异常，已停止读取，避免生成不完整报告')
      // since/end 在同一次读取中固定；nextSince 与 nextOffset 不能同时推进。
      offset = next
    }
    const result = [...messages.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
    if (generation === this.generation) {
      this.cache.set(key, { start, end, at: Date.now(), messages: result })
      while (this.cache.size > 8 || [...this.cache.values()].reduce((n, value) => n + value.messages.length, 0) > 100000) this.cache.delete(this.cache.keys().next().value!)
    }
    return result
  }
  watch(onChange: (event: DataChange) => void): void {
    this.stop()
    const controller = new AbortController()
    this.stream = controller
    let attempts = 0
    const connect = async () => {
      try {
        const response = await this.fetcher(`http://127.0.0.1:${this.port}/api/v1/push/messages`, { headers: { Authorization: `Bearer ${this.token}` }, signal: controller.signal, redirect: 'error' })
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        attempts = 0
        onChange({ type: 'status', connected: true, message: 'WeFlow 实时同步已连接' })
        for await (const event of readSse(response.body, controller.signal)) {
          if (!['message.new', 'message.revoke'].includes(event.event)) continue
          const data = parseLosslessJson(event.data)
          this.invalidate()
          onChange({ type: 'changed', sessionId: typeof (data.sessionId || data.session_id || data.talker) === 'string' ? data.sessionId || data.session_id || data.talker : undefined })
        }
      } catch { if (!controller.signal.aborted) onChange({ type: 'status', connected: false, message: 'WeFlow 实时同步断开，正在重连；仍可手动刷新' }) }
      if (!controller.signal.aborted) this.timer = setTimeout(() => { void connect() }, Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5)))
    }
    void connect()
  }
  stop(): void { this.stream?.abort(); this.stream = undefined; clearTimeout(this.timer); this.timer = undefined; this.invalidate() }
}
