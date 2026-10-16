const message = '服务地址必须使用 HTTPS，本机开发可使用 HTTP 回环地址，且不能包含账号、密码、查询参数或片段'

export function isLoopback(hostname) {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || /^127\./.test(hostname) || hostname === '[::1]'
}

export function validateServiceUrl(value, allowLoopbackHttp = false) {
  let url
  try { url = new URL(value) } catch { throw new Error(message) }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(allowLoopbackHttp && isLoopback(url.hostname) && url.protocol === 'http:'))) throw new Error(message)
  return url
}

export function validateClientConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['url', 'preview'].includes(key)) || typeof value.url !== 'string' || typeof value.preview !== 'boolean') throw new Error('客户端配置只允许公开服务地址与预览标记')
  const url = validateServiceUrl(value.url, value.preview)
  if (['0.0.0.0', '[::]'].includes(url.hostname) || (!value.preview && isLoopback(url.hostname))) throw new Error('正式客户端需要可访问的 HTTPS 云端服务地址，不能指向本机')
  return { url: url.href.replace(/\/+$/, ''), preview: value.preview }
}
