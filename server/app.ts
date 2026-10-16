import Fastify, { type FastifyRequest } from 'fastify'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { analysisSchema, loginSchema, registerSchema, type AnalysisEvent, type UserInfo } from '../shared/contracts.js'
import { encodeSse } from '../shared/sse.js'
import { DEMO_LOGIN } from '../shared/demo.js'
import type { ServerConfig } from './config.js'
import { ServiceError, publicError } from './errors.js'
import { CompatibleProvider, DemoProvider, type ModelProvider } from './provider.js'
import { CloudStore, hashPassword, verifyPassword } from './store.js'
import { groupReportInputSchema, type GroupReportEvent } from '../shared/group-report.js'
import { generateGroupReport } from './report-service.js'
import { version } from '../package.json'

export function createCloudApp(config: ServerConfig, options: { store?: CloudStore; provider?: ModelProvider } = {}) {
  const store = options.store || new CloudStore(config.databasePath, config.dailyLimit)
  const provider = options.provider || (config.provider === 'demo' ? new DemoProvider() : new CompatibleProvider(config))
  const app = Fastify({ logger: false, bodyLimit: 384000, requestTimeout: 15000, connectionTimeout: 180000, trustProxy: config.trustedProxies.length ? config.trustedProxies : false })
  const active = new Set<AbortController>()
  let stopping = false
  let stopPromise: Promise<void> | undefined
  const attempts = new Map<string, { count: number; expires: number }>()

  function limit(key: string, allowed: number): void {
    const now = Date.now()
    if (attempts.size > 5000) for (const [entryKey, entry] of attempts) if (entry.expires <= now) attempts.delete(entryKey)
    const entry = attempts.get(key)
    if (!entry || entry.expires <= now) {
      if (attempts.size >= 10000) throw new ServiceError('SERVICE_BUSY', '请求较多，请稍后重试', 429)
      attempts.set(key, { count: 1, expires: now + 60000 })
    } else if (++entry.count > allowed) throw new ServiceError('RATE_LIMITED', '操作过于频繁，请一分钟后重试', 429)
  }
  function tokenOf(request: FastifyRequest): string {
    const match = request.headers.authorization?.match(/^Bearer ([a-zA-Z0-9_-]{40,128})$/)
    if (!match) throw new ServiceError('UNAUTHORIZED', '请先登录知聊账号', 401)
    return match[1]
  }
  function requireUser(request: FastifyRequest): UserInfo {
    const user = store.authenticate(tokenOf(request))
    if (!user) throw new ServiceError('UNAUTHORIZED', '登录已过期，请重新登录', 401)
    return user
  }
  function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } } }, value: unknown): T {
    const result = schema.safeParse(value)
    if (!result.success) throw new ServiceError('INVALID_INPUT', result.error.issues[0]?.message || '请求参数不正确')
    return result.data
  }
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store')
    if (!['/health', '/readyz'].includes(request.url)) limit(`ip:${request.ip}`, 180)
  })
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined
    if (statusCode === 413) return reply.code(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: '发送内容过多，请缩小分析范围' } })
    if (statusCode === 400 && !(error instanceof ServiceError)) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '请求内容格式不正确' } })
    const safe = publicError(error)
    if (safe.status === 429) reply.header('Retry-After', '60')
    return reply.code(safe.status).send({ error: { code: safe.code, message: safe.message } })
  })
  app.get('/health', async () => ({ status: 'ok', version, aiReady: provider.ready, mode: provider.demo ? 'demo' : 'cloud' }))
  app.get('/readyz', async (_request, reply) => {
    let ready = !stopping && provider.ready
    try { store.db.prepare('SELECT 1').get() } catch { ready = false }
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'unavailable', version, aiReady: provider.ready, mode: provider.demo ? 'demo' : 'cloud' })
  })
  app.post('/v1/auth/register', async (request, reply) => {
    limit(`auth:${request.ip}`, 8)
    const input = parse(registerSchema, request.body)
    const user = store.createUser({ ...input, passwordHash: await hashPassword(input.password) })
    const token = store.createSession(user.id, config.sessionTtlDays)
    return reply.code(201).send({ token, user, quota: store.quota(user.id) })
  })
  app.post('/v1/auth/login', async request => {
    limit(`auth:${request.ip}`, 8)
    const input = parse(loginSchema, request.body)
    const row = store.userByName(input.username)
    if (!await verifyPassword(input.password, row?.password_hash) || !row) throw new ServiceError('INVALID_CREDENTIALS', '用户名或密码不正确', 401)
    const user = { id: row.id, username: row.username, displayName: row.display_name }
    return { token: store.createSession(user.id, config.sessionTtlDays), user, quota: store.quota(user.id) }
  })
  app.post('/v1/auth/logout', async request => { store.revoke(tokenOf(request)); return { success: true } })
  app.get('/v1/me', async request => { const user = requireUser(request); return { user, quota: store.quota(user.id) } })

  app.post('/v1/analysis', async (request, reply) => {
    const user = requireUser(request)
    const input = parse(analysisSchema, request.body)
    if (!provider.ready) throw new ServiceError('AI_NOT_READY', 'AI 服务尚未开通，请联系软件提供方', 503)
    limit(`analysis:${user.id}`, 12)
    store.reserve(user.id, input.requestId)
    const controller = new AbortController()
    active.add(controller)
    let completed = false
    let inputTokens = 0
    let outputTokens = 0
    let truncated = false
    let finishSeen = false
    reply.hijack()
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' })
    const onClose = () => { if (!completed) controller.abort() }
    reply.raw.on('close', onClose)
    const send = async (event: AnalysisEvent) => {
      if (reply.raw.destroyed || controller.signal.aborted) throw new DOMException('已取消', 'AbortError')
      if (!reply.raw.write(encodeSse(event.type, event))) await once(reply.raw, 'drain', { signal: controller.signal })
    }
    const heartbeat = setInterval(() => { if (!reply.raw.destroyed && !controller.signal.aborted) reply.raw.write(': keepalive\n\n') }, 15000)
    try {
      await send({ type: 'start', requestId: input.requestId })
      for await (const event of provider.stream(input, controller.signal)) {
        controller.signal.throwIfAborted()
        if (event.type === 'delta') await send(event)
        else if (event.type === 'usage') { inputTokens = event.input; outputTokens = event.output }
        else { finishSeen = true; truncated = event.truncated }
      }
      controller.signal.throwIfAborted()
      if (!finishSeen) throw new ServiceError('UPSTREAM_INCOMPLETE', 'AI 结果未完整返回，本次不扣除额度', 502)
      store.complete(input.requestId, inputTokens, outputTokens)
      completed = true
      await send({ type: 'complete', requestId: input.requestId, quota: store.quota(user.id), inputTokens, outputTokens, demo: provider.demo, truncated })
    } catch (error) {
      store.fail(input.requestId, controller.signal.aborted ? 'CANCELLED' : publicError(error).code)
      if (!reply.raw.destroyed && !controller.signal.aborted) {
        const safe = publicError(error)
        await send({ type: 'error', code: safe.code, message: safe.message }).catch(() => {})
      }
    } finally {
      clearInterval(heartbeat)
      active.delete(controller)
      reply.raw.off('close', onClose)
      reply.raw.end()
    }
  })

  app.post('/v1/group-reports', { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    const user = requireUser(request)
    const input = parse(groupReportInputSchema, request.body)
    if (!provider.ready) throw new ServiceError('AI_NOT_READY', 'AI 服务尚未开通，请联系软件提供方', 503)
    limit(`analysis:${user.id}`, 12)
    store.reserve(user.id, input.requestId)
    const controller = new AbortController()
    active.add(controller)
    const timer = setTimeout(() => controller.abort(new DOMException('报告生成超时', 'TimeoutError')), 10 * 60000)
    let completed = false
    reply.hijack()
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' })
    const onClose = () => { if (!completed) controller.abort() }
    reply.raw.on('close', onClose)
    const send = async (event: GroupReportEvent) => {
      if (reply.raw.destroyed) throw new DOMException('已取消', 'AbortError')
      if (!reply.raw.write(encodeSse(event.type, event))) await once(reply.raw, 'drain', { signal: controller.signal })
    }
    const heartbeat = setInterval(() => { if (!reply.raw.destroyed && !controller.signal.aborted) reply.raw.write(': keepalive\n\n') }, 15000)
    try {
      await send({ type: 'start', requestId: input.requestId })
      const result = await generateGroupReport(provider, input, controller.signal, (message, current, total) => send({ type: 'progress', message, current, total }))
      controller.signal.throwIfAborted()
      store.complete(input.requestId, result.inputTokens, result.outputTokens)
      completed = true
      await send({ type: 'complete', requestId: input.requestId, result, quota: store.quota(user.id) })
    } catch (error) {
      store.fail(input.requestId, controller.signal.aborted ? 'CANCELLED' : publicError(error).code)
      if (!reply.raw.destroyed) {
        const safe = controller.signal.reason?.name === 'TimeoutError' ? new ServiceError('REPORT_TIMEOUT', '本次报告生成超时，请缩小范围重试；本次不扣额度', 504) : publicError(error)
        await send({ type: 'error', code: safe.code, message: safe.message }).catch(() => {})
      }
    } finally {
      clearTimeout(timer); clearInterval(heartbeat); active.delete(controller); reply.raw.off('close', onClose); reply.raw.end()
    }
  })

  return {
    app,
    store,
    stop() { return stopPromise ||= (async () => { stopping = true; for (const controller of active) controller.abort(); await app.close(); store.close() })() }
  }
}

export async function seedDemoAccount(store: CloudStore): Promise<void> {
  if (store.userByName(DEMO_LOGIN.username)) return
  const inviteCode = store.createInvite({ code: `demo-${randomUUID()}`, uses: 1, limit: 1000 })
  store.createUser({ username: DEMO_LOGIN.username, displayName: '体验用户', passwordHash: await hashPassword(DEMO_LOGIN.password), inviteCode })
}
