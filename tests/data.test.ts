import test from 'node:test'
import assert from 'node:assert/strict'
import { analysisSchema } from '../shared/contracts.js'
import { normalizeMessage, normalizeWxid, parseImportedDataset, prepareAnalysis, timestampSeconds } from '../shared/data.js'

test('ChatLab 导入保留发送者并统一秒与毫秒时间戳', () => {
  const data = parseImportedDataset(JSON.stringify({ chatlab: { version: '0.0.2' }, meta: { name: '测试会话', ownerId: 'me' }, members: [{ platformId: 'other', accountName: '林可' }], messages: [{ sender: 'other', timestamp: 1750000000, type: 0, content: '第一条' }, { sender: 'me', timestamp: 1750000001000, type: 0, content: '第二条' }] }), 'sample.json')
  assert.equal(data.session.name, '测试会话')
  assert.deepEqual(data.messages.map(message => [message.timestamp, message.sender, message.self]), [[1750000000, '林可', false], [1750000001, '我', true]])
})

test('WeFlow 消息导入处理空文本和 XML 卡片，不把 XML 指令作为执行内容', () => {
  const message = normalizeMessage({ localId: 1, createTime: 1750000000, localType: 49, content: '<msg><appmsg><title><![CDATA[项目文件]]></title><des>请阅读</des></appmsg></msg>' }, 0)
  assert.equal(message?.text, '项目文件\n请阅读')
  assert.equal(message?.type, 'file')
  assert.equal(timestampSeconds('invalid-date'), 0)
  assert.throws(() => parseImportedDataset('{broken', 'bad.json'), /有效的 JSON/)
  assert.throws(() => parseImportedDataset('{"messages":[]}', 'empty.json'), /没有可导入/)
})

test('JSONL 导入逐行读取头信息和消息，拒绝坏行', () => {
  const data = parseImportedDataset('{"chatlab":{"version":"0.0.2"},"meta":{"name":"测试"}}\n{"sender":"a","timestamp":1750000000,"type":0,"content":"你好"}\n', 'export.jsonl')
  assert.equal(data.messages.length, 1)
  assert.equal(data.session.name, '测试')
  assert.throws(() => parseImportedDataset('{}\nthis is not json', 'bad.jsonl'), /无效记录/)
})

test('发送内容严格限制为传入的选中消息，昵称与联系方式脱敏', () => {
  const message = normalizeMessage({ id: 'local-7', sender: '林可', timestamp: 1750000000, text: '林可的联系方式是 13800138000、person@example.com、wxid_sample' }, 0)!
  const prepared = prepareAnalysis({ messages: [message], mode: 'question', question: '林可的联系方式是什么？', sessionName: '私人会话', anonymize: true, consent: true })
  assert.equal(prepared.input.messages.length, 1)
  assert.equal(prepared.input.messages[0].sender, '联系人 1')
  assert.equal(prepared.references.M1, 'local-7')
  const payload = JSON.stringify(prepared.input)
  for (const personal of ['林可', '13800138000', 'person@example.com', 'wxid_sample', '私人会话']) assert.equal(payload.includes(personal), false)
  assert.match(payload, /手机号/)
  assert.equal(prepared.input.question, '联系人 1的联系方式是什么？')
  assert.throws(() => prepareAnalysis({ messages: [message], mode: 'summary', question: '', sessionName: '会话', anonymize: false, consent: false }), /确认允许/)
})

test('分析契约拒绝额外密钥字段、重复引用编号和过长内容', () => {
  const input = prepareAnalysis({ messages: [normalizeMessage({ text: '正常消息', timestamp: 1750000000 }, 0)!], mode: 'summary', question: '', sessionName: '会话', anonymize: true, consent: true }).input
  assert.equal(analysisSchema.safeParse({ ...input, apiKey: 'must-not-leave-device' }).success, false)
  assert.equal(analysisSchema.safeParse({ ...input, messages: [input.messages[0], input.messages[0]] }).success, false)
  assert.equal(analysisSchema.safeParse({ ...input, mode: 'question', question: '' }).success, false)
  assert.equal(analysisSchema.safeParse({ ...input, messages: [{ ...input.messages[0], text: 'a'.repeat(4001) }] }).success, false)
})

test('微信账号规范化不会截掉只有四位的账号本体', () => {
  assert.equal(normalizeWxid('wxid_ab12'), 'wxid_ab12')
  assert.equal(normalizeWxid('wxid_ab12_z9x8'), 'wxid_ab12')
  assert.equal(normalizeWxid('alias_z9x8'), 'alias')
})

test('兼容 WeFlow 实际 JSONL 格式，不把 member 元数据误当成消息', () => {
  const lines = [
    { _type: 'header', chatlab: { version: '0.0.2' }, meta: { name: '实际格式' } },
    { _type: 'member', platformId: 'wxid_other', accountName: '联系人甲' },
    { _type: 'message', sender: 'wxid_other', timestamp: 1750000000, type: 0, content: '真实消息' }
  ].map(row => JSON.stringify(row)).join('\n')
  const data = parseImportedDataset(lines, 'weflow.jsonl')
  assert.equal(data.messages.length, 1)
  assert.equal(data.messages[0].sender, '联系人甲')
  assert.equal(normalizeMessage({ platformId: 'metadata', accountName: '元数据' }, 0), null)
  assert.equal(normalizeMessage({ localId: 1, createTime: 1750000000, senderUsername: 'wxid_other', senderDisplayName: '显示名称', content: '内容' }, 0)?.sender, '显示名称')
  assert.throws(() => parseImportedDataset('{"weflow":{"format":"arkme-json"},"messages":[{}]}', 'arkme.json'), /Arkme/)
})
