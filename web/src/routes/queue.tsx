import { createFileRoute } from '@tanstack/react-router'
import { QueuePanel } from '../components/queue/QueuePanel'

function QueuePage() {
  return (
    <div className="flex flex-1 overflow-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4">
        <QueuePanel />
      </div>
    </div>
  )
}

export const Route = createFileRoute('/queue')({
  component: QueuePage,
})
