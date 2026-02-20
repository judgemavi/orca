import { useState, useRef, type KeyboardEvent } from 'react'
import { Send } from 'lucide-react'

interface Props {
  onSend: (text: string) => void
  disabled?: boolean
}

export function ChatInput({ onSend, disabled }: Props) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = () => {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = () => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 150) + 'px'
    }
  }

  return (
    <div className="flex items-end gap-2 border-t border-slate-700 bg-slate-900 p-4">
      <textarea
        ref={textareaRef}
        className="min-h-10 max-h-37.5 flex-1 resize-none rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-400 focus:border-blue-500 disabled:opacity-50"
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          handleInput()
        }}
        onKeyDown={handleKeyDown}
        placeholder="Type a command or describe what you want to build..."
        disabled={disabled}
        rows={1}
      />
      <button
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white transition hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
        onClick={handleSend}
        disabled={disabled || !value.trim()}
        type="button"
      >
        <Send size={16} />
      </button>
    </div>
  )
}
