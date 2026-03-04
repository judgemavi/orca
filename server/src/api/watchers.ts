// Database watchers are no longer needed — events are emitted directly
// from store classes (TaskStore, InteractionStore, MemoryStore, ConfigStore)
// and from the orchestrator handler.
//
// This stub is kept so existing imports don't break during the transition.

export async function startDatabaseWatchers(): Promise<() => Promise<void>> {
  return async () => {};
}
