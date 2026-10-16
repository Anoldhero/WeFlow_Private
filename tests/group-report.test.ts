import test from 'node:test'
import assert from 'node:assert/strict'
import { communitySampleDataset, datasetReportSource, defaultReportDate, defaultReportTemplate, demoGroupReport, groupReportInputSchema, localDate, prepareGroupReport, reportPeriod, reportStats, saveableGroupReport, type ReportMessage } from '../shared/group-report.js'
import { groupReportDocument, renderGroupReport, reportImageSegments } from '../shared/report-renderer.js'
import type { Dataset } from '../shared/contracts.js'
import { normalizeMessage } from '../shared/data.js'
import { LatestRequest, scopedEvidence } from '../src/request-state.js'

const date = '2026-09-08'
const period = reportPeriod('daily', date)
function dataset(count: number): Dataset {
  return { session: { id: 'test-group', name: '行业讨论群', kind: 'group', source: 'import', lastTimestamp: period.start + count, preview: '' }, messages: Array.from({ length: count }, (_, index) => ({ id: `raw-${index}`, timestamp: period.start + index, sender: '林可', senderId: 'sender-a', self: false, type: 'text', text: `讨论内容 ${index}` })) }
}

test('日报与自然周按上海时区计算，覆盖跨月、跨年和闰日边界', () => {
  const day = reportPeriod('daily', '2026-01-01')
  assert.equal(new Date(day.start * 1000).toISOString(), '2025-12-31T16:00:00.000Z')
  assert.equal(day.end - day.start, 86400)
  const week = reportPeriod('weekly', '2026-01-01')
  assert.equal(week.date, '2025-12-29')
  assert.equal(week.label, '2025-12-29 — 2026-01-04')
  assert.equal(week.end - week.start, 7 * 86400)
  assert.equal(defaultReportDate('daily', Date.parse('2026-01-01T00:05:00+08:00')), '2025-12-31')
  assert.equal(defaultReportDate('weekly', Date.parse('2026-09-07T00:05:00+08:00')), '2026-08-31')
  assert.equal(defaultReportDate('weekly', Date.parse('2026-09-13T23:59:00+08:00')), '2026-08-31')
  assert.equal(localDate(Date.parse('2025-12-31T16:00:00Z') / 1000), '2026-01-01')
  assert.equal(reportPeriod('daily', '2024-02-29').date, '2024-02-29')
  for (const invalid of ['2025-02-29', '2026-02-30', '2026-13-01', '09/08/2026']) assert.throws(() => reportPeriod('daily', invalid), /有效日期/)
})

test('周期读取完整保留超过300条的记录，排除前后周期并按时间排序', () => {
  const input = dataset(601)
  input.messages.reverse()
  input.messages.push({ ...input.messages[0], id: 'previous', timestamp: period.start - 1 }, { ...input.messages[0], id: 'next', timestamp: period.end })
  const source = datasetReportSource(input, { sessionId: input.session.id, kind: 'daily', date }, period.end * 1000)
  assert.equal(source.messages.length, 601)
  assert.equal(source.messages[0].id, 'raw-0')
  assert.equal(source.messages.at(-1)?.id, 'raw-600')
  assert.equal(prepareGroupReport(source, defaultReportTemplate('daily'), true, true).input.messages.length, 601)
  assert.throws(() => datasetReportSource(dataset(12001), { sessionId: input.session.id, kind: 'daily', date }, period.end * 1000), /12,000/)
  assert.throws(() => datasetReportSource({ ...input, session: { ...input.session, kind: 'private' } }, { sessionId: input.session.id, kind: 'daily', date }), /群聊/)
})

test('同名成员按身份区分，整周期脱敏保持一致，统计不混淆身份', () => {
  const input = dataset(3)
  input.messages[0].text = '林可的邮箱是 lin@example.com，电话13812345678。'
  input.messages[1].senderId = 'sender-b'
  const source = datasetReportSource(input, { sessionId: input.session.id, kind: 'daily', date }, period.end * 1000)
  const result = prepareGroupReport(source, defaultReportTemplate('daily'), true, true)
  assert.deepEqual(result.input.messages.map(message => message.sender), ['成员 1', '成员 2', '成员 1'])
  assert.deepEqual(result.input.messages.map(message => message.actor), ['P1', 'P2', 'P1'])
  assert.doesNotMatch(result.input.messages[0].text, /林可|lin@example\.com|13812345678/)
  assert.equal(result.originals[0].text, input.messages[0].text)
  assert.equal(result.input.sessionName, '所选社群')
  const unmasked = prepareGroupReport(source, defaultReportTemplate('daily'), false, true)
  assert.equal(reportStats(unmasked.input.messages, period).participants, 2)
  assert.throws(() => prepareGroupReport(source, defaultReportTemplate('daily'), false, false), /确认允许/)
})

test('超长单条消息、重复编号、跨期消息和空分析配置均显式拒绝', () => {
  const source = datasetReportSource(dataset(1), { sessionId: 'test-group', kind: 'daily', date }, period.end * 1000)
  const prepared = prepareGroupReport(source, defaultReportTemplate('daily'), true, true)
  assert.equal(groupReportInputSchema.safeParse({ ...prepared.input, messages: [...prepared.input.messages, prepared.input.messages[0]] }).success, false)
  assert.equal(groupReportInputSchema.safeParse({ ...prepared.input, messages: [{ ...prepared.input.messages[0], timestamp: period.end }] }).success, false)
  source.messages[0].text = '长'.repeat(12001)
  assert.throws(() => prepareGroupReport(source, defaultReportTemplate('daily'), true, true))
  const template = defaultReportTemplate('daily')
  template.columns.forEach(column => { column.enabled = column.id === 'activity' })
  assert.equal(groupReportInputSchema.safeParse({ ...prepared.input, template }).success, false)
})

test('转发链接卡片的网址随标题和说明一起进入社群报告材料', () => {
  const message = normalizeMessage({ createTime: period.start, senderUsername: 'sender-a', localType: 49, content: '<msg><appmsg><title>社群资料</title><des>阅读指引</des><url>https://example.com/guide?a=1&amp;b=2</url></appmsg></msg>' }, 0)
  assert.ok(message)
  const data = dataset(1); data.messages = [message]
  const source = datasetReportSource(data, { sessionId: data.session.id, kind: 'daily', date }, period.end * 1000)
  const prepared = prepareGroupReport(source, defaultReportTemplate('daily'), true, true)
  assert.match(prepared.input.messages[0].text, /社群资料/)
  assert.match(prepared.input.messages[0].text, /https:\/\/example\.com\/guide\?a=1&b=2/)
})

test('示例群覆盖昨日与上一个完整自然周，逐日统计只计算记录中的成员', () => {
  const now = Date.parse('2026-09-09T10:00:00+08:00')
  const input = communitySampleDataset(now)
  for (const [kind, expected] of [['daily', 6], ['weekly', 42]] as const) {
    const source = datasetReportSource(input, { sessionId: input.session.id, kind, date: defaultReportDate(kind, now) }, now)
    const prepared = prepareGroupReport(source, defaultReportTemplate(kind), true, true)
    assert.equal(source.messages.length, expected)
    assert.equal(reportStats(prepared.input.messages, source.period).participants, 3)
    assert.equal(reportStats(prepared.input.messages, source.period).days.reduce((sum, day) => sum + day.count, 0), expected)
  }
  const messages: ReportMessage[] = [{ id: 'M1', sender: '系统', timestamp: period.start, type: 'system', text: '系统通知' }, { id: 'M2', sender: '成员 1', actor: 'P1', timestamp: period.start, type: 'image', text: '[图片]' }]
  assert.deepEqual({ ...reportStats(messages, period), days: [] }, { messages: 2, participants: 1, textMessages: 1, mediaMessages: 1, days: [] })
})

test('只保存本报告实际引用的原文；其他周期、无关报告引用不能回退匹配', () => {
  const source = datasetReportSource(dataset(3), { sessionId: 'test-group', kind: 'daily', date }, period.end * 1000)
  const prepared = prepareGroupReport(source, defaultReportTemplate('daily'), true, true)
  const result = { sections: [{ id: 'topics', items: [{ title: '本期重点', text: '第一条讨论。', refs: ['M1'] }] }], stats: reportStats(prepared.input.messages, period), period, demo: true, inputTokens: 0, outputTokens: 0 }
  const report = saveableGroupReport(prepared.input, result, prepared.originals, { id: source.session.id, name: source.session.name }, '社群日报')
  assert.deepEqual(report.evidence.map(message => message.id), ['M1'])
  assert.equal(scopedEvidence('M2', report, prepared.originals), undefined)
  assert.equal(scopedEvidence('M1', {}, prepared.originals), undefined)
  assert.equal(scopedEvidence('M2', null, prepared.originals)?.text, '讨论内容 1')
  assert.throws(() => saveableGroupReport(prepared.input, { ...result, period: reportPeriod('daily', '2026-09-07') }, prepared.originals, { id: 'test-group', name: '群' }, '日报'), /周期/)
  assert.throws(() => saveableGroupReport(prepared.input, result, [], { id: 'test-group', name: '群' }, '日报'), /不匹配/)
})

test('排版支持栏目顺序与显隐，转义内容，导出不留下无效引用链接', () => {
  const report = demoGroupReport({ kind: 'daily', date })
  report.title = '<img src=x onerror=alert(1)>'
  report.template.columns = [report.template.columns.find(column => column.id === 'resources')!, report.template.columns.find(column => column.id === 'topics')!]
  report.template.style = 'editorial'
  const html = groupReportDocument(report)
  assert.ok(html.indexOf('<h2>资源链接</h2>') < html.indexOf('<h2>热点话题</h2>'))
  assert.doesNotMatch(html, /<img src=x/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(html, /style-editorial/)
  assert.doesNotMatch(html, /href="#evidence-/)
  assert.match(renderGroupReport(report, true), /data-report-ref=/)
  report.template.showSources = true
  const withSources = renderGroupReport(report)
  assert.match(withSources, /href="#evidence-M4"/)
  assert.match(withSources, /id="evidence-M4"/)
  assert.doesNotMatch(withSources, /id="evidence-M1"/)
  report.template.columns[0].enabled = false
  assert.doesNotMatch(renderGroupReport(report), /<h2>资源链接<\/h2>/)
  report.sections = []
  assert.doesNotMatch(renderGroupReport(report), /class="cr-section"/)
  report.template.hideEmpty = false
  assert.match(renderGroupReport(report), /本期没有足够/)
  assert.match(renderGroupReport(report), /示例内容/)
})

test('未结束周期在报告中保留实际读取截止时间，次日排版也不冒充完整周期', () => {
  const capturedAt = (period.start + 3600) * 1000
  const source = datasetReportSource(dataset(3), { sessionId: 'test-group', kind: 'daily', date }, capturedAt)
  assert.equal(source.capturedAt, capturedAt)
  const report = demoGroupReport({ kind: 'daily', date })
  report.collectedAt = source.capturedAt
  report.createdAt = (period.end + 86400) * 1000
  assert.match(renderGroupReport(report), /记录截至/)
  assert.match(renderGroupReport(report), /01:00:00/)
  report.collectedAt = period.end * 1000
  assert.doesNotMatch(renderGroupReport(report), /记录截至/)
})

test('长图沿候选行间分割，各段完整连续、不重叠且不超过上限', () => {
  const segments = reportImageSegments(13740.8, [5900.5, 5900.5, 6010, 11780, NaN, -1, 99999])
  assert.deepEqual(segments, [{ top: 0, height: 5900 }, { top: 5900, height: 5880 }, { top: 11780, height: 1961 }])
  for (let index = 0; index < segments.length; index++) {
    assert.ok(segments[index].height <= 6000)
    if (index) assert.equal(segments[index].top, segments[index - 1].top + segments[index - 1].height)
  }
  assert.deepEqual(reportImageSegments(6000, []), [{ top: 0, height: 6000 }])
  assert.throws(() => reportImageSegments(60001, []), /PDF/)
})

test('刷新旧会话的迟到结果不能覆盖切换后的会话，刷新之间也按最新请求应用', async () => {
  const guard = new LatestRequest()
  const applied: string[] = []
  let finishA!: (value: string) => void
  const a = new Promise<string>(resolve => { finishA = resolve })
  const currentA = guard.begin()
  const pending = a.then(value => { if (currentA()) applied.push(value) })
  guard.invalidate()
  const currentB = guard.begin()
  if (currentB()) applied.push('会话B')
  finishA('会话A旧刷新'); await pending
  assert.deepEqual(applied, ['会话B'])
  const oldRefresh = guard.begin(); const newRefresh = guard.begin()
  assert.equal(oldRefresh(), false); assert.equal(newRefresh(), true)
})
