import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { QuotaInfo, UserInfo } from '../shared/contracts.js'
import { ServiceError } from './errors.js'

const derive = promisify(scrypt)
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex')
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const key = await derive(password, salt, 64) as Buffer
  return `${salt}:${key.toString('hex')}`
}
export async function verifyPassword(password: string, encoded?: string): Promise<boolean> {
  const [salt, hash] = encoded?.split(':') || ['00000000000000000000000000000000', '0'.repeat(128)]
  const key = await derive(password, salt, 64) as Buffer
  const expected = Buffer.from(hash, 'hex')
  return expected.length === key.length && timingSafeEqual(expected, key) && Boolean(encoded)
}

interface UserRow { id: string; username: string; display_name: string; password_hash: string; daily_limit: number }
export class CloudStore {
  readonly db: DatabaseSync
  constructor(path: string, private defaultLimit = 30, private now: () => number = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL, daily_limit INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invites (
        code_hash TEXT PRIMARY KEY, remaining INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        daily_limit INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), day TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0, error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS requests_user_day ON requests(user_id, day, status);
      CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
    `)
  }
  close(): void { this.db.close() }
  recoverInterrupted(): void { this.db.prepare("UPDATE requests SET status='failed', error_code='SERVER_RESTART' WHERE status='pending'").run() }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  createInvite(options: { uses?: number; days?: number; limit?: number; code?: string } = {}): string {
    const code = options.code || randomBytes(18).toString('base64url')
    this.db.prepare('INSERT INTO invites VALUES (?, ?, ?, ?)').run(tokenHash(code), options.uses ?? 1, this.now() + (options.days ?? 7) * 86400000, options.limit ?? this.defaultLimit)
    return code
  }
  createUser(input: { username: string; displayName: string; passwordHash: string; inviteCode: string }): UserInfo {
    return this.transaction(() => {
      const invite = this.db.prepare('SELECT * FROM invites WHERE code_hash=? AND remaining>0 AND expires_at>?').get(tokenHash(input.inviteCode), this.now()) as { daily_limit: number } | undefined
      if (!invite) throw new ServiceError('INVALID_INVITE', '邀请码无效、已使用或已过期')
      const username = input.username.toLowerCase()
      if (this.userByName(username)) throw new ServiceError('USERNAME_TAKEN', '这个用户名已被使用', 409)
      const id = randomUUID()
      this.db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)').run(id, username, input.displayName, input.passwordHash, invite.daily_limit, this.now())
      this.db.prepare('UPDATE invites SET remaining=remaining-1 WHERE code_hash=?').run(tokenHash(input.inviteCode))
      return { id, username, displayName: input.displayName }
    })
  }
  userByName(username: string): UserRow | undefined { return this.db.prepare('SELECT * FROM users WHERE username=?').get(username.toLowerCase()) as UserRow | undefined }
  createSession(userId: string, days: number): string {
    this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(this.now())
    const token = randomBytes(32).toString('base64url')
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(tokenHash(token), userId, this.now() + days * 86400000)
    return token
  }
  authenticate(token: string): UserInfo | null {
    const row = this.db.prepare('SELECT u.id, u.username, u.display_name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(tokenHash(token), this.now()) as UserRow | undefined
    return row ? { id: row.id, username: row.username, displayName: row.display_name } : null
  }
  revoke(token: string): void { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token)) }
  quota(userId: string): QuotaInfo {
    const day = new Date(this.now()).toISOString().slice(0, 10)
    const user = this.db.prepare('SELECT daily_limit FROM users WHERE id=?').get(userId) as { daily_limit: number } | undefined
    if (!user) throw new ServiceError('UNAUTHORIZED', '请重新登录', 401)
    const counts = this.db.prepare("SELECT status, COUNT(*) AS count FROM requests WHERE user_id=? AND day=? AND status IN ('pending','complete') GROUP BY status").all(userId, day) as unknown as Array<{ status: string; count: number }>
    const used = counts.find(row => row.status === 'complete')?.count ?? 0
    const pending = counts.find(row => row.status === 'pending')?.count ?? 0
    return { limit: user.daily_limit, used, pending, remaining: Math.max(0, user.daily_limit - used - pending), resetsAt: new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString() }
  }
  reserve(userId: string, requestId: string): void {
    this.transaction(() => {
      if (this.db.prepare('SELECT id FROM requests WHERE id=?').get(requestId)) throw new ServiceError('DUPLICATE_REQUEST', '这次请求已经处理，请发起新的分析', 409)
      const active = this.db.prepare("SELECT COUNT(*) AS count FROM requests WHERE user_id=? AND status='pending'").get(userId) as { count: number }
      if (active.count > 0) throw new ServiceError('ANALYSIS_IN_PROGRESS', '已有分析正在进行，请完成或取消后重试', 429)
      const quota = this.quota(userId)
      if (quota.remaining <= 0) throw new ServiceError('QUOTA_EXHAUSTED', '今日分析额度已用完，请在额度重置后继续', 429)
      const day = new Date(this.now()).toISOString().slice(0, 10)
      const attempts = this.db.prepare('SELECT COUNT(*) AS count FROM requests WHERE user_id=? AND day=?').get(userId, day) as { count: number }
      if (attempts.count >= Math.max(20, quota.limit * 4)) throw new ServiceError('RETRY_BUDGET_EXHAUSTED', '今日中断或重试次数较多，请在明日重试或联系服务提供方', 429)
      this.db.prepare("INSERT INTO requests(id,user_id,day,status,created_at) VALUES (?,?,?,'pending',?)").run(requestId, userId, new Date(this.now()).toISOString().slice(0, 10), this.now())
    })
  }
  complete(requestId: string, inputTokens: number, outputTokens: number): void {
    this.db.prepare("UPDATE requests SET status='complete', input_tokens=?, output_tokens=? WHERE id=? AND status='pending'").run(inputTokens, outputTokens, requestId)
  }
  fail(requestId: string, code: string): void {
    this.db.prepare("UPDATE requests SET status='failed', error_code=? WHERE id=? AND status='pending'").run(code, requestId)
  }
}
