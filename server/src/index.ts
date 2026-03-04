import { runInitCommand } from './cli/commands/init'

type Mode = 'mcp' | 'serve' | 'cli'

function detectMode(): Mode {
  if (Bun.argv.some((arg) => arg === 'mcp')) return 'mcp'
  if (Bun.argv.some((arg) => arg === 'serve' || arg === '--server-only')) return 'serve'
  return 'cli'
}

function parsePort(): number {
  const idx = Bun.argv.findIndex((arg) => arg === '-p' || arg === '--port')
  if (idx >= 0 && idx + 1 < Bun.argv.length) {
    return Number(Bun.argv[idx + 1]) || 8080
  }
  return Number(process.env.PORT ?? '8080')
}

function isInitCommand(): boolean {
  return Bun.argv.some((arg) => arg === 'init')
}

async function isInitialized(repoDir: string): Promise<boolean> {
  if (await Bun.file(`${repoDir}/.orca/.initialized`).exists()) return true
  return Bun.file(`${repoDir}/.orca/state.db`).exists()
}

async function detectRepoDir(startDir: string): Promise<string> {
  let current = startDir
  while (true) {
    if (
      (await Bun.file(`${current}/.git`).exists()) ||
      (await Bun.file(`${current}/.git/HEAD`).exists())
    ) {
      return current
    }
    const parent = parentDir(current)
    if (parent === current) return startDir
    current = parent
  }
}

function parentDir(path: string): string {
  const normalized = path.replace(/\/+$/g, '')
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return '/'
  return normalized.slice(0, index)
}

async function main() {
  const cwd = process.cwd()
  const repoDir = await detectRepoDir(cwd)

  if (isInitCommand()) {
    await runInitCommand(repoDir, {
      yes: Bun.argv.includes('-y') || Bun.argv.includes('--yes'),
    })
    return
  }

  if (!(await isInitialized(repoDir))) {
    console.error(`not an orca workspace: ${repoDir}`)
    console.error('run "orca init" first')
    process.exit(1)
  }

  const mode = detectMode()

  switch (mode) {
    case 'mcp': {
      const { runMCPEntrypoint } = await import('./entrypoints/mcp')
      await runMCPEntrypoint(repoDir)
      break
    }
    case 'serve': {
      const { runServeEntrypoint } = await import('./entrypoints/serve')
      await runServeEntrypoint(repoDir, parsePort())
      break
    }
    case 'cli': {
      const { runCLIEntrypoint } = await import('./entrypoints/cli')
      await runCLIEntrypoint(repoDir)
      break
    }
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
