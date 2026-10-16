import { createServer } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNode24 } from './runtime-config.mjs'

const stateFile = root => join(root, '.cache/dev-session.json')
async function readRecord(root) {
  let text
  try { text = await readFile(stateFile(root), 'utf8') } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  const value = JSON.parse(text)
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.token) || typeof value.instance !== 'string') throw new Error('开发会话记录无效，请核对 .cache/dev-session.json')
  return value
}
async function request(record, action) {
  let response
  try { response = await fetch(`http://127.0.0.1:${record.port}/${action}`, { method: action === 'stop' ? 'POST' : 'GET', headers: { Authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(4000), redirect: 'error' }) }
  catch (error) { if (error.cause?.code === 'ECONNREFUSED') return null; throw new Error('无法联系本项目开发进程；请回到启动终端检查状态') }
  if (!response.ok) throw new Error('开发控制记录与当前进程不匹配，未执行停止')
  const data = await response.json()
  if (data.instance !== record.instance) throw new Error('开发进程身份不匹配，未执行停止')
  return data
}
async function removeRecord(root, instance) {
  const current = await readRecord(root).catch(() => null)
  if (current?.instance === instance) await unlink(stateFile(root)).catch(error => { if (error.code !== 'ENOENT') throw error })
}
export async function startDevControl(root, information, onStop) {
  const previous = await readRecord(root)
  if (previous) {
    if (await request(previous, 'status')) throw new Error('本项目开发环境已在运行，请先执行 pnpm stop')
    await removeRecord(root, previous.instance)
  }
  const token = randomBytes(32).toString('hex'), instance = randomUUID()
  let state = 'starting'
  const server = createServer((req, res) => {
    const expected = Buffer.from(`Bearer ${token}`), provided = Buffer.from(req.headers.authorization || '')
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store')
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) { res.writeHead(403); res.end('{"error":"unauthorized"}'); return }
    if (req.method === 'GET' && req.url === '/status') res.end(JSON.stringify({ running: true, instance, pid: process.pid, state, ...information }))
    else if (req.method === 'POST' && req.url === '/stop') { res.end(JSON.stringify({ accepted: true, instance }), () => { void onStop() }) }
    else { res.writeHead(404); res.end('{}') }
  })
  server.requestTimeout = 5000; server.headersTimeout = 5000
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  try {
    await mkdir(join(root, '.cache'), { recursive: true })
    await writeFile(stateFile(root), JSON.stringify({ instance, token, port: server.address().port }), { flag: 'wx', mode: 0o600 })
  } catch (error) { await new Promise(resolve => server.close(resolve)); throw error }
  return {
    setState(value) { state = value },
    async close() { await removeRecord(root, instance); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  }
}
export async function controlDev(root, action) {
  const record = await readRecord(root)
  if (!record) return { running: false }
  const result = await request(record, action)
  if (!result) { await removeRecord(root, record.instance); return { running: false } }
  if (action === 'stop') {
    const end = Date.now() + 12000
    while (Date.now() < end) {
      const current = await readRecord(root)
      if (!current || current.instance !== record.instance) return { running: false, stopped: true }
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    throw new Error('已请求停止，但进程尚未退出，请检查启动终端')
  }
  const { instance: _instance, ...status } = result
  return status
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assertNode24()
    const action = process.argv[2]
    if (!['status', 'stop'].includes(action)) throw new Error('使用 node scripts/dev-control.mjs status 或 stop')
    const status = await controlDev(resolve(process.env.ZHILIAO_DEV_STATE_DIR || process.cwd()), action)
    console.log(status.running ? JSON.stringify(status, null, 2) : status.stopped ? '本项目开发环境已停止。' : '本项目开发环境未运行。')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
