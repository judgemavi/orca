import { TerminalPane } from './TerminalPane';

interface Props {
  theme: 'light' | 'dark';
}

export function OrchestratorSidebar({ theme }: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TerminalPane className="flex-1 min-h-0" theme={theme} />
    </div>
  );
}
