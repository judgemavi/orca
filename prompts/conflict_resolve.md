This worktree has git merge/rebase conflict markers. Your job:

1. Find ALL files with conflict markers (<<<<<<< HEAD, =======, >>>>>>>)
2. For each conflict, read both sides and choose the correct resolution:
   - Prefer the incoming (rebased) changes when they implement the task
   - Preserve existing functionality that the task doesn't intend to change
   - If both sides add new code, merge them logically
3. Remove ALL conflict markers — no <<<<<<< or ======= or >>>>>>> may remain
4. Verify the code compiles and is logically correct after resolution
5. Do NOT add new functionality beyond resolving the conflicts

After resolving, run any available build/test commands to verify correctness.
