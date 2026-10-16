export function readWav(data: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const tag = (offset: number, length: number) => String.fromCharCode(...data.subarray(offset, offset + length))
  if (data.length < 12 || tag(0, 4) !== 'RIFF' || tag(8, 4) !== 'WAVE') throw new Error('请选择有效的 WAV 或微信 SILK 语音')
  let format = 0, channels = 0, sampleRate = 0, bits = 0, body: Uint8Array | undefined
  for (let offset = 12; offset + 8 <= data.length;) {
    const size = view.getUint32(offset + 4, true), start = offset + 8
    if (start + size > data.length) throw new Error('WAV 文件不完整')
    if (tag(offset, 4) === 'fmt ' && size >= 16) { format = view.getUint16(start, true); channels = view.getUint16(start + 2, true); sampleRate = view.getUint32(start + 4, true); bits = view.getUint16(start + 14, true) }
    if (tag(offset, 4) === 'data') body = data.subarray(start, start + size)
    offset = start + size + size % 2
  }
  if (!body || ![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 192000 || !((format === 1 && bits === 16) || (format === 3 && bits === 32))) throw new Error('WAV 需为单声道或双声道 PCM16 / Float32')
  const bytes = bits / 8, count = body.length / bytes / channels
  if (!Number.isInteger(count) || count / sampleRate > 600) throw new Error('语音无效或超过 10 分钟，请拆分后转写')
  const input = new DataView(body.buffer, body.byteOffset, body.byteLength), samples = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    let sum = 0
    for (let channel = 0; channel < channels; channel++) { const offset = (i * channels + channel) * bytes; const value = bits === 16 ? input.getInt16(offset, true) / 32768 : input.getFloat32(offset, true); if (!Number.isFinite(value)) throw new Error('音频包含无效采样'); sum += value }
    samples[i] = Math.max(-1, Math.min(1, sum / channels))
  }
  return { samples, sampleRate }
}
export function imageMime(data: Uint8Array): string | undefined {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => data[i] === byte)) return 'image/png'
  const signature = String.fromCharCode(...data.subarray(0, 12))
  if (/^GIF8[79]a/.test(signature)) return 'image/gif'
  if (signature.startsWith('RIFF') && signature.slice(8) === 'WEBP') return 'image/webp'
  return undefined
}
export function decodeLegacyImage(data: Uint8Array): Uint8Array | undefined {
  for (const first of [0xff, 0x89, 0x47, 0x52]) { const key = data[0] ^ first; const probe = data.subarray(0, 12).map(byte => byte ^ key); if (imageMime(probe)) return data.map(byte => byte ^ key) }
  return undefined
}
