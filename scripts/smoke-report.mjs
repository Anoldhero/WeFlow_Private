import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { CloudClient } from '../shared/cloud-client.ts'
import { DEMO_LOGIN } from '../shared/demo.ts'
import { communitySampleDataset, datasetReportSource, defaultReportDate, defaultReportTemplate, prepareGroupReport, saveableGroupReport } from '../shared/group-report.ts'
import { groupReportDocument } from '../shared/report-renderer.ts'

const client = new CloudClient('http://127.0.0.1:5178/cloud')
const health = await client.health()
assert.equal(health.mode, 'demo', '此检查仅运行于本机演示服务')
const account = await client.login(DEMO_LOGIN)
const dataset = communitySampleDataset()
const source = datasetReportSource(dataset, { sessionId: dataset.session.id, kind: 'weekly', date: defaultReportDate('weekly') })
const prepared = prepareGroupReport(source, defaultReportTemplate('weekly'), true, true)
let completed
let progress = 0
await client.groupReport(prepared.input, event => {
  if (event.type === 'progress') progress++
  if (event.type === 'error') throw new Error(event.message)
  if (event.type === 'complete') completed = event
})
assert.ok(completed)
assert.equal(completed.result.stats.messages, 42)
assert.equal(completed.result.demo, true)
assert.equal(completed.quota.used, account.quota.used + 1)
const report = saveableGroupReport(prepared.input, completed.result, prepared.originals, { id: source.session.id, name: source.session.name, capturedAt: source.capturedAt }, '行业观察社群 · 上周精选（演示）')
mkdirSync('output/report-examples', { recursive: true })
writeFileSync('output/report-examples/community-weekly.html', groupReportDocument(report))
await client.logout()
console.log(JSON.stringify({ passed: true, version: health.version, mode: health.mode, messages: report.stats.messages, sections: report.sections.length, savedReferences: report.evidence.length, progressEvents: progress, charged: 1 }, null, 2))
