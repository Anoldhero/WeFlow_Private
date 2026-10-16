import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopAPI } from '../shared/contracts.js'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...args)
  if (!result.ok) throw new Error(result.error || '操作失败，请重试')
  return result.data
}
function listen<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}
const bridge: DesktopAPI = {
  platform: 'desktop',
  health: () => invoke('cloud:health'),
  login: input => invoke('auth:login', input),
  register: input => invoke('auth:register', input),
  account: () => invoke('auth:account'),
  logout: () => invoke('auth:logout'),
  localStatus: () => invoke('data:status'),
  sessions: () => invoke('data:sessions'),
  messages: (sessionId, limit) => invoke('data:messages', sessionId, limit),
  importFile: () => invoke('data:import'),
  sample: () => invoke('data:sample'),
  connectWeChat: options => invoke('data:wechat', options),
  connectWeFlow: options => invoke('data:weflow', options),
  wechatProfiles: () => invoke('data:profiles'),
  removeWeChatProfile: id => invoke('data:removeProfile', id),
  weflowSettings: () => invoke('data:weflowSettings'),
  onDataChange: callback => listen('data:changed', callback),
  queryMessages: input => invoke('data:query', input),
  exportChat: input => invoke('data:export', input),
  tasks: () => invoke('tasks:list'),
  taskAction: (id, action) => invoke('tasks:action', id, action),
  onTasks: callback => listen('tasks:changed', callback),
  revealTaskFile: id => invoke('tasks:reveal', id),
  schedules: () => invoke('schedules:list'),
  saveSchedule: input => invoke('schedules:save', input),
  deleteSchedule: id => invoke('schedules:delete', id),
  mediaStatus: () => invoke('media:status'),
  prepareMediaModel: mode => invoke('media:prepare', mode),
  processMedia: input => invoke('media:process', input),
  disconnect: () => invoke('data:disconnect'),
  analyze: input => invoke('analysis:start', input),
  cancelAnalysis: () => invoke('analysis:cancel'),
  onAnalysis: callback => listen('analysis:event', callback),
  reports: () => invoke('reports:list'),
  saveReport: report => invoke('reports:save', report),
  deleteReport: id => invoke('reports:delete', id),
  exportReport: report => invoke('reports:export', report),
  copyText: text => invoke('clipboard:write', text),
  reportSource: range => invoke('data:reportSource', range),
  generateGroupReport: input => invoke('groupReport:generate', input),
  onGroupReport: callback => listen('groupReport:event', callback),
  groupReports: () => invoke('groupReport:list'),
  saveGroupReport: report => invoke('groupReport:save', report),
  deleteGroupReport: id => invoke('groupReport:delete', id),
  reportTemplates: () => invoke('groupReport:templates'),
  saveReportTemplates: templates => invoke('groupReport:saveTemplates', templates),
  exportGroupReport: (report, format) => invoke('groupReport:export', report, format),
  onConnectionProgress: callback => listen('connection:progress', callback)
}
contextBridge.exposeInMainWorld('zhiliao', bridge)
