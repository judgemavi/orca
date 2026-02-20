import type { CommandHelp } from '../../types'

interface Props {
  data: { commands: CommandHelp[] }
}

export function HelpBlock({ data }: Props) {
  const commands = data?.commands ?? []

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-slate-700 bg-slate-900 p-4">
      <div className="text-sm font-semibold">Available Commands</div>
      <table className="w-full text-[13px]">
        <tbody>
          {commands.map((cmd) => (
            <tr key={cmd.command}>
              <td className="whitespace-nowrap py-1 pr-4 font-mono font-semibold text-blue-400">
                {cmd.command}
              </td>
              <td className="py-1 text-slate-400">{cmd.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
