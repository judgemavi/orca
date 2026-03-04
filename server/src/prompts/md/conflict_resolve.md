This worktree has git merge/rebase conflict markers. Your job:

1. Find ALL files with conflict markers (<<<<<<< HEAD, =======, >>>>>>>)
2. For each conflict, read both sides carefully:
   - Prior task work must be preserved unless the current task intentionally changes it
   - If both sides add new code, merge them logically
   - When in doubt, keep both — losing prior work is worse than a redundant line
3. Remove ALL conflict markers — no <<<<<<< or ======= or >>>>>>> may remain
4. Verify the result compiles and is logically correct
5. Do NOT add new functionality beyond resolving the conflicts
