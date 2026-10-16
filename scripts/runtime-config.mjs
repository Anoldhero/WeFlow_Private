import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as util from 'node:util'
import { validateClientConfig } from '../shared/service-url.mjs'

export function assertNode24() {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('知聊开发与云端服务需要 Node.js 24，请先切换 Node 版本')
}
export function readEnvFile(file) { return existsSync(file) ? util.parseEnv(readFileSync(file, 'utf8')) : {} }
export function publicClientUrl(root = process.cwd(), env = process.env) {
  const config = readEnvFile(resolve(root, '.env.client'))
  if (Object.keys(config).some(key => key !== 'CLOUD_API_URL')) throw new Error('.env.client 只允许 CLOUD_API_URL；模型凭据请放在服务端 .env')
  return env.CLOUD_API_URL || config.CLOUD_API_URL || ''
}
export function clientEnvironment(env, endpoint, webUrl, directory) {
  const result = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:LLM_|AI_PROVIDER$|DATABASE_PATH$|DAILY_REQUEST_LIMIT$|SESSION_TTL_DAYS$|TRUSTED_PROXY_CIDRS$|REPORT_MAX_OUTPUT_TOKENS$|ELECTRON_RUN_AS_NODE$|NODE_ENV$|HOST$|PORT$)/i.test(key)))
  return { ...result, NODE_ENV: 'development', CLOUD_API_URL: endpoint, VITE_DEV_SERVER_URL: webUrl, ZHILIAO_DESKTOP_DATA: directory }
}
export function resolveDevOptions(args, env = process.env, root = process.cwd()) {
  const options = { demo: false, desktop: false, cloud: false, cloudUrl: '', webPort: 5178, apiPort: 4310 }
  for (let i = 0; i < args.length; i++) {
    const name = args[i]
    if (name === '--') continue
    if (['--demo', '--desktop', '--cloud'].includes(name)) options[name.slice(2)] = true
    else if (['--cloud-url', '--web-port', '--api-port'].includes(name)) {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`${name} 后需要参数`)
      if (name === '--cloud-url') { options.cloudUrl = value; options.cloud = true }
      else { const port = Number(value); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`${name} 必须为 1024–65535 的端口`); options[name === '--web-port' ? 'webPort' : 'apiPort'] = port }
    } else throw new Error('未知启动参数，请使用 --demo、--desktop、--cloud、--cloud-url、--web-port 或 --api-port')
  }
  if (options.demo && options.cloud) throw new Error('--demo 与 --cloud 不能同时使用')
  const endpoint = options.cloud ? options.cloudUrl || publicClientUrl(root, env) : `http://127.0.0.1:${options.apiPort}`
  if (!endpoint) throw new Error('请在 .env.client 配置 CLOUD_API_URL，或传入 --cloud-url')
  return { ...options, endpoint: validateClientConfig({ url: endpoint, preview: true }).url, webUrl: `http://127.0.0.1:${options.webPort}`, mode: options.cloud ? 'cloud' : options.demo ? 'demo' : 'local' }
}
