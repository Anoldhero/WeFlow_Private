import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { normalizeMessage, parseImportedDataset } from '../shared/data.js'
import { parseLosslessJson, parseMessageContent } from '../shared/message-content.js'
import { exportFooter, exportHeader, exportMessage, safeFileName } from '../shared/chat-export.js'
import { inspectMessages, nextScheduledTime, scheduleDue, type ExportSchedule, type MessageQuery } from '../shared/workbench.js'
import { readWav, imageMime, decodeLegacyImage } from '../shared/audio.js'
import { defaultReportTemplate, prepareGroupReport, reportPeriod } from '../shared/group-report.js'
import { WeFlowClient } from '../electron/weflow-client.js'
import { TaskManager } from '../electron/task-manager.js'
import { ExportScheduler } from '../electron/export-scheduler.js'
import { accountDirectories } from '../electron/account-directories.js'
import { writeChatExport } from '../electron/chat-export.js'
import { writeFilesAtomically } from '../electron/file-output.js'
import type { ChatMessage, ChatSession } from '../shared/contracts.js'

const session: ChatSession = { id: 'test@chatroom', name: '测试群', kind: 'group', source: 'sample', preview: '', lastTimestamp: 100 }
const message = (id: string, timestamp = 100, senderId = 'member-a', text = '讨论内容'): ChatMessage => ({ id, timestamp, senderId, sender: '同名成员', self: false, text, type: 'text' })
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
async function cleanFixture(root: string): Promise<void> { if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('zhiliao-')) throw new Error('测试清理目录不在预期范围'); await rm(root, { recursive: true, force: true }) }

test('64 位消息 ID 在导入和富文本引用中保持精确字符串', () => {
  const data = parseLosslessJson('{"serverId":9223372036854775806,"timestamp":100,"content":"精确编号"}')
  assert.equal(data.serverId, '9223372036854775806')
  const normalized = normalizeMessage(data, 0)!
  assert.equal(normalized.serverId, data.serverId)
  assert.equal(normalized.id, 'svr:9223372036854775806')
  const imported = parseImportedDataset('{"session":{"name":"编号测试","username":"group@chatroom"},"messages":[{"serverId":9223372036854775806,"timestamp":100,"content":"编号"}]}', 'test.json')
  assert.equal(imported.session.kind, 'group'); assert.equal(imported.messages[0].serverId, data.serverId)
})

test('引用截取按 Unicode 字符定位，引用与链接不会丢失', () => {
  const value = parseMessageContent('<msg><appmsg><type>57</type><title>我的观点</title><refermsg><displayname>甲</displayname><content><![CDATA[甲😀乙丙]]></content><type>1</type><startindex>1</startindex><endindex>2</endindex><svrid>9223372036854775806</svrid></refermsg><url>https://example.com/a?x=1&amp;y=2</url></appmsg></msg>')
  assert.equal(value.quote?.text, '😀乙'); assert.equal(value.quote?.serverId, '9223372036854775806')
  assert.equal(value.link, 'https://example.com/a?x=1&y=2')
  assert.match(value.text, /我的观点/); assert.match(value.text, /引用 甲：😀乙/)
})

test('合并转发展开多条与嵌套记录，不将引用结构混进主消息标题', () => {
  const xml = '<msg><appmsg><type>19</type><title>精华</title><recorditem><recordinfo><dataitem><sourcename>甲</sourcename><datadesc>第一条</datadesc></dataitem><dataitem><sourcename>乙</sourcename><recordxml><recordinfo><dataitem><sourcename>丙</sourcename><datadesc>嵌套内容</datadesc></dataitem></recordinfo></recordxml></dataitem></recordinfo></recorditem></appmsg></msg>'
  const parsed = parseMessageContent(xml)
  assert.equal(parsed.forwarded?.length, 2); assert.match(parsed.text, /甲：第一条/); assert.match(parsed.text, /丙：嵌套内容/)
  assert.equal((parsed.text.match(/嵌套内容/g) || []).length, 1)
})

test('成员统计按身份区分同名用户，筛选覆盖整期且分页不影响导出范围', () => {
  const query: MessageQuery = { sessionId: session.id, start: 100, end: 200, senderId: 'member-a', keyword: '资源', offset: 1, limit: 1 }
  const messages = [message('0', 99), message('1', 100, 'member-a', '资源 A'), message('2', 101, 'member-b', '资源 B'), message('3', 102, 'member-a', '资源 C'), message('4', 200)]
  const page = inspectMessages(messages, query)
  assert.equal(page.total, 2); assert.deepEqual(page.messages.map(item => item.id), ['3']); assert.equal(page.hasMore, false)
  assert.deepEqual(page.members.map(item => [item.id, item.count]), [['member-a', 2], ['member-b', 1]])
})

test('ChatLab 多页固定 since/end，只推进 offset，保留同秒消息并带 Bearer Token', async () => {
  const urls: URL[] = [], headers: Headers[] = []
  const fetcher = (async (url: any, init: any) => {
    const value = new URL(String(url)); urls.push(value); headers.push(new Headers(init.headers))
    const offset = Number(value.searchParams.get('offset'))
    return json({ chatlab: {}, meta: { ownerId: 'owner' }, members: [{ platformId: 'a', accountName: '甲' }], messages: offset ? [{ platformMessageId: '9007199254741003', sender: 'a', timestamp: 100, content: '三', type: 0 }] : [{ platformMessageId: '9007199254741001', sender: 'a', timestamp: 100, content: '一', type: 0 }, { platformMessageId: '9007199254741002', sender: 'a', timestamp: 100, content: '二', type: 0 }], sync: { hasMore: !offset, nextOffset: offset ? undefined : 2, nextSince: 100, watermark: 300 } })
  }) as typeof fetch
  const client = new WeFlowClient(5031, 'local-test-token', fetcher)
  const result = await client.readRange(session.id, 90, 200, 100)
  assert.equal(result.length, 3); assert.deepEqual(urls.map(url => url.searchParams.get('since')), ['90', '90']); assert.deepEqual(urls.map(url => url.searchParams.get('offset')), ['0', '2'])
  assert.ok(headers.every(header => header.get('Authorization') === 'Bearer local-test-token')); assert.ok(urls.every(url => !url.search.includes('local-test-token')))
})

test('增量读取重读最后一秒去重，账号切换与坏游标显式拒绝', async () => {
  const since: string[] = []
  let owner = 'a'
  const client = new WeFlowClient(5031, 'token', (async (url: any) => { const value = new URL(String(url)); since.push(value.searchParams.get('since')!); return json({ meta: { ownerId: owner }, messages: [{ platformMessageId: '10', timestamp: 100, content: '同秒消息', type: 0 }], sync: { hasMore: false } }) }) as typeof fetch)
  assert.equal((await client.readRange('group', 90, 101, 100)).length, 1)
  assert.equal((await client.readRange('group', 90, 102, 100)).length, 1)
  assert.deepEqual(since, ['90', '100'])
  owner = 'b'
  await assert.rejects(client.readRange('group', 90, 103, 100), /账号已切换/)
  const broken = new WeFlowClient(5031, 'token', (async () => json({ messages: [], sync: { hasMore: true, nextOffset: 0 } })) as typeof fetch)
  await assert.rejects(broken.readRange('group', 90, 110, 100), /游标异常/)
  await assert.rejects(new WeFlowClient(5031, 'token', (async () => json({}, 401)) as typeof fetch).request('/api/v1/sessions'), /Token 无效/)
})

test('JSON/JSONL 导出可重新导入；SQL 转义保持消息与数据库结构', () => {
  const msg = { ...message('id-1', 100, 'member-a', "O'Reilly'); DROP TABLE messages; --\n<script>"), serverId: '9223372036854775806' }
  for (const format of ['json', 'jsonl'] as const) {
    const text = exportHeader(session, format) + exportMessage(msg, session.id, format, 0) + exportFooter(format)
    const imported = parseImportedDataset(text, `roundtrip.${format}`)
    assert.equal(imported.messages[0].text, msg.text); assert.equal(imported.messages[0].sender, msg.sender); assert.equal(imported.messages[0].serverId, msg.serverId); assert.equal(imported.messages[0].senderId, msg.senderId); assert.equal(imported.session.kind, 'group')
  }
  const database = new DatabaseSync(':memory:')
  try { database.exec(exportHeader(session, 'sql') + exportMessage(msg, session.id, 'sql', 0) + exportFooter('sql')); assert.equal(database.prepare('SELECT text FROM messages').get()?.text, msg.text) } finally { database.close() }
  assert.match(exportMessage(msg, session.id, 'md', 0), /&lt;script&gt;/); assert.equal(safeFileName('CON'), '_CON'); assert.equal(safeFileName('../unsafe'), '.._unsafe')
})

test('任务队列串行执行，运行任务可以在检查点暂停、恢复并取消排队任务', async () => {
  const started = deferred(), checkpoint = deferred(), pauseReached = deferred()
  const events: string[] = []
  const manager = new TaskManager([], () => {}, tasks => { if (tasks.some(task => task.state === 'paused')) pauseReached.resolve() })
  const first = manager.enqueue({ title: '第一个', kind: 'export' }, async context => { events.push('start'); started.resolve(); await checkpoint.promise; await context.checkpoint(); events.push('continue') })
  await started.promise
  const second = manager.enqueue({ title: '第二个', kind: 'export' }, async () => { events.push('second') })
  await manager.control(first.id, 'pause'); checkpoint.resolve(); await pauseReached.promise
  assert.deepEqual(events, ['start']); assert.equal(manager.list().find(task => task.id === first.id)?.state, 'paused')
  await manager.control(second.id, 'cancel'); await assert.rejects(second.done, /已取消/)
  await manager.control(first.id, 'resume'); await first.done
  assert.deepEqual(events, ['start', 'continue']); assert.equal(manager.busy(), false)
})

test('取消正在运行的任务终止后续步骤，持久化中的未完任务在重启后标中断', async () => {
  const started = deferred(), proceed = deferred()
  const manager = new TaskManager([], () => {}, () => {})
  const task = manager.enqueue({ title: '取消测试', kind: 'export' }, async context => { started.resolve(); await proceed.promise; await context.checkpoint(); assert.fail('取消后不应继续执行') })
  await started.promise; const saved = manager.list(); await manager.control(task.id, 'cancel'); proceed.resolve(); await assert.rejects(task.done, /已取消/)
  assert.equal(manager.list()[0].state, 'canceled')
  const restored = new TaskManager(saved, () => {}, () => {})
  assert.equal(restored.list()[0].state, 'interrupted'); assert.equal(restored.busy(), false)
})

test('定时计划绑定来源、尊重截止与次数、合并错过的多次执行', async () => {
  const schedule: ExportSchedule = { id: crypto.randomUUID(), name: '计划', sessionId: session.id, sessionName: session.name, sourceId: 'bound-source', directory: 'unused', format: 'md', intervalHours: 24, recentDays: 1, firstRunAt: 1000, nextRunAt: 1000, runs: 0, skipUnchanged: true, enabled: true, keyword: '' }
  const now = 1000 + 3 * 86400000 + 200
  assert.equal(scheduleDue(schedule, now, 'other'), false); assert.equal(scheduleDue(schedule, now, 'bound-source'), true)
  assert.equal(scheduleDue({ ...schedule, endAt: now }, now, 'bound-source'), false); assert.equal(scheduleDue({ ...schedule, maxRuns: 1, runs: 1 }, now, 'bound-source'), false)
  assert.equal(nextScheduledTime(schedule, now), 1000 + 4 * 86400000)
  let saved = [schedule]
  const completed = deferred()
  const manager = new TaskManager([], () => {}, tasks => { if (tasks[0]?.state === 'completed') completed.resolve() })
  const scheduler = new ExportScheduler({ identity: () => 'bound-source', sessions: async () => [session], readRange: async () => [] } as any, manager, { schedules: () => saved, saveSchedules: (items: ExportSchedule[]) => { saved = items } } as any)
  scheduler.get(schedule.id)!.fingerprint = 'saved-fingerprint'
  scheduler.save({ ...scheduler.list()[0], enabled: false })
  assert.equal(scheduler.get(schedule.id)!.fingerprint, 'saved-fingerprint')
  scheduler.save({ ...scheduler.list()[0], enabled: true })
  await scheduler.tick(now); await scheduler.tick(now); await completed.promise; await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.list().length, 1); assert.equal(saved[0].runs, 1); assert.match(saved[0].lastMessage!, /已跳过/); assert.ok(saved[0].nextRunAt > now)
})

test('账号目录识别忽略空壳目录，兼容扁平与嵌套 session.db', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhiliao-accounts-'))
  try {
    await mkdir(join(root, 'empty/db_storage'), { recursive: true }); await mkdir(join(root, 'wxid_abcd/db_storage/session'), { recursive: true }); await mkdir(join(root, 'alias_z9x8/db_storage'), { recursive: true })
    await writeFile(join(root, 'wxid_abcd/db_storage/session/session.db'), 'test-db'); await writeFile(join(root, 'alias_z9x8/db_storage/session.db'), 'test-db')
    assert.equal(accountDirectories(root).length, 2); assert.deepEqual(accountDirectories(root, 'alias'), [join(root, 'alias_z9x8')]); assert.deepEqual(accountDirectories(join(root, 'wxid_abcd/db_storage')), [join(root, 'wxid_abcd')])
  } finally { await cleanFixture(root) }
})

test('WAV 解析读取实际 data 块并下混立体声；旧图片 XOR 解密识别文件签名', () => {
  const wav = Buffer.alloc(60); wav.write('RIFF'); wav.writeUInt32LE(52, 4); wav.write('WAVE', 8); wav.write('JUNK', 12); wav.writeUInt32LE(4, 16); wav.write('test', 20); wav.write('fmt ', 24); wav.writeUInt32LE(16, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(2, 34); wav.writeUInt32LE(16000, 36); wav.writeUInt16LE(16, 46); wav.write('data', 48); wav.writeUInt32LE(4, 52); wav.writeInt16LE(16000, 56); wav.writeInt16LE(-8000, 58)
  const result = readWav(wav); assert.equal(result.sampleRate, 16000); assert.equal(result.samples.length, 1); assert.equal(result.samples[0], 4000 / 32768)
  assert.throws(() => readWav(wav.subarray(0, 58)), /不完整/)
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]); const encoded = png.map(byte => byte ^ 63)
  assert.deepEqual(decodeLegacyImage(encoded), png); assert.equal(imageMime(png), 'image/png')
})

test('本地语音转写可进入既有日报文字链路，并继续要求发送确认', () => {
  const period = reportPeriod('daily', '2026-09-15')
  const source = { session, period, capturedAt: Date.now(), complete: true as const, messages: [{ ...message('voice', period.start + 100, 'a', '[本地语音转写] 讨论结论'), type: 'voice' as const, transcript: '讨论结论' }] }
  const report = prepareGroupReport(source, defaultReportTemplate('daily'), false, true)
  assert.equal(report.input.messages[0].type, 'text'); assert.match(report.input.messages[0].text, /讨论结论/)
  assert.throws(() => prepareGroupReport(source, defaultReportTemplate('daily'), false, false), /确认允许/)
})

test('真实导出 Worker 分批写入；取消不覆盖原文件，也不遗留临时文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhiliao-export-'))
  const worker = join(root, 'worker.cjs'), output = join(root, 'chat.json')
  try {
    await build({ entryPoints: ['electron/export-worker.ts'], outfile: worker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
    const messages = Array.from({ length: 1101 }, (_, index) => message(`id-${index}`))
    const progress: number[] = [], controller = new AbortController()
    await writeChatExport(output, session, messages, 'json', { signal: controller.signal, checkpoint: async () => {}, progress: current => { progress.push(current) }, files: () => {} }, worker)
    assert.equal(JSON.parse(await readFile(output, 'utf8')).messages.length, 1101); assert.ok(progress.includes(500)); assert.ok(progress.includes(1000))
    await writeFile(output, 'existing-content')
    let checks = 0
    await assert.rejects(writeChatExport(output, session, messages, 'json', { signal: controller.signal, checkpoint: async () => { if (++checks === 2) throw new Error('任务已取消') }, progress: () => {}, files: () => {} }, worker), /已取消/)
    assert.equal(await readFile(output, 'utf8'), 'existing-content'); assert.equal((await readdir(root)).some(file => file.endsWith('.tmp')), false)
  } finally { await cleanFixture(root) }
})

test('分页图片整批保存，目标出错时保留原文件并清理临时内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhiliao-files-'))
  try {
    const first = join(root, 'page-01.png'), second = join(root, 'page-02.png')
    await writeFile(first, 'original'); await mkdir(second)
    await assert.rejects(writeFilesAtomically([{ path: first, data: Buffer.from('new') }, { path: second, data: Buffer.from('invalid') }]), /不是文件/)
    assert.equal(await readFile(first, 'utf8'), 'original'); assert.equal((await readdir(root)).some(file => /\.(tmp|bak)$/.test(file)), false)
    await writeFilesAtomically([{ path: first, data: Buffer.from('replaced') }, { path: join(root, 'page-03.png'), data: Buffer.from('third') }])
    assert.equal(await readFile(first, 'utf8'), 'replaced'); assert.equal((await readdir(root)).some(file => /\.(tmp|bak)$/.test(file)), false)
  } finally { await cleanFixture(root) }
})
