import { useState } from 'react'
import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2 } from 'lucide-react'
import { REPORT_COLUMNS, reportStyles, type ReportTemplate } from '../../shared/group-report.js'

const styles = { cards: ['社群卡片', '分栏清晰，轻松阅读'], briefing: ['清爽简报', '重点突出，简洁专业'], editorial: ['人文刊物', '暖色纸感，从容阅读'] }

export function ReportTemplateEditor({ template, onChange, disabled, generatedIds }: { template: ReportTemplate; onChange: (template: ReportTemplate) => void; disabled: boolean; generatedIds?: Set<string> }) {
  const [tab, setTab] = useState<'content' | 'style'>('content')
  const [editing, setEditing] = useState('')
  const patchColumn = (id: string, patch: Partial<ReportTemplate['columns'][number]>) => onChange({ ...template, columns: template.columns.map(column => column.id === id ? { ...column, ...patch } : column) })
  const move = (index: number, step: number) => {
    const columns = [...template.columns]
    ;[columns[index], columns[index + step]] = [columns[index + step], columns[index]]
    onChange({ ...template, columns })
  }
  return <section className="report-config-card">
    <div className="report-config-tabs" role="tablist" aria-label="报告配置">
      <button role="tab" aria-selected={tab === 'content'} onClick={() => setTab('content')}>内容栏目<span>{template.columns.filter(column => column.enabled).length}</span></button>
      <button role="tab" aria-selected={tab === 'style'} onClick={() => setTab('style')}>呈现风格</button>
    </div>
    {tab === 'content' ? <div role="tabpanel" aria-label="内容栏目">
      <p className="report-help">选出群成员关心的内容，按阅读顺序排列。</p>
      <ol className="report-column-list">
        {template.columns.map((column, index) => <li key={column.id} className={column.enabled ? 'enabled' : ''}>
          <div className="report-column-row">
            <label><input type="checkbox" checked={column.enabled} disabled={disabled} onChange={event => patchColumn(column.id, { enabled: event.target.checked })} /><span>{column.title || '未命名栏目'}</span></label>
            {column.enabled && column.id !== 'activity' && generatedIds && !generatedIds.has(column.id) && <small className="report-needs-content">待生成</small>}
            <div className="report-column-actions">
              <button className="icon-button" title="编辑栏目" aria-label={`编辑${column.title}`} disabled={disabled} onClick={() => setEditing(editing === column.id ? '' : column.id)}><Pencil size={13} /></button>
              <button className="icon-button" title="上移" aria-label={`上移${column.title}`} disabled={disabled || index === 0} onClick={() => move(index, -1)}><ArrowUp size={13} /></button>
              <button className="icon-button" title="下移" aria-label={`下移${column.title}`} disabled={disabled || index === template.columns.length - 1} onClick={() => move(index, 1)}><ArrowDown size={13} /></button>
            </div>
          </div>
          {editing === column.id && <div className="report-column-edit">
            <label className="report-field">栏目标题<input value={column.title} maxLength={36} disabled={disabled} onChange={event => patchColumn(column.id, { title: event.target.value })} /></label>
            {column.id !== 'activity' && <label className="report-field">希望 AI 关注什么<textarea value={column.instruction} maxLength={300} rows={3} disabled={disabled} onChange={event => patchColumn(column.id, { instruction: event.target.value })} /></label>}
            {!REPORT_COLUMNS.some(item => item.id === column.id) && <button className="text-button danger" disabled={disabled} onClick={() => { onChange({ ...template, columns: template.columns.filter(item => item.id !== column.id) }); setEditing('') }}><Trash2 size={13} />移除此栏目</button>}
          </div>}
        </li>)}
      </ol>
      <button className="report-add-column" disabled={disabled || template.columns.length >= 12} onClick={() => {
        const id = `custom-${crypto.randomUUID().slice(0, 8)}`
        onChange({ ...template, columns: [...template.columns, { id, title: '自定义栏目', instruction: '整理本期与这个栏目有关的讨论，保留依据和消息引用。', enabled: true }] }); setEditing(id)
      }}><Plus size={15} />添加自定义栏目<span>{template.columns.length}/12</span></button>
      <div className="report-option-grid">
        <label className="report-field">文字语气<select value={template.tone} disabled={disabled} onChange={event => onChange({ ...template, tone: event.target.value as ReportTemplate['tone'] })}><option value="objective">客观简洁</option><option value="friendly">自然亲切</option><option value="professional">专业深入</option></select></label>
        <label className="report-field">阅读篇幅<select value={template.length} disabled={disabled} onChange={event => onChange({ ...template, length: event.target.value as ReportTemplate['length'] })}><option value="short">精简 · 快速扫读</option><option value="standard">标准 · 重点清晰</option><option value="detailed">详细 · 保留细节</option></select></label>
      </div>
      <p className="report-help report-bottom-help">语气、篇幅和栏目说明在下次生成时生效。</p>
    </div> : <div role="tabpanel" aria-label="呈现风格">
      <p className="report-help">同一份内容，换一种适合社群的阅读方式。</p>
      <div className="report-style-options">
        {reportStyles.map(style => <button key={style} disabled={disabled} aria-pressed={template.style === style} className={`report-style-option ${style} ${template.style === style ? 'selected' : ''}`} onClick={() => onChange({ ...template, style })}>
          <span className="report-style-mini" aria-hidden="true"><i /><b /><em /><em /><em /></span><span><strong>{styles[style][0]}</strong><small>{styles[style][1]}</small></span>{template.style === style && <Check size={17} />}
        </button>)}
      </div>
      <div className="report-display-options">
        <label className="report-field">中文字体<select value={template.font || 'system'} disabled={disabled} onChange={event => onChange({ ...template, font: event.target.value as ReportTemplate['font'] })}><option value="system">清晰黑体</option><option value="serif">阅读宋体</option></select></label>
        <label className="report-field">阅读字号<select value={template.density || 'standard'} disabled={disabled} onChange={event => onChange({ ...template, density: event.target.value as ReportTemplate['density'] })}><option value="standard">标准</option><option value="comfortable">舒适大字</option><option value="compact">紧凑小字</option></select></label>
        <label><input type="checkbox" checked={template.showStats} disabled={disabled} onChange={event => onChange({ ...template, showStats: event.target.checked })} /><span>显示消息与参与人数<small>按本期可用记录统计</small></span></label>
        <label><input type="checkbox" checked={template.hideEmpty} disabled={disabled} onChange={event => onChange({ ...template, hideEmpty: event.target.checked })} /><span>自动隐藏没有内容的栏目<small>让报告保持紧凑</small></span></label>
        <label><input type="checkbox" checked={template.showSources} disabled={disabled} onChange={event => onChange({ ...template, showSources: event.target.checked })} /><span>附上引用原文<small>导出将包含原始昵称和引用的消息正文</small></span></label>
      </div>
      <p className="report-help report-bottom-help">风格、显隐与顺序即时生效，无需重新分析。</p>
    </div>}
  </section>
}
