import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDownToLine, ChevronLeft, ChevronRight, FileAudio, Image, LoaderCircle, Search } from 'lucide-react'
import { bridge } from '../bridge.js'
import { Modal } from './Modal.js'
import { localDate, reportPeriod } from '../../shared/group-report.js'
import { exportFormats, type ChatExportFormat, type MessagePage, type MessageQuery } from '../../shared/workbench.js'
import type { ChatMessage, ChatSession } from '../../shared/contracts.js'

export function MessageExplorer({ active, sessions, notify, onTasks }: { active: boolean; sessions: ChatSession[]; notify: (message: string) => void; onTasks: () => void }) {
  const [sessionId, setSessionId] = useState(''), [from, setFrom] = useState(localDate(Date.now() / 1000 - 7 * 86400)), [to, setTo] = useState(localDate(Date.now() / 1000))
  const [member, setMember] = useState(''), [keyword, setKeyword] = useState(''), [offset, setOffset] = useState(0), [reload, setReload] = useState(0)
  const [page, setPage] = useState<MessagePage | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState(''), [mediaBusy, setMediaBusy] = useState(''), [image, setImage] = useState('')
  const [format, setFormat] = useState<ChatExportFormat>('md'), [exporting, setExporting] = useState(false)
  const closeImage = useCallback(() => setImage(''), [])
  useEffect(() => { if (!sessions.some(session => session.id === sessionId)) { setSessionId(sessions.find(session => session.kind === 'group')?.id || sessions[0]?.id || ''); setMember(''); setOffset(0) } }, [sessions, sessionId])
  const query = useMemo<MessageQuery | null>(() => { try { const start = reportPeriod('daily', from).start, end = reportPeriod('daily', to).end; return sessionId && end > start ? { sessionId, start, end, senderId: member || undefined, keyword, offset, limit: 100 } : null } catch { return null } }, [sessionId, from, to, member, keyword, offset])
  useEffect(() => {
    if (!active) return
    let alive = true
    setError(''); setLoading(Boolean(query)); setPage(null)
    if (!query) return
    const timer = setTimeout(() => { void bridge.queryMessages(query).then(value => { if (alive) setPage(value) }).catch(error => { if (alive) setError(error.message) }).finally(() => { if (alive) setLoading(false) }) }, 250)
    return () => { alive = false; clearTimeout(timer) }
  }, [active, query, reload, sessions])
  useEffect(() => { let timer: ReturnType<typeof setTimeout>; const off = bridge.onDataChange(event => { if (active && event.type === 'changed' && (!event.sessionId || event.sessionId === sessionId)) { clearTimeout(timer); timer = setTimeout(() => setReload(value => value + 1), 700) } }); return () => { clearTimeout(timer); off() } }, [active, sessionId])
  async function exportMessages() { if (!query) return; setExporting(true); try { const id = await bridge.exportChat({ query, format }); if (id) { notify(bridge.platform === 'desktop' ? '导出已加入任务中心' : '聊天记录已导出'); if (bridge.platform === 'desktop') onTasks() } } catch (error) { notify(error instanceof Error ? error.message : '导出失败') } finally { setExporting(false) } }
  async function media(message: ChatMessage, chooseFile = false) {
    setMediaBusy(message.id)
    try { const result = await bridge.processMedia({ sessionId, messageId: message.id, action: message.type === 'voice' ? 'transcribe' : 'image', chooseFile }); if (result.image) setImage(result.image); if (result.text) { notify('转写已保存，重新生成报告时会纳入分析'); setReload(value => value + 1) } }
    catch (error) { notify(error instanceof Error ? error.message : '处理失败') } finally { setMediaBusy('') }
  }
  return <section className="message-explorer">
    <div className="explorer-filters"><label>会话<select value={sessionId} onChange={event => { setSessionId(event.target.value); setMember(''); setOffset(0) }}><option value="" disabled>选择群聊或私聊</option>{sessions.map(session => <option key={session.id} value={session.id}>{session.name}</option>)}</select></label><label>开始日期<input type="date" value={from} onChange={event => { setFrom(event.target.value); setOffset(0) }} /></label><label>结束日期<input type="date" value={to} onChange={event => { setTo(event.target.value); setOffset(0) }} /></label><label className="explorer-keyword">消息关键词<span><Search size={16} /><input value={keyword} placeholder="搜索本期完整消息" maxLength={200} onChange={event => { setKeyword(event.target.value); setOffset(0) }} /></span></label></div>
    <div className="explorer-toolbar"><span>北京时间 · 每次最多读取 100,000 条，超限会提示缩小范围</span><select aria-label="聊天记录导出格式" value={format} onChange={event => setFormat(event.target.value as ChatExportFormat)}>{exportFormats.map(format => <option key={format} value={format}>{format.toUpperCase()}</option>)}</select><button className="button secondary" disabled={!page?.total || loading || exporting} onClick={() => { void exportMessages() }}><ArrowDownToLine size={15} />导出筛选结果</button><button className="button subtle" disabled={!query || loading} onClick={() => setReload(value => value + 1)}>刷新</button></div>
    <div className="explorer-body"><aside className="member-panel"><h2>成员与发言</h2><button className={!member ? 'selected' : ''} onClick={() => { setMember(''); setOffset(0) }}>全部成员</button>{page?.members.map(item => <button key={item.id} title={item.id} className={member === item.id ? 'selected' : ''} onClick={() => { setMember(item.id); setOffset(0) }}><span>{item.name}<small>{item.id === '__self__' ? '当前微信账号' : item.id}</small></span><b>{item.count}</b></button>)}<p>次数按当前日期范围统计，同名成员按身份区分。</p></aside>
      <div className="explorer-results">{loading ? <div className="center-state"><LoaderCircle className="spin" /><p>正在读取所选范围…</p></div> : error ? <p className="inline-error">{error}</p> : !query ? <p className="list-empty">选择会话及有效日期后开始检索。</p> : page ? <>
        <div className="explorer-stats"><strong>{page.total.toLocaleString()} 条匹配消息</strong><span>{page.mediaCount} 条媒体消息</span><span>{page.days.length} 个活跃日期</span></div>
        {page.days.length > 1 && <div className="activity-days" aria-label="按日发言数量">{page.days.map(day => <div key={day.date} title={`${day.date}：${day.count} 条`}><i style={{ height: `${Math.max(4, day.count / Math.max(...page.days.map(item => item.count)) * 50)}px` }} /><small>{day.date.slice(5)}</small></div>)}</div>}
        {page.messages.length ? page.messages.map(message => <article className="explorer-message" key={message.id}><header><strong>{message.sender}</strong><time>{new Date(message.timestamp * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</time><small>{message.type === 'voice' && message.transcript ? '已本地转写' : message.type}</small></header><p>{message.text}</p>{message.quote?.serverId && <small>引用消息：{message.quote.serverId}</small>}{message.forwarded?.length && <small>合并转发 · {message.forwarded.length} 条</small>}
          {['voice', 'image'].includes(message.type) && <div className="message-media-actions"><button className="text-button" disabled={Boolean(mediaBusy) || bridge.platform !== 'desktop'} onClick={() => { void media(message) }}>{mediaBusy === message.id ? <LoaderCircle className="spin" size={14} /> : message.type === 'voice' ? <FileAudio size={14} /> : <Image size={14} />}{message.type === 'voice' ? '本机转写' : '查看图片'}</button><button className="text-button" disabled={Boolean(mediaBusy) || bridge.platform !== 'desktop'} onClick={() => { void media(message, true) }}>选择对应媒体文件</button></div>}
        </article>) : <p className="list-empty">该范围内没有匹配消息。</p>}
        <div className="explorer-pagination"><button className="button subtle" disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 100))}><ChevronLeft size={15} />上一页</button><span>{Math.floor(offset / 100) + 1} / {Math.max(1, Math.ceil(page.total / 100))}</span><button className="button subtle" disabled={!page.hasMore} onClick={() => setOffset(value => value + 100)}>下一页<ChevronRight size={15} /></button></div>
      </> : null}</div>
    </div>
    {image && <Modal title="本机图片预览" wide onClose={closeImage}><img className="local-image-preview" src={image} alt="所选消息对应的本机图片" /><p className="fine-print">图片仅在本机显示。</p></Modal>}
  </section>
}
