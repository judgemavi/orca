import type { Interaction, Task } from '../../../types'
import { INTERACTION_STATUSES, isRunLike } from '@orca/types'
import { DiffViewer } from '../../blocks/DiffViewer'

type Props = {
  interaction: Interaction
  task: Task
}

export function RunPhaseSection({ interaction, task }: Props) {
  if (
    !isRunLike(interaction.phase) ||
    interaction.status !== INTERACTION_STATUSES.completed ||
    !interaction.diff
  ) {
    return null
  }

  return (
    <DiffViewer
      data={{
        taskId: task.id,
        title: task.title,
        diff: interaction.diff,
        filesChanged: [],
        actions: [],
      }}
    />
  )
}
