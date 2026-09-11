/**
 * Single-permit gate for git-info refreshes (used by `../index.ts`).
 *
 * `run` waits for the permit, so an explicit `/pr` refresh always happens;
 * `runIfIdle` skips outright when a refresh is already in flight, so polling
 * and event-driven refreshes never queue up behind a slow `gh` call.
 */

import { Effect, Semaphore } from "effect";

/** Serializes explicit refreshes while allowing background refreshes to coalesce. */
export function makeRefreshCoordinator() {
  const semaphore = Semaphore.makeUnsafe(1);

  return {
    run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      semaphore.withPermit(effect),
    runIfIdle: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      semaphore.withPermitsIfAvailable(1)(effect).pipe(Effect.asVoid),
  };
}
