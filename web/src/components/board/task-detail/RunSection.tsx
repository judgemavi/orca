import { INTERACTION_STATUSES } from '@orca/server/types';
import type { Interaction, Task } from '../../../types';
import { DiffViewer } from '../../blocks/DiffViewer';

type Props = {
  interaction: Interaction;
  task: Task;
};

export function RunSection({ interaction, task }: Props) {
  if (
    !(interaction.type === 'run' || interaction.type === 'revise') ||
    interaction.status !== INTERACTION_STATUSES.completed ||
    !interaction.diff
  ) {
    return null;
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
  );
}
