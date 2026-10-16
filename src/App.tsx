import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowRight, BookOpen, Check, CheckCheck, ChevronRight, CircleHelp, Cloud, FileCheck2, FileText, FolderOpen, History, LayoutDashboard, ListChecks, LoaderCircle, LogOut, MessageCircle, MessageSquareText, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Square, Trash2, Upload, Users, X } from 'lucide-react'
import { bridge } from './bridge.js'
import { AuthModal } from './components/AuthModal.js'
import { Modal } from './components/Modal.js'
import { Markdown } from './components/Markdown.js'
import { ContextPreview } from './components/ContextPreview.js'
import { GroupReportWorkspace } from './components/GroupReportWorkspace.js'
import { activeTask, type BackgroundTask } from '../shared/workbench.js'
import './workbench.css'
import { LatestRequest, scopedEvidence } from './request-state.js'
import { prepareAnalysis } from '../shared/data.js'
import type { AccountInfo, AnalysisInput, AnalysisMode, ChatMessage, ChatSession, HealthInfo, QuotaInfo, SavedReport } from '../shared/contracts.js'
import { version } from '../package.json'

const modeNames: Record<AnalysisMode, string> = { summary: '对话总结', actions: '提取待办', question: '询问对话' }
const ConnectionSettings = lazy(() => import('./components/ConnectionSettings.js').then(module => ({ default: module.ConnectionSettings })))
const MessageExplorer = lazy(() => import('./components/MessageExplorer.js').then(module => ({ default: module.MessageExplorer })))
const TaskCenter = lazy(() => import('./components/TaskCenter.js').then(module => ({ default: module.TaskCenter })))
const modeDescriptions: Record<AnalysisMode, string> = { summary: '看清讨论主题、重要决定和待确认事项。', actions: '整理负责人、截止时间和下一步行动。', question: '带着一个问题，在聊天记录中寻找答案。' }
const modeIcons = { summary: FileText, actions: ListChecks, question: MessageSquareText }
const sourceNames = { wechat: '本机微信', import: '导入文件', sample: '示例会话', weflow: 'WeFlow' }
const time = (seconds: number) => seconds ? new Date(seconds * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '--:--'
const date = (seconds: number) => seconds ? new Date(seconds * 1000).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }) : '时间未知'
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试'
type View = 'community' | 'workspace' | 'history' | 'settings' | 'messages' | 'tasks'
const viewNames: Record<View, string> = { community: '社群报告', workspace: '对话助手', history: '已存分析', settings: '设置', messages: '记录检索', tasks: '任务中心' }
type Evidence = NonNullable<SavedReport['evidence']>[number]

function Brand() {
  return <div className="brand"><div className="brand-symbol"><MessageSquareText size={23} strokeWidth={1.9} /></div><div><strong>知聊<span>ZHILIAO</span></strong><small>让对话成为线索</small></div></div>
}

export default function App() {
  const [view, setView] = useState<View>('community')
  const [visitedMessages, setVisitedMessages] = useState(false)
  const [tasks, setTasks] = useState<BackgroundTask[]>([])
  useEffect(() => { if (view === 'messages') setVisitedMessages(true) }, [view])
  const [health, setHealth] = useState<HealthInfo | null>(null)
  const [healthLoading, setHealthLoading] = useState(true)
  const [account, setAccount] = useState<AccountInfo | null>(null)
  const cloudReady = Boolean(health?.aiReady && !account?.offline)
  const [authOpen, setAuthOpen] = useState(false)
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [messageError, setMessageError] = useState('')
  const [busyAction, setBusyAction] = useState('')
  const [search, setSearch] = useState('')
  const [sessionFilter, setSessionFilter] = useState<'all' | 'group' | 'private'>('all')
  const [limit, setLimit] = useState(100)
  const [selectedMessages, setSelectedMessages] = useState<Set<string> | null>(null)
  const [mode, setMode] = useState<AnalysisMode>('summary')
  const [question, setQuestion] = useState('')
  const [anonymize, setAnonymize] = useState(true)
  const [consent, setConsent] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [reportBusy, setReportBusy] = useState(false)
  const [result, setResult] = useState('')
  const [resultState, setResultState] = useState<'idle' | 'generating' | 'complete' | 'cancelled' | 'error'>('idle')
  const [activeReport, setActiveReport] = useState<SavedReport | null>(null)
  const [reports, setReports] = useState<SavedReport[]>([])
  const [historySearch, setHistorySearch] = useState('')
  const [reportPreview, setReportPreview] = useState<SavedReport | null>(null)
  const [evidencePreview, setEvidencePreview] = useState<Evidence | null>(null)
  const [contextPreview, setContextPreview] = useState(false)
  const [toast, setToast] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const resultRef = useRef('')
  const job = useRef<{ input: AnalysisInput; sourceName: string; evidence: Evidence[] } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resultBottom = useRef<HTMLDivElement>(null)
  const messageRequests = useRef(new LatestRequest())
  const currentSessionId = useRef(selectedId)
  currentSessionId.current = selectedId
  const globallyBusy = generating || reportBusy || tasks.some(activeTask)
  const selectedSession = sessions.find(session => session.id === selectedId)
  const notify = useCallback((message: string) => { setToast(message); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 5500) }, [])
  const replaceSessions = useCallback((next: ChatSession[]) => { setSessions(next); setSelectedId(next.find(session => session.id === 'sample:community')?.id || next[0]?.id || null) }, [])
  const closeAuth = useCallback(() => setAuthOpen(false), [])
  const closeContext = useCallback(() => setContextPreview(false), [])
  const closeReport = useCallback(() => setReportPreview(null), [])
  const closeEvidence = useCallback(() => setEvidencePreview(null), [])
  const refreshAccount = useCallback(async () => { try { setAccount(await bridge.account()) } catch {} }, [])
  const updateQuota = useCallback((quota: QuotaInfo) => setAccount(previous => previous ? { ...previous, quota } : previous), [])
  const loadMessages = useCallback(async (id: string) => {
    const current = messageRequests.current.begin()
    const applies = () => current() && currentSessionId.current === id
    setLoadingMessages(true); setMessageError('')
    try { const value = await bridge.messages(id, 300); if (applies()) { setMessages(value); setSelectedMessages(null); setConsent(false) } }
    catch (error) { if (applies()) setMessageError(errorMessage(error)) }
    finally { if (applies()) setLoadingMessages(false) }
  }, [])

  useEffect(() => {
    let alive = true
    void bridge.health().then(value => { if (alive) setHealth(value) }).catch(() => {}).finally(() => { if (alive) setHealthLoading(false) })
    void bridge.account().then(value => { if (alive) setAccount(value) }).catch(() => {})
    void bridge.sessions().then(value => { if (alive) { setSessions(value); setSelectedId(value[0]?.id || null) } }).catch(() => {})
    void bridge.reports().then(value => { if (alive) setReports(value) }).catch(() => {})
    void bridge.tasks().then(value => { if (alive) setTasks(value) }).catch(() => {})
    const removeTasks = bridge.onTasks(value => { if (alive) setTasks(value) })
    const removeProgress = bridge.onConnectionProgress(message => { if (alive) setBusyAction(message.replace(/\(PID:\s*\d+\)/g, '')) })
    return () => { alive = false; removeProgress(); removeTasks(); if (toastTimer.current) clearTimeout(toastTimer.current) }
  }, [])

  useEffect(() => bridge.onAnalysis(event => {
    if (!job.current) return
    if ((event.type === 'start' || event.type === 'complete') && event.requestId !== job.current.input.requestId) return
    if (event.type === 'delta') { resultRef.current += event.text; setResult(resultRef.current) }
    if (event.type === 'complete') {
      const current = job.current
      const content = resultRef.current + (event.truncated ? '\n\n> 本次输出达到长度上限，可缩小范围后继续询问。' : '')
      const report: SavedReport = { id: event.requestId, title: `${current.sourceName} · ${modeNames[current.input.mode]}`.slice(0, 160), mode: current.input.mode, createdAt: Date.now(), sourceName: current.sourceName, messageCount: current.input.messages.length, content, demo: event.demo, evidence: current.evidence }
      setResult(content); setActiveReport(report); setResultState('complete'); setGenerating(false); setConsent(false)
      setAccount(previous => previous ? { ...previous, quota: event.quota } : previous)
      void bridge.saveReport(report).then(() => bridge.reports()).then(setReports).catch(error => notify(`结果已生成，但保存失败：${errorMessage(error)}`))
    }
    if (event.type === 'error') { setGenerating(false); setResultState('error'); setConsent(false); notify(event.message); void refreshAccount() }
  }), [notify, refreshAccount])

  useEffect(() => {
    messageRequests.current.invalidate(); job.current = null
    setMessages([]); setSelectedMessages(null); setConsent(false); setMessageError(''); setResult(''); resultRef.current = ''; setActiveReport(null); setResultState('idle')
    if (!selectedId) { setLoadingMessages(false); return }
    void loadMessages(selectedId)
    return () => messageRequests.current.invalidate()
  }, [selectedId, sessions, loadMessages])

  useEffect(() => { if (generating) resultBottom.current?.scrollIntoView({ block: 'nearest' }) }, [result, generating])
  const visibleMessages = useMemo(() => messages.slice(-limit), [messages, limit])
  const chosenMessages = useMemo(() => visibleMessages.filter(message => selectedMessages === null || selectedMessages.has(message.id)), [visibleMessages, selectedMessages])
  const filteredSessions = sessions.filter(session => (sessionFilter === 'all' || session.kind === sessionFilter) && session.name.toLowerCase().includes(search.toLowerCase()))
  const draft = useMemo(() => {
    if (!selectedSession || !chosenMessages.length) return { value: null, error: '' }
    try { return { value: prepareAnalysis({ messages: chosenMessages, mode, question, sessionName: selectedSession.name, anonymize, consent: true }), error: '' } }
    catch (error) { return { value: null, error: errorMessage(error).includes('Zod') ? '请填写问题后再分析' : errorMessage(error) } }
  }, [chosenMessages, mode, question, selectedSession, anonymize])

  async function dataAction(action: 'sample' | 'import' | 'wechat' | 'weflow') {
    if (globallyBusy || busyAction) return
    const destination = view === 'community' ? 'community' : 'workspace'
    setAddOpen(false); setBusyAction(action === 'wechat' ? '正在准备连接微信…' : '正在加载会话…')
    try {
      let next: ChatSession[]
      let preferred: string | undefined
      if (action === 'import') { const imported = await bridge.importFile(); if (!imported) return; next = await bridge.sessions(); preferred = imported.id }
      else if (action === 'sample') next = await bridge.sample()
      else if (action === 'wechat') next = await bridge.connectWeChat()
      else next = await bridge.connectWeFlow()
      setSessions(next); setSelectedId(preferred || next.find(session => session.id === 'sample:community')?.id || next[0]?.id || null); setView(destination); setSearch(''); setSessionFilter('all')
      if (action === 'sample') notify('已加载虚构示例会话，可以体验分析流程')
      else notify(`已加载 ${next.length} 个会话`)
    } catch (error) { notify(errorMessage(error)) } finally { setBusyAction('') }
  }

  async function reloadMessages() {
    if (!selectedId || globallyBusy) return
    await loadMessages(selectedId)
  }
  function toggleMessage(id: string) {
    if (globallyBusy) return
    const next = new Set(selectedMessages || visibleMessages.map(message => message.id))
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelectedMessages(next); setConsent(false)
  }
  async function analyze() {
    if (!account) { setAuthOpen(true); return }
    if (!draft.value || !consent || !selectedSession || globallyBusy) return
    const input = { ...draft.value.input, requestId: crypto.randomUUID() }
    job.current = { input, sourceName: selectedSession.name, evidence: input.messages.map((message, index) => ({ id: message.id, sender: chosenMessages[index].sender, timestamp: message.timestamp, text: chosenMessages[index].text.slice(0, 4000) })) }
    resultRef.current = ''; setResult(''); setActiveReport(null); setGenerating(true); setResultState('generating')
    try { await bridge.analyze(input) } catch (error) {
      const cancelled = error instanceof Error && /abort|取消/i.test(error.message)
      setGenerating(false); setResultState(cancelled ? 'cancelled' : 'error'); setConsent(false)
      if (!cancelled) notify(errorMessage(error))
      await refreshAccount()
    }
  }
  function openEvidence(id: string, report: SavedReport | null = activeReport) {
    const evidence = scopedEvidence(id, report, job.current?.evidence)
    if (evidence) setEvidencePreview(evidence)
    else notify('这条结果没有保存对应的原始消息')
  }
  async function exportReport(report: SavedReport) { try { if (await bridge.exportReport(report)) notify('分析结果已导出') } catch (error) { notify(errorMessage(error)) } }
  const onLogin = (value: AccountInfo) => { setAccount(value); setAuthOpen(false); void bridge.reports().then(setReports).catch(error => notify(errorMessage(error))); notify(`欢迎，${value.user.displayName}`) }
  const filteredReports = reports.filter(report => `${report.title} ${report.sourceName}`.toLowerCase().includes(historySearch.toLowerCase()))

  return <div className="app-shell">
    <aside className="navigation">
      <Brand />
      <div className="nav-label">我的工作空间</div>
      <nav aria-label="主导航">
        <button className={view === 'community' ? 'nav-item active' : 'nav-item'} onClick={() => setView('community')}><FileText size={19} />社群报告<span className="nav-dot" /></button>
        <button className={view === 'workspace' ? 'nav-item active' : 'nav-item'} onClick={() => setView('workspace')}><LayoutDashboard size={19} />对话助手</button>
        <button className={view === 'messages' ? 'nav-item active' : 'nav-item'} onClick={() => setView('messages')}><Search size={19} />记录检索</button>
        <button className={view === 'tasks' ? 'nav-item active' : 'nav-item'} onClick={() => setView('tasks')}><ListChecks size={19} />任务中心{tasks.filter(activeTask).length > 0 && <span className="nav-count">{tasks.filter(activeTask).length}</span>}</button>
        <button className={view === 'history' ? 'nav-item active' : 'nav-item'} onClick={() => setView('history')}><History size={19} />已存分析{reports.length > 0 && <span className="nav-count">{reports.length}</span>}</button>
        <button className={view === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => setView('settings')}><Settings2 size={19} />设置</button>
      </nav>
      <div className="nav-note"><ShieldCheck size={18} /><span>对话留在本机<br /><small>由你选择每次分析的内容</small></span></div>
      <div className="nav-bottom">
        <div className="quota-card"><div className="quota-heading"><Sparkles size={15} />今日 AI 额度</div>{account ? <><div className="quota-value">{account.offline ? '--' : account.quota.remaining}<span>/ {account.quota.limit} 次</span></div><div className="quota-track"><i style={{ width: `${Math.max(0, account.quota.remaining / account.quota.limit * 100)}%` }} /></div><small>{account.offline ? '恢复连接后刷新额度' : '成功生成后计入使用量'}</small></> : <><p>登录后开启对话洞察</p><button className="text-button" onClick={() => setAuthOpen(true)}>登录知聊 <ArrowRight size={14} /></button></>}</div>
        <div className="version"><span>知聊 {version}</span><span>{bridge.platform === 'browser' ? '浏览器预览' : '桌面版'}</span></div>
      </div>
    </aside>
    <main className="main-area">
      <header className="topbar">
        <div className="breadcrumb">工作空间<ChevronRight size={13} /><strong>{viewNames[view]}</strong></div>
        <div className="topbar-actions"><span className={`service-status ${cloudReady ? 'online' : ''}`}><i />{healthLoading ? '连接服务中' : account?.offline ? '云端暂不可用' : health?.mode === 'demo' ? '演示服务' : cloudReady ? '云端已就绪' : '云端暂不可用'}</span><span className="topbar-divider" /><button className="account-button" onClick={() => account ? setView('settings') : setAuthOpen(true)}><span className="account-avatar">{account?.user.displayName.slice(0, 1) || '访'}</span><span>{account?.user.displayName || '登录知聊'}</span></button></div>
      </header>
      <div className="page-heading"><div><div className="eyebrow">{view === 'community' ? '把社群里的好讨论，变成值得分享的一期' : view === 'workspace' ? '从对话中，找到下一步' : view === 'history' ? '留住每一次有价值的发现' : view === 'messages' ? '按日期、成员和关键词定位讨论' : view === 'tasks' ? '查看进度，安排本机导出计划' : '按你的方式使用知聊'}</div><h1>{view === 'community' ? '群聊有精华，每期都看见。' : view === 'workspace' ? '对话有迹，思路更清晰。' : view === 'history' ? '你的分析笔记' : view === 'messages' ? '查看成员发言与聊天记录' : view === 'tasks' ? '后台任务与定时导出' : '工作空间设置'}</h1></div>{(view === 'workspace' || view === 'community') && <div className="add-source"><button className="button secondary" disabled={Boolean(busyAction) || globallyBusy} onClick={() => setAddOpen(!addOpen)}><Plus size={17} />{view === 'community' ? '添加群聊' : '添加会话'}</button>{addOpen && <div className="dropdown"><button onClick={() => { void dataAction('import') }}><Upload size={16} />导入聊天记录</button><button onClick={() => { void dataAction('wechat') }}><MessageCircle size={16} />连接本机微信</button><button onClick={() => { void dataAction('sample') }}><BookOpen size={16} />体验示例会话</button></div>}</div>}</div>
      {health?.mode === 'demo' && <div className="demo-notice"><CircleHelp size={15} /><span>当前为本地演示环境，AI 回复由测试服务生成，用于体验完整交互。</span></div>}
      {account?.offline && <div className="demo-notice"><Cloud size={15} /><span>暂时无法连接云端。可以继续查看本机记录和已保存报告，恢复连接后再生成 AI 报告。</span></div>}
      {busyAction && <div className="busy-notice" role="status"><LoaderCircle className="spin" size={16} />{busyAction}</div>}

      <div hidden={view !== 'community'}><GroupReportWorkspace sessions={sessions} account={account} health={account?.offline ? null : health} blocked={generating || Boolean(busyAction)} onDataAction={dataAction} onLogin={() => setAuthOpen(true)} onBusy={setReportBusy} onQuota={updateQuota} refreshAccount={refreshAccount} notify={notify} /></div>
      {(view === 'messages' || visitedMessages) && <div hidden={view !== 'messages'}><Suspense fallback={<p className="busy-notice">正在打开记录检索…</p>}><MessageExplorer active={view === 'messages'} sessions={sessions} notify={notify} onTasks={() => setView('tasks')} /></Suspense></div>}
      {view === 'tasks' && <Suspense fallback={<p className="busy-notice">正在打开任务中心…</p>}><TaskCenter tasks={tasks} sessions={sessions} notify={notify} /></Suspense>}

      {view === 'workspace' && <div className="workspace">
        <section className="sessions-panel" aria-label="会话列表">
          <div className="panel-heading"><h2>我的会话 <span>{sessions.length.toString().padStart(2, '0')}</span></h2><MessageCircle size={18} /></div>
          <label className="search-box"><Search size={16} /><input aria-label="搜索会话" placeholder="搜索会话…" value={search} onChange={event => setSearch(event.target.value)} /></label>
          <div className="session-filters">{(['all', 'group', 'private'] as const).map(filter => <button className={sessionFilter === filter ? 'selected' : ''} key={filter} onClick={() => setSessionFilter(filter)}>{filter === 'all' ? '全部' : filter === 'group' ? '群聊' : '私聊'}</button>)}</div>
          <div className="session-list">
            {filteredSessions.map((session, index) => <button key={session.id} className={`session-card ${selectedId === session.id ? 'selected' : ''}`} disabled={globallyBusy || Boolean(busyAction)} onClick={() => { if (session.id !== selectedId) { messageRequests.current.invalidate(); setSelectedId(session.id) } }}>
              <div className={`conversation-avatar color-${index % 4}`}>{session.kind === 'group' ? <Users size={20} /> : session.name.slice(0, 1)}</div>
              <div className="session-info"><div><strong>{session.name}</strong><small>{time(session.lastTimestamp)}</small></div><p>{session.preview || '点击查看聊天记录'}</p><span className="source-tag">{sourceNames[session.source]}</span></div>
            </button>)}
            {filteredSessions.length === 0 && <div className="list-empty"><MessageCircle size={29} /><p>{sessions.length ? '没有找到匹配的会话' : '把对话带进来'}</p><small>{sessions.length ? '试试其他关键词或筛选条件' : '连接微信，或导入本机聊天记录'}</small></div>}
          </div>
          <button className="sample-link" disabled={globallyBusy || Boolean(busyAction)} onClick={() => { void dataAction('sample') }}><BookOpen size={15} />先用示例会话体验<ArrowRight size={13} /></button>
        </section>

        <section className="chat-panel" aria-label="聊天记录">
          {selectedSession ? <>
            <div className="chat-heading"><div><h2>{selectedSession.name}{selectedSession.kind === 'group' && <span>群聊</span>}</h2><p><i className="tiny-dot" />{sourceNames[selectedSession.source]}<span>·</span>已加载最近 {messages.length} 条</p></div><button className="icon-button" title="刷新聊天记录" aria-label="刷新聊天记录" disabled={globallyBusy || loadingMessages} onClick={() => { void reloadMessages() }}><RefreshCw size={17} className={loadingMessages ? 'spin' : ''} /></button></div>
            <div className="selection-bar"><label><input type="checkbox" checked={chosenMessages.length === visibleMessages.length && visibleMessages.length > 0} disabled={globallyBusy || !visibleMessages.length} onChange={event => { setSelectedMessages(event.target.checked ? null : new Set()); setConsent(false) }} />已选择 <strong>{chosenMessages.length}</strong> 条</label><label>分析范围<select aria-label="分析消息范围" value={limit} disabled={globallyBusy} onChange={event => { setLimit(Number(event.target.value)); setSelectedMessages(null); setConsent(false) }}><option value={30}>最近 30 条</option><option value={100}>最近 100 条</option><option value={300}>最近 300 条</option></select></label></div>
            <div className="messages-scroll">
              {loadingMessages ? <div className="center-state"><LoaderCircle className="spin" size={24} /><p>正在读取本机消息…</p></div> : messageError ? <div className="center-state"><CircleHelp size={26} /><p>{messageError}</p><button className="button secondary" onClick={() => { void reloadMessages() }}>重新加载</button></div> : visibleMessages.length ? <>
                <div className="date-divider"><span>{date(visibleMessages[0].timestamp)}</span></div>
                {visibleMessages.map((message, index) => <div key={`${message.id}:${index}`} className={`message-row ${message.self ? 'self' : ''} ${selectedMessages && !selectedMessages.has(message.id) ? 'not-selected' : ''}`}>
                  <label className="message-select"><input type="checkbox" aria-label={`选择 ${message.sender} ${time(message.timestamp)} 的消息`} checked={selectedMessages === null || selectedMessages.has(message.id)} disabled={globallyBusy} onChange={() => toggleMessage(message.id)} /></label>
                  <div className={`message-avatar ${message.self ? 'self' : ''}`}>{message.self ? '我' : message.sender.slice(0, 1)}</div>
                  <div className="message-content"><div className="message-meta"><span>{message.sender}</span><time>{time(message.timestamp)}</time></div><div className={`message-bubble ${message.type === 'system' ? 'system-message' : ''}`}>{message.text}</div></div>
                </div>)}
              </> : <div className="center-state"><MessageCircle size={28} /><p>此会话暂时没有可显示的消息</p></div>}
            </div>
            <div className="chat-footer"><ShieldCheck size={14} />勾选消息后再分析，聊天记录不会自动上传</div>
          </> : <div className="welcome-state"><div className="welcome-illustration"><div className="paper back" /><div className="paper front"><div className="paper-avatar"><MessageSquareText size={22} /></div><i /><i /><div className="paper-check"><Check size={16} />找到清晰的下一步</div></div><div className="floating-spark"><Sparkles size={25} /></div></div><div className="eyebrow">你好，欢迎来到知聊</div><h2>有些答案，<br />就藏在你的对话里。</h2><p>把零散的讨论整理成重点、决定与行动。<br />从选择一段对话开始。</p><button className="button primary" disabled={Boolean(busyAction)} onClick={() => { void dataAction(bridge.platform === 'desktop' ? 'wechat' : 'import') }}>{bridge.platform === 'desktop' ? <MessageCircle size={17} /> : <Upload size={17} />}{bridge.platform === 'desktop' ? '连接本机微信' : '导入聊天记录'}<ArrowRight size={16} /></button><button className="text-button welcome-secondary" disabled={Boolean(busyAction)} onClick={() => { void dataAction('sample') }}>先体验一段示例对话</button><div className="welcome-features"><span><ShieldCheck size={14} />本机数据</span><span><Cloud size={14} />云端洞察</span><span><FileCheck2 size={14} />原文可追溯</span></div></div>}
        </section>

        <section className="analysis-panel" aria-label="AI 分析">
          <div className="panel-heading"><h2><span className="ai-mark"><Sparkles size={16} /></span>对话洞察</h2><span className="beta-tag">AI</span></div>
          <div className="analysis-controls"><div className="mode-switch">{(['summary', 'actions', 'question'] as const).map(value => { const Icon = modeIcons[value]; return <button key={value} disabled={globallyBusy} className={mode === value ? 'selected' : ''} onClick={() => { setMode(value); setConsent(false) }}><Icon size={16} />{modeNames[value]}</button> })}</div><p className="mode-description">{modeDescriptions[mode]}</p>
            {mode === 'question' && <textarea aria-label="关于对话的问题" placeholder="例如：大家对上线时间达成一致了吗？" value={question} onChange={event => { setQuestion(event.target.value); setConsent(false) }} maxLength={1000} disabled={globallyBusy} rows={3} />}
            <div className="scope-card"><div><ShieldCheck size={16} /><strong>这次只分析你选中的内容</strong></div><p>{chosenMessages.length} 条消息<span>·</span>{draft.value?.input.messages.reduce((sum, message) => sum + message.text.length, 0).toLocaleString() || 0} 字符<button disabled={!draft.value} className="text-button" onClick={() => setContextPreview(true)}>查看内容<ChevronRight size={12} /></button></p><label className="checkbox-line"><input type="checkbox" checked={anonymize} disabled={globallyBusy} onChange={event => { setAnonymize(event.target.checked); setConsent(false) }} />隐藏昵称、手机号和邮箱</label></div>
            <label className="consent-line"><input type="checkbox" checked={consent} disabled={globallyBusy || !chosenMessages.length} onChange={event => setConsent(event.target.checked)} /><span>允许将选中的内容发送到云端，进行本次分析</span></label>
            {draft.error && !(mode === 'question' && !question.trim()) && <div className="inline-error compact">{draft.error.startsWith('[') ? '请检查问题和消息范围' : draft.error}</div>}
            {generating ? <button className="button stop full" onClick={() => { void bridge.cancelAnalysis() }}><Square size={14} fill="currentColor" />停止生成</button> : <button className="button primary full" onClick={() => { void analyze() }} disabled={reportBusy || Boolean(busyAction) || (account ? !draft.value || !consent || !cloudReady || account.quota.remaining <= 0 || loadingMessages : false)}><Sparkles size={17} />{!account ? '登录后开始分析' : !cloudReady ? 'AI 服务暂不可用' : account.quota.remaining <= 0 ? '今日额度已用完' : '开始分析'}{account && cloudReady && account.quota.remaining > 0 && <span className="button-cost">1 次</span>}</button>}
          </div>
          <div className="result-heading"><span>{resultState === 'generating' ? '正在梳理对话' : resultState === 'complete' ? '分析结果' : resultState === 'cancelled' ? '已停止生成' : resultState === 'error' ? '本次分析未完成' : '灵感，即将浮现'}</span>{resultState === 'complete' && <span className="saved-label"><CheckCheck size={13} />已生成</span>}</div>
          <div className="result-scroll">{result ? <><Markdown text={result} onReference={id => openEvidence(id)} />{generating && <span className="typing-cursor" />}<div ref={resultBottom} /></> : <div className="analysis-empty"><div className="insight-orbit"><Sparkles size={27} /><i /><i /></div><h3>{generating ? '正在连接 AI 服务…' : '让信息，变成有用的线索'}</h3><p>{generating ? '正在读取你选中的对话，请稍候。' : '选择左侧会话，勾选分析范围，\n每个结论都能回到原始消息。'}</p><div className="insight-example"><span>你可以发现</span><p><Check size={13} />讨论中达成了哪些共识</p><p><Check size={13} />谁负责什么，何时完成</p><p><Check size={13} />哪些问题仍待确认</p></div></div>}</div>
          {result && <div className="result-actions"><button className="button subtle" onClick={() => { void bridge.copyText(result).then(() => notify('已复制分析内容')).catch(error => notify(errorMessage(error))) }}><FileText size={14} />复制</button><button className="button subtle" disabled={!activeReport} onClick={() => { if (activeReport) void exportReport(activeReport) }}><ArrowDownToLine size={14} />导出</button><button className="text-button" disabled={!activeReport} onClick={() => { if (activeReport) setReportPreview(activeReport) }}>展开阅读<ArrowRight size={13} /></button></div>}
        </section>
      </div>}

      {view === 'history' && <section className="history-page"><div className="history-toolbar"><span><FileCheck2 size={18} />已在本机保存 {reports.length} 份分析</span><label className="search-box"><Search size={16} /><input aria-label="搜索分析结果" placeholder="搜索标题或会话…" value={historySearch} onChange={event => setHistorySearch(event.target.value)} /></label></div>{filteredReports.length ? <div className="report-grid">{filteredReports.map(report => { const Icon = modeIcons[report.mode] || FileText; return <article className="report-card" key={report.id}><div className="report-topline"><span className={`report-icon ${report.mode}`}><Icon size={22} /></span><span>{new Date(report.createdAt).toLocaleDateString('zh-CN')}</span></div><button className="report-title" onClick={() => setReportPreview(report)}>{report.title}</button><p className="report-excerpt">{report.content.replace(/[#>*|\[\]]/g, '').slice(0, 110)}</p><div className="report-tags"><span>{report.messageCount} 条消息</span>{report.demo && <span>演示结果</span>}</div><div className="report-actions"><button className="text-button" onClick={() => setReportPreview(report)}>阅读分析<ArrowRight size={14} /></button><button className="icon-button" title="导出结果" aria-label={`导出 ${report.title}`} onClick={() => { void exportReport(report) }}><ArrowDownToLine size={16} /></button><button className="icon-button" title="删除本机结果" aria-label={`删除 ${report.title}`} onClick={() => { void bridge.deleteReport(report.id).then(() => bridge.reports()).then(setReports).then(() => notify('已删除本机保存的分析结果')).catch(error => notify(errorMessage(error))) }}><Trash2 size={16} /></button></div></article> })}</div> : <div className="history-empty"><History size={37} /><h2>{historySearch ? '没有匹配的结果' : '你的第一份洞察，等你开启'}</h2><p>成功生成的分析会自动保存在本机，随时回来查看。</p><button className="button primary" onClick={() => setView('workspace')}>去分析一段对话<ArrowRight size={16} /></button></div>}</section>}

      {view === 'settings' && <section className="settings-page"><div className="settings-card"><div className="settings-title"><Cloud size={21} /><div><h2>账号与云端服务</h2><p>AI 服务由提供方统一维护，直接登录即可使用。</p></div></div><div className="settings-row"><span>当前账号</span><strong>{account ? `${account.user.displayName}（${account.user.username}）` : '尚未登录'}</strong></div><div className="settings-row"><span>服务状态</span><strong>{health?.mode === 'demo' ? '本地演示服务' : cloudReady ? '云端 AI 已就绪' : '暂时不可用'}</strong></div>{account && <><div className="settings-row"><span>今日分析额度</span><strong>{account.quota.remaining} / {account.quota.limit} 次</strong></div><div className="settings-row"><span>下次重置</span><strong>{new Date(account.quota.resetsAt).toLocaleString('zh-CN')}</strong></div></>}<div className="settings-buttons"><button className="button secondary" disabled={globallyBusy} onClick={() => { setHealthLoading(true); void bridge.health().then(setHealth).then(() => refreshAccount()).then(() => notify('服务状态已刷新')).catch(error => { setHealth(null); notify(errorMessage(error)) }).finally(() => setHealthLoading(false)) }}><RefreshCw size={16} />刷新状态</button>{account ? <button className="button subtle" disabled={globallyBusy} onClick={() => { void bridge.logout().catch(() => {}).finally(() => { setAccount(null); setReports([]); setResult(''); setActiveReport(null); setReportPreview(null); setEvidencePreview(null); job.current = null; notify('本机已退出登录') }) }}><LogOut size={16} />退出登录</button> : <button className="button primary" onClick={() => setAuthOpen(true)}>登录账号</button>}</div></div>
        <div className="settings-card"><div className="settings-title"><FolderOpen size={21} /><div><h2>本机数据</h2><p>导入文件、连接信息和分析笔记保存在你的电脑上。</p></div></div><div className="settings-row"><span>当前数据来源</span><strong>{sessions[0] ? sourceNames[sessions[0].source] : '尚未连接'}</strong></div><div className="settings-row"><span>可用会话</span><strong>{sessions.length} 个</strong></div><div className="settings-buttons"><button className="button secondary" disabled={globallyBusy || Boolean(busyAction)} onClick={() => { void dataAction('import') }}><Upload size={16} />导入记录</button><button className="button subtle danger" disabled={globallyBusy || Boolean(busyAction) || !sessions.length} onClick={() => { void bridge.disconnect().then(() => { setSessions([]); setSelectedId(null); notify('连接和导入缓存已清除，原始微信数据未被修改') }).catch(error => notify(errorMessage(error))) }}><Trash2 size={15} />断开并清理导入缓存</button></div></div>
        <Suspense fallback={<p className="busy-notice">正在加载本机设置…</p>}><ConnectionSettings disabled={globallyBusy || Boolean(busyAction)} onSessions={replaceSessions} onBusy={setBusyAction} notify={notify} /></Suspense>
        <div className="settings-card about-card"><Brand /><p>本机微信读取组件来自 WeFlow，保留其原始许可和来源记录。微信连接兼容性与正式云端部署需按目标环境验证。</p><a href="https://github.com/hicccc77/WeFlow" target="_blank" rel="noreferrer">查看 WeFlow 项目<ArrowRight size={14} /></a><small>WeFlow 原生组件适用 CC BY-NC-SA 4.0，商业用途须另行解决授权。</small></div></section>}
      <footer className="page-footer"><span><ShieldCheck size={13} />只分析由你选定的内容</span><span>把时间留给更重要的对话。</span></footer>
    </main>

    {authOpen && <AuthModal demo={health?.mode === 'demo'} onSuccess={onLogin} onClose={closeAuth} />}
    {contextPreview && draft.value && <ContextPreview context={draft.value} anonymize={anonymize} onClose={closeContext} />}
    {reportPreview && !evidencePreview && <Modal title={reportPreview.title} wide onClose={closeReport}><div className="report-modal-meta">{reportPreview.messageCount} 条消息 · {new Date(reportPreview.createdAt).toLocaleString('zh-CN')}{reportPreview.demo ? ' · 演示结果' : ''}</div><div className="report-modal-body"><Markdown text={reportPreview.content} onReference={reportPreview.evidence ? id => openEvidence(id, reportPreview) : undefined} /></div><div className="modal-footer"><button className="button secondary" onClick={() => { void exportReport(reportPreview) }}><ArrowDownToLine size={16} />导出 Markdown</button></div></Modal>}
    {evidencePreview && <Modal title={`原始消息 · ${evidencePreview.id}`} onClose={closeEvidence}><div className="evidence-meta"><strong>{evidencePreview.sender}</strong><time>{date(evidencePreview.timestamp)} {time(evidencePreview.timestamp)}</time></div><p className="evidence-text">{evidencePreview.text}</p><p className="fine-print"><ShieldCheck size={14} />此处显示保存在本机的原文快照。</p></Modal>}
    {toast && <div className="toast" role="status"><MessageSquareText size={16} /><span>{toast}</span><button className="icon-button" onClick={() => setToast('')} aria-label="关闭提示"><X size={16} /></button></div>}
  </div>
}
