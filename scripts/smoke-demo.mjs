import { CloudClient } from '../shared/cloud-client.ts'
import { DEMO_LOGIN } from '../shared/demo.ts'
import { prepareAnalysis } from '../shared/data.ts'
import { sampleDatasets } from '../shared/sample.ts'

const client = new CloudClient('http://127.0.0.1:5178/cloud')
const health = await client.health()
if (health.mode !== 'demo') throw new Error('仅允许对显式演示环境运行此检查')
const account = await client.login(DEMO_LOGIN)
const sample = sampleDatasets()[0]
const { input } = prepareAnalysis({ messages: sample.messages.slice(-3), mode: 'summary', question: '', sessionName: sample.session.name, anonymize: true, consent: true })
let output = ''
let completed = null
await client.analyze(input, event => {
  if (event.type === 'delta') output += event.text
  if (event.type === 'complete') completed = event
  if (event.type === 'error') throw new Error(event.message)
})
if (!completed || !output.includes('演示回复') || !output.includes('[M1]')) throw new Error('演示闭环没有完整完成')
if (completed.quota.remaining !== account.quota.remaining - 1) throw new Error('额度变化不符合预期')
await client.logout()
console.log(JSON.stringify({ passed: true, mode: health.mode, throughFrontendProxy: true, sentMessages: input.messages.length, receivedCharacters: output.length, referencedEvidence: true, quotaCharged: 1 }, null, 2))
