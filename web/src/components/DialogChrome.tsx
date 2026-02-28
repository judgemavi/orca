import { DialogClose } from '@tiny-bits/react-dialog'
import { X } from 'lucide-react'

export function DialogChrome({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
      <span className="text-sm font-semibold text-foreground">{title}</span>
      <DialogClose
        aria-label="Close"
        className="btn-icon btn-destructive rounded-full p-0.5"
        type="button"
      >
        <X size={12} />
      </DialogClose>
    </div>
  )
}
