interface ToolModelOption {
  id: string
  name: string
}

interface Props {
  tools: string[]
  selectedTool: string
  selectedModel: string
  models: ToolModelOption[]
  modelsFetching: boolean
  disabled?: boolean
  onToolChange: (tool: string) => void
  onModelChange: (model: string) => void
  controlClass: string
  toolPlaceholder?: string
  modelPlaceholder?: string
  className?: string
}

export function ToolModelSelector({
  tools,
  selectedTool,
  selectedModel,
  models,
  modelsFetching,
  disabled = false,
  onToolChange,
  onModelChange,
  controlClass,
  toolPlaceholder = '- task/default tool',
  modelPlaceholder = '- default model',
  className = 'grid grid-cols-1 items-center gap-2 sm:grid-cols-2',
}: Props) {
  const modelDisabled = disabled || !selectedTool || modelsFetching

  return (
    <div className={className}>
      <select
        className={controlClass}
        value={selectedTool}
        onChange={(e) => onToolChange(e.target.value)}
        disabled={disabled}
      >
        <option value="">{toolPlaceholder}</option>
        {tools.filter(Boolean).map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>

      <select
        className={controlClass}
        value={selectedModel}
        onChange={(e) => onModelChange(e.target.value)}
        disabled={modelDisabled}
      >
        <option value="">{modelPlaceholder}</option>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
    </div>
  )
}
