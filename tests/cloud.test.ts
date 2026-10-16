import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createCloudApp } from '../server/app.js'
import { CloudStore, hashPassword, tokenHash } from '../server/store.js'
import { readConfig } from '../server/config.js'
import { ServiceError } from '../server/errors.js'
import type { ModelProvider } from '../server/provider.js'
import type { AnalysisInput } from '../shared/contracts.js'
import { CloudClient, CloudError } from '../shared/cloud-client.js'

const request = (): AnalysisInput => ({ requestId: randomUUID(), mode: 'summary', question: '', consent: true, sessionName: '测试会话', messages: [{ id: 'M1', timestamp: 1750000000, sender: '联系人 1', text: 'PRIVATE_EVIDENCE_ONLY' }] })
const normal: ModelProvider = { ready: true, demo: false, async *stream() { yield { type: 'delta', text: '结果 [M1]' }; yield { type: 'usage', input: 30, output: 10 }; yield { type: 'finish', truncated: false } } }

async function setup(provider = normal, limit = 2) {
  const store = new CloudStore(':memory:', limit)
  const service = createCloudApp(readConfig({}), { store, provider })
  const code = store.createInvite({ limit })
  const user = store.createUser({ username: 'alice', displayName: '测试用户', passwordHash: await hashPassword('test-password-123'), inviteCode: code })
  const token = store.createSession(user.id, 7)
  const headers = { authorization: `Bearer ${token}` }
  return { ...service, user, token, headers }
}

test('登录和退出；存储只保留令牌哈希', async t => {
  const service = await setup()
  t.after(() => service.stop())
  const stored = service.store.db.prepare('SELECT token_hash FROM sessions').get()
  assert.equal(stored?.token_hash, tokenHash(service.token))
  const wrong = await service.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'alice', password: 'wrong-password-123' } })
  assert.equal(wrong.statusCode, 401)
  const login = await service.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'alice', password: 'test-password-123' } })
  assert.equal(login.statusCode, 200)
  assert.ok(login.json().token)
  const logout = await service.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: service.headers, payload: {} })
  assert.equal(logout.statusCode, 200)
  assert.equal((await service.app.inject({ url: '/v1/me', headers: service.headers })).statusCode, 401)
})

test('邀请码不能重复消费，未知字段与无发送确认的请求被拒绝', async t => {
  const service = await setup()
  t.after(() => service.stop())
  const code = service.store.createInvite()
  const register = { username: 'new-user', displayName: '新用户', password: 'new-password-123', inviteCode: code }
  assert.equal((await service.app.inject({ method: 'POST', url: '/v1/auth/register', payload: register })).statusCode, 201)
  assert.equal((await service.app.inject({ method: 'POST', url: '/v1/auth/register', payload: { ...register, username: 'other-user' } })).statusCode, 400)
  assert.equal((await service.app.inject({ method: 'POST', url: '/v1/analysis', payload: request() })).statusCode, 401)
  for (const payload of [{ ...request(), consent: false }, { ...request(), apiKey: 'UNEXPECTED_SECRET' }]) {
    assert.equal((await service.app.inject({ method: 'POST', url: '/v1/analysis', headers: service.headers, payload })).statusCode, 400)
  }
  assert.equal(service.store.quota(service.user.id).used, 0)
})

test('生成成功只扣一次额度，不在云端数据库保存聊天内容', async t => {
  const service = await setup(normal, 1)
  t.after(() => service.stop())
  const payload = request()
  const result = await service.app.inject({ method: 'POST', url: '/v1/analysis', headers: service.headers, payload })
  assert.equal(result.statusCode, 200)
  assert.match(result.body, /event: delta/)
  assert.match(result.body, /event: complete/)
  assert.equal(service.store.quota(service.user.id).remaining, 0)
  assert.equal(service.store.quota(service.user.id).pending, 0)
  const duplicate = await service.app.inject({ method: 'POST', url: '/v1/analysis', headers: service.headers, payload })
  assert.equal(duplicate.statusCode, 409)
  const exhausted = await service.app.inject({ method: 'POST', url: '/v1/analysis', headers: service.headers, payload: request() })
  assert.equal(exhausted.statusCode, 429)
  const rows = service.store.db.prepare('SELECT * FROM requests').all()
  assert.equal(JSON.stringify(rows).includes('PRIVATE_EVIDENCE_ONLY'), false)
  assert.equal(rows[0].input_tokens, 30)
})

test('上游失败释放预约额度，保留明确失败状态', async t => {
  const provider: ModelProvider = { ready: true, demo: false, async *stream() { yield { type: 'delta', text: '未完成内容' }; throw new ServiceError('UPSTREAM_TIMEOUT', '服务超时', 504) } }
  const service = await setup(provider, 1)
  t.after(() => service.stop())
  const result = await service.app.inject({ method: 'POST', url: '/v1/analysis', headers: service.headers, payload: request() })
  assert.match(result.body, /event: error/)
  assert.doesNotMatch(result.body, /event: complete/)
  assert.equal(service.store.quota(service.user.id).remaining, 1)
  assert.equal(service.store.db.prepare('SELECT status FROM requests').get()?.status, 'failed')
})

test('同一用户不能并发生成以绕过额度', async t => {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const provider: ModelProvider = { ready: true, demo: false, async *stream(_input, signal) { entered(); signal.addEventListener('abort', release, { once: true }); await gate; signal.throwIfAborted(); yield { type: 'delta', text: '完成' }; yield { type: 'finish', truncated: false } } }
  const service = await setup(provider, 2)
  t.after(async () => { release(); await service.stop() })
  const first = service.app.inject({ method: 'POST', url: '/v1/analysis', headers: service.headers, payload: request() })
  await started
  const second = await service.app.inject({ method: 'POST', url: '/v1/analysis', headers: service.headers, payload: request() })
  assert.equal(second.statusCode, 429)
  assert.equal(service.store.quota(service.user.id).pending, 1)
  release()
  assert.match((await first).body, /event: complete/)
  assert.equal(service.store.quota(service.user.id).used, 1)
})

test('服务未配置不扣费，重启可回收未完成请求', async t => {
  const service = await setup({ ...normal, ready: false })
  t.after(() => service.stop())
  assert.equal((await service.app.inject({ method: 'POST', url: '/v1/analysis', headers: service.headers, payload: request() })).statusCode, 503)
  assert.equal(service.store.quota(service.user.id).remaining, 2)
  service.store.reserve(service.user.id, randomUUID())
  service.store.recoverInterrupted()
  assert.equal(service.store.quota(service.user.id).pending, 0)
  assert.equal(service.store.quota(service.user.id).remaining, 2)
})

test('真实 HTTP 连接取消后，客户端停止接收且服务端释放额度', async t => {
  const provider: ModelProvider = { ready: true, demo: false, async *stream(_input, signal) {
    yield { type: 'delta', text: '第一部分' }
    await delay(5000, undefined, { signal })
    yield { type: 'delta', text: '不应收到的第二部分' }
    yield { type: 'finish', truncated: false }
  } }
  const service = await setup(provider, 1)
  t.after(() => service.stop())
  const address = await service.app.listen({ host: '127.0.0.1', port: 0 })
  const client = new CloudClient(address)
  client.token = service.token
  const text: string[] = []
  await assert.rejects(client.analyze(request(), event => {
    if (event.type === 'delta') { text.push(event.text); client.cancel() }
  }), error => error instanceof Error && error.name === 'AbortError')
  for (let attempt = 0; attempt < 50 && service.store.quota(service.user.id).pending; attempt++) await delay(10)
  assert.deepEqual(text, ['第一部分'])
  assert.equal(service.store.quota(service.user.id).pending, 0)
  assert.equal(service.store.quota(service.user.id).remaining, 1)
})

test('登录令牌按时过期，跨日额度自动重置', async t => {
  let now = Date.parse('2026-09-08T10:00:00Z')
  const store = new CloudStore(':memory:', 1, () => now)
  t.after(() => store.close())
  const inviteCode = store.createInvite()
  const user = store.createUser({ username: 'daily-user', displayName: '日额度用户', passwordHash: await hashPassword('test-password-123'), inviteCode })
  const token = store.createSession(user.id, 1)
  const id = randomUUID()
  store.reserve(user.id, id); store.complete(id, 1, 1)
  assert.equal(store.quota(user.id).remaining, 0)
  now += 86400000
  assert.equal(store.authenticate(token), null)
  assert.equal(store.quota(user.id).remaining, 1)
})

test('取消和失败不扣成功额度，但不能无限重试消耗上游资源', async t => {
  const service = await setup(normal, 1)
  t.after(() => service.stop())
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = randomUUID()
    service.store.reserve(service.user.id, id)
    service.store.fail(id, 'CANCELLED')
  }
  assert.equal(service.store.quota(service.user.id).remaining, 1)
  assert.throws(() => service.store.reserve(service.user.id, randomUUID()), /中断或重试次数较多/)
})

test('客户端生成期间禁止切换账号，保留本次报告的账号归属', async t => {
  const service = await setup()
  t.after(() => service.stop())
  const address = await service.app.listen({ host: '127.0.0.1', port: 0 })
  const client = new CloudClient(address)
  client.token = service.token
  const generation = client.analyze(request(), () => {})
  await assert.rejects(client.login({ username: 'alice', password: 'test-password-123' }), error => error instanceof CloudError && error.code === 'ANALYSIS_IN_PROGRESS')
  await generation
  assert.equal(client.token, service.token)
})
