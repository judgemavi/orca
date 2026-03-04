import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

export function DialogChrome({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
      <Dialog.Title className="text-sm font-semibold text-foreground">
        {title}
      </Dialog.Title>
      <Dialog.Close
        aria-label="Close"
        className="btn-icon btn-destructive rounded-full p-0.5"
      >
        <X size={12} />
      </Dialog.Close>
    </div>
  );
}
