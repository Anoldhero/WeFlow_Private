import { CloudStore } from './store.js'
import { readConfig } from './config.js'

const config = readConfig()
const args = process.argv.slice(2)
const option = (name: string, fallback: number, max: number) => {
  const index = args.indexOf(name)
  const value = index < 0 ? fallback : Number(args[index + 1])
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} 参数无效`)
  return value
}
const store = new CloudStore(config.databasePath, config.dailyLimit)
try {
  const uses = option('--uses', 1, 10000)
  const days = option('--days', 7, 365)
  const limit = option('--limit', config.dailyLimit, 10000)
  const code = store.createInvite({ uses, days, limit })
  console.log(`邀请码：${code}\n可注册 ${uses} 个账号，有效期 ${days} 天，每个账号每日 ${limit} 次分析。`)
} finally { store.close() }
