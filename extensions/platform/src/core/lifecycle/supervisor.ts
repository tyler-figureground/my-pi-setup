export type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

export interface LifecycleLease<T> {
  readonly value: T;
  close(context: {
    reason: ShutdownReason;
    signal: AbortSignal;
  }): void | Promise<void>;
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
  constructor(id: string) {
    super(
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
  constructor(id: string) {
    super(
      `Lifecycle resource ${JSON.stringify(id)} was aborted because the session shut down.`,
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
  acquisition: Promise<T>;
  settlement: Promise<void>;
  lease?: LifecycleLease<T>;
  cancelled: boolean;
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
): LifecycleSupervisor {
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
  const entries = new Map<string, Entry>();
  let nextOrder = 0;
  let state: "open" | "stopping" | "closed" = "open";
  let shutdownPromise: Promise<ShutdownReport> | undefined;
  let shutdownReason: ShutdownReason | undefined;

  const closeLate = <T>(entry: Entry<T>, lease: LifecycleLease<T>) => {
    if (entry.lateClose) return entry.lateClose;
    const controller = new AbortController();
    entry.lateClose = raceDeadline(
      Promise.resolve()
        .then(() =>
          lease.close({
            reason: shutdownReason ?? "quit",
            signal: controller.signal,
          }),
        )
        .then(() => undefined),
      entry.resource.closeTimeoutMs ?? closeTimeoutMs,
      () =>
        controller.abort(new DeadlineError("Late resource close timed out.")),
    ).catch((error) => {
      if (error instanceof DeadlineError) throw error;
      throw new LateResourceCloseError(errorMessage(error), { cause: error });
    });
    return entry.lateClose;
  };

  const acquire = <T>(resource: LifecycleResource<T>) => {
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
    const prior = entries.get(resource.id);
    if (prior) {
      if (prior.resource !== resource) {
        return Promise.reject(new ResourceConflictError(resource.id));
      }
      return prior.acquisition as Promise<T>;
    }

    const controller = new AbortController();
    const entry: Entry<T> = {
      resource,
      order: nextOrder++,
      controller,
      acquisition: undefined as unknown as Promise<T>,
      settlement: undefined as unknown as Promise<void>,
      cancelled: false,
    };
    entries.set(resource.id, entry as Entry);

    const started = Promise.resolve()
      .then(() => resource.start(controller.signal))
      .then(async (lease) => {
        if (entry.cancelled || state !== "open") {
          await closeLate(entry, lease);
          throw new ResourceAcquireAbortedError(resource.id);
        }
        entry.lease = lease;
        return lease.value;
      });

    entry.settlement = started.then(() => undefined);
    void entry.settlement.catch(() => undefined);
    entry.acquisition = raceDeadline(
      Promise.race([started, abortPromise(controller.signal)]),
      acquireTimeoutMs,
      () =>
        controller.abort(new DeadlineError("Resource acquisition timed out.")),
    ).catch((error) => {
      entry.cancelled = true;
      if (entries.get(resource.id) === entry) entries.delete(resource.id);
      if (
        error instanceof ResourceAcquireAbortedError ||
        (controller.signal.aborted && state !== "open")
      ) {
        throw new ResourceAcquireAbortedError(resource.id);
      }
      if (error instanceof ResourceAcquireError) throw error;
      throw new ResourceAcquireError(resource.id, errorMessage(error), {
        cause: error,
      });
    });

    return entry.acquisition;
  };

  const shutdown = (reason: ShutdownReason) => {
    if (shutdownPromise) return shutdownPromise;
    state = "stopping";
    shutdownReason = reason;
    const startedAt = Date.now();
    const pending = [...entries.values()].filter((entry) => !entry.lease);
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
      const failures: ShutdownFailure[] = [];
      const active = [...entries.values()]
        .filter((entry) => entry.lease)
        .sort((left, right) => right.order - left.order);

      await Promise.all(
        pending.map(async (entry) => {
          const remaining = Math.max(
            0,
            shutdownTimeoutMs - (Date.now() - startedAt),
          );
          try {
            await raceDeadline(entry.settlement, remaining);
          } catch (error) {
            if (
              error instanceof ResourceAcquireAbortedError &&
              entry.lateClose
            ) {
              closed.push(entry.resource.id);
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
          await raceDeadline(
            Promise.resolve(
              entry.lease!.close({ reason, signal: controller.signal }),
            ).then(() => undefined),
            timeout,
            () =>
              controller.abort(new DeadlineError("Resource close timed out.")),
          );
          closed.push(entry.resource.id);
        } catch (error) {
          failures.push({
            resourceId: entry.resource.id,
            phase: "close",
            kind: error instanceof DeadlineError ? "timeout" : "error",
            message: errorMessage(error),
          });
        }
      }

      state = "closed";
      entries.clear();
      return {
        reason,
        status: failures.length === 0 ? "clean" : "degraded",
        closed,
        failures,
      } satisfies ShutdownReport;
    })();
    return shutdownPromise;
  };

  return { acquire, shutdown };
}
