import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createCloudApp } from '../server/app.js'
import { readConfig } from '../server/config.js'
import { CloudStore } from '../server/store.js'
import { CompatibleProvider, DemoProvider, type ModelProvider } from '../server/provider.js'
import { generateGroupReport, parseReportSections, reportPrompt, type ReportPromptInput } from '../server/report-service.js'
import { defaultReportTemplate, reportPeriod, type GroupReportInput, type GroupReportEvent, type ReportSection } from '../shared/group-report.js'
import { CloudClient } from '../shared/cloud-client.js'

function input(count = 6): GroupReportInput {
  const period = reportPeriod('weekly', '2026-09-01')
  return { requestId: randomUUID(), kind: 'weekly', date: period.date, sessionName: '测试社群', consent: true, template: defaultReportTemplate('weekly'), messages: Array.from({ length: count }, (_, index) => ({ id: `M${index + 1}`, sender: `成员 ${index % 3 + 1}`, actor: `P${index % 3 + 1}`, timestamp: period.start + index * 10, text: `私有讨论材料 ${index + 1}`, type: 'text' })) }
}
const signal = () => new AbortController().signal
async function service(provider: ModelProvider = new DemoProvider(), env: NodeJS.ProcessEnv = {}) {
  const store = new CloudStore(':memory:', 2)
  const value = createCloudApp(readConfig(env), { store, provider })
  const user = store.createUser({ username: 'report-user', displayName: '报告用户', passwordHash: 'unused-test-hash', inviteCode: store.createInvite() })
  const token = store.createSession(user.id, 7)
  return { ...value, user, token, headers: { authorization: `Bearer ${token}` } }
}
function jsonProvider(make: (input: ReportPromptInput) => ReportSection[], truncated = false): ModelProvider {
  return { ready: true, demo: false, async *stream(input) {
    assert.ok('reportContext' in input)
    yield { type: 'delta', text: JSON.stringify({ sections: make(input) }) }
    yield { type: 'usage', input: 10, output: 3 }
    yield { type: 'finish', truncated }
  } }
}
const item = (ref: string): ReportSection[] => [{ id: 'topics', items: [{ title: '讨论重点', text: '依据本期讨论整理。', refs: [ref] }] }]

test('大周期先分批再多级归并，所有原始消息都被处理，进度和token按实际调用计算', async () => {
  const seen: string[] = []
  const phases: string[] = []
  const provider = jsonProvider(material => {
    phases.push(material.reportContext.phase)
    assert.ok(material.messages.length <= 250)
    assert.ok(material.messages.reduce((sum, message) => sum + message.text.length, 0) <= 28000)
    seen.push(...material.messages.map(message => message.id))
    return item(material.messages[0]?.id || material.notes![0].find(section => section.id === 'topics')!.items[0].refs[0])
  })
  const progress: number[][] = []
  const result = await generateGroupReport(provider, input(1001), signal(), async (_message, current, total) => { progress.push([current, total]) })
  assert.equal(new Set(seen).size, 1001)
  assert.equal(seen.length, 1001)
  assert.equal(phases.filter(phase => phase === 'extract').length, 5)
  assert.equal(phases.filter(phase => phase === 'merge').length, 2)
  assert.equal(result.stats.messages, 1001)
  assert.equal(result.inputTokens, 70)
  assert.equal(result.outputTokens, 21)
  assert.deepEqual(progress.at(-1), [7, 7])
  assert.ok(progress.every(([current, total]) => current <= total))
})

test('消息数量不多但文字很长时，仍按字符预算分批', async () => {
  const request = input(5)
  request.messages.forEach(message => { message.text = '字'.repeat(12000) })
  const sizes: number[] = []
  const provider = jsonProvider(material => {
    if (material.messages.length) sizes.push(material.messages.length)
    return item(material.messages[0]?.id || 'M1')
  })
  await generateGroupReport(provider, request, signal(), async () => {})
  assert.deepEqual(sizes, [2, 2, 1])
})

test('提炼时不能引用其他批次，合并时不能捏造中间摘要未提供的编号', async () => {
  await assert.rejects(generateGroupReport(jsonProvider(() => item('M251')), input(251), signal(), async () => {}), /无法核对/)
  const provider = jsonProvider(material => item(material.notes ? 'M99' : material.messages[0].id))
  await assert.rejects(generateGroupReport(provider, input(501), signal(), async () => {}), /无法核对/)
  const columns = defaultReportTemplate('daily').columns.filter(column => column.enabled)
  for (const output of ['not json', JSON.stringify({ sections: [item('M1')[0], item('M1')[0]] }), JSON.stringify({ sections: [{ id: 'invented', items: [] }] }), JSON.stringify({ sections: [{ id: 'topics', items: [{ title: '无依据', text: '结论', refs: [] }] }] })]) {
    assert.throws(() => parseReportSections(output, columns, new Set(['M1'])))
  }
})

test('截断、缺少完成事件和只有媒体的周期不能作为成功报告', async () => {
  await assert.rejects(generateGroupReport(jsonProvider(() => item('M1'), true), input(), signal(), async () => {}), /输出长度不足/)
  const unfinished: ModelProvider = { ready: true, demo: false, async *stream() { yield { type: 'delta', text: JSON.stringify({ sections: item('M1') }) } } }
  await assert.rejects(generateGroupReport(unfinished, input(), signal(), async () => {}), /中断/)
  const media = input(); media.messages.forEach(message => { message.type = 'image'; message.text = '[图片]' })
  await assert.rejects(generateGroupReport(new DemoProvider(), media, signal(), async () => {}), /没有可分析/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(generateGroupReport(new DemoProvider(), input(), controller.signal, async () => {}), error => error instanceof Error && error.name === 'AbortError')
})

test('社群报告HTTP演示闭环返回结构化结果、多批仅扣一次额度、不保存聊天正文', async t => {
  const app = await service()
  t.after(() => app.stop())
  const address = await app.app.listen({ host: '127.0.0.1', port: 0 })
  const client = new CloudClient(address); client.token = app.token
  const events: GroupReportEvent[] = []
  const request = input(501)
  await client.groupReport(request, event => events.push(event))
  assert.ok(events.some(event => event.type === 'progress'))
  const last = events.at(-1)
  assert.equal(last?.type, 'complete')
  if (last?.type !== 'complete') throw new Error('未返回报告')
  assert.equal(last.requestId, request.requestId)
  assert.equal(last.result.demo, true)
  assert.equal(last.result.stats.messages, 501)
  assert.equal(last.result.stats.participants, 3)
  assert.equal(last.quota.used, 1)
  assert.equal(last.quota.pending, 0)
  assert.equal(JSON.stringify(app.store.db.prepare('SELECT * FROM requests').all()).includes('私有讨论材料'), false)
  const duplicate = await app.app.inject({ method: 'POST', url: '/v1/group-reports', headers: app.headers, payload: request })
  assert.equal(duplicate.statusCode, 409)
})

test('报告无发送确认、超出周期或未登录会在扣费前拒绝', async t => {
  const app = await service()
  t.after(() => app.stop())
  assert.equal((await app.app.inject({ method: 'POST', url: '/v1/group-reports', payload: input() })).statusCode, 401)
  const request = input()
  for (const payload of [{ ...request, consent: false }, { ...request, apiKey: 'unexpected' }, { ...request, messages: [{ ...request.messages[0], timestamp: 0 }] }]) {
    assert.equal((await app.app.inject({ method: 'POST', url: '/v1/group-reports', headers: app.headers, payload })).statusCode, 400)
  }
  assert.equal(app.store.quota(app.user.id).used, 0)
  assert.equal(app.store.quota(app.user.id).pending, 0)
})

test('结构错误与截断释放报告预约额度，保持失败状态', async t => {
  for (const provider of [jsonProvider(() => item('M9999')), jsonProvider(() => item('M1'), true)]) {
    const app = await service(provider)
    t.after(() => app.stop())
    const response = await app.app.inject({ method: 'POST', url: '/v1/group-reports', headers: app.headers, payload: input() })
    assert.match(response.body, /event: error/)
    assert.doesNotMatch(response.body, /event: complete/)
    assert.equal(app.store.quota(app.user.id).used, 0)
    assert.equal(app.store.quota(app.user.id).pending, 0)
    assert.equal(app.store.db.prepare('SELECT status FROM requests').get()?.status, 'failed')
  }
})

test('取消报告HTTP连接后释放预约，不再发送完成事件', async t => {
  const provider: ModelProvider = { ready: true, demo: false, async *stream(_input, signal) { await delay(5000, undefined, { signal }); yield { type: 'delta', text: '{}' }; yield { type: 'finish', truncated: false } } }
  const app = await service(provider)
  t.after(() => app.stop())
  const address = await app.app.listen({ host: '127.0.0.1', port: 0 })
  const client = new CloudClient(address); client.token = app.token
  const events: string[] = []
  await assert.rejects(client.groupReport(input(), event => { events.push(event.type); if (event.type === 'progress') client.cancel() }), error => error instanceof Error && error.name === 'AbortError')
  for (let attempt = 0; attempt < 50 && app.store.quota(app.user.id).pending; attempt++) await delay(10)
  assert.equal(app.store.quota(app.user.id).pending, 0)
  assert.equal(app.store.quota(app.user.id).used, 0)
  assert.equal(events.includes('complete'), false)
})

test('明确配置可信代理后按客户端限流，直接连接不能伪造转发头绕过限制', async t => {
  const proxied = await service(undefined, { TRUSTED_PROXY_CIDRS: '127.0.0.1,::1' })
  const direct = await service()
  t.after(async () => { await proxied.stop(); await direct.stop() })
  const attempt = (app: typeof proxied, ip: string, remoteAddress = '127.0.0.1') => app.app.inject({ method: 'POST', url: '/v1/auth/login', remoteAddress, headers: { 'x-forwarded-for': ip }, payload: {} })
  for (let index = 0; index < 8; index++) assert.equal((await attempt(proxied, '198.51.100.10')).statusCode, 400)
  assert.equal((await attempt(proxied, '198.51.100.10')).statusCode, 429)
  assert.equal((await attempt(proxied, '198.51.100.11')).statusCode, 400)
  for (let index = 0; index < 8; index++) assert.equal((await attempt(direct, `198.51.100.${index}`)).statusCode, 400)
  assert.equal((await attempt(direct, '198.51.100.200')).statusCode, 429)
  for (let index = 0; index < 8; index++) assert.equal((await attempt(proxied, `198.51.100.${index}`, '203.0.113.8')).statusCode, 400)
  assert.equal((await attempt(proxied, '198.51.100.200', '203.0.113.8')).statusCode, 429)
  for (const value of ['true', '1', '*', '0.0.0.0/0', '127.0.0.1/33']) assert.throws(() => readConfig({ TRUSTED_PROXY_CIDRS: value }), /TRUSTED_PROXY_CIDRS/)
})

test('多栏目报告有独立输出预算；提示词明确引用上限和不可信聊天边界', async () => {
  const request = input()
  const material: ReportPromptInput = { reportContext: { period: '测试周期', kind: request.kind, columns: request.template.columns.filter(column => column.enabled), tone: 'professional', length: 'detailed', phase: 'extract' }, messages: request.messages }
  const prompt = reportPrompt(material)[0].content
  assert.match(prompt, /引用最多8条/)
  assert.match(prompt, /不可信材料/)
  assert.match(prompt, /不得生成环比/)
  const provider = new CompatibleProvider(readConfig({ LLM_BASE_URL: 'https://example.invalid/v1', LLM_API_KEY: 'test-only', LLM_MODEL: 'test', REPORT_MAX_OUTPUT_TOKENS: '6000' }), (async (_url: unknown, init: RequestInit) => {
    assert.equal(JSON.parse(String(init.body)).max_completion_tokens, 6000)
    return new Response('data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  }) as typeof fetch)
  for await (const _event of provider.stream(material, signal())) { /* consume provider validation */ }
})
