import { useEffect, useMemo, useRef, useState } from 'react'
import type { SavedGroupReport } from '../../shared/group-report.js'
import { renderGroupReport, reportCss } from '../../shared/report-renderer.js'

export function ReportPaper({ report, onReference }: { report: SavedGroupReport; onReference: (id: string) => void }) {
  const container = useRef<HTMLDivElement>(null)
  const paper = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ scale: 1, height: 1000 })
  const html = useMemo(() => renderGroupReport(report, true), [report])
  useEffect(() => {
    const outer = container.current!
    const inner = paper.current!
    const update = () => {
      if (!outer.clientWidth) return
      setSize({ scale: Math.min(1, outer.clientWidth / 720), height: inner.scrollHeight })
    }
    const observer = new ResizeObserver(update)
    observer.observe(outer); observer.observe(inner); update()
    return () => observer.disconnect()
  }, [])
  return <div className="report-paper-container" ref={container}>
    <style>{reportCss}</style>
    <div style={{ width: 720 * size.scale, height: size.height * size.scale }} className="report-paper-size">
      <div ref={paper} className="report-paper-content" style={{ transform: `scale(${size.scale})` }} onClick={event => {
        const reference = (event.target as Element).closest<HTMLElement>('[data-report-ref]')
        if (reference?.dataset.reportRef) { event.preventDefault(); onReference(reference.dataset.reportRef) }
      }} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  </div>
}
