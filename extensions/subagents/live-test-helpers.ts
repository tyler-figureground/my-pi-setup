import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import {
  findWindowsProcessIdentitiesByCommandLine,
  isWindowsProcessIdentityAlive,
} from "../platform/src/core/processes/windows-tree.ts";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import type { SubagentEvent, SubagentSnapshot } from "./src/domain.ts";
import { SubagentManagerLive, type SubagentReadModel } from "./src/manager.ts";

export function createObservedSubagentRuntime(
  backend: SubagentBackend,
  events: SubagentEvent[],
) {
  const observed = {
    ...backend,
    spawn(task) {
      return backend.spawn(task).pipe(
        Effect.map((session) => ({
          ...session,
          events: session.events.pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            ),
          ),
        })),
      );
    },
  } satisfies SubagentBackend;
  const registry = Layer.succeed(
    BackendRegistry,
    new Map([[backend.name, observed]]),
  );
  return ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)));
}

export function deadline<A>(
  operation: Promise<A>,
  timeoutMs: number,
  label: string,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function waitForRunning(
  view: SubagentReadModel,
  id: string,
  timeoutMs: number,
  label: string,
) {
  return new Promise<void>((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`${label} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    const check = () => {
      if (view.get(id)?.status !== "running") return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    unsubscribe = view.subscribeTo(id, check);
    check();
  });
}

export async function disposeLiveRuntime(runtime: {
  readonly dispose: () => Promise<void>;
}) {
  let codexRoots: Awaited<
    ReturnType<typeof findWindowsProcessIdentitiesByCommandLine>
  > = [];
  if (process.platform === "win32") {
    try {
      codexRoots = await findWindowsProcessIdentitiesByCommandLine(
        "--disable multi_agent app-server --stdio",
      );
    } catch {
      // No captured identity means a disposal error remains unverifiable and
      // is rethrown below. A runtime whose process already exited disposes
      // normally without needing this race check.
    }
  }
  try {
    await runtime.dispose();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const racedWithWindowsTreeExit =
      process.platform === "win32" &&
      message.includes("Windows process operation failed") &&
      (message.includes("There is no running instance of the task") ||
        message.includes("The operation attempted is not supported"));
    if (!racedWithWindowsTreeExit) throw error;
    assert.ok(
      codexRoots.length > 0,
      "Codex teardown error had no captured process identity",
    );
    const stillAlive = (
      await Promise.all(
        codexRoots.map((identity) => isWindowsProcessIdentityAlive(identity)),
      )
    ).filter(Boolean);
    assert.equal(
      stillAlive.length,
      0,
      "Codex teardown reported an already-exited race while its process remained alive",
    );
  }
}

export function assertLiveMetered(snapshot: SubagentSnapshot | undefined) {
  assert.ok(snapshot);
  const metered = snapshot.metered.tokens;
  assert.ok(typeof metered === "number");
  assert.ok(Number.isFinite(metered));
  assert.ok(metered > 0);

  const occupancy = snapshot.usage.tokens;
  assert.ok(typeof occupancy === "number");
  assert.ok(Number.isFinite(occupancy));
  assert.ok(occupancy > 0);
  assert.notStrictEqual(snapshot.metered, snapshot.usage);
  return metered;
}

export function latestMeteredUsage(events: ReadonlyArray<SubagentEvent>) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?._tag === "UsageChanged" && event.meteredTokens !== undefined) {
      return event;
    }
  }
  return undefined;
}

export function latestOccupancyUsage(events: ReadonlyArray<SubagentEvent>) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?._tag === "UsageChanged" && event.tokens !== undefined) {
      return event;
    }
  }
  return undefined;
}

function record(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveFinite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

export async function claudeAssistantBilling(sessionFilePath: string) {
  const jsonl = await readFile(sessionFilePath, "utf8");
  const billedByRequest = new Map<string, number>();
  for (const line of jsonl.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown> | undefined;
    try {
      entry = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (entry?.type !== "assistant") continue;
    const message = record(entry.message);
    const usage = record(message?.usage);
    const requestId =
      typeof entry.requestId === "string"
        ? entry.requestId
        : typeof message?.id === "string"
          ? message.id
          : undefined;
    if (!usage || !requestId) continue;
    const billed =
      positiveFinite(usage.input_tokens) +
      positiveFinite(usage.cache_read_input_tokens) +
      positiveFinite(usage.cache_creation_input_tokens) +
      positiveFinite(usage.output_tokens);
    billedByRequest.set(
      requestId,
      Math.max(billedByRequest.get(requestId) ?? 0, billed),
    );
  }
  return [...billedByRequest.values()].reduce(
    (total, billed) => total + billed,
    0,
  );
}
