import { embedded, FILE_NAMES, type PromptName } from './embedded';

export type { PromptName } from './embedded';

export async function loadPrompt(
  repoDir: string,
  name: PromptName,
): Promise<string> {
  const fileName = FILE_NAMES[name];
  const override = await Bun.file(`${repoDir}/.orca/prompts/${fileName}.md`)
    .text()
    .catch(() => '');
  if (override.trim()) return override;
  return embedded[name];
}
