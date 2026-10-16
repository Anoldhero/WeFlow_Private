import { resolve } from 'node:path'
import { isIP } from 'node:net'
import { validateServiceUrl } from '../shared/service-url.mjs'
export { validateServiceUrl } from '../shared/service-url.mjs'

export interface ServerConfig {
  production: boolean
  host: string
  port: number
  databasePath: string
  provider: 'compatible' | 'demo'
  baseUrl: string
  apiKey: string
  model: string
  protocol: 'chat-completions' | 'responses'
  tokenField: 'max_completion_tokens' | 'max_tokens'
  maxOutputTokens: number
  reportMaxOutputTokens: number
  trustedProxies: string[]
  timeoutMs: number
  dailyLimit: number
  sessionTtlDays: number
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name])
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min}–${max} 之间的整数`)
    return value
  }
  const production = env.NODE_ENV === 'production'
  const provider = env.AI_PROVIDER === 'demo' ? 'demo' : 'compatible'
  if (production && provider === 'demo') throw new Error('生产环境禁止启用演示模型')
  const baseUrl = (env.LLM_BASE_URL || '').replace(/\/+$/, '')
  if (baseUrl) validateServiceUrl(baseUrl, !production)
  const apiKey = env.LLM_API_KEY || ''
  const model = env.LLM_MODEL || ''
  const trustedProxies = (env.TRUSTED_PROXY_CIDRS || '').split(',').map(value => value.trim()).filter(Boolean)
  for (const entry of trustedProxies) {
    const [address, prefix, extra] = entry.split('/')
    const version = isIP(address)
    if (!version || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (version === 4 ? 32 : 128)))) throw new Error('TRUSTED_PROXY_CIDRS 仅允许明确的代理 IP 或 CIDR，不能信任所有来源')
  }
  if (production && (!baseUrl || !apiKey || !model)) throw new Error('生产环境必须配置 LLM_BASE_URL、LLM_API_KEY 和 LLM_MODEL')
  return {
    production,
    host: env.HOST || '127.0.0.1',
    port: integer('PORT', 4310, 1, 65535),
    databasePath: resolve(env.DATABASE_PATH || './data/cloud.sqlite'),
    provider,
    baseUrl,
    apiKey,
    model,
    protocol: env.LLM_PROTOCOL === 'responses' || (!env.LLM_PROTOCOL && baseUrl && new URL(baseUrl).hostname === 'api.openai.com') ? 'responses' : 'chat-completions',
    tokenField: env.LLM_TOKEN_FIELD === 'max_tokens' ? 'max_tokens' : 'max_completion_tokens',
    maxOutputTokens: integer('LLM_MAX_OUTPUT_TOKENS', 1800, 64, 8192),
    reportMaxOutputTokens: integer('REPORT_MAX_OUTPUT_TOKENS', 8192, 512, 16384),
    trustedProxies,
    timeoutMs: integer('LLM_TIMEOUT_MS', 90000, 1000, 180000),
    dailyLimit: integer('DAILY_REQUEST_LIMIT', 30, 1, 10000),
    sessionTtlDays: integer('SESSION_TTL_DAYS', 7, 1, 30)
  }
}
