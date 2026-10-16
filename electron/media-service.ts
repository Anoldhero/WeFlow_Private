import { app, dialog, type BrowserWindow } from 'electron'
import { existsSync, statSync, realpathSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { imageMime, decodeLegacyImage } from '../shared/audio.js'
import type { MediaRequest, MediaResult, MediaStatus } from '../shared/workbench.js'
import type { DataSource } from './data-source.js'
import type { LocalVault } from './vault.js'
import type { TaskContext, TaskManager } from './task-manager.js'

const modelFiles = ['model.int8.onnx', 'tokens.txt'] as const
const modelBase = 'https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master/'
export class MediaService {
  constructor(private source: DataSource, private vault: LocalVault, private tasks: TaskManager, private window: () => BrowserWindow, private resources: string) {}
  status(): MediaStatus {
    const modelDirectory = this.vault.secret<string>('speechModelDirectory') || join(app.getPath('userData'), 'models/sensevoice')
    const files = modelFiles.map(name => join(modelDirectory, name))
    const modelReady = files.every(file => existsSync(file) && statSync(file).isFile() && statSync(file).size > 100)
    let engineAvailable = false
    try { require.resolve('sherpa-onnx-node'); require.resolve('silk-wasm'); engineAvailable = existsSync(join(app.getAppPath(), 'node_modules/sherpa-onnx-win-x64/package.json')) || existsSync(join(process.resourcesPath, 'app.asar.unpacked/node_modules/sherpa-onnx-win-x64/package.json')) } catch {}
    return { modelReady, modelBytes: modelReady ? files.reduce((sum, file) => sum + statSync(file).size, 0) : 0, modelDirectory, engineAvailable }
  }
  async prepare(mode: 'download' | 'folder'): Promise<string | null> {
    if (mode === 'folder') {
      const choice = await dialog.showOpenDialog(this.window(), { title: '选择包含 model.int8.onnx 和 tokens.txt 的 SenseVoice 目录', properties: ['openDirectory'] })
      if (choice.canceled || !choice.filePaths[0]) return null
      const directory = choice.filePaths[0]
      if (!modelFiles.every(name => existsSync(join(directory, name)) && statSync(join(directory, name)).size > 100)) throw new Error('目录缺少有效的 model.int8.onnx 或 tokens.txt')
      this.vault.setSecret('speechModelDirectory', directory)
      return 'selected'
    }
    if (!this.status().engineAvailable) throw new Error('当前构建缺少离线语音引擎，请先安装项目依赖后再准备模型')
    const task = this.tasks.enqueue({ title: '下载离线语音模型', kind: 'model', canPause: false }, async context => {
      const directory = join(app.getPath('userData'), 'models', `sensevoice-${randomUUID()}`)
      await mkdir(directory, { recursive: true })
      try {
        for (const [index, name] of modelFiles.entries()) {
          const response = await fetch(`${modelBase}${name}`, { signal: AbortSignal.any([context.signal, AbortSignal.timeout(30 * 60 * 1000)]) })
          if (!response.ok || !response.body || /text\/html/i.test(response.headers.get('content-type') || '')) throw new Error(`模型下载失败（HTTP ${response.status}）`)
          const maximum = name.endsWith('.onnx') ? 500 * 1024 * 1024 : 5 * 1024 * 1024
          const expected = Number(response.headers.get('content-length'))
          if (expected > maximum) throw new Error('模型文件超出预期大小')
          const temporary = join(directory, `${name}.part`), file = await open(temporary, 'wx')
          const reader = response.body.getReader()
          let received = 0
          try {
            while (true) {
              context.signal.throwIfAborted()
              const chunk = await reader.read(); if (chunk.done) break
              received += chunk.value.length
              if (received > maximum) throw new Error('模型文件超出预期大小')
              await file.write(chunk.value)
              context.progress(received, expected || received + 1, `下载${index ? '词表' : '语音模型'} · ${(received / 1048576).toFixed(1)} MB`)
            }
            if (received < 100 || (expected && received !== expected)) throw new Error('模型文件下载不完整')
          } finally { await file.close(); await reader.cancel().catch(() => {}); reader.releaseLock() }
          await rename(temporary, join(directory, name))
        }
        this.vault.setSecret('speechModelDirectory', directory); context.progress(1, 1, '离线语音模型已就绪')
      } catch (error) { await Promise.all(modelFiles.flatMap(name => [name, `${name}.part`]).map(name => rm(join(directory, name), { force: true }))); throw error }
    })
    return task.id
  }
  private worker(parameters: Record<string, unknown>, context: TaskContext): Promise<MediaResult> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(join(__dirname, 'media-worker.cjs'), { workerData: { ...parameters, appPath: app.getAppPath(), resources: process.resourcesPath } })
      let settled = false
      const finish = (error?: Error, result?: MediaResult) => { if (settled) return; settled = true; clearTimeout(timer); context.signal.removeEventListener('abort', abort); void worker.terminate(); if (error) reject(error); else resolve(result!) }
      const abort = () => finish(new Error('任务已取消'))
      const timer = setTimeout(() => finish(new Error('本地媒体处理超时，请缩短语音或重试')), 10 * 60 * 1000)
      context.signal.addEventListener('abort', abort, { once: true })
      if (context.signal.aborted) { abort(); return }
      worker.on('message', (message: { result?: MediaResult; error?: string }) => finish(message.error ? new Error(message.error) : undefined, message.result))
      worker.on('error', error => finish(error)); worker.on('exit', code => { if (!settled) finish(new Error(`本地媒体引擎提前退出（${code}）`)) })
    })
  }
  async process(request: MediaRequest): Promise<MediaResult> {
    const message = await this.source.findMessage(request.sessionId, request.messageId)
    if ((request.action === 'transcribe' && message.type !== 'voice') || (request.action === 'image' && message.type !== 'image')) throw new Error('消息类型与操作不匹配')
    if (request.action === 'transcribe' && !request.chooseFile && message.transcript) return { text: message.transcript, cached: true }
    const model = this.status()
    if (request.action === 'transcribe' && (!model.engineAvailable || !model.modelReady)) throw new Error('请先在设置中准备离线语音引擎和模型')
    let file: string | undefined
    if (request.chooseFile || this.source.status().source !== 'wechat') {
      const choice = await dialog.showOpenDialog(this.window(), { title: request.action === 'transcribe' ? '选择这条消息对应的 WAV / SILK 语音' : '选择这条消息对应的图片', properties: ['openFile'], filters: [{ name: '本地媒体', extensions: request.action === 'transcribe' ? ['wav', 'silk'] : ['dat', 'png', 'jpg', 'jpeg', 'webp', 'gif'] }] })
      if (choice.canceled || !choice.filePaths[0]) throw new Error('已取消选择')
      file = choice.filePaths[0]
    } else if (request.action === 'image' && message.imageMd5) {
      const paths = await this.source.imagePaths(message.imageMd5) as { full_path?: string }
      const directory = this.source.connection()!.accountDir
      if (paths.full_path && existsSync(paths.full_path)) {
        const path = realpathSync(paths.full_path), rel = relative(realpathSync(directory), path)
        if (!rel.startsWith('..') && !isAbsolute(rel)) file = path
      }
      if (!file) throw new Error('未找到本机图片，可选择已保存的原图')
    } else if (request.action === 'image') throw new Error('这条消息没有图片定位信息，请选择本机图片文件')
    if (file && (!statSync(file).isFile() || statSync(file).size > 20 * 1024 * 1024)) throw new Error('请选择小于 20 MB 的媒体文件')
    const sourceId = this.source.identity()
    const task = this.tasks.enqueue({ title: request.action === 'transcribe' ? `语音转写 · ${message.sender}` : '读取本机图片', kind: 'media', canPause: false }, async context => {
      if (sourceId !== this.source.identity()) throw new Error('数据来源已变化，请重新选择消息')
      context.progress(0, 1, request.action === 'transcribe' ? '正在本机识别语音…' : '正在本机解码图片…')
      let result: MediaResult
      if (request.action === 'transcribe') {
        const audio = file ? await readFile(file) : await this.source.voice(request.sessionId, message)
        result = await this.worker({ kind: 'voice', audio, modelPath: join(model.modelDirectory, modelFiles[0]), tokensPath: join(model.modelDirectory, modelFiles[1]) }, context)
        context.signal.throwIfAborted()
        this.source.saveTranscript(request.sessionId, request.messageId, result.text!)
      } else {
        const bytes = await readFile(file!)
        const keys = !imageMime(bytes) && !decodeLegacyImage(bytes) ? await this.source.imageKeys() : undefined
        result = await this.worker({ kind: 'image', file, keys, addon: join(this.resources, 'weflow-image-native-win32-x64.node') }, context)
      }
      context.progress(1, 1, request.action === 'transcribe' ? '转写已保存，可用于本期报告' : '图片已解码'); return result
    })
    return task.done
  }
}
