import { Modal } from './Modal.js'
import type { prepareAnalysis } from '../../shared/data.js'

export function ContextPreview({ context, anonymize, onClose }: { context: ReturnType<typeof prepareAnalysis>; anonymize: boolean; onClose: () => void }) {
  return <Modal title="确认本次发送的内容" wide onClose={onClose}>
    <p className="modal-intro">下方展示实际发送给云端的文本。共 {context.input.messages.length} 条消息；{anonymize ? '已替换昵称及常见联系方式。' : '保留原始昵称和文本。'}{context.shortened > 0 && `有 ${context.shortened} 条长消息已截短。`}</p>
    <div className="context-preview">
      {context.input.question && <article><header><strong>本次问题</strong></header><p>{context.input.question}</p></article>}
      {context.input.messages.map(message => <article key={message.id}>
        <header><span>{message.id}</span><strong>{message.sender}</strong><time>{message.timestamp ? new Date(message.timestamp * 1000).toLocaleString('zh-CN') : '时间未知'}</time></header>
        <p>{message.text}</p>
      </article>)}
    </div>
    <div className="modal-footer"><button className="button primary" onClick={onClose}>已查看，返回工作台</button></div>
  </Modal>
}
