import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowLeft, ArrowRight, BookOpen, CalendarDays, Check, FileText, History, Image, LoaderCircle, Plus, RefreshCw, Save, ShieldCheck, Sparkles, Square, Trash2, Upload, Users } from 'lucide-react'
import { bridge } from '../bridge.js'
import { LatestRequest, scopedEvidence } from '../request-state.js'
import { Modal } from './Modal.js'
import { ReportPaper } from './ReportPaper.js'
import { ReportTemplateEditor } from './ReportTemplateEditor.js'
import { defaultReportDate, defaultReportTemplate, defaultReportTemplates, demoGroupReport, localDate, prepareGroupReport, reportPeriod, reportTemplateSchema, saveableGroupReport, savedGroupReportSchema, type GroupReportInput, type ReportKind, type ReportMessage, type ReportSource, type SavedGroupReport } from '../../shared/group-report.js'
import type { AccountInfo, ChatSession, HealthInfo, QuotaInfo } from '../../shared/contracts.js'
import '../report-workspace.css'

type SourceAction = 'sample' | 'import' | 'wechat' | 'weflow'
interface Props {
  sessions: ChatSession[]; account: AccountInfo | null; health: HealthInfo | null; blocked: boolean
  onDataAction: (action: SourceAction) => Promise<void>; onLogin: () => void
  onBusy: (busy: boolean) => void; onQuota: (quota: QuotaInfo) => void
  refreshAccount: () => Promise<void>; notify: (message: string) => void
}
const kindName = (kind: ReportKind) => kind === 'daily' ? '日报' : '周报'
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试'
const timeText = (seconds: number) => new Date(seconds * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

export function GroupReportWorkspace({ sessions, account, health, blocked, onDataAction, onLogin, onBusy, onQuota, refreshAccount, notify }: Props) {
  const groups = useMemo(() => sessions.filter(session => session.kind === 'group'), [sessions])
  const [sessionId, setSessionId] = useState('')
  const [kind, setKind] = useState<ReportKind>('daily')
  const [dates, setDates] = useState(() => ({ daily: defaultReportDate('daily'), weekly: defaultReportDate('weekly') }))
  const [templates, setTemplates] = useState(defaultReportTemplates)
  const [templatesReady, setTemplatesReady] = useState(false)
  const [source, setSource] = useState<ReportSource | null>(null)
  const [sourceError, setSourceError] = useState('')
  const [loading, setLoading] = useState(false)
  const [reload, setReload] = useState(0)
  const [draftTitle, setDraftTitle] = useState('')
  const [anonymize, setAnonymize] = useState(true)
  const [report, setReport] = useState<SavedGroupReport | null>(null)
  const [history, setHistory] = useState<SavedGroupReport[]>([])
  const [saved, setSaved] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [exporting, setExporting] = useState('')
  const [stopping, setStopping] = useState(false)
  const [progress, setProgress] = useState({ message: '', current: 0, total: 1 })
  const [generationError, setGenerationError] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [consent, setConsent] = useState(false)
  const [previewPage, setPreviewPage] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historySearch, setHistorySearch] = useState('')
  const [evidence, setEvidence] = useState<{ message: ReportMessage; sourceName: string } | null>(null)
  const sourceRequest = useRef(new LatestRequest())
  const owner = account?.user.id || ''
  const ownerRef = useRef(owner)
  ownerRef.current = owner
  const job = useRef<{ input: GroupReportInput; originals: ReportMessage[]; source: { id: string; name: string; capturedAt: number }; title: string } | null>(null)
  const selectedSession = groups.find(session => session.id === sessionId)
  const template = report?.template || templates[kind]
  const title = report?.title ?? draftTitle
  const defaultTitle = `${selectedSession?.name || report?.sourceName || '社群精选'} · ${kindName(kind)}`.slice(0, 120)
  const locked = blocked || generating || Boolean(exporting) || saving
  const dirty = Boolean(report && saved[report.id] !== JSON.stringify(report))
  const closeConfirm = useCallback(() => setConfirmOpen(false), [])
  const closeHistory = useCallback(() => setHistoryOpen(false), [])
  const closeEvidence = useCallback(() => setEvidence(null), [])
  const period = useMemo(() => { try { return reportPeriod(kind, dates[kind]) } catch { return null } }, [kind, dates])
  const matchingSource = source && selectedSession && source.session.id === selectedSession.id && source.period.start === period?.start && source.period.kind === kind ? source : null
  const configCheck = reportTemplateSchema.safeParse(template)
  const configError = !configCheck.success ? configCheck.error.issues[0]?.message : !template.columns.some(column => column.enabled && column.id !== 'activity') ? '请至少选择一个分析栏目' : ''
  const draft = useMemo(() => {
    if (!matchingSource?.messages.length) return { value: null, error: '' }
    try { return { value: prepareGroupReport(matchingSource, template, anonymize, true), error: '' } }
    catch (error) { return { value: null, error: errorText(error) } }
  }, [matchingSource, template, anonymize])
  const readable = matchingSource?.messages.some(message => message.transcript || !['image', 'voice', 'video'].includes(message.type))
  const generatedIds = useMemo(() => report ? new Set(report.sections.map(section => section.id)) : undefined, [report])
  const missingColumns = report ? template.columns.filter(column => column.enabled && column.id !== 'activity' && !generatedIds?.has(column.id)) : []
  const preview = useMemo(() => report || { ...demoGroupReport({ kind, date: period?.date || defaultReportDate(kind), template }), title: draftTitle.trim() || defaultTitle, sourceName: selectedSession?.name || '行业观察与交流社群' }, [report, kind, period, template, draftTitle, defaultTitle, selectedSession])

  useEffect(() => { onBusy(generating || saving || Boolean(exporting)); return () => onBusy(false) }, [generating, saving, exporting, onBusy])
  useEffect(() => {
    let alive = true
    void bridge.reportTemplates().then(value => { if (alive) setTemplates(value) }).catch(error => notify(errorText(error))).finally(() => { if (alive) setTemplatesReady(true) })
    return () => { alive = false }
  }, [notify])
  useEffect(() => {
    let alive = true
    setReport(null); setEvidence(null); setHistory([]); setSaved({}); setHistoryOpen(false); setConfirmOpen(false)
    if (owner) void bridge.groupReports().then(value => {
      if (alive) { setHistory(value); setSaved(Object.fromEntries(value.map(item => [item.id, JSON.stringify(item)]))) }
    }).catch(error => { if (alive) notify(errorText(error)) })
    return () => { alive = false }
  }, [owner, notify])
  useEffect(() => {
    if (!groups.some(session => session.id === sessionId) && !report) setSessionId(groups.find(session => session.id === 'sample:community')?.id || groups[0]?.id || '')
  }, [groups, sessionId, report])
  useEffect(() => {
    const current = sourceRequest.current.begin()
    setSource(null); setSourceError(''); setConsent(false)
    if (!selectedSession || !period || blocked) { setLoading(false); return }
    setLoading(true)
    void bridge.reportSource({ sessionId: selectedSession.id, kind, date: period.date }).then(value => { if (current()) setSource(value) }).catch(error => { if (current()) setSourceError(errorText(error)) }).finally(() => { if (current()) setLoading(false) })
    return () => sourceRequest.current.invalidate()
  }, [selectedSession, kind, period, reload, blocked])
  useEffect(() => { setConsent(false); setPreviewPage(0) }, [matchingSource, template, anonymize])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const off = bridge.onDataChange(event => { if (event.type === 'changed' && !locked && (!event.sessionId || event.sessionId === sessionId)) { clearTimeout(timer); timer = setTimeout(() => setReload(value => value + 1), 700) } })
    return () => { clearTimeout(timer); off() }
  }, [sessionId, locked])

  const persist = useCallback(async (value: SavedGroupReport) => {
    if (!owner) throw new Error('请先登录后保存报告')
    const parsed = savedGroupReportSchema().safeParse(value)
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || '报告内容无效')
    setSaving(true)
    try {
      await bridge.saveGroupReport(parsed.data)
      if (ownerRef.current === owner) {
        setHistory(previous => [value, ...previous.filter(item => item.id !== value.id)].slice(0, 60))
        setSaved(previous => ({ ...previous, [value.id]: JSON.stringify(value) }))
      }
    } finally { setSaving(false) }
  }, [owner])

  useEffect(() => bridge.onGroupReport(event => {
    const current = job.current
    if (!current) return
    if (event.type === 'progress') setProgress(event)
    if (event.type === 'error') setGenerationError(event.message)
    if (event.type === 'complete' && event.requestId === current.input.requestId) {
      onQuota(event.quota)
      try {
        const result = saveableGroupReport(current.input, event.result, current.originals, current.source, current.title)
        setReport(result); setDraftTitle(''); setGenerationError(''); setEvidence(null)
        void persist(result).catch(error => notify(`报告已生成，保存失败：${errorText(error)}。可点击保存修改重试。`))
      } catch (error) { setGenerationError(errorText(error)) }
    }
  }), [onQuota, persist, notify])

  function changeContext(change: () => void) {
    if (locked) return
    void (async () => {
      if (report && dirty) await persist(report)
      sourceRequest.current.invalidate(); setSource(null); setReport(null); setDraftTitle(''); setEvidence(null); setGenerationError('')
      change(); setReload(value => value + 1)
    })().catch(error => notify(errorText(error)))
  }
  async function startGeneration() {
    if (!account || !draft.value || !matchingSource || !consent || locked || job.current) return
    const input = { ...draft.value.input, requestId: crypto.randomUUID() }
    const current = { input, originals: draft.value.originals, source: { id: matchingSource.session.id, name: matchingSource.session.name, capturedAt: matchingSource.capturedAt }, title: (title.trim() || defaultTitle).slice(0, 120) }
    job.current = current
    setConfirmOpen(false); setGenerating(true); setStopping(false); setGenerationError(''); setProgress({ message: '正在准备本期讨论…', current: 0, total: 1 })
    try {
      if (report && dirty) await persist(report)
      setReport(null); setEvidence(null); setDraftTitle(current.title)
      await bridge.generateGroupReport(input)
    } catch (error) {
      if (error instanceof Error && /abort|取消/i.test(error.message)) setGenerationError('已停止生成。')
      else setGenerationError(errorText(error))
    } finally {
      job.current = null; setGenerating(false); setStopping(false); setConsent(false)
      void refreshAccount()
    }
  }
  async function saveTemplate() {
    if (configError) { notify(configError); return }
    setSaving(true)
    try { const next = { ...templates, [kind]: template }; await bridge.saveReportTemplates(next); setTemplates(next); notify(`已保存${kindName(kind)}模板，下次创建时继续使用`) }
    catch (error) { notify(errorText(error)) } finally { setSaving(false) }
  }
  async function exportReport(format: 'png' | 'png-pages' | 'pdf' | 'html') {
    if (!report || locked || missingColumns.length) return
    setExporting(format)
    try {
      if (dirty) await persist(report)
      const result = await bridge.exportGroupReport(report, format)
      if (result.saved) notify(format.startsWith('png') ? `已导出 ${result.files} 张社群图片` : format === 'pdf' ? 'PDF 报告已导出' : '网页报告已导出')
    } catch (error) { notify(errorText(error)) } finally { setExporting('') }
  }
  function openReport(value: SavedGroupReport) {
    if (locked) return
    void (async () => {
      if (report && dirty) await persist(report)
      sourceRequest.current.invalidate(); setSource(null); setReport(value); setKind(value.period.kind); setDates(previous => ({ ...previous, [value.period.kind]: value.period.date })); setSessionId(value.sourceId)
      setHistoryOpen(false); setEvidence(null); setGenerationError(''); setReload(previous => previous + 1)
    })().catch(error => notify(errorText(error)))
  }
  const filteredHistory = history.filter(item => `${item.title} ${item.sourceName} ${item.period.label}`.toLowerCase().includes(historySearch.toLowerCase()))
  const sendMessages = draft.value?.input.messages || []
  const canGenerate = Boolean(draft.value && readable && !loading && !configError && templatesReady)

  return <>
    <div className="report-workspace-bar"><p><span>01</span>选群与周期<i /><span>02</span>自选栏目<i /><span>03</span>生成并分享</p><button className="button secondary" disabled={locked || !account} onClick={() => setHistoryOpen(true)}><History size={15} />报告库{history.length > 0 && <span>{history.length}</span>}</button></div>
    <div className="community-workspace">
      <div className="report-settings-column">
        <section className="report-config-card report-source-card">
          <div className="report-card-heading"><h2><Users size={17} />本期社群</h2>{report && <button className="text-button" disabled={locked} onClick={() => changeContext(() => {})}><Plus size={13} />新建一份</button>}</div>
          <label className="report-field">选择群聊<select aria-label="报告群聊" disabled={locked || !groups.length} value={sessionId} onChange={event => { const id = event.target.value; changeContext(() => setSessionId(id)) }}>
            {!selectedSession && <option value={sessionId}>{report ? `${report.sourceName}（历史记录）` : '请先添加群聊记录'}</option>}
            {groups.map(session => <option value={session.id} key={session.id}>{session.name}</option>)}
          </select></label>
          <div className="report-kind-switch" aria-label="报告周期">{(['daily', 'weekly'] as const).map(value => <button aria-pressed={kind === value} className={kind === value ? 'selected' : ''} disabled={locked} key={value} onClick={() => { if (kind !== value) changeContext(() => setKind(value)) }}><CalendarDays size={15} />{kindName(value)}</button>)}</div>
          <label className="report-field">{kind === 'daily' ? '报告日期' : '选择本周任意一天'}<input type="date" aria-label="报告日期" value={dates[kind]} max={localDate(Date.now() / 1000)} disabled={locked} onChange={event => { const value = event.target.value; changeContext(() => setDates(previous => ({ ...previous, [kind]: value }))) }} /></label>
          <p className="report-period">{period?.label || '请选择有效日期'}<small>{kind === 'weekly' ? '自然周：周一至周日 · 北京时间' : '00:00 至次日 00:00 · 北京时间'}</small></p>
          {selectedSession ? <div className={`report-source-status ${sourceError ? 'error' : ''}`} role="status"><div>{loading ? <LoaderCircle className="spin" size={15} /> : sourceError ? <FileText size={15} /> : <Check size={15} />}<strong>{loading ? '正在读取整个周期…' : sourceError || `${matchingSource?.messages.length.toLocaleString() || 0} 条本期消息`}</strong><button className="icon-button" aria-label="重新读取报告周期" title="刷新本期记录" disabled={locked || loading} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} /></button></div><p>{matchingSource?.messages.length ? `${selectedSession.source === 'import' ? '范围仅覆盖导入文件中已有的记录。' : '已读取本期全部可用记录。'}${period && period.end > Date.now() / 1000 ? '本期尚未结束，将整理目前已读取的内容。' : ''}` : sourceError ? '可重试读取，或导入该周期的聊天记录。' : '可切换日期，或导入对应日期的聊天记录。'}</p></div> : <div className="report-source-empty"><p>{report ? '历史报告可直接阅读和导出；重新分析需连接原群聊。' : '导入群聊记录，或先用示例体验完整流程。'}</p><div><button className="button secondary" disabled={locked} onClick={() => { void onDataAction('import') }}><Upload size={14} />导入记录</button><button className="text-button" disabled={locked} onClick={() => { void onDataAction('sample') }}><BookOpen size={14} />体验示例群</button></div></div>}
        </section>
        <ReportTemplateEditor template={template} disabled={locked || !templatesReady} generatedIds={generatedIds} onChange={value => { if (report) setReport({ ...report, template: value }); else setTemplates(previous => ({ ...previous, [kind]: value })) }} />
        <div className="report-template-actions"><button className="text-button" disabled={locked || !templatesReady || Boolean(configError)} onClick={() => { void saveTemplate() }}><Save size={14} />保存为{kindName(kind)}模板</button><button className="text-button" disabled={locked || !templatesReady} onClick={() => { const value = defaultReportTemplate(kind); if (report) setReport({ ...report, template: value }); else setTemplates(previous => ({ ...previous, [kind]: value })) }}>恢复默认</button></div>
        <section className="report-generate-card">
          <label className="report-privacy"><input type="checkbox" checked={anonymize} disabled={locked} onChange={event => setAnonymize(event.target.checked)} /><span>发送前替换昵称与常见联系方式</span></label>
          {(configError || draft.error) && <p className="inline-error">{configError || draft.error}</p>}
          {matchingSource?.messages.length && !readable ? <p className="inline-error">本期只有图片、语音或视频，暂没有可分析的文字内容。</p> : null}
          {generating ? <button className="button stop full" disabled={stopping} onClick={() => { setStopping(true); void bridge.cancelAnalysis().catch(error => { setStopping(false); notify(errorText(error)) }) }}><Square size={14} />{stopping ? '正在停止…' : '停止生成'}</button> : <button className="button primary full" disabled={locked || (account !== null && (!canGenerate || !health?.aiReady || account.quota.remaining <= 0))} onClick={() => {
            if (!account) { onLogin(); return }
            if (canGenerate) { setConsent(false); setConfirmOpen(true) }
          }}><Sparkles size={17} />{!account ? '登录后生成报告' : !health?.aiReady ? 'AI 服务暂不可用' : account.quota.remaining <= 0 ? '今日额度已用完' : report ? `重新生成${kindName(kind)}` : `生成社群${kindName(kind)}`}<span className="button-cost">1 次</span></button>}
          <p>生成前可核对发送内容。成功生成才计入额度。</p>
        </section>
      </div>
      <section className="report-preview-column" aria-label="社群报告预览">
        <header className="report-preview-toolbar"><div><span className={`report-preview-status ${report ? 'ready' : ''}`}>{report ? report.demo ? '演示报告' : '报告已生成' : '排版示例'}</span><small>{report ? saving ? '正在保存…' : dirty ? '排版有修改' : '已保存到本机' : '生成后替换为本群分析内容'}</small></div><div className="report-export-actions">
          <button className="button secondary" disabled={!report || locked || missingColumns.length > 0 || Boolean(configError) || !title.trim() || bridge.platform !== 'desktop'} onClick={() => { void exportReport('png-pages') }}><Image size={14} />分页图片</button>
          {report && dirty && <button className="button subtle" disabled={locked || Boolean(configError) || !title.trim()} onClick={() => { void persist(report).then(() => notify('报告修改已保存')).catch(error => notify(errorText(error))) }}><Save size={14} />保存修改</button>}
          <button className="button secondary" disabled={!report || locked || missingColumns.length > 0 || Boolean(configError) || !title.trim()} title={bridge.platform === 'browser' ? '需使用桌面版导出 PDF' : '导出适合阅读与打印的 PDF'} onClick={() => { void exportReport('pdf') }}>{exporting === 'pdf' ? <LoaderCircle className="spin" size={15} /> : <FileText size={15} />}PDF</button>
          <button className="button primary" disabled={!report || locked || missingColumns.length > 0 || Boolean(configError) || !title.trim()} title={bridge.platform === 'browser' ? '需使用桌面版导出长图' : '导出适合群内分享的图片'} onClick={() => { void exportReport('png') }}>{exporting === 'png' ? <LoaderCircle className="spin" size={15} /> : <Image size={15} />}导出长图</button>
        </div></header>
        <div className="report-title-editor"><label htmlFor="community-report-title">报告标题</label><input id="community-report-title" placeholder={defaultTitle} value={title} maxLength={120} disabled={locked} onChange={event => { if (report) setReport({ ...report, title: event.target.value }); else setDraftTitle(event.target.value) }} /></div>
        {generating && <div className="report-progress" role="status"><div><LoaderCircle className="spin" size={16} /><span>{progress.message}</span><small>{progress.current}/{progress.total}</small></div><progress max={Math.max(1, progress.total)} value={progress.current} /><p>讨论较多时会分批整理，再合并重复话题。</p></div>}
        {generationError && <div className="inline-error report-generation-error" role="alert">{generationError}</div>}
        {missingColumns.length > 0 && <div className="report-layout-note">{missingColumns.map(column => column.title).join('、')}尚未生成。请重新生成，或关闭这些栏目后导出。</div>}
        {!report && <div className="report-layout-note">下方为虚构内容，用于预览栏目与风格。</div>}
        <div className="report-preview-canvas"><ReportPaper report={preview} onReference={id => {
          const message = scopedEvidence(id, preview)
          if (message) setEvidence({ message, sourceName: preview.sourceName }); else notify('这份报告未保存该条引用原文')
        }} /></div>
        <footer className="report-preview-footer"><span><ShieldCheck size={13} />点击消息编号可核对本机原文</span><button className="text-button" disabled={!report || locked || missingColumns.length > 0 || Boolean(configError) || !title.trim()} onClick={() => { void exportReport('html') }}><ArrowDownToLine size={13} />导出网页</button></footer>
        {bridge.platform === 'browser' && <p className="report-browser-note">浏览器预览可导出网页；长图与 PDF 使用桌面版导出。</p>}
      </section>
    </div>
    {confirmOpen && draft.value && <Modal title={`确认生成社群${kindName(kind)}`} wide onClose={closeConfirm}>
      <p className="modal-intro">{selectedSession?.name} · {period?.label}<br />将发送 {sendMessages.length.toLocaleString()} 条消息中的文字与媒体占位说明，共 {sendMessages.reduce((sum, message) => sum + message.text.length, 0).toLocaleString()} 字符。{anonymize ? '已替换昵称并遮盖常见手机号、邮箱，请核对下方文本。' : '保留原始昵称和文本。'}</p>
      <p className="report-confirm-columns">本次栏目：{template.columns.filter(column => column.enabled).map(column => column.title).join('、')}</p>
      <div className="context-preview">{sendMessages.slice(previewPage * 60, (previewPage + 1) * 60).map(message => <article key={message.id}><header><span>{message.id}</span><strong>{message.sender}</strong><time>{timeText(message.timestamp)}</time></header><p>{message.text}</p></article>)}</div>
      <div className="report-context-pages"><span>第 {previewPage * 60 + 1}–{Math.min((previewPage + 1) * 60, sendMessages.length)} 条，共 {sendMessages.length} 条</span><button className="icon-button" aria-label="上一页发送内容" disabled={previewPage === 0} onClick={() => setPreviewPage(value => value - 1)}><ArrowLeft size={16} /></button><button className="icon-button" aria-label="下一页发送内容" disabled={(previewPage + 1) * 60 >= sendMessages.length} onClick={() => setPreviewPage(value => value + 1)}><ArrowRight size={16} /></button></div>
      <label className="report-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />允许将以上内容发送至云端，生成本次报告</label>
      <div className="modal-footer"><button className="button secondary" onClick={closeConfirm}>返回调整</button><button className="button primary" disabled={!consent || locked} onClick={() => { void startGeneration() }}><Sparkles size={16} />确认生成 · 1 次</button></div>
    </Modal>}
    {historyOpen && <Modal title="本机报告库" wide onClose={closeHistory}>
      <p className="modal-intro">日报和周报保存在当前账号的本机报告库，最多保留最近 60 份。重新打开后可调整排版并导出。</p>
      <input className="report-history-search" aria-label="搜索社群报告" placeholder="搜索群名、报告标题或日期" value={historySearch} onChange={event => setHistorySearch(event.target.value)} />
      <div className="report-history-list">{filteredHistory.length ? filteredHistory.map(item => <article key={item.id}><span className={`report-history-kind ${item.period.kind}`}>{kindName(item.period.kind)}</span><button className="report-history-open" disabled={locked} onClick={() => openReport(item)}><strong>{item.title}</strong><small>{item.period.label} · {item.stats.messages} 条消息{item.demo ? ' · 演示内容' : ''}</small></button><button className="icon-button" aria-label={`删除报告${item.title}`} disabled={locked} onClick={() => {
        setSaving(true)
        void bridge.deleteGroupReport(item.id).then(() => { setHistory(previous => previous.filter(value => value.id !== item.id)); if (report?.id === item.id) setReport(null); notify('已删除本机报告') }).catch(error => notify(errorText(error))).finally(() => setSaving(false))
      }}><Trash2 size={16} /></button></article>) : <div className="report-history-empty"><BookOpen size={28} /><p>{historySearch ? '没有找到匹配的报告' : '生成第一份社群报告后，会自动保存在这里。'}</p></div>}</div>
    </Modal>}
    {evidence && <Modal title={`引用原文 · ${evidence.message.id}`} onClose={closeEvidence}><p className="modal-intro">{evidence.sourceName}</p><div className="evidence-meta"><strong>{evidence.message.sender}</strong><time>{timeText(evidence.message.timestamp)}</time></div><p className="evidence-text">{evidence.message.text}</p><p className="fine-print"><ShieldCheck size={14} />仅查看本报告保存的原文快照。</p></Modal>}
  </>
}
