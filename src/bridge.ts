import { CloudClient } from '../shared/cloud-client.js'
import type { AnalysisEvent, Dataset, DesktopAPI, SavedReport } from '../shared/contracts.js'
import { parseImportedDataset } from '../shared/data.js'
import { sampleDatasets } from '../shared/sample.js'
import { defaultReportTemplates, datasetReportSource, communitySampleDataset, reportTemplatesSchema, savedGroupReportSchema, type GroupReportEvent, type SavedGroupReport } from '../shared/group-report.js'
import { groupReportDocument } from '../shared/report-renderer.js'
import { inspectMessages, selectMessages } from '../shared/workbench.js'
import { exportFooter, exportHeader, exportMessage, safeFileName } from '../shared/chat-export.js'

declare global { interface Window { zhiliao?: DesktopAPI } }
export type ClientBridge = Omit<DesktopAPI, 'platform'> & { platform: 'desktop' | 'browser' }

function browserBridge(): ClientBridge {
  const cloud = new CloudClient('/cloud')
  let datasets: Dataset[] = []
  let owner = ''
  const listeners = new Set<(event: AnalysisEvent) => void>()
  const groupListeners = new Set<(event: GroupReportEvent) => void>()
  const reportKey = () => `zhiliao-preview-reports:${owner}`
  const reports = (): SavedReport[] => { try { const value = owner ? JSON.parse(localStorage.getItem(reportKey()) || '[]') : []; return Array.isArray(value) ? value : [] } catch { return [] } }
  const desktopOnly = async (): Promise<never> => { throw new Error('此功能需要桌面客户端，浏览器预览支持导入记录、检索和导出') }
  const readGroups = (): SavedGroupReport[] => { try { const value = owner ? JSON.parse(localStorage.getItem(`group-${reportKey()}`) || '[]') : []; return Array.isArray(value) ? value.filter(item => savedGroupReportSchema().safeParse(item).success) : [] } catch { return [] } }
  return {
    platform: 'browser',
    health: () => cloud.health(),
    login: async input => { const result = await cloud.login(input); owner = result.user.id; return result },
    register: async input => { const result = await cloud.login(input, true); owner = result.user.id; return result },
    account: async () => { const result = await cloud.account(); owner = result?.user.id || ''; return result },
    logout: async () => { try { await cloud.logout() } finally { owner = '' } },
    localStatus: async () => ({ connected: datasets.length > 0, source: datasets[0]?.session.source || null }),
    sessions: async () => datasets.map(dataset => dataset.session),
    messages: async (sessionId, limit) => datasets.find(dataset => dataset.session.id === sessionId)?.messages.slice(-limit) || [],
    importFile: () => new Promise((resolve, reject) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.json,.jsonl'
      input.oncancel = () => resolve(null)
      input.onchange = async () => {
        const file = input.files?.[0]
        if (!file) { resolve(null); return }
        try {
          if (file.size > 25 * 1024 * 1024) throw new Error('文件超过 25 MB，请拆分后导入')
          const dataset = parseImportedDataset(await file.text(), file.name)
          datasets = [...datasets.filter(item => item.session.source === 'import'), dataset]
          resolve(dataset.session)
        } catch (error) { reject(error) }
      }
      input.click()
    }),
    sample: async () => { datasets = [communitySampleDataset(), ...sampleDatasets()]; return datasets.map(dataset => dataset.session) },
    connectWeChat: desktopOnly,
    connectWeFlow: desktopOnly,
    wechatProfiles: async () => [],
    removeWeChatProfile: desktopOnly,
    weflowSettings: async () => ({ port: 5031, hasToken: false }),
    onDataChange: () => () => {},
    queryMessages: async query => inspectMessages(datasets.find(item => item.session.id === query.sessionId)?.messages || [], query),
    exportChat: async ({ query, format }) => {
      const dataset = datasets.find(item => item.session.id === query.sessionId)
      if (!dataset) throw new Error('请先选择会话')
      const messages = selectMessages(dataset.messages, query)
      const url = URL.createObjectURL(new Blob([exportHeader(dataset.session, format), ...messages.map((message, index) => exportMessage(message, dataset.session.id, format, index)), exportFooter(format)], { type: 'text/plain;charset=utf-8' }))
      const link = document.createElement('a'); link.href = url; link.download = `${safeFileName(dataset.session.name)}.${format}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      return 'browser-export'
    },
    tasks: async () => [], taskAction: desktopOnly, onTasks: () => () => {}, revealTaskFile: desktopOnly,
    schedules: async () => [], saveSchedule: desktopOnly, deleteSchedule: desktopOnly,
    mediaStatus: async () => ({ modelReady: false, modelBytes: 0, modelDirectory: '', engineAvailable: false }), prepareMediaModel: desktopOnly, processMedia: desktopOnly,
    disconnect: async () => { datasets = [] },
    analyze: input => cloud.analyze(input, event => { for (const callback of listeners) callback(event) }),
    cancelAnalysis: async () => cloud.cancel(),
    onAnalysis: callback => { listeners.add(callback); return () => { listeners.delete(callback) } },
    reports: async () => reports(),
    saveReport: async report => {
      if (!owner) throw new Error('请先登录后保存结果')
      localStorage.setItem(reportKey(), JSON.stringify([report, ...reports().filter(item => item.id !== report.id)].slice(0, 100)))
    },
    deleteReport: async id => { localStorage.setItem(reportKey(), JSON.stringify(reports().filter(item => item.id !== id))) },
    exportReport: async report => {
      const url = URL.createObjectURL(new Blob([`# ${report.title}\n\n${report.content}\n`], { type: 'text/markdown;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${report.title.replace(/[<>:"/\\|?*]/g, '_')}.md`
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      return true
    },
    copyText: text => navigator.clipboard.writeText(text),
    reportSource: async range => {
      const dataset = datasets.find(item => item.session.id === range.sessionId)
      if (!dataset) throw new Error('请选择一个群聊')
      return datasetReportSource(dataset, range)
    },
    generateGroupReport: input => cloud.groupReport(input, event => { for (const callback of groupListeners) callback(event) }),
    onGroupReport: callback => { groupListeners.add(callback); return () => { groupListeners.delete(callback) } },
    groupReports: async () => readGroups(),
    saveGroupReport: async report => { if (!owner) throw new Error('请先登录'); localStorage.setItem(`group-${reportKey()}`, JSON.stringify([savedGroupReportSchema().parse(report), ...readGroups().filter(item => item.id !== report.id)].slice(0, 60))) },
    deleteGroupReport: async id => { localStorage.setItem(`group-${reportKey()}`, JSON.stringify(readGroups().filter(item => item.id !== id))) },
    reportTemplates: async () => { try { const parsed = reportTemplatesSchema.safeParse(JSON.parse(localStorage.getItem('zhiliao-report-templates') || 'null')); return parsed.success ? parsed.data : defaultReportTemplates() } catch { return defaultReportTemplates() } },
    saveReportTemplates: async templates => { localStorage.setItem('zhiliao-report-templates', JSON.stringify(reportTemplatesSchema.parse(templates))) },
    exportGroupReport: async (report, format) => {
      if (format !== 'html') throw new Error('长图和 PDF 导出请使用桌面版；浏览器预览可导出独立网页报告')
      const url = URL.createObjectURL(new Blob([groupReportDocument(report)], { type: 'text/html;charset=utf-8' }))
      const link = document.createElement('a'); link.href = url; link.download = `${report.title.replace(/[<>:"/\\|?*]/g, '_')}.html`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      return { saved: true, files: 1 }
    },
    onConnectionProgress: () => () => {}
  }
}

export const bridge: ClientBridge = window.zhiliao || browserBridge()
