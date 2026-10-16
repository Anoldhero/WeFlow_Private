import type { AccountInfo, AnalysisEvent, AnalysisInput, HealthInfo, LoginInput, RegisterInput } from './contracts.js'
import { readSse } from './sse.js'
import type { GroupReportInput, GroupReportEvent } from './group-report.js'

export class CloudError extends Error {
  constructor(public code: string, message: string, public status?: number) { super(message) }
}

export class CloudClient {
  private active: AbortController | null = null
  token: string | null = null
  constructor(private baseUrl: string) {}
  private async request(path: string, init: RequestInit = {}, signal = AbortSignal.timeout(15000)): Promise<Response> {
    if (!this.baseUrl) throw new CloudError('SERVICE_NOT_CONFIGURED', '云端服务尚未发布，请联系软件提供方')
    let response: Response
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...init.headers }, signal, credentials: 'omit', redirect: 'error' })
    } catch (error) {
      if (signal.aborted && signal.reason?.name === 'AbortError') throw error
      throw new CloudError('NETWORK_ERROR', '暂时无法连接云端服务，请检查网络后重试')
    }
    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
      throw new CloudError(data?.error?.code || 'SERVICE_ERROR', data?.error?.message || '云端服务暂时不可用', response.status)
    }
    return response
  }
  async health(): Promise<HealthInfo> { return (await this.request('/health')).json() }
  async login(input: LoginInput | RegisterInput, register = false): Promise<AccountInfo> {
    if (this.active) throw new CloudError('ANALYSIS_IN_PROGRESS', '请先完成或取消当前分析，再切换账号')
    const result = await (await this.request(`/v1/auth/${register ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(input) })).json() as AccountInfo & { token: string }
    if (typeof result.token !== 'string' || !result.user?.id) throw new CloudError('INVALID_RESPONSE', '登录响应不完整')
    this.token = result.token
    return { user: result.user, quota: result.quota }
  }
  async account(): Promise<AccountInfo | null> {
    if (!this.token) return null
    try { return await (await this.request('/v1/me')).json() } catch (error) {
      if (error instanceof CloudError && error.code === 'UNAUTHORIZED') { this.token = null; return null }
      throw error
    }
  }
  async logout(): Promise<void> {
    this.cancel()
    try { if (this.token) await this.request('/v1/auth/logout', { method: 'POST', body: '{}' }) } finally { this.token = null }
  }
  cancel(): void { this.active?.abort() }
  async analyze(input: AnalysisInput, onEvent: (event: AnalysisEvent) => void): Promise<void> {
    return this.stream('/v1/analysis', input, onEvent)
  }
  async groupReport(input: GroupReportInput, onEvent: (event: GroupReportEvent) => void): Promise<void> {
    return this.stream('/v1/group-reports', input, onEvent)
  }
  private async stream<T extends AnalysisEvent | GroupReportEvent>(path: string, input: AnalysisInput | GroupReportInput, onEvent: (event: T) => void): Promise<void> {
    if (this.active) throw new CloudError('ANALYSIS_IN_PROGRESS', '请先完成或取消当前分析')
    const controller = new AbortController()
    this.active = controller
    let terminal = false
    try {
      const response = await this.request(path, { method: 'POST', body: JSON.stringify(input) }, controller.signal)
      if (!response.body) throw new CloudError('EMPTY_RESPONSE', '服务未返回分析内容')
      for await (const frame of readSse(response.body, controller.signal)) {
        const event = JSON.parse(frame.data) as T
        if (!['start', 'delta', 'progress', 'complete', 'error'].includes(event.type)) continue
        if ((event.type === 'start' || event.type === 'complete') && event.requestId !== input.requestId) throw new CloudError('INVALID_RESPONSE', '分析响应不属于当前请求')
        if (event.type === 'delta' && typeof event.text !== 'string') throw new CloudError('INVALID_RESPONSE', '分析响应格式不正确')
        if (event.type === 'complete' || event.type === 'error') terminal = true
        onEvent(event)
        if (terminal) break
      }
      if (!terminal && !controller.signal.aborted) throw new CloudError('STREAM_INTERRUPTED', '连接已中断，分析未完成')
    } finally { this.active = null }
  }
}
