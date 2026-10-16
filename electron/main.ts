import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { analysisSchema, loginSchema, registerSchema, type AccountInfo } from '../shared/contracts.js'
import { CloudClient, CloudError } from '../shared/cloud-client.js'
import { validateClientConfig } from '../shared/service-url.mjs'
import { CloudAuthStore } from './cloud-auth.js'
import { LocalVault } from './vault.js'
import { DataSource } from './data-source.js'
import { groupReportInputSchema, reportRangeSchema, reportTemplatesSchema, savedGroupReportSchema } from '../shared/group-report.js'
import { exportCommunityReport } from './report-export.js'
import { randomUUID } from 'node:crypto'
import { activeTask, chatExportSchema, messageQuerySchema, scheduleInputSchema, selectMessages, wechatConnectSchema, weflowConnectSchema } from '../shared/workbench.js'
import { safeFileName } from '../shared/chat-export.js'
import { TaskManager } from './task-manager.js'
import { ExportScheduler } from './export-scheduler.js'
import { writeChatExport } from './chat-export.js'
import { MediaService } from './media-service.js'

const development = !app.isPackaged
if (development) {
  const dataPath = process.env.ZHILIAO_DESKTOP_DATA || join(app.getAppPath(), 'data', 'desktop')
  mkdirSync(dataPath, { recursive: true })
  app.setPath('userData', dataPath)
}
const reportSchema = z.object({ id: z.string().uuid(), title: z.string().min(1).max(160), mode: z.enum(['summary', 'actions', 'question']), createdAt: z.number().finite(), sourceName: z.string().max(100), messageCount: z.number().int().min(1).max(300), content: z.string().min(1).max(128000), demo: z.boolean(), evidence: z.array(z.object({ id: z.string().regex(/^M\d+$/), sender: z.string().max(128), timestamp: z.number().finite(), text: z.string().max(4000) }).strict()).max(300).optional() }).strict()
let window: BrowserWindow
let source: DataSource | null = null
let cloud: CloudClient | null = null
let tasks: TaskManager | null = null
let scheduler: ExportScheduler | null = null
let quitAllowed = false
let quitPending = false

async function requestQuit(): Promise<void> {
  if (quitPending) return
  quitPending = true
  try {
    if (tasks?.busy()) {
      const answer = await dialog.showMessageBox(window, { type: 'question', title: '还有任务未完成', message: '退出后，当前任务将中断，定时导出也会停止。', detail: '已完成的文件会保留；下次启动后可在任务中心查看中断记录。', buttons: ['继续运行', '退出软件'], defaultId: 0, cancelId: 0 })
      if (answer.response !== 1) return
    }
    scheduler?.stop(); tasks?.shutdown(); cloud?.cancel(); await source?.stop(); quitAllowed = true; app.quit()
  } finally { quitPending = false }
}

awaitReady()
function awaitReady(): void {
  void app.whenReady().then(async () => {
    const vault = new LocalVault(app.getPath('userData'))
    let endpoint = process.env.CLOUD_API_URL || 'http://127.0.0.1:4310'
    if (app.isPackaged) {
      try {
        const config = JSON.parse(readFileSync(join(process.resourcesPath, 'cloud-config.json'), 'utf8'))
        endpoint = validateClientConfig(config).url
      } catch { endpoint = '' }
    } else endpoint = validateClientConfig({ url: endpoint, preview: true }).url
    cloud = new CloudClient(endpoint)
    const auth = new CloudAuthStore(vault, endpoint)
    cloud.token = auth.read()?.token || null
    let owner = auth.read()?.account.user.id || ''
    const indexPath = join(__dirname, '../dist/index.html')
    const devUrl = process.env.VITE_DEV_SERVER_URL || ''
    window = new BrowserWindow({
      width: 1440, height: 940, minWidth: 1050, minHeight: 720, backgroundColor: '#f5f6f2', title: '知聊', show: false,
      webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
    })
    const resources = app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources/native')
    const send = (channel: string, value: unknown) => { if (!window.isDestroyed()) window.webContents.send(channel, value) }
    tasks = new TaskManager(vault.tasks(), value => vault.saveTasks(value), value => send('tasks:changed', value))
    source = new DataSource(vault, () => window, resources, event => send('data:changed', event))
    scheduler = new ExportScheduler(source, tasks, vault)
    scheduler.start()
    const media = new MediaService(source, vault, tasks, () => window, resources)
    const assertIdle = () => { if (tasks!.busy()) throw new Error('请先完成或取消任务，再切换账号或数据来源') }
    window.on('close', event => { if (!quitAllowed) { event.preventDefault(); void requestQuit() } })
    const allowedUrl = devUrl || pathToFileURL(indexPath).href
    const trusted = (url: string) => url.split('#')[0] === allowedUrl || (Boolean(devUrl) && new URL(url).origin === new URL(devUrl).origin)
    window.webContents.on('will-navigate', (event, url) => { if (!trusted(url)) event.preventDefault() })
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    if (!devUrl) window.webContents.session.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'"] } }))
    const handle = (channel: string, action: (...args: any[]) => unknown) => {
      ipcMain.handle(channel, async (event, ...args) => {
        if (event.senderFrame !== window.webContents.mainFrame || !trusted(event.senderFrame.url)) return { ok: false, error: '无权执行此操作' }
        try { return { ok: true, data: await action(...args) } } catch (error) {
          return { ok: false, error: error instanceof z.ZodError ? '输入信息不正确，请检查后重试' : error instanceof Error ? error.message : '操作失败，请重试' }
        }
      })
    }
    const saveAuth = (account: AccountInfo) => { owner = account.user.id; return auth.save(cloud!.token, account) }
    handle('cloud:health', () => cloud!.health())
    handle('auth:login', async input => { assertIdle(); return saveAuth(await cloud!.login(loginSchema.parse(input))) })
    handle('auth:register', async input => { assertIdle(); return saveAuth(await cloud!.login(registerSchema.parse(input), true)) })
    handle('auth:account', async () => {
      try {
        const account = await cloud!.account()
        if (account) return saveAuth(account)
        owner = ''; auth.clear(); return null
      } catch (error) {
        if (error instanceof CloudError && (error.code === 'NETWORK_ERROR' || (error.status && error.status >= 500))) return auth.offline()
        throw error
      }
    })
    handle('auth:logout', async () => { assertIdle(); try { await cloud!.logout() } finally { owner = ''; auth.clear() } })
    handle('data:status', () => source!.status())
    handle('data:sessions', () => source!.sessions())
    handle('data:messages', (sessionId, limit) => source!.messages(z.string().min(1).max(512).parse(sessionId), z.number().int().min(1).max(1000).parse(limit)))
    handle('data:import', () => { assertIdle(); return source!.importFile() })
    handle('data:sample', () => { assertIdle(); return source!.sample() })
    handle('data:wechat', options => { assertIdle(); return source!.connectWeChat(wechatConnectSchema.parse(options || {})) })
    handle('data:weflow', options => { assertIdle(); return source!.connectWeFlow(weflowConnectSchema.parse(options || { port: source!.weflowSettings().port })) })
    handle('data:disconnect', () => { assertIdle(); return source!.disconnect() })
    handle('data:profiles', () => source!.profiles())
    handle('data:removeProfile', id => { assertIdle(); return source!.removeProfile(z.string().min(1).max(80).parse(id)) })
    handle('data:weflowSettings', () => source!.weflowSettings())
    handle('data:query', input => source!.query(messageQuerySchema.parse(input)))
    handle('data:reportSource', range => source!.reportSource(reportRangeSchema.parse(range)))
    handle('groupReport:generate', input => {
      const parsed = groupReportInputSchema.parse(input)
      return tasks!.enqueue({ title: `${parsed.kind === 'daily' ? '日报' : '周报'} · ${parsed.sessionName}`, kind: 'report', canPause: false }, async context => {
        const cancel = () => cloud!.cancel(); context.signal.addEventListener('abort', cancel, { once: true })
        try { await context.checkpoint(); await cloud!.groupReport(parsed, event => { if (event.type === 'progress') context.progress(event.current, event.total, event.message); send('groupReport:event', event); if (event.type === 'error') throw new Error(event.message) }) } finally { context.signal.removeEventListener('abort', cancel) }
      }).done
    })
    handle('groupReport:list', () => vault.groupReports(owner))
    handle('groupReport:save', report => vault.saveGroupReport(owner, savedGroupReportSchema().parse(report)))
    handle('groupReport:delete', id => vault.deleteGroupReport(owner, z.string().uuid().parse(id)))
    handle('groupReport:templates', () => vault.reportTemplates())
    handle('groupReport:saveTemplates', templates => vault.saveReportTemplates(reportTemplatesSchema.parse(templates)))
    handle('groupReport:export', (report, format) => {
      const parsed = savedGroupReportSchema().parse(report), target = z.enum(['png', 'png-pages', 'pdf', 'html']).parse(format)
      return tasks!.enqueue({ title: `分享报告 · ${parsed.title}`, kind: 'export' }, context => exportCommunityReport(window, parsed, target, context)).done
    })
    handle('analysis:start', input => {
      const parsed = analysisSchema.parse(input)
      return tasks!.enqueue({ title: `对话分析 · ${parsed.sessionName}`, kind: 'analysis', canPause: false }, async context => {
        const cancel = () => cloud!.cancel(); context.signal.addEventListener('abort', cancel, { once: true })
        try { await context.checkpoint(); await cloud!.analyze(parsed, event => { send('analysis:event', event); if (event.type === 'error') throw new Error(event.message) }) } finally { context.signal.removeEventListener('abort', cancel) }
      }).done
    })
    handle('analysis:cancel', async () => { for (const task of tasks!.list().filter(task => activeTask(task) && ['analysis', 'report'].includes(task.kind))) await tasks!.control(task.id, 'cancel') })
    handle('tasks:list', () => tasks!.list())
    handle('tasks:action', (id, action) => tasks!.control(z.string().uuid().parse(id), z.enum(['pause', 'resume', 'cancel']).parse(action)))
    handle('tasks:reveal', id => { const task = tasks!.list().find(item => item.id === z.string().uuid().parse(id)); if (task?.files[0]) shell.showItemInFolder(task.files[0]) })
    handle('data:export', async input => {
      const parsed = chatExportSchema.parse(input), identity = source!.identity()
      const session = (await source!.sessions()).find(item => item.id === parsed.query.sessionId)
      if (!session) throw new Error('请选择有效会话')
      const choice = await dialog.showSaveDialog(window, { title: '导出所选范围的聊天记录', defaultPath: `${safeFileName(session.name)}.${parsed.format}`, filters: [{ name: parsed.format.toUpperCase(), extensions: [parsed.format] }] })
      if (choice.canceled || !choice.filePath) return null
      return tasks!.enqueue({ title: `聊天导出 · ${session.name}`, kind: 'export' }, async context => {
        if (source!.identity() !== identity) throw new Error('数据来源已变化，请重新发起导出')
        const messages = selectMessages(await source!.readRange(session.id, parsed.query.start, parsed.query.end, 100000, context), parsed.query)
        await writeChatExport(choice.filePath!, session, messages, parsed.format, context)
      }).id
    })
    handle('schedules:list', () => scheduler!.list())
    handle('schedules:save', async input => {
      const parsed = scheduleInputSchema.parse(input)
      const previous = parsed.id ? scheduler!.get(parsed.id) : undefined
      if (parsed.id && !previous) throw new Error('导出计划不存在')
      if (previous?.activeTaskId) throw new Error('该计划正在执行，请完成后修改')
      const session = (await source!.sessions()).find(item => item.id === parsed.sessionId)
      if (!session) throw new Error('请连接计划使用的会话来源')
      if (!previous && scheduler!.list().length >= 30) throw new Error('最多保存 30 个导出计划')
      let directory = previous?.directory
      if (!directory) {
        const choice = await dialog.showOpenDialog(window, { title: '选择定时导出保存目录', properties: ['openDirectory', 'createDirectory'] })
        if (choice.canceled || !choice.filePaths[0]) return null
        directory = choice.filePaths[0]
      }
      const schedule = { ...parsed, id: parsed.id || randomUUID(), directory, sourceId: source!.identity(), sessionName: session.name, nextRunAt: previous && previous.firstRunAt === parsed.firstRunAt && previous.intervalHours === parsed.intervalHours ? previous.nextRunAt : parsed.firstRunAt, runs: previous?.runs || 0, lastRunAt: previous?.lastRunAt, lastMessage: previous?.lastMessage }
      scheduler!.save(schedule); return schedule
    })
    handle('schedules:delete', id => scheduler!.remove(z.string().uuid().parse(id)))
    handle('media:status', () => media.status())
    handle('media:prepare', mode => media.prepare(z.enum(['download', 'folder']).parse(mode)))
    handle('media:process', input => media.process(z.object({ sessionId: z.string().min(1).max(512), messageId: z.string().min(1).max(1024), action: z.enum(['transcribe', 'image']), chooseFile: z.boolean().optional() }).strict().parse(input)))
    handle('reports:list', () => vault.reports(owner))
    handle('reports:save', input => vault.saveReport(owner, reportSchema.parse(input)))
    handle('reports:delete', id => vault.deleteReport(owner, z.string().uuid().parse(id)))
    handle('clipboard:write', text => clipboard.writeText(z.string().max(128000).parse(text)))
    handle('reports:export', async input => {
      const report = reportSchema.parse(input)
      const result = await dialog.showSaveDialog(window, { title: '导出分析结果', defaultPath: `${safeFileName(report.title)}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] })
      if (result.canceled || !result.filePath) return false
      writeFileSync(result.filePath, `# ${report.title}\n\n会话：${report.sourceName}\n消息数：${report.messageCount}\n时间：${new Date(report.createdAt).toLocaleString('zh-CN')}\n${report.demo ? '\n> 演示结果，不代表真实 AI 分析。\n' : ''}\n${report.content}\n`, 'utf8')
      return true
    })
    window.once('ready-to-show', () => window.show())
    if (devUrl) await window.loadURL(devUrl)
    else await window.loadFile(indexPath)
  }).catch(error => { dialog.showErrorBox('知聊启动失败', error instanceof Error ? error.message : '启动异常'); app.quit() })
}
app.on('before-quit', event => { if (!quitAllowed && window && !window.isDestroyed()) { event.preventDefault(); void requestQuit() } else { scheduler?.stop(); cloud?.cancel(); void source?.stop() } })
app.on('window-all-closed', () => app.quit())
