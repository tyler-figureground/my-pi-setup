import assert from "node:assert/strict";
import test from "node:test";
import {
  createLifecycleSupervisor,
  LifecycleClosedError,
  ResourceConflictError,
  type LifecycleLease,
  type LifecycleResource,
} from "./src/core/lifecycle/supervisor.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function resource<T>(
  id: string,
  start: LifecycleResource<T>["start"],
  closeTimeoutMs?: number,
): LifecycleResource<T> {
  return {
    id,
    start,
    ...(closeTimeoutMs === undefined ? {} : { closeTimeoutMs }),
  };
}

test("concurrent acquisition of one resource starts once and shares its value", async () => {
  let starts = 0;
  const supervisor = createLifecycleSupervisor();
  const fixture = resource("shared", async () => {
    starts++;
    return { value: { token: 1 }, close() {} };
  });

  const [first, second] = await Promise.all([
    supervisor.acquire(fixture),
    supervisor.acquire(fixture),
  ]);
  assert.equal(starts, 1);
  assert.equal(first, second);
  await supervisor.shutdown("quit");
});

test("two active lifecycle handles cannot share one close authority", async () => {
  let closes = 0;
  const supervisor = createLifecycleSupervisor();
  const shared = resource("exclusive-handle", async () => ({
    value: "open",
    close: () => void closes++,
  }));
  const first = supervisor.acquireHandle(shared);
  assert.equal(await first.value, "open");

  const second = supervisor.acquireHandle(shared);
  await assert.rejects(second.value, /already has an active lifecycle handle/i);
  await second.release();
  assert.equal(closes, 0);

  await first.release();
  assert.equal(closes, 1);
  await supervisor.shutdown("quit");
});

test("a lifecycle handle releases early and permits same-id reacquisition", async () => {
  const closes: string[] = [];
  const supervisor = createLifecycleSupervisor();
  const first = supervisor.acquireHandle(
    resource("dynamic", async () => ({
      value: "first",
      close: ({ cause }) => void closes.push(`first:${cause}`),
    })),
  );

  assert.equal(await first.value, "first");
  const releasing = first.release();
  assert.equal(releasing, first.release());
  await releasing;

  const second = supervisor.acquireHandle(
    resource("dynamic", async () => ({
      value: "second",
      close: ({ cause }) => void closes.push(`second:${cause}`),
    })),
  );
  assert.equal(await second.value, "second");
  await second.release();

  assert.deepEqual(closes, ["first:release", "second:release"]);
  await supervisor.shutdown("quit");
});

test("acquisition racing release waits for close settlement before reusing the id", async () => {
  const closeStarted = deferred<void>();
  const closeSettled = deferred<void>();
  let starts = 0;
  const supervisor = createLifecycleSupervisor();
  const first = supervisor.acquireHandle(
    resource("rotating", async () => {
      starts++;
      return {
        value: "first",
        close: () => {
          closeStarted.resolve();
          return closeSettled.promise;
        },
      };
    }),
  );
  await first.value;

  const releasing = first.release();
  await closeStarted.promise;
  const second = supervisor.acquireHandle(
    resource("rotating", async () => {
      starts++;
      return { value: "second", close() {} };
    }),
  );
  await Promise.resolve();
  assert.equal(starts, 1);

  closeSettled.resolve();
  await releasing;
  assert.equal(await second.value, "second");
  assert.equal(starts, 2);
  await supervisor.shutdown("quit");
});

test("a queued handle released before acceptance cannot leave a resource open", async () => {
  const firstClose = deferred<void>();
  let secondStarts = 0;
  let secondCloses = 0;
  const supervisor = createLifecycleSupervisor();
  const first = supervisor.acquireHandle(
    resource("queued-release", async () => ({
      value: "first",
      close: () => firstClose.promise,
    })),
  );
  await first.value;
  const releasingFirst = first.release();

  const second = supervisor.acquireHandle(
    resource("queued-release", async () => {
      secondStarts++;
      return {
        value: "second",
        close: () => void secondCloses++,
      };
    }),
  );
  const releasingSecond = second.release();
  firstClose.resolve();

  await releasingFirst;
  await assert.rejects(second.value, /aborted/i);
  await releasingSecond;
  assert.equal(secondStarts, 1);
  assert.equal(secondCloses, 1);
  await supervisor.shutdown("quit");
  assert.equal(secondCloses, 1);
});

test("release of an abort-ignoring start is bounded and reported once", async () => {
  const supervisor = createLifecycleSupervisor({
    closeTimeoutMs: 5,
    shutdownTimeoutMs: 10,
  });
  const handle = supervisor.acquireHandle(
    resource(
      "stuck-release",
      () => new Promise<LifecycleLease<never>>(() => {}),
    ),
  );

  const release = handle.release();
  assert.equal(release, handle.release());
  await assert.rejects(handle.value, /aborted/i);
  await assert.rejects(release, /Timed out/);
  const report = await supervisor.shutdown("quit");

  assert.equal(report.status, "degraded");
  assert.deepEqual(
    report.failures.map(({ resourceId, phase, kind }) => ({
      resourceId,
      phase,
      kind,
    })),
    [{ resourceId: "stuck-release", phase: "acquire", kind: "timeout" }],
  );
});

test("timed-out release keeps the id fenced until physical close settles", async () => {
  const physicalClose = deferred<void>();
  let starts = 0;
  const supervisor = createLifecycleSupervisor({ closeTimeoutMs: 5 });
  const first = supervisor.acquireHandle(
    resource("bounded-release", async () => {
      starts++;
      return { value: "first", close: () => physicalClose.promise };
    }),
  );
  await first.value;

  await assert.rejects(first.release(), /Timed out/);
  const second = supervisor.acquireHandle(
    resource("bounded-release", async () => {
      starts++;
      return { value: "second", close() {} };
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(starts, 1);

  physicalClose.resolve();
  assert.equal(await second.value, "second");
  assert.equal(starts, 2);
  const report = await supervisor.shutdown("quit");
  assert.equal(report.status, "degraded");
  assert.deepEqual(
    report.failures.map(({ resourceId, phase, kind }) => ({
      resourceId,
      phase,
      kind,
    })),
    [{ resourceId: "bounded-release", phase: "close", kind: "timeout" }],
  );
});

test("a timed-out late close keeps the released id fenced", async () => {
  const opening = deferred<LifecycleLease<string>>();
  const physicalClose = deferred<void>();
  let starts = 0;
  const supervisor = createLifecycleSupervisor({ closeTimeoutMs: 5 });
  const first = supervisor.acquireHandle(
    resource("late-close-fence", () => {
      starts++;
      return opening.promise;
    }),
  );
  const release = first.release();
  opening.resolve({ value: "late", close: () => physicalClose.promise });

  await assert.rejects(first.value, /aborted/i);
  await assert.rejects(release, /Timed out/);
  const second = supervisor.acquireHandle(
    resource("late-close-fence", async () => {
      starts++;
      return { value: "second", close() {} };
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(starts, 1);

  physicalClose.resolve();
  assert.equal(await second.value, "second");
  assert.equal(starts, 2);
  assert.equal((await supervisor.shutdown("quit")).status, "degraded");
});

test("release aborts acquisition and immediately closes a late lease", async () => {
  const pending = deferred<LifecycleLease<string>>();
  let startAborted = false;
  let closes = 0;
  let closeReason: string | undefined;
  const supervisor = createLifecycleSupervisor({ closeTimeoutMs: 100 });
  const handle = supervisor.acquireHandle(
    resource("late-release", (signal) => {
      startAborted = signal.aborted;
      signal.addEventListener("abort", () => (startAborted = true), {
        once: true,
      });
      return pending.promise;
    }),
  );

  const release = handle.release();
  pending.resolve({
    value: "late",
    close: ({ cause }) => {
      closes++;
      closeReason = cause;
    },
  });

  await assert.rejects(handle.value, /aborted/i);
  await release;
  assert.equal(startAborted, true);
  assert.equal(closes, 1);
  assert.equal(closeReason, "release");
  await supervisor.shutdown("quit");
  assert.equal(closes, 1);
});

test("release and shutdown share one in-flight close", async () => {
  const closeSettled = deferred<void>();
  let closes = 0;
  const supervisor = createLifecycleSupervisor();
  const handle = supervisor.acquireHandle(
    resource("shared-close", async () => ({
      value: undefined,
      close: () => {
        closes++;
        return closeSettled.promise;
      },
    })),
  );
  await handle.value;

  const release = handle.release();
  const shutdown = supervisor.shutdown("reload");
  await Promise.resolve();
  assert.equal(closes, 1);

  closeSettled.resolve();
  await release;
  const report = await shutdown;
  assert.equal(report.status, "clean");
  assert.equal(closes, 1);
});

test("shutdown and a later release share one in-flight close", async () => {
  const closeSettled = deferred<void>();
  let closes = 0;
  const supervisor = createLifecycleSupervisor();
  const handle = supervisor.acquireHandle(
    resource("shutdown-first", async () => ({
      value: undefined,
      close: () => {
        closes++;
        return closeSettled.promise;
      },
    })),
  );
  await handle.value;

  const shutdown = supervisor.shutdown("reload");
  await Promise.resolve();
  const release = handle.release();
  assert.equal(closes, 1);

  closeSettled.resolve();
  await release;
  assert.equal((await shutdown).status, "clean");
  assert.equal(closes, 1);
});

test("failed release is reported by shutdown without closing twice", async () => {
  let closes = 0;
  const supervisor = createLifecycleSupervisor();
  const handle = supervisor.acquireHandle(
    resource("release-failure", async () => ({
      value: undefined,
      close: () => {
        closes++;
        throw new Error("release close failed");
      },
    })),
  );
  await handle.value;

  await assert.rejects(handle.release(), /release close failed/);
  const report = await supervisor.shutdown("quit");

  assert.equal(closes, 1);
  assert.equal(report.status, "degraded");
  assert.deepEqual(
    report.failures.map(({ resourceId, phase, kind, message }) => ({
      resourceId,
      phase,
      kind,
      message,
    })),
    [
      {
        resourceId: "release-failure",
        phase: "close",
        kind: "error",
        message: "release close failed",
      },
    ],
  );
});

test("different resources cannot reuse an id", async () => {
  const supervisor = createLifecycleSupervisor();
  const first = resource("collision", async () => ({ value: 1, close() {} }));
  const second = resource("collision", async () => ({ value: 2, close() {} }));
  await supervisor.acquire(first);
  await assert.rejects(supervisor.acquire(second), ResourceConflictError);
  await supervisor.shutdown("quit");
});

test("failed acquisition can be retried", async () => {
  const supervisor = createLifecycleSupervisor();
  const failed = resource("retry", async () => {
    throw new Error("not ready");
  });
  await assert.rejects(supervisor.acquire(failed), /not ready/);
  const value = await supervisor.acquire(
    resource("retry", async () => ({ value: "ready", close() {} })),
  );
  assert.equal(value, "ready");
  await supervisor.shutdown("quit");
});

test("shutdown aborts a pending start and closes a late lease once", async () => {
  const pending = deferred<LifecycleLease<string>>();
  let startAborted = false;
  let closes = 0;
  let closeReason: string | undefined;
  const supervisor = createLifecycleSupervisor({ acquireTimeoutMs: 1_000 });
  const acquiring = supervisor.acquire(
    resource("late", async (signal) => {
      startAborted = signal.aborted;
      signal.addEventListener("abort", () => (startAborted = true), {
        once: true,
      });
      return pending.promise;
    }),
  );

  const shutdown = supervisor.shutdown("reload");
  pending.resolve({
    value: "too late",
    close: async ({ reason }) => {
      closes++;
      closeReason = reason;
    },
  });
  await assert.rejects(acquiring, /shut down|aborted/i);
  const report = await shutdown;
  assert.equal(startAborted, true);
  assert.equal(closes, 1);
  assert.equal(closeReason, "reload");
  assert.equal(report.reason, "reload");
  await supervisor.shutdown("quit");
  assert.equal(closes, 1);
});

test("shutdown reports a pending acquisition that ignores abort", async () => {
  const supervisor = createLifecycleSupervisor({ shutdownTimeoutMs: 10 });
  const acquiring = supervisor.acquire(
    resource(
      "ignores-abort",
      () => new Promise<LifecycleLease<never>>(() => {}),
    ),
  );
  const acquisitionRejected = assert.rejects(acquiring, /shut down|aborted/i);
  const report = await supervisor.shutdown("quit");
  await acquisitionRejected;
  assert.equal(report.status, "degraded");
  assert.deepEqual(
    report.failures.map(({ resourceId, phase, kind }) => ({
      resourceId,
      phase,
      kind,
    })),
    [{ resourceId: "ignores-abort", phase: "acquire", kind: "timeout" }],
  );
});

test("an already timed-out start remains tracked for bounded shutdown", async () => {
  const pending = deferred<LifecycleLease<string>>();
  const lateClosed = deferred<void>();
  let lateCloseReason: string | undefined;
  const supervisor = createLifecycleSupervisor({
    acquireTimeoutMs: 5,
    shutdownTimeoutMs: 10,
  });
  await assert.rejects(
    supervisor.acquire(resource("timed-out-start", () => pending.promise)),
    /Timed out/,
  );
  let retryCloses = 0;
  await supervisor.acquire(
    resource("timed-out-start", async () => ({
      value: "retry",
      close: () => void retryCloses++,
    })),
  );

  const report = await supervisor.shutdown("reload");

  assert.equal(report.status, "degraded");
  assert.equal(retryCloses, 1);
  assert.deepEqual(report.closed, ["timed-out-start"]);
  assert.deepEqual(
    report.failures.map(({ resourceId, phase, kind }) => ({
      resourceId,
      phase,
      kind,
    })),
    [{ resourceId: "timed-out-start", phase: "acquire", kind: "timeout" }],
  );

  pending.resolve({
    value: "late",
    close: ({ reason }) => {
      lateCloseReason = reason;
      lateClosed.resolve();
    },
  });
  await lateClosed.promise;
  assert.equal(lateCloseReason, "reload");
});

test("a timed-out start permits retry and closes its eventual late lease", async () => {
  const firstStart = deferred<LifecycleLease<string>>();
  const firstClosed = deferred<void>();
  let retryCloses = 0;
  const supervisor = createLifecycleSupervisor({ acquireTimeoutMs: 5 });
  await assert.rejects(
    supervisor.acquire(
      resource("retry-after-timeout", () => firstStart.promise),
    ),
    /Timed out/,
  );

  const value = await supervisor.acquire(
    resource("retry-after-timeout", async () => ({
      value: "retry",
      close: () => void retryCloses++,
    })),
  );
  assert.equal(value, "retry");

  firstStart.resolve({
    value: "late",
    close: () => firstClosed.resolve(),
  });
  await firstClosed.promise;

  const report = await supervisor.shutdown("quit");
  assert.equal(report.status, "clean");
  assert.deepEqual(report.closed, ["retry-after-timeout"]);
  assert.equal(retryCloses, 1);
});

test("shutdown reports a failed late closer", async () => {
  const pending = deferred<LifecycleLease<string>>();
  const supervisor = createLifecycleSupervisor({ shutdownTimeoutMs: 100 });
  const acquiring = supervisor.acquire(
    resource("late-close-error", () => pending.promise),
  );
  const shutdown = supervisor.shutdown("fork");
  pending.resolve({
    value: "late",
    close: () => {
      throw new Error("late close failed");
    },
  });
  await assert.rejects(acquiring, /shut down|aborted/i);
  const report = await shutdown;
  assert.equal(report.status, "degraded");
  assert.deepEqual(
    report.failures.map(({ resourceId, phase, kind }) => ({
      resourceId,
      phase,
      kind,
    })),
    [{ resourceId: "late-close-error", phase: "close", kind: "error" }],
  );
});

test("invalid resource deadlines fail before startup", async () => {
  const supervisor = createLifecycleSupervisor();
  let starts = 0;
  await assert.rejects(
    supervisor.acquire(
      resource(
        "invalid-timeout",
        async () => {
          starts++;
          return { value: undefined, close() {} };
        },
        -1,
      ),
    ),
    /closeTimeoutMs must be finite and non-negative/,
  );
  assert.equal(starts, 0);
  await supervisor.shutdown("quit");
});

test("resources close in reverse acceptance order despite completion order", async () => {
  const firstStart = deferred<LifecycleLease<string>>();
  const closed: string[] = [];
  const supervisor = createLifecycleSupervisor();
  const first = supervisor.acquire(resource("first", () => firstStart.promise));
  await supervisor.acquire(
    resource("second", async () => ({
      value: "second",
      close: async () => void closed.push("second"),
    })),
  );
  firstStart.resolve({
    value: "first",
    close: async () => void closed.push("first"),
  });
  await first;

  const report = await supervisor.shutdown("quit");
  assert.deepEqual(closed, ["second", "first"]);
  assert.deepEqual(report.closed, ["second", "first"]);
});

test("shutdown is idempotent, bounded, and continues after close failures", async () => {
  const supervisor = createLifecycleSupervisor({ closeTimeoutMs: 15 });
  let goodCloses = 0;
  await supervisor.acquire(
    resource("good", async () => ({
      value: undefined,
      close: async () => void goodCloses++,
    })),
  );
  await supervisor.acquire(
    resource("throws", async () => ({
      value: undefined,
      close: async () => {
        throw new Error("close failed");
      },
    })),
  );
  await supervisor.acquire(
    resource("stuck", async () => ({
      value: undefined,
      close: () => new Promise(() => {}),
    })),
  );

  const [first, second] = await Promise.all([
    supervisor.shutdown("resume"),
    supervisor.shutdown("quit"),
  ]);
  assert.equal(first, second);
  assert.equal(first.reason, "resume");
  assert.equal(first.status, "degraded");
  assert.equal(goodCloses, 1);
  assert.deepEqual(
    first.failures.map(({ resourceId, kind }) => [resourceId, kind]),
    [
      ["stuck", "timeout"],
      ["throws", "error"],
    ],
  );
  await assert.rejects(
    supervisor.acquire(
      resource("after", async () => ({ value: 1, close() {} })),
    ),
    LifecycleClosedError,
  );
});
