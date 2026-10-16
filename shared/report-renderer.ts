import type { SavedGroupReport } from './group-report.js'

export function escapeReportText(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

export const reportCss = `
.community-report{--r-ink:#203c34;--r-muted:#637c73;--r-accent:#286b53;--r-paper:#f4f7ed;--r-card:#fffefb;box-sizing:border-box;width:720px;padding:44px 38px;background:var(--r-paper);color:var(--r-ink);font:25px/1.8 "Microsoft YaHei","PingFang SC",sans-serif;overflow-wrap:anywhere}
.community-report *{box-sizing:border-box}.community-report h1,.community-report h2,.community-report h3,.community-report p{margin:0}.community-report .cr-topline{display:flex;justify-content:space-between;gap:16px;font-size:17px;letter-spacing:2px;color:var(--r-accent)}
.community-report h1{font-size:48px;line-height:1.4;font-weight:600;letter-spacing:1px;margin:24px 0 12px}.community-report .cr-date{font-size:19px;color:var(--r-muted)}.community-report .cr-rule{height:4px;background:var(--r-accent);margin:26px 0}
.community-report .cr-stats{display:flex;gap:16px;padding:23px 0;border-top:1px solid #64866b35;border-bottom:1px solid #64866b35;margin:26px 0}.community-report .cr-stat{flex:1}.community-report .cr-stat strong{font-size:37px;font-weight:600;display:block;color:var(--r-accent)}.community-report .cr-stat span{font-size:17px;color:var(--r-muted)}
.community-report .cr-section{padding:27px 26px;background:var(--r-card);border-radius:18px;margin:22px 0;break-inside:avoid}.community-report .cr-section-heading{display:flex;align-items:baseline;gap:12px;padding-bottom:18px;margin-bottom:18px;border-bottom:1px solid #64866b25}.community-report .cr-number{font-size:17px;letter-spacing:1px;color:var(--r-accent)}.community-report h2{font-size:28px;font-weight:600;line-height:1.6}.community-report h3{font-size:25px;font-weight:600;margin-bottom:9px;line-height:1.6}.community-report .cr-item+.cr-item{margin-top:24px;padding-top:22px;border-top:1px dashed #64866b30}.community-report .cr-item p{white-space:pre-wrap;font-size:24px;line-height:1.85}.community-report .cr-refs{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}.community-report .cr-ref{font-size:15px;color:var(--r-accent);border:1px solid #64866b40;border-radius:5px;padding:0 6px;text-decoration:none;background:transparent}
.community-report .cr-empty{font-size:21px;color:var(--r-muted)}.community-report .cr-day{display:flex;align-items:center;gap:15px;font-size:17px;margin:10px 0}.community-report .cr-day span:first-child{width:74px}.community-report .cr-day-track{height:8px;background:#64866b15;flex:1;border-radius:6px;overflow:hidden}.community-report .cr-day-track i{height:100%;display:block;background:var(--r-accent);border-radius:6px}.community-report .cr-day b{width:38px;text-align:right;font-size:16px;font-weight:400}
.community-report .cr-foot{margin-top:30px;border-top:1px solid #64866b35;padding-top:20px;font-size:16px;line-height:1.9;color:var(--r-muted)}.community-report .cr-source{margin-top:17px;padding-top:17px;border-top:1px solid #64866b25;font-size:18px}.community-report .cr-source p{font-size:17px;white-space:pre-wrap}.community-report .cr-demo{margin-top:18px;font-size:16px;color:var(--r-muted)}
.community-report.style-briefing{--r-ink:#213651;--r-muted:#617288;--r-accent:#315d96;--r-paper:#fff;--r-card:#fff}.community-report.style-briefing .cr-section{padding:22px 0;border-radius:0;border-bottom:1px solid #64866b35}.community-report.style-briefing h1{font-size:43px}.community-report.style-briefing .cr-item p{font-size:23px}
.community-report.style-editorial{--r-ink:#3d352a;--r-muted:#786c5b;--r-accent:#9a6038;--r-paper:#f7f0e3;--r-card:#f7f0e3}.community-report.style-editorial h1,.community-report.style-editorial h2{font-family:"Noto Serif SC","SimSun",serif}.community-report.style-editorial .cr-section{border-radius:0;padding:24px 0;border-top:2px solid #9a603850}.community-report.style-editorial .cr-section-heading{border-bottom:0;margin-bottom:8px;padding-bottom:8px}
.community-report.font-serif{font-family:"SimSun","Songti SC",serif}.community-report.font-system h1,.community-report.font-system h2{font-family:"Microsoft YaHei","PingFang SC",sans-serif}.community-report.density-comfortable .cr-item p{font-size:27px;line-height:2}.community-report.density-compact .cr-item p{font-size:21px;line-height:1.7}.community-report.density-compact .cr-section{padding-top:18px;padding-bottom:18px}.community-report .cr-item{break-inside:avoid}.community-report .cr-section-heading{break-after:avoid}
@media print{@page{size:A4;margin:14mm}.community-report{width:100%;padding:0;background:#fff!important;font-size:13px;line-height:1.7;print-color-adjust:exact;-webkit-print-color-adjust:exact}.community-report h1,.community-report.style-briefing h1{font-size:27px;margin-top:14px}.community-report h2{font-size:18px}.community-report h3{font-size:15px}.community-report .cr-item p,.community-report.style-briefing .cr-item p{font-size:13px;line-height:1.8}.community-report .cr-topline,.community-report .cr-date{font-size:11px}.community-report .cr-section{padding:15px 17px;margin:14px 0}.community-report .cr-number,.community-report .cr-stat span,.community-report .cr-demo,.community-report .cr-foot{font-size:10px}.community-report .cr-stats{padding:12px 0;margin:14px 0}.community-report .cr-stat strong{font-size:23px}.community-report .cr-section-heading{padding-bottom:9px;margin-bottom:9px}.community-report .cr-ref{font-size:9px}.community-report .cr-source p{font-size:10px}.community-report .cr-item+.cr-item{padding-top:12px;margin-top:12px}.community-report .cr-day{font-size:11px}.community-report .cr-day b{font-size:11px}}
@media print{.community-report .cr-section{break-inside:auto}.community-report.density-comfortable .cr-item p{font-size:15px;line-height:1.9}.community-report.density-compact .cr-item p{font-size:12px;line-height:1.65}.community-report.density-compact .cr-section{padding-top:10px;padding-bottom:10px}}
`

export function renderGroupReport(report: SavedGroupReport, interactive = false): string {
  const e = escapeReportText
  const collectedAt = report.collectedAt ?? report.createdAt
  const cutoff = collectedAt / 1000 < report.period.end ? `<br>记录截至 ${e(new Date(collectedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}` : ''
  const selected = report.template.columns.filter(column => column.enabled)
  let number = 0
  const sections = selected.map(column => {
    const content = report.sections.find(section => section.id === column.id)
    if (column.id !== 'activity' && !content?.items.length && report.template.hideEmpty) return ''
    const body = column.id === 'activity'
      ? report.stats.days.map(day => `<div class="cr-day"><span>${e(day.date.slice(5))}</span><span class="cr-day-track"><i style="width:${Math.round(day.count / Math.max(1, ...report.stats.days.map(item => item.count)) * 100)}%"></i></span><b>${day.count}</b></div>`).join('')
      : content?.items.length ? content.items.map(item => `<div class="cr-item"><h3>${e(item.title)}</h3><p>${e(item.text)}</p><div class="cr-refs">${item.refs.map(ref => interactive || report.template.showSources ? `<a class="cr-ref" href="#evidence-${e(ref)}" data-report-ref="${e(ref)}" aria-label="查看原文 ${e(ref)}">${e(ref)}</a>` : `<span class="cr-ref">${e(ref)}</span>`).join('')}</div></div>`).join('') : '<p class="cr-empty">本期没有足够的相关讨论。</p>'
    return `<section class="cr-section"><div class="cr-section-heading"><span class="cr-number">${String(++number).padStart(2, '0')}</span><h2>${e(column.title)}</h2></div>${body}</section>`
  }).join('')
  const references = new Set(report.sections.filter(section => selected.some(column => column.id === section.id)).flatMap(section => section.items.flatMap(item => item.refs)))
  const sourceHtml = report.template.showSources ? report.evidence.filter(message => references.has(message.id)).map(message => `<div class="cr-source" id="evidence-${e(message.id)}"><strong>${e(message.id)} · ${e(message.sender)}</strong><p>${e(message.text)}</p></div>`).join('') : ''
  return `<article class="community-report style-${report.template.style} font-${report.template.font || (report.template.style === 'editorial' ? 'serif' : 'system')} density-${report.template.density || 'standard'}"><div class="cr-topline"><span>知聊 · 社群${report.period.kind === 'daily' ? '日报' : '周报'}</span><span>${report.period.kind === 'daily' ? 'DAILY' : 'WEEKLY'}</span></div><h1>${e(report.title)}</h1><p class="cr-date">${e(report.sourceName)}<br>${e(report.period.label)}${cutoff}</p><div class="cr-rule"></div>${report.demo ? '<p class="cr-demo">示例内容 · 仅用于体验报告与样式，不代表真实 AI 分析</p>' : ''}${report.template.showStats ? `<div class="cr-stats"><div class="cr-stat"><strong>${report.stats.messages}</strong><span>条群聊消息</span></div><div class="cr-stat"><strong>${report.stats.participants}</strong><span>位参与成员</span></div><div class="cr-stat"><strong>${report.stats.textMessages}</strong><span>条可读内容</span></div></div>` : ''}${sections}<footer class="cr-foot">根据所选周期的群聊文字整理。观点归参与者所有，可通过消息编号核对来源。${report.stats.mediaMessages ? `<br>本期包含 ${report.stats.mediaMessages} 条图片、语音或视频消息，其媒体内容未作语义分析。` : ''}<br>由知聊整理 · ${e(report.period.label)}</footer>${sourceHtml}</article>`
}

export function groupReportDocument(report: SavedGroupReport): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=720"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'self'"><title>${escapeReportText(report.title)}</title><style>html,body{margin:0;padding:0;background:#fff}body{width:720px}${reportCss}@media print{body{width:auto}}</style></head><body>${renderGroupReport(report)}</body></html>`
}

export function reportImageSegments(height: number, boundaries: number[], limit = 6000): Array<{ top: number; height: number }> {
  if (!Number.isFinite(height) || height < 1 || height > 60000 || !Number.isFinite(limit) || limit < 1) throw new Error('报告过长，请改用 PDF 或减少展示栏目')
  const end = Math.ceil(height)
  const breaks = [...new Set(boundaries.filter(value => Number.isFinite(value) && value > 0 && value < end).map(Math.floor))].sort((a, b) => a - b)
  const result = []
  for (let top = 0; top < end;) {
    const maximum = Math.min(top + Math.floor(limit), end)
    const candidates = maximum < end ? breaks.filter(value => value > top + limit / 2 && value <= maximum) : []
    const bottom = candidates.at(-1) || maximum
    result.push({ top, height: bottom - top }); top = bottom
  }
  return result
}
