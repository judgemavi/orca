import type { ChatMessage as ChatMessageType, Block } from '../../types'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { TextBlock } from '../blocks/TextBlock'
import { TaskCard } from '../blocks/TaskCard'
import { TaskList } from '../blocks/TaskList'
import { PlanProposal } from '../blocks/PlanProposal'
import { SprintProgress } from '../blocks/SprintProgress'
import { SprintResult } from '../blocks/SprintResult'
import { DiffViewer } from '../blocks/DiffViewer'
import { ReviewResult } from '../blocks/ReviewResult'
import { CostCard } from '../blocks/CostCard'
import { StatusCard } from '../blocks/StatusCard'
import { EscalationBlock } from '../blocks/EscalationBlock'
import { IntegrateResult } from '../blocks/IntegrateResult'
import { HelpBlock } from '../blocks/HelpBlock'

interface Props {
  message: ChatMessageType
  onAction?: (action: string) => void
  sessionId: string
  actionedPlanProposals: Set<string>
  onPlanProposalActioned: (proposalId: string) => void
}

function BlockRenderer({
  block,
  onAction,
  sessionId,
  proposalIdFallback,
  actionedPlanProposals,
  onPlanProposalActioned,
}: {
  block: Block
  onAction?: (a: string) => void
  sessionId: string
  proposalIdFallback: string
  actionedPlanProposals: Set<string>
  onPlanProposalActioned: (proposalId: string) => void
}) {
  switch (block.type) {
    case 'text':
      return <TextBlock data={block.data} />
    case 'task_card':
      return <TaskCard data={block.data} onAction={onAction} />
    case 'task_list':
      return <TaskList data={block.data} onAction={onAction} />
    case 'plan_proposal': {
      const proposalId = block.data.proposal_id ?? proposalIdFallback
      return (
        <PlanProposal
          data={block.data}
          sessionId={block.data.session_id ?? sessionId}
          proposalId={proposalId}
          actioned={actionedPlanProposals.has(proposalId)}
          onActioned={onPlanProposalActioned}
        />
      )
    }
    case 'sprint_progress':
      return <SprintProgress data={block.data} />
    case 'sprint_result':
      return <SprintResult data={block.data} onAction={onAction} />
    case 'diff_viewer':
      return <DiffViewer data={block.data} onAction={onAction} />
    case 'review_result':
      return <ReviewResult data={block.data} onAction={onAction} />
    case 'cost_card':
      return <CostCard data={block.data} />
    case 'status_card':
      return <StatusCard data={block.data} onAction={onAction} />
    case 'escalation':
      return <EscalationBlock data={block.data} onAction={onAction} />
    case 'integrate_result':
      return <IntegrateResult data={block.data} />
    case 'help':
      return <HelpBlock data={block.data} />
    default:
      return null
  }
}

export function ChatMessage({
  message,
  onAction,
  sessionId,
  actionedPlanProposals,
  onPlanProposalActioned,
}: Props) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end py-1">
        <div className="max-w-[70%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-blue-600 px-3.5 py-2 text-sm text-white">
          {message.content}
        </div>
      </div>
    )
  }

  return (
    <div className="flex py-1">
      <div className="flex min-w-[300px] max-w-[85%] flex-col gap-2">
        {message.blocks?.map((block, i) => (
          <BlockRenderer
            key={i}
            block={block}
            onAction={onAction}
            sessionId={sessionId}
            proposalIdFallback={`${message.id}:${i}`}
            actionedPlanProposals={actionedPlanProposals}
            onPlanProposalActioned={onPlanProposalActioned}
          />
        ))}
        {!message.blocks?.length && message.content && (
          <div className="prose prose-invert max-w-none text-sm leading-6 prose-p:my-1">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}
