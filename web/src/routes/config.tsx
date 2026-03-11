import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Button } from '../components/Button';
import {
  useConfigQuery,
  useEmbeddingProvidersQuery,
  useModelsQuery,
} from '../hooks/queries';
import type { Config } from '../types';

type SectionId =
  | 'project'
  | 'tools'
  | 'workers'
  | 'orchestrator'
  | 'monitor'
  | 'quality'
  | 'embeddings'
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

const inputClass =
  'w-full rounded-md border px-2.5 py-2 text-[13px] outline-none transition-colors focus:border-accent';

const sectionClass = 'rounded-lg border';

function EmbeddingsSection({
  draft,
  saving,
  error,
  onSave,
  onUpdate,
}: {
  draft: Config;
  saving?: boolean;
  error?: string | null;
  onSave: () => void;
  onUpdate: (value: Config['embeddings'] | undefined) => void;
}) {
  const { data: providers } = useEmbeddingProvidersQuery();
  const selectedProvider = draft.embeddings?.provider ?? '';
  const providerFields = useMemo(
    () =>
      providers?.find((p) => p.name === selectedProvider)?.configFields ?? [],
    [providers, selectedProvider],
  );

  // Seed defaults from plugin configFields when provider changes
  const handleProviderChange = (provider: string) => {
    if (!provider) {
      onUpdate(undefined);
      return;
    }
    const fields =
      providers?.find((p) => p.name === provider)?.configFields ?? [];
    const seeded: Record<string, unknown> = { provider };
    for (const field of fields) {
      seeded[field.key] =
        draft.embeddings?.[field.key] ?? field.defaultValue ?? '';
    }
    onUpdate(seeded as Config['embeddings']);
  };

  // Ensure fields are populated when draft loads with existing provider
  useEffect(() => {
    if (!selectedProvider || providerFields.length === 0) return;
    const current = draft.embeddings ?? {};
    const missing = providerFields.filter((f) => !(f.key in current));
    if (missing.length === 0) return;
    const patched: Record<string, unknown> = { ...current };
    for (const field of missing) {
      patched[field.key] = field.defaultValue ?? '';
    }
    onUpdate(patched as Config['embeddings']);
  }, [selectedProvider, providerFields]);

  return (
    <SectionCard
      title="Embeddings"
      id="embeddings"
      saving={saving}
      error={error}
      onSave={onSave}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs">
          Provider
          <select
            className={inputClass}
            value={selectedProvider}
            onChange={(e) => handleProviderChange(e.target.value)}
          >
            <option value="">None (FTS only)</option>
            {(providers ?? []).map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {selectedProvider &&
          providerFields.map((field) => (
            <LabeledInput
              key={field.key}
              label={field.label + (field.hint ? ` (${field.hint})` : '')}
              value={String(
                draft.embeddings?.[field.key] ?? field.defaultValue ?? '',
              )}
              onChange={(next) =>
                onUpdate({
                  ...draft.embeddings,
                  [field.key]: next || undefined,
                } as Config['embeddings'])
              }
            />
          ))}
      </div>
    </SectionCard>
  );
}

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
        orchestrator: data.orchestrator ?? {
          tool: '',
          model: '',
        },
        workers: data.workers ?? { maxParallel: 3 },
        monitor: data.monitor ?? {
          stuckCheckIntervalMs: 300_000,
          maxStuckCycles: 3,
          conflictCheckIntervalMs: 600_000,
        },
        logging: data.logging ?? {
          level: 'info',
          file: '.orca/orca.log',
          maxSize: '50mb',
        },
        embeddings: data.embeddings,
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
    } catch (err) {
      setErrors((prev) => ({
        ...prev,
        [sectionId]: err instanceof Error ? err.message : 'Save failed',
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
          <fieldset>
            <span className="flex flex-col gap-1 text-xs">Enabled tools</span>
            <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
              {toolOptions.map((tool) => {
                const checked = draft.tools.includes(tool);
                return (
                  <label
                    key={tool}
                    className="flex items-center gap-2 text-[13px]"
                    htmlFor={tool}
                  >
                    <input
                      id={tool}
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
          </fieldset>
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
              label="Stuck check interval (ms)"
              type="number"
              value={String(draft.monitor.stuckCheckIntervalMs)}
              onChange={(value) =>
                updateSection('monitor', {
                  ...draft.monitor,
                  stuckCheckIntervalMs: Number(value) || 0,
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
              label="Conflict check interval (ms)"
              type="number"
              value={String(draft.monitor.conflictCheckIntervalMs)}
              onChange={(value) =>
                updateSection('monitor', {
                  ...draft.monitor,
                  conflictCheckIntervalMs: Number(value) || 0,
                })
              }
            />
          </div>
        </SectionCard>

        <EmbeddingsSection
          draft={draft}
          saving={saving.embeddings}
          error={errors.embeddings}
          onSave={() =>
            savePatch('embeddings', { embeddings: draft.embeddings })
          }
          onUpdate={(value) => updateSection('embeddings', value)}
        />

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
          <Button
            variant="primary"
            className="text-xs"
            onClick={onSave}
            disabled={saving}
            data-section={id}
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
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

export const Route = createFileRoute('/config')({
  component: ConfigPage,
});
