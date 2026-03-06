import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useConfigQuery, useModelsQuery } from '../hooks/queries';
import type { Config } from '../types';

const INTERACTION_TYPES = [
  'run',
  'evaluate',
  'review',
  'plan',
  'breakdown',
  'explore',
  'retro',
  'merge',
] as const;

type SectionId =
  | 'project'
  | 'tools'
  | 'workers'
  | 'interactions'
  | 'orchestrator'
  | 'monitor'
  | 'quality'
  | 'logging';

type SectionCardProps = {
  title: string;
  id: SectionId;
  saving?: boolean;
  error?: string | null;
  onSave: () => void;
  children: React.ReactNode;
};

type LabeledInputProps = {
  label: string;
  value: string;
  onChange: (next: string) => void;
  type?: React.InputHTMLAttributes<HTMLInputElement>['type'];
};

type ToggleProps = {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
};

const inputClass =
  'w-full rounded-md border px-2.5 py-2 text-[13px] outline-none transition-colors focus:border-accent';

const sectionClass = 'rounded-lg border';

function ConfigPage() {
  const { data, isLoading } = useConfigQuery();
  const { data: modelsByTool = {} } = useModelsQuery();
  const [draft, setDraft] = useState<Config | null>(null);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  useEffect(() => {
    if (data)
      setDraft({
        ...data,
        project: data.project ?? {
          name: '',
          integrationBranch: '',
          worktreeDir: '',
        },
        tools: data.tools ?? [],
        interactions: data.interactions ?? ({} as Config['interactions']),
        orchestrator: data.orchestrator ?? { tool: '', model: '' },
        validation: data.validation ?? { commands: [] },
        workers: data.workers ?? { maxParallel: 3 },
        monitor: data.monitor ?? {
          stuckCheckInterval: '5m' as any,
          maxStuckCycles: 3,
          conflictCheckInterval: '10m' as any,
        },
        quality: data.quality ?? {
          enabled: true,
          scopeCheck: true,
          testDelta: true,
        },
        logging: data.logging ?? {
          level: 'info',
          file: '.orca/orca.log',
          maxSize: '50mb',
        },
      });
  }, [data]);

  const toolOptions = useMemo(() => {
    const configuredTools = draft?.tools ?? [];
    const discoveredTools = Object.keys(modelsByTool);
    return Array.from(new Set([...configuredTools, ...discoveredTools])).sort(
      (a, b) => a.localeCompare(b),
    );
  }, [draft, modelsByTool]);

  const updateSection = <K extends keyof Config>(
    section: K,
    value: Config[K],
  ) => {
    setDraft((prev) => (prev ? { ...prev, [section]: value } : prev));
  };

  const savePatch = async (sectionId: SectionId, patch: Partial<Config>) => {
    setSaving((prev) => ({ ...prev, [sectionId]: true }));
    setErrors((prev) => ({ ...prev, [sectionId]: null }));
    try {
      const updated = await api.updateConfig(patch);
      setDraft(updated);
    } catch (err: any) {
      setErrors((prev) => ({
        ...prev,
        [sectionId]: err?.message ?? 'Save failed',
      }));
    } finally {
      setSaving((prev) => ({ ...prev, [sectionId]: false }));
    }
  };

  if (isLoading || !draft) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
      </div>
    );
  }

  const orchModels = draft.orchestrator.tool
    ? (modelsByTool[draft.orchestrator.tool] ?? [])
    : [];

  return (
    <div className="flex flex-1 overflow-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 p-4">
        <SectionCard
          title="Project"
          id="project"
          saving={saving.project}
          error={errors.project}
          onSave={() => savePatch('project', { project: draft.project })}
        >
          <LabeledInput
            label="Name"
            value={draft.project.name}
            onChange={(value) =>
              updateSection('project', { ...draft.project, name: value })
            }
          />
          <LabeledInput
            label="Integration branch"
            value={draft.project.integrationBranch}
            onChange={(value) =>
              updateSection('project', {
                ...draft.project,
                integrationBranch: value,
              })
            }
          />
          <LabeledInput
            label="Worktree dir"
            value={draft.project.worktreeDir}
            onChange={(value) =>
              updateSection('project', {
                ...draft.project,
                worktreeDir: value,
              })
            }
          />
        </SectionCard>

        <SectionCard
          title="Tools"
          id="tools"
          saving={saving.tools}
          error={errors.tools}
          onSave={() => savePatch('tools', { tools: draft.tools })}
        >
          <label className="flex flex-col gap-1 text-xs">
            Enabled tools
            <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
              {toolOptions.map((tool) => {
                const checked = draft.tools.includes(tool);
                return (
                  <label
                    key={tool}
                    className="flex items-center gap-2 text-[13px]"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const nextTools = e.target.checked
                          ? [...draft.tools, tool]
                          : draft.tools.filter((item) => item !== tool);
                        updateSection('tools', Array.from(new Set(nextTools)));
                      }}
                    />
                    {tool}
                  </label>
                );
              })}
            </div>
          </label>
        </SectionCard>

        <SectionCard
          title="Orchestrator"
          id="orchestrator"
          saving={saving.orchestrator}
          error={errors.orchestrator}
          onSave={() =>
            savePatch('orchestrator', { orchestrator: draft.orchestrator })
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs">
              Tool
              <select
                className={inputClass}
                value={draft.orchestrator.tool}
                onChange={(e) =>
                  updateSection('orchestrator', {
                    tool: e.target.value,
                    model: modelsByTool[e.target.value]?.[0]?.id ?? '',
                  })
                }
              >
                <option value="">Select tool</option>
                {toolOptions.map((tool) => (
                  <option key={tool} value={tool}>
                    {tool}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs">
              Model
              <select
                className={inputClass}
                value={draft.orchestrator.model}
                onChange={(e) =>
                  updateSection('orchestrator', {
                    ...draft.orchestrator,
                    model: e.target.value,
                  })
                }
              >
                <option value="">Select model</option>
                {orchModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </SectionCard>

        <SectionCard
          title="Interaction Defaults"
          id="interactions"
          saving={saving.interactions}
          error={errors.interactions}
          onSave={() =>
            savePatch('interactions', { interactions: draft.interactions })
          }
        >
          <div className="space-y-2">
            {INTERACTION_TYPES.map((type) => {
              const entry = draft.interactions?.[type] ?? {
                tool: '',
                model: '',
              };
              const typeModels = entry.tool
                ? (modelsByTool[entry.tool] ?? [])
                : [];
              return (
                <div
                  key={type}
                  className="grid items-center gap-3 rounded-md border p-3 sm:grid-cols-[120px_1fr_1fr]"
                >
                  <div className="text-[13px] font-medium">{type}</div>
                  <select
                    className={inputClass}
                    value={entry.tool}
                    onChange={(e) =>
                      updateSection('interactions', {
                        ...draft.interactions,
                        [type]: {
                          tool: e.target.value,
                          model:
                            modelsByTool[e.target.value]?.[0]?.id ?? '',
                        },
                      })
                    }
                  >
                    <option value="">Select tool</option>
                    {toolOptions.map((tool) => (
                      <option key={tool} value={tool}>
                        {tool}
                      </option>
                    ))}
                  </select>
                  <select
                    className={inputClass}
                    value={entry.model}
                    onChange={(e) =>
                      updateSection('interactions', {
                        ...draft.interactions,
                        [type]: { ...entry, model: e.target.value },
                      })
                    }
                  >
                    <option value="">Select model</option>
                    {typeModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.id}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </SectionCard>

        <SectionCard
          title="Workers"
          id="workers"
          saving={saving.workers}
          error={errors.workers}
          onSave={() => savePatch('workers', { workers: draft.workers })}
        >
          <LabeledInput
            label="Max parallel"
            type="number"
            value={String(draft.workers.maxParallel)}
            onChange={(value) =>
              updateSection('workers', {
                maxParallel: Number(value) || 0,
              })
            }
          />
        </SectionCard>

        <SectionCard
          title="Monitor"
          id="monitor"
          saving={saving.monitor}
          error={errors.monitor}
          onSave={() => savePatch('monitor', { monitor: draft.monitor })}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <LabeledInput
              label="Stuck check interval"
              value={draft.monitor.stuckCheckInterval}
              onChange={(value) =>
                updateSection('monitor', {
                  ...draft.monitor,
                  stuckCheckInterval:
                    value as typeof draft.monitor.stuckCheckInterval,
                })
              }
            />
            <LabeledInput
              label="Max stuck cycles"
              type="number"
              value={String(draft.monitor.maxStuckCycles)}
              onChange={(value) =>
                updateSection('monitor', {
                  ...draft.monitor,
                  maxStuckCycles: Number(value) || 0,
                })
              }
            />
            <LabeledInput
              label="Conflict check interval"
              value={draft.monitor.conflictCheckInterval}
              onChange={(value) =>
                updateSection('monitor', {
                  ...draft.monitor,
                  conflictCheckInterval:
                    value as typeof draft.monitor.conflictCheckInterval,
                })
              }
            />
          </div>
        </SectionCard>

        <SectionCard
          title="Quality"
          id="quality"
          saving={saving.quality}
          error={errors.quality}
          onSave={() => savePatch('quality', { quality: draft.quality })}
        >
          <Toggle
            label="Enabled"
            checked={draft.quality.enabled}
            onChange={(checked) =>
              updateSection('quality', { ...draft.quality, enabled: checked })
            }
          />
          <Toggle
            label="Scope check"
            checked={draft.quality.scopeCheck}
            onChange={(checked) =>
              updateSection('quality', {
                ...draft.quality,
                scopeCheck: checked,
              })
            }
          />
          <Toggle
            label="Test delta"
            checked={draft.quality.testDelta}
            onChange={(checked) =>
              updateSection('quality', {
                ...draft.quality,
                testDelta: checked,
              })
            }
          />
        </SectionCard>

        <SectionCard
          title="Logging"
          id="logging"
          saving={saving.logging}
          error={errors.logging}
          onSave={() => savePatch('logging', { logging: draft.logging })}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-xs">
              Level
              <select
                className={inputClass}
                value={draft.logging.level}
                onChange={(e) =>
                  updateSection('logging', {
                    ...draft.logging,
                    level: e.target.value,
                  })
                }
              >
                {['debug', 'info', 'warn', 'error'].map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
            <LabeledInput
              label="File"
              value={draft.logging.file}
              onChange={(value) =>
                updateSection('logging', { ...draft.logging, file: value })
              }
            />
            <LabeledInput
              label="Max size"
              value={draft.logging.maxSize}
              onChange={(value) =>
                updateSection('logging', { ...draft.logging, maxSize: value })
              }
            />
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

function SectionCard({
  title,
  id,
  saving,
  error,
  onSave,
  children,
}: SectionCardProps) {
  return (
    <details className={sectionClass} open>
      <summary className="cursor-pointer list-none border-b px-4 py-3 text-sm font-semibold">
        {title}
      </summary>
      <div className="space-y-3 p-4">
        {children}
        <div className="flex items-center justify-end gap-3 pt-1">
          {error ? <span className="text-xs text-danger">{error}</span> : null}
          <button
            type="button"
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
            onClick={onSave}
            disabled={saving}
            data-section={id}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </details>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  type = 'text',
}: LabeledInputProps) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      {label}
      <input
        className={inputClass}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function Toggle({ label, checked, onChange }: ToggleProps) {
  return (
    <label className="flex items-center gap-2 text-[13px]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

export const Route = createFileRoute('/config')({
  component: ConfigPage,
});
