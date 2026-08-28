export type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";
export type LifecycleCloseCause = "shutdown" | "release" | "acquire-timeout";

export interface LifecycleLease<T> {
  readonly value: T;
  close(context: {
    reason: ShutdownReason;
    cause: LifecycleCloseCause;
    signal: AbortSignal;
  }): void | Promise<void>;
}

export interface LifecycleHandle<T> {
  readonly value: Promise<T>;
  release(): Promise<void>;
}

export interface LifecycleResource<T> {
  readonly id: string;
  start(signal: AbortSignal): Promise<LifecycleLease<T>>;
  readonly closeTimeoutMs?: number;
}

export interface ShutdownFailure {
  readonly resourceId: string;
  readonly phase: "acquire" | "close";
  readonly kind: "error" | "timeout";
  readonly message: string;
}

export interface ShutdownReport {
  readonly reason: ShutdownReason;
  readonly status: "clean" | "degraded";
  readonly closed: readonly string[];
  readonly failures: readonly ShutdownFailure[];
}

export interface LifecycleSupervisor {
  acquire<T>(resource: LifecycleResource<T>): Promise<T>;
  shutdown(reason: ShutdownReason): Promise<ShutdownReport>;
}

export interface ReleasableLifecycleSupervisor extends LifecycleSupervisor {
  acquireHandle<T>(resource: LifecycleResource<T>): LifecycleHandle<T>;
}

export interface LifecycleOptions {
  readonly acquireTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

export class LifecycleClosedError extends Error {
  constructor() {
    super("Lifecycle supervisor has begun shutdown.");
    this.name = "LifecycleClosedError";
  }
}

export class ResourceConflictError extends Error {
  constructor(id: string, message?: string) {
    super(
      message ??
        `A different lifecycle resource already uses id ${JSON.stringify(id)}.`,
    );
    this.name = "ResourceConflictError";
  }
}

export class ResourceAcquireError extends Error {
  constructor(id: string, message: string, options?: ErrorOptions) {
    super(
      `Could not acquire lifecycle resource ${JSON.stringify(id)}: ${message}`,
      options,
    );
    this.name = "ResourceAcquireError";
  }
}

export class ResourceAcquireAbortedError extends Error {
  constructor(id: string, cause: "shutdown" | "release" = "shutdown") {
    super(
      cause === "release"
        ? `Lifecycle resource ${JSON.stringify(id)} acquisition was aborted because its handle was released.`
        : `Lifecycle resource ${JSON.stringify(id)} was aborted because the session shut down.`,
    );
    this.name = "ResourceAcquireAbortedError";
  }
}

class DeadlineError extends Error {}
class LateResourceCloseError extends Error {}

interface Entry<T = unknown> {
  readonly resource: LifecycleResource<T>;
  readonly order: number;
  readonly controller: AbortController;
  readonly opening: Promise<LifecycleLease<T>>;
  acquisition: Promise<T>;
  settlement: Promise<void>;
  lease?: LifecycleLease<T>;
  cancelled: boolean;
  released: boolean;
  releasePromise?: Promise<void>;
  closePromise?: Promise<void>;
  releaseFailure?: ShutdownFailure;
  retirement?: Promise<void>;
  physicalRetirement?: Promise<void>;
  closeCause?: LifecycleCloseCause;
  lateClose?: Promise<void>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function raceDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("Lifecycle deadlines must be finite and non-negative.");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new DeadlineError(`Timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function abortPromise(signal: AbortSignal) {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

export function createLifecycleSupervisor(
  options: LifecycleOptions = {},
): ReleasableLifecycleSupervisor {
  const acquireTimeoutMs = options.acquireTimeoutMs ?? 30_000;
  const closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30_000;
  for (const [name, value] of Object.entries({
    acquireTimeoutMs,
    closeTimeoutMs,
    shutdownTimeoutMs,
  })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`${name} must be finite and non-negative.`);
    }
  }
  const currentEntries = new Map<string, Entry>();
  const trackedEntries = new Set<Entry>();
  let nextOrder = 0;
  let state: "open" | "stopping" | "closed" = "open";
  let shutdownPromise: Promise<ShutdownReport> | undefined;
  let shutdownReason: ShutdownReason | undefined;
  const releasedFailures: ShutdownFailure[] = [];

  const closeLate = <T>(entry: Entry<T>, lease: LifecycleLease<T>) => {
    if (entry.lateClose) return entry.lateClose;
    const controller = new AbortController();
    const physicalClose = Promise.resolve()
      .then(() =>
        lease.close({
          reason: shutdownReason ?? "quit",
          cause:
            entry.closeCause ??
            (shutdownReason ? "shutdown" : "acquire-timeout"),
          signal: controller.signal,
        }),
      )
      .then(() => undefined);
    entry.physicalRetirement = physicalClose.then(
      () => undefined,
      () => undefined,
    );
    entry.lateClose = raceDeadline(
      physicalClose,
      entry.resource.closeTimeoutMs ?? closeTimeoutMs,
      () =>
        controller.abort(new DeadlineError("Late resource close timed out.")),
    ).catch((error) => {
      if (error instanceof DeadlineError) throw error;
      throw new LateResourceCloseError(errorMessage(error), { cause: error });
    });
    return entry.lateClose;
  };

  const acquireResource = <T>(
    resource: LifecycleResource<T>,
    onEntry?: (entry: Entry<T>) => void,
    exclusiveHandle = false,
  ): Promise<T> => {
    if (state !== "open") return Promise.reject(new LifecycleClosedError());
    if (
      resource.closeTimeoutMs !== undefined &&
      (!Number.isFinite(resource.closeTimeoutMs) || resource.closeTimeoutMs < 0)
    ) {
      return Promise.reject(
        new ResourceAcquireError(
          resource.id,
          "closeTimeoutMs must be finite and non-negative.",
        ),
      );
    }
    const prior = currentEntries.get(resource.id);
    if (prior?.releasePromise) {
      return (prior.retirement ?? prior.releasePromise)
        .catch(() => undefined)
        .then(() => acquireResource(resource, onEntry, exclusiveHandle));
    }
    if (prior) {
      if (exclusiveHandle) {
        return Promise.reject(
          new ResourceConflictError(
            resource.id,
            `Resource ${JSON.stringify(resource.id)} already has an active lifecycle handle.`,
          ),
        );
      }
      if (prior.resource !== resource) {
        return Promise.reject(new ResourceConflictError(resource.id));
      }
      onEntry?.(prior as Entry<T>);
      return prior.acquisition as Promise<T>;
    }

    const controller = new AbortController();
    const opening = Promise.resolve().then(() =>
      resource.start(controller.signal),
    );
    const entry: Entry<T> = {
      resource,
      order: nextOrder++,
      controller,
      opening,
      acquisition: undefined as unknown as Promise<T>,
      settlement: undefined as unknown as Promise<void>,
      cancelled: false,
      released: false,
    };
    currentEntries.set(resource.id, entry as Entry);
    trackedEntries.add(entry as Entry);

    const started = opening.then(async (lease) => {
      if (entry.cancelled || state !== "open") {
        await closeLate(entry, lease);
        throw new ResourceAcquireAbortedError(
          resource.id,
          entry.closeCause === "release" ? "release" : "shutdown",
        );
      }
      entry.lease = lease;
      return lease.value;
    });

    entry.settlement = started.then(() => undefined);
    void entry.settlement
      .finally(() => {
        if (!entry.lease) trackedEntries.delete(entry as Entry);
      })
      .catch(() => undefined);
    entry.acquisition = raceDeadline(
      Promise.race([started, abortPromise(controller.signal)]),
      acquireTimeoutMs,
      () => {
        entry.cancelled = true;
        controller.abort(new DeadlineError("Resource acquisition timed out."));
      },
    ).catch((error) => {
      entry.cancelled = true;
      if (!entry.releasePromise && currentEntries.get(resource.id) === entry) {
        currentEntries.delete(resource.id);
      }
      if (error instanceof ResourceAcquireAbortedError) throw error;
      if (controller.signal.aborted && state !== "open") {
        throw new ResourceAcquireAbortedError(resource.id);
      }
      if (error instanceof ResourceAcquireError) throw error;
      throw new ResourceAcquireError(resource.id, errorMessage(error), {
        cause: error,
      });
    });
    onEntry?.(entry);

    return entry.acquisition;
  };

  const acquire = <T>(resource: LifecycleResource<T>) =>
    acquireResource(resource);

  const releaseEntry = <T>(entry: Entry<T>) => {
    if (entry.releasePromise) return entry.releasePromise;
    if (entry.closePromise) {
      entry.releasePromise = entry.closePromise;
      return entry.releasePromise;
    }
    entry.cancelled = true;
    entry.closeCause = state === "open" ? "release" : "shutdown";
    entry.controller.abort(
      new ResourceAcquireAbortedError(entry.resource.id, "release"),
    );
    const controller = new AbortController();
    const close = () => {
      const physicalClose = Promise.resolve().then(() =>
        entry.lease!.close({
          reason: shutdownReason ?? "quit",
          cause: "release",
          signal: controller.signal,
        }),
      );
      entry.retirement = physicalClose.then(
        () => undefined,
        () => undefined,
      );
      entry.closePromise = raceDeadline(
        physicalClose,
        entry.resource.closeTimeoutMs ?? closeTimeoutMs,
        () => controller.abort(new DeadlineError("Resource close timed out.")),
      ).then(() => undefined);
      return entry.closePromise;
    };
    if (!entry.lease) {
      entry.retirement = entry.opening.then(
        async (lease) => {
          void closeLate(entry, lease).catch(() => undefined);
          await entry.physicalRetirement;
        },
        () => undefined,
      );
    }
    entry.releasePromise = (
      entry.lease
        ? close()
        : raceDeadline(
            entry.settlement.catch(async () => {
              if (entry.lateClose) await entry.lateClose;
            }),
            entry.resource.closeTimeoutMs ?? closeTimeoutMs,
            () =>
              controller.abort(
                new DeadlineError("Released acquisition did not settle."),
              ),
          )
    )
      .catch((error) => {
        entry.releaseFailure = {
          resourceId: entry.resource.id,
          phase: entry.lease || entry.lateClose ? "close" : "acquire",
          kind: error instanceof DeadlineError ? "timeout" : "error",
          message: errorMessage(error),
        };
        releasedFailures.push(entry.releaseFailure);
        throw error;
      })
      .finally(() => {
        entry.released = true;
      });
    const retirement = entry.retirement;
    if (!retirement) {
      throw new Error("Lifecycle release retirement was not initialized.");
    }
    void retirement
      .finally(() => {
        if (currentEntries.get(entry.resource.id) === entry) {
          currentEntries.delete(entry.resource.id);
        }
        trackedEntries.delete(entry as Entry);
      })
      .catch(() => undefined);
    return entry.releasePromise;
  };

  const acquireHandle = <T>(resource: LifecycleResource<T>) => {
    let entry: Entry<T> | undefined;
    let releaseRequested = false;
    let handleReleasePromise: Promise<void> | undefined;
    let settleRelease:
      { resolve: () => void; reject: (error: unknown) => void } | undefined;
    const value = acquireResource(
      resource,
      (accepted) => {
        entry = accepted;
        if (releaseRequested) {
          void releaseEntry(accepted).then(
            () => settleRelease?.resolve(),
            (error) => settleRelease?.reject(error),
          );
        }
      },
      true,
    );
    return {
      value,
      release() {
        if (handleReleasePromise) return handleReleasePromise;
        releaseRequested = true;
        if (entry) {
          handleReleasePromise = releaseEntry(entry);
          return handleReleasePromise;
        }
        handleReleasePromise = new Promise<void>((resolve, reject) => {
          settleRelease = { resolve, reject };
        });
        void value.catch(() => {
          if (!entry) settleRelease?.resolve();
        });
        return handleReleasePromise;
      },
    } satisfies LifecycleHandle<T>;
  };

  const shutdown = (reason: ShutdownReason) => {
    if (shutdownPromise) return shutdownPromise;
    state = "stopping";
    shutdownReason = reason;
    const startedAt = Date.now();
    const pending = [...trackedEntries].filter((entry) => !entry.lease);
    for (const entry of pending) {
      if (!entry.lease) {
        entry.cancelled = true;
        entry.controller.abort(
          new ResourceAcquireAbortedError(entry.resource.id),
        );
      }
    }

    shutdownPromise = (async () => {
      const closed: string[] = [];
      const closedIds = new Set<string>();
      const markClosed = (resourceId: string) => {
        if (closedIds.has(resourceId)) return;
        closedIds.add(resourceId);
        closed.push(resourceId);
      };
      const failures: ShutdownFailure[] = [...releasedFailures];
      const active = [...trackedEntries]
        .filter((entry) => entry.lease && !entry.released)
        .sort((left, right) => right.order - left.order);

      for (const entry of active) {
        const remaining = shutdownTimeoutMs - (Date.now() - startedAt);
        if (remaining <= 0) {
          failures.push({
            resourceId: entry.resource.id,
            phase: "close",
            kind: "timeout",
            message: "Global lifecycle shutdown deadline elapsed.",
          });
          continue;
        }
        const controller = new AbortController();
        const timeout = Math.min(
          remaining,
          entry.resource.closeTimeoutMs ?? closeTimeoutMs,
        );
        try {
          if (entry.releasePromise) {
            await entry.releasePromise;
          } else {
            const physicalClose = Promise.resolve().then(() =>
              entry.lease!.close({
                reason,
                cause: "shutdown",
                signal: controller.signal,
              }),
            );
            entry.retirement = physicalClose.then(
              () => undefined,
              () => undefined,
            );
            entry.closePromise = raceDeadline(physicalClose, timeout, () =>
              controller.abort(new DeadlineError("Resource close timed out.")),
            ).then(() => undefined);
            await entry.closePromise;
          }
          markClosed(entry.resource.id);
        } catch (error) {
          const failure = entry.releaseFailure ?? {
            resourceId: entry.resource.id,
            phase: "close" as const,
            kind:
              error instanceof DeadlineError
                ? ("timeout" as const)
                : ("error" as const),
            message: errorMessage(error),
          };
          if (!failures.includes(failure)) failures.push(failure);
        }
      }

      await Promise.all(
        pending.map(async (entry) => {
          const remaining = Math.max(
            0,
            shutdownTimeoutMs - (Date.now() - startedAt),
          );
          try {
            await raceDeadline(entry.settlement, remaining);
          } catch (error) {
            if (entry.releaseFailure) {
              if (!failures.includes(entry.releaseFailure)) {
                failures.push(entry.releaseFailure);
              }
              return;
            }
            if (
              error instanceof ResourceAcquireAbortedError &&
              entry.lateClose
            ) {
              markClosed(entry.resource.id);
              return;
            }
            if (
              !(error instanceof DeadlineError) &&
              entry.controller.signal.aborted &&
              !entry.lateClose
            )
              return;
            failures.push({
              resourceId: entry.resource.id,
              phase: entry.lateClose ? "close" : "acquire",
              kind: error instanceof DeadlineError ? "timeout" : "error",
              message: errorMessage(error),
            });
          }
        }),
      );

      state = "closed";
      currentEntries.clear();
      trackedEntries.clear();
      return {
        reason,
        status: failures.length === 0 ? "clean" : "degraded",
        closed,
        failures,
      } satisfies ShutdownReport;
    })();
    return shutdownPromise;
  };

  return {
    acquire,
    acquireHandle,
    shutdown,
  } satisfies ReleasableLifecycleSupervisor;
}
