import { useCallback, useEffect, useState } from 'react'
import { Download, FolderOpen, MessageCircle, RefreshCw, Trash2 } from 'lucide-react'
import { bridge } from '../bridge.js'
import type { ChatSession } from '../../shared/contracts.js'
import type { MediaStatus, WeChatProfile } from '../../shared/workbench.js'

export function ConnectionSettings({ disabled, onSessions, onBusy, notify }: { disabled: boolean; onSessions: (sessions: ChatSession[]) => void; onBusy: (message: string) => void; notify: (message: string) => void }) {
  const [profiles, setProfiles] = useState<WeChatProfile[]>([])
  const [port, setPort] = useState(5031), [token, setToken] = useState(''), [hasToken, setHasToken] = useState(false)
  const [media, setMedia] = useState<MediaStatus | null>(null), [busy, setBusy] = useState(false), [sync, setSync] = useState('')
  const refresh = useCallback(async () => { const [accounts, settings, status] = await Promise.all([bridge.wechatProfiles(), bridge.weflowSettings(), bridge.mediaStatus()]); setProfiles(accounts); setPort(settings.port); setHasToken(settings.hasToken); setMedia(status) }, [])
  useEffect(() => { void refresh().catch(error => notify(error.message)); const off = bridge.onDataChange(event => { if (event.type === 'status') setSync(event.message || '') }); const tasks = bridge.onTasks(() => { void bridge.mediaStatus().then(setMedia).catch(() => {}) }); return () => { off(); tasks() } }, [notify, refresh])
  async function run(action: () => Promise<void>) { setBusy(true); onBusy('正在处理本机连接…'); try { await action(); await refresh() } catch (error) { notify(error instanceof Error ? error.message : '操作失败') } finally { setBusy(false); onBusy('') } }
  const locked = disabled || busy || bridge.platform === 'browser'
  return <>
    <div className="settings-card"><div className="settings-title"><MessageCircle size={21} /><div><h2>微信账号</h2><p>可保存多个本机账号，选择后读取对应的群聊记录。</p></div></div>
      {profiles.length ? profiles.map(profile => <div className="connection-profile" key={profile.id}><div><strong>{profile.name}{profile.active ? ' · 当前使用' : ''}</strong><small>{profile.directory}</small></div><button className="button secondary" disabled={locked || profile.active} onClick={() => { void run(async () => onSessions(await bridge.connectWeChat({ profileId: profile.id }))) }}>切换</button><button className="icon-button danger" title="移除此账号的本机连接资料" aria-label={`移除账号 ${profile.name}`} disabled={locked} onClick={() => { void run(async () => { await bridge.removeWeChatProfile(profile.id); onSessions(await bridge.sessions()); notify('已移除本机连接资料，微信原始记录不受影响') }) }}><Trash2 size={16} /></button></div>) : <p className="fine-print">尚未保存微信连接。</p>}
      <div className="settings-buttons"><button className="button secondary" disabled={locked} onClick={() => { void run(async () => onSessions(await bridge.connectWeChat({ add: true }))) }}><MessageCircle size={16} />添加当前微信账号</button><button className="button subtle" disabled={locked} onClick={() => { void run(async () => onSessions(await bridge.connectWeChat({ add: true, chooseDirectory: true }))) }}><FolderOpen size={16} />选择数据目录</button></div>
    </div>
    <div className="settings-card"><div className="settings-title"><RefreshCw size={21} /><div><h2>连接已有 WeFlow</h2><p>填写 WeFlow HTTP API 的本机端口和访问 Token。此处不是模型 API 设置。</p></div></div>
      <div className="local-settings-fields"><label>本机端口<input type="number" min={1024} max={65535} value={port} disabled={locked} onChange={event => setPort(Number(event.target.value))} /></label><label>WeFlow 访问 Token<input type="password" autoComplete="off" value={token} disabled={locked} placeholder={hasToken ? '已保存，留空继续使用' : '在 WeFlow 的 HTTP API 页面查看'} onChange={event => setToken(event.target.value)} /></label></div>
      <div className="settings-buttons"><button className="button secondary" disabled={locked || (!token.trim() && !hasToken)} onClick={() => { void run(async () => { onSessions(await bridge.connectWeFlow({ port, token: token.trim() || undefined })); setToken(''); notify('WeFlow 已连接，正在接收消息更新') }) }}>保存并连接</button><span className="fine-print" role="status">{sync}</span></div>
    </div>
    <div className="settings-card"><div className="settings-title"><Download size={21} /><div><h2>离线语音转写</h2><p>首次准备语音模型后在本机转写，无需模型 API Key。转写文字可用于日报、周报。</p></div></div>
      <div className="settings-row"><span>语音引擎</span><strong>{media?.engineAvailable ? '已就绪' : '当前构建尚未包含离线语音引擎'}</strong></div><div className="settings-row"><span>语音模型</span><strong>{media?.modelReady ? `已准备 · ${(media.modelBytes / 1048576).toFixed(0)} MB` : '尚未准备'}</strong></div>
      <div className="settings-buttons"><button className="button secondary" disabled={locked || !media?.engineAvailable} onClick={() => { void run(async () => { const id = await bridge.prepareMediaModel('download'); if (id) notify('模型下载已加入任务中心') }) }}><Download size={16} />下载语音模型</button><button className="button subtle" disabled={locked} onClick={() => { void run(async () => { if (await bridge.prepareMediaModel('folder')) notify('已选择本机语音模型') }) }}><FolderOpen size={16} />使用已有模型</button></div><p className="fine-print">在「记录检索」中选择语音消息进行转写。图片只在本机查看，暂不识别图片文字。</p>
    </div>
  </>
}
