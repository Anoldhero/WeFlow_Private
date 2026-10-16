import { useState, type FormEvent } from 'react'
import { ArrowRight, LoaderCircle, ShieldCheck } from 'lucide-react'
import { bridge } from '../bridge.js'
import { Modal } from './Modal.js'
import { DEMO_LOGIN } from '../../shared/demo.js'
import type { AccountInfo } from '../../shared/contracts.js'

export function AuthModal({ demo, onSuccess, onClose }: { demo: boolean; onSuccess: (account: AccountInfo) => void; onClose: () => void }) {
  const [register, setRegister] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const login = async (useDemo = false) => {
    setBusy(true); setError('')
    try {
      if (!useDemo && !/^[a-zA-Z0-9_-]{3,32}$/.test(username)) throw new Error('用户名需为 3–32 位字母、数字、下划线或短横线')
      if (!useDemo && password.length < 10) throw new Error('密码至少需要 10 个字符')
      const account = useDemo ? await bridge.login(DEMO_LOGIN) : register ? await bridge.register({ username, password, displayName, inviteCode }) : await bridge.login({ username, password })
      onSuccess(account)
    } catch (error) { setError(error instanceof Error ? error.message : '暂时无法登录') } finally { setBusy(false) }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void login() }
  return <Modal title={register ? '创建知聊账号' : '欢迎回到知聊'} onClose={onClose}>
    <p className="modal-intro">一个账号，直接使用云端 AI。模型服务由我们统一提供。</p>
    <form onSubmit={submit} className="auth-form">
      <label>用户名<input data-autofocus autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} placeholder="字母、数字或下划线" minLength={3} maxLength={32} required disabled={busy} /></label>
      {register && <label>显示名称<input value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={32} placeholder="怎么称呼你" required disabled={busy} /></label>}
      <label>密码<input type="password" autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} minLength={10} maxLength={128} placeholder="至少 10 个字符" required disabled={busy} /></label>
      {register && <label>邀请码<input value={inviteCode} onChange={event => setInviteCode(event.target.value)} minLength={8} maxLength={128} placeholder="由服务提供方发放" required disabled={busy} /></label>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      <button className="button primary full" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}{register ? '创建账号并登录' : '登录账号'}</button>
    </form>
    <div className="auth-switch">{register ? '已经有账号？' : '第一次使用？'} <button className="text-button" disabled={busy} onClick={() => { setRegister(!register); setError('') }}>{register ? '直接登录' : '使用邀请码注册'}</button></div>
    {demo && <button className="button secondary full" disabled={busy} onClick={() => { void login(true) }}>以演示账号体验</button>}
    <p className="fine-print"><ShieldCheck size={14} />登录后仍由你选择每次分析发送的内容。</p>
  </Modal>
}
