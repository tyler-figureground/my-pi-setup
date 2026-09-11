/**
 * Pending-result buffer, keyed by subagent id, that keeps a settled
 * subagent's result retractable while the parent is still working.
 *
 * `../index.ts` defers a copy of each settled snapshot, `consume`s it when
 * `subagent_wait` has already returned that result to the model (or the child
 * belongs to a scheduled/named-profile run), and `drain`s the rest as
 * follow-up messages on `agent_settled`, or at once if the parent is idle.
 * Pure in-memory state; a re-deferred id replaces the earlier entry.
 */
export function createDeferredResultDelivery<T extends { id: string }>() {
  const pending = new Map<string, T>();

  return {
    defer(result: T) {
      pending.set(result.id, result);
    },
    consume(ids: Iterable<string>) {
      for (const id of ids) pending.delete(id);
    },
    drain() {
      const results = [...pending.values()];
      pending.clear();
      return results;
    },
    clear() {
      pending.clear();
    },
  };
}
