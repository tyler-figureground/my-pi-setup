import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  ScheduleCommand,
  ScheduleInspection,
  ScheduleQuery,
  ScheduleSnapshot,
  SchedulerRuntime,
} from "./src/automation/scheduler/index.ts";
import type {
  CapabilityOperation,
  CapabilityPolicy,
  PolicyMode,
} from "./src/core/policy/index.ts";
import { createSchedulerCapability } from "./src/wiring/scheduler.ts";

interface SchemaNode {
  readonly additionalProperties?: boolean;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly items?: SchemaNode;
  readonly anyOf?: readonly SchemaNode[];
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
  readonly enum?: readonly string[];
}

interface RegisteredTool {
  readonly name: string;
  readonly executionMode?: string;
  readonly parameters: SchemaNode;
  execute(
    toolCallId: string,
    parameters: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    update?: unknown,
    context?: unknown,
  ): Promise<{
    readonly content: readonly { readonly text: string }[];
    readonly details: unknown;
  }>;
}

interface RegisteredCommand {
  handler(args: string, context: unknown): Promise<void>;
}

type EventHandler = (event: unknown, context: unknown) => unknown;

const emptyInspection: ScheduleInspection = {
  schedules: [],
  closed: false,
};

const allowPolicy: CapabilityPolicy = {
  decide(operation) {
    const name = operation.kind === "operation" ? operation.name : "read";
    return {
      kind: "allow",
      operation: name,
      capabilities: [name],
      sideEffecting: name !== "read",
      reason: "fixture allow",
      provenance: { source: "fixture", reference: "allow" },
    };
  },
};

function createHarness(
  input: {
    readonly policy?: () => CapabilityPolicy;
    readonly mode?: () => PolicyMode["kind"];
    readonly actor?: () => "parent" | "subagent" | "scheduled";
    readonly requestId?: () => string;
    readonly inspect?: (query?: ScheduleQuery) => Promise<
      | { readonly ok: true; readonly value: ScheduleInspection }
      | {
          readonly ok: false;
          readonly error: {
            readonly code: "invalid_request";
            readonly message: string;
            readonly retryable: boolean;
          };
        }
    >;
    readonly change?: (command: ScheduleCommand) => Promise<
      | {
          readonly ok: true;
          readonly value: {
            readonly schedule: ScheduleInspection["schedules"][number];
            readonly replayed: boolean;
          };
        }
      | {
          readonly ok: false;
          readonly error: {
            readonly code: "revision_conflict" | "invalid_request";
            readonly message: string;
            readonly retryable: boolean;
          };
        }
    >;
    readonly close?: () => Promise<void>;
  } = {},
) {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const handlers = new Map<string, EventHandler[]>();
  const policyCalls: Array<{
    readonly operation: CapabilityOperation;
    readonly actor: string;
    readonly mode: PolicyMode;
  }> = [];
  let activeTools = ["peer_tool"];
  let closeCalls = 0;
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
      activeTools = [...new Set([...activeTools, tool.name])];
    },
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
    on(name: string, handler: EventHandler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
  };
  const policy = () => {
    const selected = input.policy?.() ?? allowPolicy;
    return {
      decide(
        operation: CapabilityOperation,
        actor: "parent" | "subagent" | "scheduled",
        mode: PolicyMode,
      ) {
        policyCalls.push({ operation, actor, mode });
        return selected.decide(operation, actor, mode);
      },
    } satisfies CapabilityPolicy;
  };
  const runtime: SchedulerRuntime = {
    scheduler: {
      inspect:
        input.inspect ?? (async () => ({ ok: true, value: emptyInspection })),
      change:
        input.change ??
        (async () => ({
          ok: false,
          error: {
            code: "invalid_request",
            message: "fixture change unavailable",
            retryable: false,
          },
        })),
    },
    async close() {
      closeCalls += 1;
      await input.close?.();
    },
  };
  const capability = createSchedulerCapability({
    pi: pi as unknown as ExtensionAPI,
    actor: input.actor ?? (() => "parent"),
    policy,
    mode: input.mode ?? (() => "normal"),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  });
  return {
    activeTools: () => [...activeTools],
    capability,
    closeCalls: () => closeCalls,
    commands,
    handlers,
    policyCalls,
    runtime,
    tools,
  };
}

function snapshot(
  input: Partial<ScheduleSnapshot> & Pick<ScheduleSnapshot, "id" | "schedule">,
): ScheduleSnapshot {
  return {
    id: input.id,
    revision: input.revision ?? 1,
    scope: input.scope ?? "durable",
    state: input.state ?? "active",
    schedule: input.schedule,
    missedRunPolicy: input.missedRunPolicy ?? "run-once",
    nextAt: input.nextAt ?? null,
    binding: {
      projectId: "project-host",
      cwd: "C:/host/project",
      creatorSessionId: "session-host",
      resultRoute: { kind: "session", sessionId: "session-host" },
      executionRole: "scheduled",
    },
    profile: input.profile ?? {
      name: "nightly",
      contentDigest: "a".repeat(64),
      source: { scope: "user", path: "C:/profiles/nightly.yaml" },
    },
    promptArtifact: input.promptArtifact ?? {
      id: "prompt-artifact-secret",
      sha256: "b".repeat(64),
      size: 42,
    },
    policy: input.policy ?? {
      timeoutMs: 900_000,
      maxRetries: 2,
      maxOutputBytes: 1_048_576,
    },
    credentialReferenceCount: input.credentialReferenceCount ?? 0,
    currentOccurrence: input.currentOccurrence ?? null,
    recentOccurrences: input.recentOccurrences ?? [],
    ...(input.blockedReason === undefined
      ? {}
      : { blockedReason: input.blockedReason }),
  };
}

test("scheduler wiring registers exact commands and strict bounded model schemas", async () => {
  const wired = createHarness();

  assert.deepEqual([...wired.commands.keys()], ["schedule", "schedules"]);
  assert.deepEqual(
    [...wired.tools.keys()],
    ["schedule_inspect", "schedule_change"],
  );

  const inspect = wired.tools.get("schedule_inspect");
  assert.ok(inspect);
  assert.equal(inspect.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(inspect.parameters.properties ?? {}), [
    "id",
    "state",
    "includeHistory",
    "afterId",
    "limit",
  ]);
  assert.equal(inspect.parameters.properties?.id?.minLength, 1);
  assert.equal(inspect.parameters.properties?.id?.maxLength, 128);
  assert.deepEqual(inspect.parameters.properties?.state?.enum, [
    "active",
    "paused",
    "blocked",
  ]);
  assert.equal(inspect.parameters.properties?.limit?.minimum, 1);
  assert.equal(inspect.parameters.properties?.limit?.maximum, 25);

  const change = wired.tools.get("schedule_change");
  assert.ok(change);
  assert.equal(change.executionMode, "sequential");
  assert.equal(change.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(change.parameters.properties ?? {}), [
    "action",
    "id",
    "expectedRevision",
    "scope",
    "schedule",
    "missedRunPolicy",
    "profileName",
    "prompt",
    "credentialReferences",
    "policy",
  ]);
  assert.deepEqual(change.parameters.properties?.action?.enum, [
    "create",
    "replace",
    "pause",
    "resume",
    "run-now",
    "delete",
  ]);
  assert.equal(change.parameters.properties?.prompt?.maxLength, 262_144);
  assert.equal(
    change.parameters.properties?.credentialReferences?.maxItems,
    32,
  );
  assert.equal(
    change.parameters.properties?.schedule?.additionalProperties,
    false,
  );
  assert.deepEqual(
    change.parameters.properties?.schedule?.properties?.kind?.enum,
    ["one-shot", "interval", "cron"],
  );
  assert.equal(
    change.parameters.properties?.policy?.additionalProperties,
    false,
  );
  for (const forbidden of [
    "project",
    "projectId",
    "cwd",
    "sessionId",
    "resultRoute",
    "role",
    "tools",
    "trust",
    "credentials",
  ]) {
    assert.equal(forbidden in (change.parameters.properties ?? {}), false);
  }

  assert.deepEqual(wired.activeTools(), ["peer_tool"]);
  await wired.capability.start(wired.runtime);
  assert.deepEqual(wired.activeTools(), [
    "peer_tool",
    "schedule_inspect",
    "schedule_change",
  ]);
  await wired.capability.stop();
  assert.deepEqual(wired.activeTools(), ["peer_tool"]);
  assert.equal(wired.closeCalls(), 1);
});

test("/schedule deterministically parses every time kind into exact normalized core requests", async () => {
  const requests: ScheduleCommand[] = [];
  const confirmations: Array<{
    readonly title: string;
    readonly message: string;
  }> = [];
  const notices: string[] = [];
  let requestSequence = 0;
  const wired = createHarness({
    requestId: () => `command-${++requestSequence}`,
    async change(command) {
      requests.push(command);
      if (command.type !== "create" && command.type !== "replace") {
        throw new Error("fixture expected definition command");
      }
      const digest = createHash("sha256").update(command.prompt).digest("hex");
      return {
        ok: true,
        value: {
          replayed: false,
          schedule: snapshot({
            id: command.id,
            schedule:
              command.schedule.kind === "one-shot"
                ? {
                    kind: "one-shot",
                    at: new Date(command.schedule.at).toISOString(),
                  }
                : command.schedule.kind === "interval"
                  ? {
                      kind: "interval",
                      anchor: new Date(command.schedule.anchor).toISOString(),
                      everyMs: command.schedule.everyMs,
                    }
                  : command.schedule,
            scope: command.scope,
            missedRunPolicy: command.missedRunPolicy,
            profile: {
              name: command.profileName,
              contentDigest: "a".repeat(64),
              source: { scope: "user", path: "C:/profile.yaml" },
            },
            promptArtifact: {
              id: `artifact-${command.id}`,
              sha256: digest,
              size: Buffer.byteLength(command.prompt),
            },
          }),
        },
      };
    },
  });
  await wired.capability.start(wired.runtime);
  const context = {
    mode: "tui",
    hasUI: true,
    async waitForIdle() {},
    ui: {
      async confirm(title: string, message: string) {
        confirmations.push({ title, message });
        return true;
      },
      notify(message: string) {
        notices.push(message);
      },
    },
  };
  const command = wired.commands.get("schedule");
  assert.ok(command);

  await command.handler(
    "create one-shot deploy-once 2027-01-01T09:30:00-05:00 durable run-once nightly -- one-shot prompt secret",
    context,
  );
  await command.handler(
    "create interval heartbeat 2027-01-01T00:00:00Z 3600000 session skip hourly -- interval prompt secret",
    context,
  );
  await command.handler(
    'create cron weekday-report "0 9 * * 1-5" America/New_York durable run-once reporter -- cron prompt secret',
    context,
  );

  assert.deepEqual(requests, [
    {
      type: "create",
      requestId: "command-1",
      id: "deploy-once",
      expectedRevision: 0,
      scope: "durable",
      schedule: { kind: "one-shot", at: "2027-01-01T14:30:00.000Z" },
      missedRunPolicy: "run-once",
      profileName: "nightly",
      prompt: "one-shot prompt secret",
    },
    {
      type: "create",
      requestId: "command-2",
      id: "heartbeat",
      expectedRevision: 0,
      scope: "session",
      schedule: {
        kind: "interval",
        anchor: "2027-01-01T00:00:00.000Z",
        everyMs: 3_600_000,
      },
      missedRunPolicy: "skip",
      profileName: "hourly",
      prompt: "interval prompt secret",
    },
    {
      type: "create",
      requestId: "command-3",
      id: "weekday-report",
      expectedRevision: 0,
      scope: "durable",
      schedule: {
        kind: "cron",
        expression: "0 9 * * 1-5",
        timeZone: "America/New_York",
      },
      missedRunPolicy: "run-once",
      profileName: "reporter",
      prompt: "cron prompt secret",
    },
  ]);
  assert.equal(confirmations.length, 3);
  for (const [index, prompt] of [
    "one-shot prompt secret",
    "interval prompt secret",
    "cron prompt secret",
  ].entries()) {
    const confirmation = confirmations[index]!.message;
    const digest = createHash("sha256").update(prompt).digest("hex");
    assert.match(confirmation, new RegExp(digest));
    assert.match(
      confirmation,
      new RegExp(`${Buffer.byteLength(prompt)} bytes`),
    );
    assert.doesNotMatch(confirmation, new RegExp(prompt));
  }
  assert.match(confirmations[0]!.message, /2027-01-01T14:30:00\.000Z/);
  assert.match(confirmations[1]!.message, /3600000 ms/);
  assert.match(confirmations[2]!.message, /America\/New_York/);
  for (const prompt of [
    "one-shot prompt secret",
    "interval prompt secret",
    "cron prompt secret",
  ]) {
    assert.doesNotMatch(notices.join("\n"), new RegExp(prompt));
  }
});

test("/schedule controls bind current metadata and send exact revisioned requests", async () => {
  const requests: ScheduleCommand[] = [];
  const confirmations: string[] = [];
  let current = snapshot({
    id: "controlled",
    revision: 4,
    schedule: {
      kind: "cron",
      expression: "0 9 * * 1-5",
      timeZone: "America/New_York",
    },
    profile: {
      name: "reporter",
      contentDigest: "a".repeat(64),
      source: { scope: "user", path: "private-profile-path" },
    },
    promptArtifact: {
      id: "private-prompt-artifact",
      sha256: "c".repeat(64),
      size: 77,
    },
  });
  let requestSequence = 0;
  const wired = createHarness({
    requestId: () => `control-${++requestSequence}`,
    inspect: async () => ({
      ok: true,
      value: { schedules: [current], closed: false },
    }),
    async change(command) {
      requests.push(command);
      current = snapshot({
        ...current,
        revision: current.revision + 1,
        state:
          command.type === "pause"
            ? "paused"
            : command.type === "delete"
              ? "deleted"
              : "active",
      });
      return {
        ok: true,
        value: { schedule: current, replayed: false },
      };
    },
  });
  await wired.capability.start(wired.runtime);
  const context = {
    mode: "rpc",
    hasUI: true,
    waitForIdle: async () => {},
    ui: {
      async confirm(_title: string, message: string) {
        confirmations.push(message);
        return true;
      },
      notify() {},
    },
  };
  const command = wired.commands.get("schedule")!;

  await command.handler("pause controlled 4", context);
  await command.handler("resume controlled 5", context);
  await command.handler("run-now controlled 6", context);
  await command.handler("delete controlled 7", context);

  assert.deepEqual(requests, [
    {
      type: "pause",
      requestId: "control-1",
      id: "controlled",
      expectedRevision: 4,
    },
    {
      type: "resume",
      requestId: "control-2",
      id: "controlled",
      expectedRevision: 5,
    },
    {
      type: "run-now",
      requestId: "control-3",
      id: "controlled",
      expectedRevision: 6,
    },
    {
      type: "delete",
      requestId: "control-4",
      id: "controlled",
      expectedRevision: 7,
    },
  ]);
  for (const confirmation of confirmations) {
    assert.match(confirmation, /Expected revision:/);
    assert.match(confirmation, /cron "0 9 \* \* 1-5"/);
    assert.match(confirmation, /America\/New_York/);
    assert.match(confirmation, /Profile: reporter/);
    assert.match(confirmation, new RegExp("c".repeat(64)));
    assert.match(confirmation, /77 bytes/);
    assert.doesNotMatch(confirmation, /private-prompt-artifact/);
    assert.doesNotMatch(confirmation, /private-profile-path/);
  }
});

test("mutation confirmation is one-use and fails closed on decline, revision drift, policy drift, and Plan Mode", async () => {
  let revision = 1;
  let changes = 0;
  let confirms = 0;
  let allowConfirmation = false;
  let policyChecks = 0;
  let denyAfterConfirmation = false;
  let platformMode: PolicyMode["kind"] = "normal";
  const policy: CapabilityPolicy = {
    decide(operation) {
      const mutation =
        operation.kind === "operation" && operation.name === "orchestration";
      if (mutation) policyChecks += 1;
      const denied = mutation && denyAfterConfirmation && policyChecks > 1;
      return {
        kind: denied ? "deny" : "allow",
        operation: mutation ? "orchestration" : "read",
        capabilities: [mutation ? "orchestration" : "read"],
        sideEffecting: mutation,
        reason: denied ? "policy changed after confirmation" : "allowed",
        provenance: { source: "fixture", reference: denied ? "deny" : "allow" },
      };
    },
  };
  const wired = createHarness({
    policy: () => policy,
    mode: () => platformMode,
    inspect: async () => ({
      ok: true,
      value: {
        schedules: [
          snapshot({
            id: "guarded",
            revision,
            schedule: { kind: "one-shot", at: "2027-01-02T00:00:00.000Z" },
          }),
        ],
        closed: false,
      },
    }),
    async change() {
      changes += 1;
      throw new Error("guarded change must not run");
    },
  });
  await wired.capability.start(wired.runtime);
  const context = {
    mode: "tui",
    hasUI: true,
    waitForIdle: async () => {},
    ui: {
      async confirm() {
        confirms += 1;
        if (allowConfirmation && !denyAfterConfirmation) revision += 1;
        return allowConfirmation;
      },
      notify() {},
    },
  };
  const command = wired.commands.get("schedule")!;

  await command.handler("pause guarded 1", context);
  assert.equal(changes, 0);
  assert.equal(confirms, 1);

  allowConfirmation = true;
  await assert.rejects(
    () => command.handler("pause guarded 1", context),
    /approval is stale/,
  );
  assert.equal(changes, 0);

  revision = 1;
  denyAfterConfirmation = true;
  policyChecks = 0;
  await assert.rejects(
    () => command.handler("pause guarded 1", context),
    /policy changed after confirmation/,
  );
  assert.equal(changes, 0);

  platformMode = "plan";
  denyAfterConfirmation = false;
  policyChecks = 0;
  const confirmationsBeforePlan = confirms;
  await assert.rejects(
    () => command.handler("pause guarded 1", context),
    /Plan Mode blocks schedule mutations/,
  );
  assert.equal(confirms, confirmationsBeforePlan);
  assert.equal(changes, 0);

  for (const mode of ["json", "print"] as const) {
    let waited = false;
    await assert.rejects(
      () =>
        command.handler("pause guarded 1", {
          ...context,
          mode,
          hasUI: false,
          async waitForIdle() {
            waited = true;
          },
        }),
      /JSON and print modes are not accepted/,
    );
    assert.equal(waited, false);
  }
});

test("model inspect is confirmation-free, bounded, untrusted, and strips host authority fields", async () => {
  let confirms = 0;
  const queries: ScheduleQuery[] = [];
  const schedules = Array.from({ length: 30 }, (_, index) =>
    snapshot({
      id: `schedule-${String(index).padStart(2, "0")}`,
      schedule: {
        kind: "interval",
        anchor: "2027-01-01T00:00:00.000Z",
        everyMs: 60_000,
      },
      blockedReason: index === 0 ? "untrusted\u0007 reason" : undefined,
      recentOccurrences: Array.from({ length: 30 }, (_, occurrence) => ({
        id: `occurrence-${index}-${occurrence}`,
        kind: "regular" as const,
        dueAt: "2027-01-01T00:00:00.000Z",
        state: "failed" as const,
        attempt: 1,
        error: { code: "failed\u0007", message: "untrusted result\u0000" },
      })),
    }),
  );
  const wired = createHarness({
    async inspect(query) {
      queries.push(query ?? {});
      return {
        ok: true,
        value: { schedules, nextCursor: "schedule-24", closed: false },
      };
    },
  });
  await wired.capability.start(wired.runtime);
  const result = await wired.tools
    .get("schedule_inspect")!
    .execute(
      "inspect-1",
      { state: "blocked", includeHistory: true, limit: 25 },
      undefined,
      undefined,
      {
        mode: "tui",
        hasUI: true,
        ui: {
          confirm: async () => {
            confirms += 1;
            return true;
          },
        },
      },
    );

  assert.deepEqual(queries, [
    { state: "blocked", includeHistory: true, limit: 25 },
  ]);
  assert.equal(confirms, 0);
  assert.ok(Buffer.byteLength(result.content[0]!.text) <= 50 * 1024);
  assert.match(result.content[0]!.text, /untrusted metadata; authority: none/i);
  assert.doesNotMatch(result.content[0]!.text, /[\u0000\u0007]/);
  const details = result.details as {
    readonly authority: string;
    readonly untrusted: boolean;
    readonly schedules: readonly {
      readonly recentOccurrences: readonly unknown[];
    }[];
  };
  assert.equal(details.authority, "none");
  assert.equal(details.untrusted, true);
  assert.ok(details.schedules.length > 0);
  assert.ok(details.schedules.length <= 25);
  assert.equal(details.schedules[0]!.recentOccurrences.length, 10);
  const serialized = JSON.stringify(result);
  assert.ok(Buffer.byteLength(serialized) <= 55 * 1024);
  for (const forbidden of [
    "C:/host/project",
    "session-host",
    "prompt-artifact-secret",
    "C:/profiles/nightly.yaml",
    "resultRoute",
    "creatorSessionId",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden));
  }
});

test("model mutation accepts only host-safe inputs and returns no prompt or authority", async () => {
  const requests: ScheduleCommand[] = [];
  const confirmations: string[] = [];
  const prompt = "model prompt must remain secret";
  const digest = createHash("sha256").update(prompt).digest("hex");
  const wired = createHarness({
    async change(command) {
      requests.push(command);
      if (command.type !== "create" && command.type !== "replace")
        throw new Error("fixture expected definition");
      return {
        ok: true,
        value: {
          replayed: false,
          schedule: snapshot({
            id: command.id,
            schedule: command.schedule,
            scope: command.scope,
            profile: {
              name: command.profileName,
              contentDigest: "a".repeat(64),
              source: { scope: "user", path: "private" },
            },
            promptArtifact: {
              id: "private-artifact",
              sha256: digest,
              size: Buffer.byteLength(command.prompt),
            },
            credentialReferenceCount: command.credentialReferences?.length ?? 0,
          }),
        },
      };
    },
  });
  await wired.capability.start(wired.runtime);
  const result = await wired.tools.get("schedule_change")!.execute(
    "mutation-7",
    {
      action: "create",
      id: "model-created",
      expectedRevision: 0,
      scope: "durable",
      schedule: {
        kind: "cron",
        expression: " 0  9 * * 1-5 ",
        timeZone: "America/New_York",
      },
      missedRunPolicy: "run-once",
      profileName: "reporter",
      prompt,
      credentialReferences: ["credential:ci-read"],
      policy: {
        timeoutMs: 12_000,
        maxRetries: 0,
        maxOutputBytes: 2_048,
      },
    },
    undefined,
    undefined,
    {
      mode: "rpc",
      hasUI: true,
      ui: {
        async confirm(_title: string, message: string) {
          confirmations.push(message);
          return true;
        },
      },
    },
  );

  assert.deepEqual(requests, [
    {
      type: "create",
      requestId: "pi-tool:mutation-7",
      id: "model-created",
      expectedRevision: 0,
      scope: "durable",
      schedule: {
        kind: "cron",
        expression: "0 9 * * 1-5",
        timeZone: "America/New_York",
      },
      missedRunPolicy: "run-once",
      profileName: "reporter",
      prompt,
      credentialReferences: ["credential:ci-read"],
      policy: {
        timeoutMs: 12_000,
        maxRetries: 0,
        maxOutputBytes: 2_048,
      },
    },
  ]);
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0]!, new RegExp(digest));
  assert.doesNotMatch(confirmations[0]!, new RegExp(prompt));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(prompt));
  assert.match(result.content[0]!.text, /untrusted metadata; authority: none/i);
  assert.equal(
    (result.details as { readonly authority: string }).authority,
    "none",
  );
});

test("/schedules uses deterministic bounded query grammar and history rendering", async () => {
  const queries: ScheduleQuery[] = [];
  const notices: string[] = [];
  const wired = createHarness({
    async inspect(query) {
      queries.push(query ?? {});
      return {
        ok: true,
        value: {
          schedules: [
            snapshot({
              id: "listed",
              state: "blocked",
              schedule: { kind: "one-shot", at: "2027-01-02T00:00:00.000Z" },
              blockedReason: "blocked\u0007 by untrusted metadata",
              recentOccurrences: Array.from({ length: 20 }, (_, index) => ({
                id: `history-${index}`,
                kind: "regular" as const,
                dueAt: "2027-01-01T00:00:00.000Z",
                state: "completed" as const,
                attempt: 1,
              })),
            }),
          ],
          nextCursor: "listed",
          closed: false,
        },
      };
    },
  });
  await wired.capability.start(wired.runtime);
  await wired.commands
    .get("schedules")!
    .handler("id listed blocked history after earlier limit 7", {
      mode: "tui",
      hasUI: true,
      waitForIdle: async () => {},
      ui: { notify: (message: string) => notices.push(message) },
    });

  assert.deepEqual(queries, [
    {
      id: "listed",
      state: "blocked",
      includeHistory: true,
      afterId: "earlier",
      limit: 7,
    },
  ]);
  assert.equal(notices.length, 1);
  assert.ok(Buffer.byteLength(notices[0]!) <= 50 * 1024);
  assert.match(notices[0]!, /prompt sha256/);
  assert.match(notices[0]!, /history-19/);
  assert.doesNotMatch(notices[0]!, /history-0(?:\D|$)/);
  assert.doesNotMatch(notices[0]!, /[\u0000\u0007]/);
  await assert.rejects(
    () =>
      wired.commands.get("schedules")!.handler("unknown-token", {
        mode: "tui",
        hasUI: true,
        waitForIdle: async () => {},
        ui: { notify() {} },
      }),
    /Usage: \/schedules/,
  );
});

test("Plan Mode dynamically leaves inspect active and removes or denies mutation", async () => {
  let mode: PolicyMode["kind"] = "normal";
  let confirms = 0;
  const wired = createHarness({ mode: () => mode });
  await wired.capability.start(wired.runtime);
  assert.ok(wired.activeTools().includes("schedule_change"));

  mode = "plan";
  for (const handler of wired.handlers.get("before_agent_start") ?? [])
    await handler({}, {});
  assert.ok(wired.activeTools().includes("schedule_inspect"));
  assert.equal(wired.activeTools().includes("schedule_change"), false);
  await assert.rejects(
    () =>
      wired.tools
        .get("schedule_change")!
        .execute(
          "plan-bypass",
          { action: "pause", id: "planned", expectedRevision: 1 },
          undefined,
          undefined,
          {
            mode: "tui",
            hasUI: true,
            ui: {
              confirm: async () => {
                confirms += 1;
                return true;
              },
            },
          },
        ),
    /Plan Mode/,
  );
  assert.equal(confirms, 0);

  mode = "normal";
  for (const handler of wired.handlers.get("before_agent_start") ?? [])
    await handler({}, {});
  assert.ok(wired.activeTools().includes("schedule_change"));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("inspection denial and command mode or grammar errors fail before UI and core", async () => {
  let inspections = 0;
  let confirmations = 0;
  const denyRead: CapabilityPolicy = {
    decide(operation) {
      const read = operation.kind === "operation" && operation.name === "read";
      return {
        kind: read ? "deny" : "allow",
        operation: read ? "read" : "orchestration",
        capabilities: [read ? "read" : "orchestration"],
        sideEffecting: !read,
        reason: read ? "inspection denied" : "allowed",
        provenance: { source: "fixture", reference: read ? "deny" : "allow" },
      };
    },
  };
  const wired = createHarness({
    policy: () => denyRead,
    inspect: async () => {
      inspections += 1;
      return { ok: true, value: emptyInspection };
    },
  });
  await wired.capability.start(wired.runtime);
  await assert.rejects(
    () =>
      wired.tools
        .get("schedule_inspect")!
        .execute("denied", {}, undefined, undefined, {
          mode: "tui",
          hasUI: true,
          ui: {
            confirm: async () => {
              confirmations += 1;
              return true;
            },
          },
        }),
    /inspection denied/,
  );
  assert.equal(inspections, 0);
  assert.equal(confirmations, 0);

  const schedule = wired.commands.get("schedule")!;
  await assert.rejects(
    () =>
      schedule.handler(
        "create cron malformed 0 9 * * 1-5 UTC durable skip nightly -- prompt",
        {
          mode: "tui",
          hasUI: true,
          waitForIdle: async () => {},
          ui: { confirm: async () => true, notify() {} },
        },
      ),
    /Usage:\n\/schedule create one-shot/,
  );
  for (const name of ["schedule", "schedules"] as const) {
    for (const mode of ["json", "print"] as const) {
      await assert.rejects(
        () =>
          wired.commands.get(name)!.handler("", {
            mode,
            hasUI: false,
            waitForIdle: async () => {
              throw new Error("must not wait");
            },
            ui: {},
          }),
        /JSON and print modes are not accepted/,
      );
    }
  }
});

test("stop and restart fence pending confirmation and late inspection without UI or change", async () => {
  const approval = deferred<boolean>();
  const inspection = deferred<{
    readonly ok: true;
    readonly value: ScheduleInspection;
  }>();
  let inspectionStarted = false;
  let oldChanges = 0;
  const notices: string[] = [];
  const old = createHarness({
    inspect: () => {
      inspectionStarted = true;
      return inspection.promise;
    },
    async change() {
      oldChanges += 1;
      throw new Error("old generation must not mutate");
    },
  });
  await old.capability.start(old.runtime);
  const listing = old.commands.get("schedules")!.handler("", {
    mode: "tui",
    hasUI: true,
    waitForIdle: async () => {},
    ui: { notify: (message: string) => notices.push(message) },
  });
  for (let spin = 0; !inspectionStarted && spin < 20; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(inspectionStarted, true);
  await old.capability.stop();
  inspection.resolve({ ok: true, value: emptyInspection });
  await assert.rejects(() => listing, /generation stopped/);
  assert.equal(notices.length, 0);

  const currentSchedule = snapshot({
    id: "pending",
    schedule: { kind: "one-shot", at: "2027-01-02T00:00:00.000Z" },
  });
  const pending = createHarness({
    inspect: async () => ({
      ok: true,
      value: { schedules: [currentSchedule], closed: false },
    }),
    async change() {
      oldChanges += 1;
      throw new Error("old generation must not mutate");
    },
  });
  await pending.capability.start(pending.runtime);
  let confirmationOpened = false;
  const mutation = pending.commands
    .get("schedule")!
    .handler("pause pending 1", {
      mode: "tui",
      hasUI: true,
      waitForIdle: async () => {},
      ui: {
        confirm: async () => {
          confirmationOpened = true;
          return approval.promise;
        },
        notify: (message: string) => notices.push(message),
      },
    });
  for (let spin = 0; !confirmationOpened && spin < 20; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(confirmationOpened, true);
  await pending.capability.stop();
  await pending.capability.start({
    scheduler: {
      inspect: async () => ({ ok: true, value: emptyInspection }),
      change: async () => {
        throw new Error("fresh runtime must not receive old mutation");
      },
    },
    close: async () => {},
  });
  approval.resolve(true);
  await assert.rejects(() => mutation, /generation stopped/);
  assert.equal(oldChanges, 0);
  assert.deepEqual(notices, []);
});

test("stop drains an already invoked core change and suppresses its late UI", async () => {
  const changed = deferred<{
    readonly ok: true;
    readonly value: {
      readonly schedule: ScheduleSnapshot;
      readonly replayed: boolean;
    };
  }>();
  let changeCalls = 0;
  const notices: string[] = [];
  const currentSchedule = snapshot({
    id: "in-flight",
    schedule: { kind: "one-shot", at: "2027-01-02T00:00:00.000Z" },
  });
  const wired = createHarness({
    inspect: async () => ({
      ok: true,
      value: { schedules: [currentSchedule], closed: false },
    }),
    change() {
      changeCalls += 1;
      return changed.promise;
    },
  });
  await wired.capability.start(wired.runtime);
  const mutation = wired.commands
    .get("schedule")!
    .handler("pause in-flight 1", {
      mode: "tui",
      hasUI: true,
      waitForIdle: async () => {},
      ui: {
        confirm: async () => true,
        notify: (message: string) => notices.push(message),
      },
    });
  for (let spin = 0; changeCalls === 0 && spin < 20; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(changeCalls, 1);
  let stopped = false;
  const stopping = wired.capability.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stopped, false);
  changed.resolve({
    ok: true,
    value: {
      replayed: false,
      schedule: snapshot({
        ...currentSchedule,
        revision: 2,
        state: "paused",
      }),
    },
  });
  await stopping;
  await assert.rejects(() => mutation, /generation stopped/);
  assert.deepEqual(notices, []);
});

test("child role cannot own or later mutate Scheduler", async () => {
  const child = createHarness({ actor: () => "subagent" });
  await assert.rejects(
    () => child.capability.start(child.runtime),
    /Parent execution role/,
  );

  let actor: "parent" | "subagent" = "parent";
  let confirms = 0;
  const changedRole = createHarness({
    actor: () => actor,
    inspect: async () => ({
      ok: true,
      value: {
        schedules: [
          snapshot({
            id: "role-guarded",
            schedule: { kind: "one-shot", at: "2027-01-02T00:00:00.000Z" },
          }),
        ],
        closed: false,
      },
    }),
  });
  await changedRole.capability.start(changedRole.runtime);
  actor = "subagent";
  await assert.rejects(
    () =>
      changedRole.commands.get("schedule")!.handler("pause role-guarded 1", {
        mode: "tui",
        hasUI: true,
        waitForIdle: async () => {},
        ui: {
          confirm: async () => {
            confirms += 1;
            return true;
          },
          notify() {},
        },
      }),
    /Only Parent execution role/,
  );
  assert.equal(confirms, 0);
});
