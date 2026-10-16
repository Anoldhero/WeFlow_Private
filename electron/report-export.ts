import { BrowserWindow, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, extname, join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { groupReportDocument, reportImageSegments } from '../shared/report-renderer.js'
import type { SavedGroupReport } from '../shared/group-report.js'
import type { TaskContext } from './task-manager.js'
import { safeFileName } from '../shared/chat-export.js'
import { writeFilesAtomically } from './file-output.js'

type Format = 'png' | 'png-pages' | 'pdf' | 'html'
interface ReportFile { suffix: string; data: Buffer }

export async function renderReportFiles(report: SavedGroupReport, format: Format, context?: TaskContext): Promise<ReportFile[]> {
  const html = groupReportDocument(report)
  if (format === 'html') return [{ suffix: '', data: Buffer.from(html, 'utf8') }]
  await context?.checkpoint()
  const preview = new BrowserWindow({ width: 720, height: 1000, show: false, useContentSize: true, webPreferences: { partition: `report-export-${randomUUID()}`, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  preview.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  preview.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:') }))
  const abort = () => { if (!preview.isDestroyed()) preview.destroy() }
  context?.signal.addEventListener('abort', abort, { once: true })
  try {
    await preview.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => { throw new Error('报告排版引擎启动失败，请重启软件后重试') })
    await preview.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
    if (format === 'pdf') { context?.progress(0, 1, '正在排版 PDF…'); return [{ suffix: '', data: await preview.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: '<div style="font:9px sans-serif;width:100%;text-align:center;color:#777"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' }) }] }
    const layout: { height: number; boundaries: number[] } = await preview.webContents.executeJavaScript(`(() => {
      const paper = document.querySelector('.community-report');
      const boundaries = [...paper.querySelectorAll('.cr-section,.cr-item,.cr-source,.cr-foot')].flatMap(element => { const rect = element.getBoundingClientRect(); return [rect.top, rect.bottom]; });
      for (const paragraph of paper.querySelectorAll('.cr-item p,.cr-source p')) {
        const range = document.createRange(); range.selectNodeContents(paragraph);
        const lines = [...range.getClientRects()].filter(rect => rect.height > 0);
        for (let index = 0; index < lines.length - 1; index++) if (lines[index + 1].top >= lines[index].bottom) boundaries.push((lines[index].bottom + lines[index + 1].top) / 2);
      }
      return { height: paper.getBoundingClientRect().height, boundaries };
    })()`)
    const segments = reportImageSegments(layout.height, layout.boundaries, format === 'png-pages' ? 1600 : 6000)
    const files: ReportFile[] = []
    for (const [index, segment] of segments.entries()) {
      await context?.checkpoint()
      context?.progress(index, segments.length, `正在生成第 ${index + 1} / ${segments.length} 张图片`)
      preview.setContentSize(720, segment.height)
      await preview.webContents.executeJavaScript(`window.scrollTo(0,${segment.top}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`)
      const capture = await preview.webContents.capturePage({ x: 0, y: 0, width: 720, height: segment.height }, { stayHidden: true, stayAwake: true })
      if (capture.isEmpty()) throw new Error('未能生成长图，请重试或使用 PDF 导出')
      const data = capture.resize({ width: 720, height: segment.height, quality: 'best' }).toPNG()
      files.push({ suffix: segments.length === 1 ? '' : `-${String(index + 1).padStart(2, '0')}`, data })
    }
    return files
  } finally { context?.signal.removeEventListener('abort', abort); if (!preview.isDestroyed()) preview.destroy() }
}

export async function exportCommunityReport(parent: BrowserWindow, report: SavedGroupReport, format: Format, context?: TaskContext): Promise<{ saved: boolean; files: number }> {
  const extension = format === 'png-pages' ? 'png' : format
  const fileName = safeFileName(report.title)
  const choice = await dialog.showSaveDialog(parent, { title: format === 'png-pages' ? '导出分页图片' : format === 'png' ? '导出社群长图' : format === 'pdf' ? '导出 PDF 报告' : '导出网页报告', defaultPath: `${fileName}.${extension}`, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] })
  if (choice.canceled || !choice.filePath) return { saved: false, files: 0 }
  const files = await renderReportFiles(report, format, context)
  const paths = files.map(file => file.suffix ? join(dirname(choice.filePath!), `${basename(choice.filePath!, extname(choice.filePath!))}${file.suffix}.${extension}`) : choice.filePath!)
  if (files.length > 1) {
    const existing = paths.filter(path => existsSync(path))
    const confirmation = await dialog.showMessageBox(parent, { type: existing.length ? 'warning' : 'info', message: `报告较长，将导出 ${files.length} 张连续图片`, detail: `将保存为 ${basename(paths[0])} 至 ${basename(paths.at(-1)!)}。${existing.length ? `\n以下文件已存在，继续将覆盖：\n${existing.map(path => basename(path)).join('\n')}` : ''}`, buttons: ['取消', existing.length ? '覆盖并导出' : '导出图片'], defaultId: existing.length ? 0 : 1, cancelId: 0 })
    if (confirmation.response !== 1) return { saved: false, files: 0 }
  }
  await context?.checkpoint()
  await writeFilesAtomically(files.map((file, index) => ({ path: paths[index], data: file.data })))
  context?.files(paths); context?.progress(1, 1, `已导出 ${files.length} 个文件`)
  return { saved: true, files: files.length }
}
