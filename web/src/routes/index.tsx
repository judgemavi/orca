import { BoardView } from '../components/board/BoardView'
import { useAppShellContext } from '../App'

export function BoardRoute() {
  const app = useAppShellContext()

  return (
    <BoardView
      lastWSEvent={app.lastWSEvent}
      autopilotRunning={app.autopilot.running}
      autopilotGoal={app.autopilot.goal}
      autopilotEvents={app.autopilot.events}
      autopilotPendingConfirm={app.autopilot.pendingConfirm}
      onAutopilotStart={app.autopilot.start}
      onAutopilotStop={app.autopilot.stop}
      onAutopilotRespond={app.autopilot.respond}
    />
  )
}
