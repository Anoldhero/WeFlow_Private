import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve, join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { validateClientConfig, validateServiceUrl } from '../shared/service-url.mjs'
import { CloudAuthStore } from '../electron/cloud-auth.js'
import { backupDatabase } from '../server/backup.js'
import { createCloudApp } from '../server/app.js'
import { readConfig } from '../server/config.js'
import { CloudStore } from '../server/store.js'
import { CloudClient } from '../shared/cloud-client.js'
import { DEMO_LOGIN } from '../shared/demo.js'
import { communitySampleDataset, datasetReportSource, defaultReportDate, defaultReportTemplate, prepareGroupReport } from '../shared/group-report.js'
import type { AccountInfo } from '../shared/contracts.js'

const { resolveDevOptions, clientEnvironment, publicClientUrl } = await import(new URL('../scripts/runtime-config.mjs', import.meta.url).href)
const { controlDev, startDevControl } = await import(new URL('../scripts/dev-control.mjs', import.meta.url).href)
const root = resolve('.')
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function cleanup(directory: string) { if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('zhiliao-deploy-')) throw new Error('测试目录超出清理范围'); await rm(directory, { recursive: true, force: true }) }
async function listen(server: Server): Promise<number> { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return (server.address() as { port: number }).port }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
async function freePort(): Promise<number> { const server = createServer(); const port = await listen(server); await close(server); return port }
function launch(directory: string, args: string[]) {
  const child = spawn(process.execPath, ['scripts/dev.mjs', ...args], { cwd: root, env: { ...process.env, ZHILIAO_DEV_STATE_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  child.stdout?.on('data', value => { output += value }); child.stderr?.on('data', value => { output += value })
  return { child, output: () => output }
}
async function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode
  return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('开发进程未按时退出')), 15000); child.once('exit', code => { clearTimeout(timer); resolve(code) }) })
}
async function ready(directory: string, child: ChildProcess, output: () => string) {
  const end = Date.now() + 30000
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(output())
    const state = await controlDev(directory, 'status').catch(() => null)
    if (state?.state === 'ready') return state
    await delay(100)
  }
  throw new Error(`开发环境未就绪：${output()}`)
}

test('正式客户端仅接受公开 HTTPS 地址与预览标记，错误信息不回显凭据', () => {
  assert.deepEqual(validateClientConfig({ url: 'https://cloud.example.org/api/', preview: false }), { url: 'https://cloud.example.org/api', preview: false })
  assert.equal(validateClientConfig({ url: 'http://127.0.0.1:4310', preview: true }).preview, true)
  for (const url of ['http://cloud.example.org', 'https://localhost', 'https://127.1', 'https://[::1]']) assert.throws(() => validateClientConfig({ url, preview: false }))
  assert.throws(() => validateClientConfig({ url: 'https://cloud.example.org', preview: false, apiKey: 'must-not-ship' }), /只允许/)
  assert.throws(() => validateServiceUrl('https://user:private-secret@cloud.example.org?q=secret', false), error => error instanceof Error && !error.message.includes('private-secret'))
})

test('本机/演示/云端三种开发模式互斥，客户端进程不继承服务端模型配置', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zhiliao-deploy-config-'))
  try {
    assert.equal(resolveDevOptions([], {}, directory).mode, 'local')
    assert.equal(resolveDevOptions(['--demo'], {}, directory).mode, 'demo')
    const cloud = resolveDevOptions(['--cloud', '--desktop', '--web-port', '5179'], { CLOUD_API_URL: 'https://cloud.example.org/api' }, directory)
    assert.equal(cloud.mode, 'cloud'); assert.equal(cloud.endpoint, 'https://cloud.example.org/api'); assert.equal(cloud.webPort, 5179)
    assert.throws(() => resolveDevOptions(['--demo', '--cloud'], {}, directory), /不能同时/)
    assert.throws(() => resolveDevOptions(['--cloud'], {}, directory), /CLOUD_API_URL/)
    const env = clientEnvironment({ PATH: 'system-path', LLM_API_KEY: 'server-secret', LLM_MODEL: 'model', AI_PROVIDER: 'compatible', DATABASE_PATH: 'private.sqlite', ELECTRON_RUN_AS_NODE: '1' }, cloud.endpoint, cloud.webUrl, directory)
    for (const name of ['LLM_API_KEY', 'LLM_MODEL', 'AI_PROVIDER', 'DATABASE_PATH', 'ELECTRON_RUN_AS_NODE']) assert.equal(name in env, false)
    assert.equal(env.PATH, 'system-path'); assert.equal(env.CLOUD_API_URL, cloud.endpoint)
    await writeFile(join(directory, '.env.client'), 'CLOUD_API_URL=https://cloud.example.org\nLLM_API_KEY=not-public\n')
    assert.throws(() => publicClientUrl(directory, {}), /只允许/)
  } finally { await cleanup(directory) }
})

test('本机登录缓存按云端地址隔离，离线账户可阅读但不冒用额度', () => {
  const storage = new Map<string, unknown>([['token', 'legacy-token'], ['accountId', 'legacy-id']])
  const vault = { secret<T>(key: string) { return storage.get(key) as T ?? null }, setSecret(key: string, value: unknown) { if (value === null) storage.delete(key); else storage.set(key, value) } }
  const account: AccountInfo = { user: { id: 'user-a', username: 'alice', displayName: '甲' }, quota: { limit: 30, remaining: 28, used: 2, pending: 0, resetsAt: new Date().toISOString() } }
  const first = new CloudAuthStore(vault, 'https://a.example.org'), same = new CloudAuthStore(vault, 'https://a.example.org/'), other = new CloudAuthStore(vault, 'https://b.example.org')
  assert.equal(first.read(), null)
  first.save('new-token', account)
  assert.equal(same.read()?.token, 'new-token'); assert.equal(other.read(), null)
  assert.equal(first.offline()?.offline, true); assert.equal(first.offline()?.quota.remaining, 0); assert.equal(first.read()?.account.quota.remaining, 28)
  first.clear(); assert.equal(first.read(), null)
})

test('云端健康与就绪状态分离，停止服务可重复调用', async () => {
  const service = createCloudApp(readConfig({}), { store: new CloudStore(':memory:') })
  assert.equal((await service.app.inject({ url: '/health' })).statusCode, 200)
  assert.equal((await service.app.inject({ url: '/readyz' })).statusCode, 503)
  await Promise.all([service.stop(), service.stop()])
  const readyService = createCloudApp(readConfig({ AI_PROVIDER: 'demo' }), { store: new CloudStore(':memory:') })
  try { assert.equal((await readyService.app.inject({ url: '/readyz' })).statusCode, 200) } finally { await readyService.stop() }
})

test('SQLite 在线备份包含 WAL 中的记录，重复文件名不会覆盖历史备份', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zhiliao-deploy-backup-'))
  const source = join(directory, 'source.sqlite'), output = join(directory, 'backups/result.sqlite')
  const db = new DatabaseSync(source)
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE records(value TEXT); INSERT INTO records VALUES (\'first\')')
    const result = await backupDatabase(source, output)
    assert.ok(result.bytes > 0)
    db.exec("INSERT INTO records VALUES ('later')")
    const snapshot = new DatabaseSync(output, { readOnly: true })
    try { assert.equal(snapshot.prepare('SELECT COUNT(*) AS n FROM records').get()?.n, 1) } finally { snapshot.close() }
    await assert.rejects(backupDatabase(source, output), /已存在/)
    assert.equal((await readdir(dirname(output))).some(name => name.endsWith('.tmp')), false)
  } finally { db.close(); await cleanup(directory) }
})

test('开发控制接口验证本次实例身份，拒绝未授权停止请求', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zhiliao-deploy-control-'))
  let stopped = false
  const control = await startDevControl(directory, { mode: 'test' }, async () => { stopped = true })
  try {
    const record = JSON.parse(await readFile(join(directory, '.cache/dev-session.json'), 'utf8'))
    const response = await fetch(`http://127.0.0.1:${record.port}/stop`, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })
    assert.equal(response.status, 403); assert.equal(stopped, false)
    const status = await controlDev(directory, 'status')
    assert.equal(status.running, true); assert.equal('token' in status, false)
    await assert.rejects(startDevControl(directory, {}, async () => {}), /已在运行/)
  } finally { await control.close(); await cleanup(directory) }
})

test('真实演示进程经 Vite 代理生成周报，停服同时关闭前后端并保留数据', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zhiliao-deploy-demo-'))
  const webPort = await freePort(), apiPort = await freePort()
  const run = launch(directory, ['--demo', '--web-port', String(webPort), '--api-port', String(apiPort)])
  try {
    const state = await ready(directory, run.child, run.output)
    assert.equal(state.localApiPort, apiPort)
    const client = new CloudClient(`http://127.0.0.1:${webPort}/cloud`)
    assert.equal((await client.health()).mode, 'demo')
    await client.login(DEMO_LOGIN)
    const dataset = communitySampleDataset(), source = datasetReportSource(dataset, { sessionId: dataset.session.id, kind: 'weekly', date: defaultReportDate('weekly') })
    const { input } = prepareGroupReport(source, defaultReportTemplate('weekly'), true, true)
    let complete = false
    await client.groupReport(input, event => { if (event.type === 'error') throw new Error(event.message); if (event.type === 'complete') { complete = true; assert.equal(event.result.stats.messages, 42) } })
    assert.equal(complete, true); await client.logout()
    await controlDev(directory, 'stop'); assert.equal(await exited(run.child), 0)
    for (const port of [webPort, apiPort]) await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }))
    assert.ok((await readFile(join(directory, 'data/demo.sqlite'))).byteLength > 0)
  } finally { if (run.child.exitCode === null) { await controlDev(directory, 'stop').catch(() => {}); if (run.child.exitCode === null) run.child.kill(); await exited(run.child) }; await cleanup(directory) }
})

test('云端开发模式仅启动客户端代理，停止时不影响独立云端服务', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zhiliao-deploy-remote-'))
  const requested: string[] = []
  const remote = createServer((req, res) => { requested.push(req.url || ''); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'ok', version: 'test', aiReady: true, mode: 'cloud' })) })
  const remotePort = await listen(remote), webPort = await freePort(), unusedApiPort = await freePort()
  const run = launch(directory, ['--cloud-url', `http://127.0.0.1:${remotePort}/product`, '--web-port', String(webPort), '--api-port', String(unusedApiPort)])
  try {
    const state = await ready(directory, run.child, run.output)
    assert.equal(state.mode, 'cloud'); assert.equal(state.localApiPort, null)
    const response = await fetch(`http://127.0.0.1:${webPort}/cloud/health`)
    assert.equal(response.status, 200); assert.deepEqual(requested, ['/product/health'])
    await assert.rejects(fetch(`http://127.0.0.1:${unusedApiPort}`, { signal: AbortSignal.timeout(1000) }))
    await controlDev(directory, 'stop'); assert.equal(await exited(run.child), 0)
    assert.equal((await fetch(`http://127.0.0.1:${remotePort}/health`)).status, 200)
  } finally { if (run.child.exitCode === null) { await controlDev(directory, 'stop').catch(() => {}); if (run.child.exitCode === null) run.child.kill(); await exited(run.child) }; await close(remote); await cleanup(directory) }
})

test('前端端口被占用时启动失败会清理自己启动的 API 进程', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zhiliao-deploy-failure-'))
  const occupied = createServer((_req, res) => res.end('other-service')), webPort = await listen(occupied), apiPort = await freePort()
  const run = launch(directory, ['--demo', '--web-port', String(webPort), '--api-port', String(apiPort)])
  try {
    assert.equal(await exited(run.child), 1)
    assert.equal((await controlDev(directory, 'status')).running, false)
    await assert.rejects(fetch(`http://127.0.0.1:${apiPort}`, { signal: AbortSignal.timeout(1000) }))
    assert.equal(await (await fetch(`http://127.0.0.1:${webPort}`)).text(), 'other-service')
  } finally { if (run.child.exitCode === null) { run.child.kill(); await exited(run.child) }; await close(occupied); await cleanup(directory) }
})
