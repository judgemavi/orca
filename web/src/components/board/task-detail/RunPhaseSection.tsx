import type { Interaction, Task } from '../../../types'
import { isRunLike } from '../../../lib/phases'
import { DiffViewer } from '../../blocks/DiffViewer'

type Props = {
  interaction: Interaction
  task: Task
}

export function RunPhaseSection({ interaction, task }: Props) {
  if (
    !isRunLike(interaction.phase) ||
    interaction.status !== 'completed' ||
    !interaction.diff
  ) {
    return null
  }

  return (
    <DiffViewer
      data={{
        task_id: task.id,
        title: task.title,
        diff: interaction.diff,
        files_changed: [],
        actions: [],
      }}
    />
  )
}
