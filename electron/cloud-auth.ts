import { createHash } from 'node:crypto'
import type { AccountInfo } from '../shared/contracts.js'

interface SecretStore { secret<T>(name: string): T | null; setSecret(name: string, value: unknown): void }
interface StoredAuth { token: string; account: AccountInfo }

export class CloudAuthStore {
  private key: string
  constructor(private vault: SecretStore, endpoint: string) {
    this.key = `cloud-auth:${createHash('sha256').update(endpoint.replace(/\/+$/, '')).digest('hex')}`
  }
  read(): StoredAuth | null {
    const value = this.vault.secret<StoredAuth>(this.key)
    return typeof value?.token === 'string' && typeof value.account?.user?.id === 'string' && value.account.quota ? value : null
  }
  save(token: string | null, account: AccountInfo): AccountInfo {
    if (!token) throw new Error('云端登录信息不完整')
    this.vault.setSecret(this.key, { token, account: { user: account.user, quota: account.quota } })
    return account
  }
  clear(): void { this.vault.setSecret(this.key, null) }
  offline(): AccountInfo | null {
    const saved = this.read()
    return saved ? { ...saved.account, offline: true, quota: { ...saved.account.quota, remaining: 0 } } : null
  }
}
