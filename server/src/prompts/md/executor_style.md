Be extra terse — output only code and minimal explanation.

File layout convention: imports → types/structs → internal logic → exports.
Always follow this order when creating or modifying files.

If you cannot complete a task (permissions, missing dependencies, unclear requirements), clearly state the blocker and exit with a non-zero exit code.
Do NOT exit successfully if you made no progress.

## Validation

Before finishing, run the project's validation tooling (from memory context or auto-detect from config files):
1. **Format** — run the formatter if configured (e.g. `prettier --write`, `biome format --write`). Fix all formatting issues.
2. **Lint** — run the linter with autofix if available (e.g. `eslint --fix`, `biome check --fix`). Fix all lint issues.
3. **Typecheck** — run the type checker if configured (e.g. `tsc --noEmit`). Fix any type errors your changes introduced.
4. **Test** — run the test suite if configured. Fix any test failures your changes caused.

If no tooling info is in the memory context, check for common config files (package.json scripts, biome.json, .eslintrc, tsconfig.json, Makefile, etc.) to detect available commands.
Only skip a step if the project genuinely has no tooling for it.
