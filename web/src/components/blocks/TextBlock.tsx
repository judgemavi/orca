import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  data: { content: string }
}

export function TextBlock({ data }: Props) {
  return (
    <div className="prose prose-invert max-w-none text-sm leading-6 prose-p:my-1 prose-code:rounded prose-code:bg-slate-800 prose-code:px-1 prose-code:py-0.5 prose-code:font-mono prose-code:text-xs prose-a:text-blue-400 hover:prose-a:underline">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.content}</ReactMarkdown>
    </div>
  )
}
