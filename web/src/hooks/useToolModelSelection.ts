import { useState } from 'react';
import { useModelsQuery } from './queries';

export function useToolModelSelection() {
  const [selectedTool, setSelectedTool] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const modelsQuery = useModelsQuery(selectedTool || undefined);
  const models = selectedTool ? (modelsQuery.data?.[selectedTool] ?? []) : [];

  const handleToolChange = (tool: string) => {
    setSelectedTool(tool);
    setSelectedModel('');
  };

  return {
    selectedTool,
    selectedModel,
    setSelectedTool,
    setSelectedModel,
    models,
    isFetching: modelsQuery.isFetching,
    handleToolChange,
  };
}
