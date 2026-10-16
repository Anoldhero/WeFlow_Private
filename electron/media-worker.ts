import { parentPort, workerData } from 'node:worker_threads'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { readWav, imageMime, decodeLegacyImage } from '../shared/audio.js'

async function main() {
  if (workerData.kind === 'image') {
    const input = readFileSync(workerData.file)
    let data: Uint8Array | undefined = imageMime(input) ? input : decodeLegacyImage(input)
    if (!data && workerData.keys) {
      const addon = require(workerData.addon)
      data = addon.decryptDatNative(workerData.file, workerData.keys.xorKey, workerData.keys.aesKey).data
    }
    const mime = data && imageMime(data)
    if (!data || !mime) throw new Error('图片未能解码，请在微信中加载原图后重试，或选择另存的 PNG/JPEG 图片')
    if (data.length > 20 * 1024 * 1024) throw new Error('解密后的图片超过 20 MB')
    parentPort?.postMessage({ result: { image: `data:${mime};base64,${Buffer.from(data).toString('base64')}`, cached: false } })
    return
  }
  const platform = process.platform === 'win32' ? 'win' : process.platform
  const pkg = `sherpa-onnx-${platform}-${process.arch}`
  const directories = [join(workerData.appPath, 'node_modules', pkg), join(workerData.resources, 'app.asar.unpacked/node_modules', pkg)]
  try { directories.push(dirname(require.resolve(`${pkg}/package.json`))) } catch {}
  process.env.PATH = [...directories.filter(existsSync), process.env.PATH || ''].join(process.platform === 'win32' ? ';' : ':')
  let audio: ReturnType<typeof readWav>
  const bytes = Buffer.from(workerData.audio)
  if (bytes.toString('ascii', 0, 4) === 'RIFF') audio = readWav(bytes)
  else {
    if (!bytes.subarray(0, 16).toString('ascii').includes('#!SILK_V3')) throw new Error('仅支持 WAV 或微信 SILK 格式')
    const silk = require('silk-wasm')
    const decoded = await silk.decode(bytes, 24000)
    const pcm = Buffer.from(decoded.data)
    if (pcm.length % 2 || pcm.length > 24000 * 2 * 600) throw new Error('语音无效或超过 10 分钟')
    const samples = new Float32Array(pcm.length / 2)
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768
    audio = { sampleRate: 24000, samples }
  }
  const sherpa = require('sherpa-onnx-node')
  const recognizer = new sherpa.OfflineRecognizer({ modelConfig: { senseVoice: { model: workerData.modelPath, useInverseTextNormalization: 1 }, tokens: workerData.tokensPath, numThreads: 2, debug: 0 } })
  const stream = recognizer.createStream()
  stream.acceptWaveform(audio); recognizer.decode(stream)
  const text = String(recognizer.getResult(stream).text || '').replace(/<\|[^|]+\|>/g, '').replace(/\s+/g, ' ').trim()
  if (!text) throw new Error('没有识别到可读语音内容')
  parentPort?.postMessage({ result: { text, cached: false } })
}
void main().catch(error => parentPort?.postMessage({ error: error instanceof Error ? error.message : '本地媒体处理失败' }))
