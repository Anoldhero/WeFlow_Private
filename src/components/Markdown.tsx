import ReactMarkdown from 'react-markdown'

export function Markdown({ text, onReference }: { text: string; onReference?: (id: string) => void }) {
  const content = text.replace(/(?<!!)\[(M\d+)\](?!\()/g, (_match, id: string) => `[${id}](#evidence-${id})`)
  return <div className="markdown"><ReactMarkdown skipHtml components={{
    img: () => null,
    a: ({ href, children }) => href?.startsWith('#evidence-')
      ? onReference ? <button className="citation" onClick={() => onReference(href.slice('#evidence-'.length))} title="查看原始消息">{children}</button> : <span className="citation">{children}</span>
      : <a href={href?.startsWith('https://') || href?.startsWith('http://') ? href : undefined} target="_blank" rel="noreferrer">{children}</a>
  }}>{content}</ReactMarkdown></div>
}
