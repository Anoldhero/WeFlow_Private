import { app, BrowserWindow, nativeImage } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { demoGroupReport, reportStyles } from '../shared/group-report.js'
import { renderReportFiles } from '../electron/report-export.js'

const cache = resolve('.cache/report-export-check')
if (process.argv.includes('--software-rendering')) app.disableHardwareAcceleration()
app.on('child-process-gone', (_event, details) => console.error('Export process failure:', { type: details.type, reason: details.reason, exitCode: details.exitCode }))
mkdirSync(cache, { recursive: true })
const userData = join(cache, 'user-data')
mkdirSync(userData, { recursive: true })
app.setPath('userData', userData)

async function check() {
  await app.whenReady()
  if (process.argv.includes('--engine-check')) {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    try { await window.loadURL('data:text/html;charset=utf-8,<p>Export engine check</p>'); console.log('Export engine ready') }
    finally { window.destroy() }
    return
  }
  const output = resolve('output/report-examples')
  const pdfOutput = resolve('output/pdf')
  mkdirSync(output, { recursive: true }); mkdirSync(pdfOutput, { recursive: true })
  const results: Array<{ style: string; format: string; files: number; bytes: number; sizes?: Array<{ width: number; height: number }> }> = []
  for (const style of reportStyles) {
    const report = demoGroupReport({ kind: 'weekly', date: '2026-08-31' })
    report.title = '行业交流社群 · 本周精选'
    report.template.style = style
    for (const format of ['png', 'pdf'] as const) {
      const files = await renderReportFiles(report, format)
      assert.ok(files.length > 0)
      const sizes = []
      for (const file of files) {
        assert.ok(file.data.byteLength > 1000)
        if (format === 'png') { const size = nativeImage.createFromBuffer(file.data).getSize(); assert.equal(size.width, 720); assert.ok(size.height > 0 && size.height <= 6000); sizes.push(size) }
        else assert.equal(file.data.subarray(0, 5).toString(), '%PDF-')
        const directory = style === 'cards' ? format === 'pdf' ? pdfOutput : output : cache
        writeFileSync(join(directory, `community-weekly-${style}${file.suffix}.${format}`), file.data)
      }
      results.push({ style, format, files: files.length, bytes: files.reduce((sum, file) => sum + file.data.length, 0), ...(sizes.length ? { sizes } : {}) })
    }
  }
  const long = demoGroupReport({ kind: 'weekly', date: '2026-08-31' })
  long.template.showSources = true
  long.sections.forEach(section => { section.items = Array.from({ length: 5 }, (_, index) => ({ ...section.items[0], title: `分段验收 ${index + 1}`, text: `${section.items[0].text}\n${section.items[0].text}` })) })
  const split = await renderReportFiles(long, 'png')
  assert.ok(split.length > 1)
  for (const file of split) { assert.match(file.suffix, /^-\d{2}$/); assert.ok(nativeImage.createFromBuffer(file.data).getSize().height <= 6000); writeFileSync(join(cache, `split-check${file.suffix}.png`), file.data) }
  results.push({ style: 'long-split', format: 'png', files: split.length, bytes: split.reduce((sum, file) => sum + file.data.length, 0) })
  writeFileSync(join(cache, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ passed: true, results }, null, 2))
}

void check().then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
