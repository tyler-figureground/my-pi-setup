import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createMonitorRegistry } from "./src/automation/monitors/index.ts";
import {
  createTerminalMonitorSourceFactory,
  type TerminalObservation,
  type TerminalObservationSource,
} from "./src/automation/monitors/terminal-source.ts";
import type {
  MonitorChangeReceipt,
  MonitorCommand,
  MonitorDeliveryRequest,
  MonitorOutcome,
  MonitorRegistryOptions,
  MonitorSourceEvent,
} from "./src/automation/monitors/model.ts";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
import {
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileSystemMonitorSourceFactory } from "./src/automation/monitors/filesystem-source.ts";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  createJsonPollAdapter,
  createPollMonitorSourceFactory,
} from "./src/automation/monitors/poll-source.ts";
import { WebSocketServer } from "ws";
import { createWebSocketMonitorSourceFactory } from "./src/automation/monitors/websocket-source.ts";
import { createProductionMonitorSourceFactory } from "./src/automation/monitors/sources.ts";
import { createLifecycleSupervisor } from "./src/core/lifecycle/supervisor.ts";
import { createTriggerEngine } from "./src/automation/triggers/index.ts";
import {
  createMemoryStateStore,
  type StateStore,
} from "./src/core/persistence/index.ts";
import { createSessionBrokerMonitorDelivery } from "./src/automation/monitors/delivery.ts";
import type { SessionBroker } from "./src/messaging/index.ts";

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

function createFixture() {
  const sourceStarts: string[] = [];
  const deliveries: string[] = [];
  const artifacts = createInMemoryArtifactStore();
  const lifecycle = createLifecycleSupervisor();
  const triggers = createTriggerEngine({ hostId: "monitor-test-host" });
  const options: Mutable<MonitorRegistryOptions> = {
    ownerId: "monitor-registry-test",
    binding: {
      projectId: "non-git:monitor-test",
      cwd: "C:/monitor-test",
      sessionId: "parent-session",
    },
    triggers,
    lifecycle,
    artifacts,
    sources: {
      async open(definition) {
        sourceStarts.push(definition.id);
        return { close() {} };
      },
    },
    delivery: {
      async deliver(request) {
        deliveries.push(request.deliveryId);
        return {
          ok: true,
          value: { state: "delivered" },
        };
      },
    },
    authority: {
      async authorize() {
        return {
          ok: true,
          value: { allowed: true },
        };
      },
    },
  };
  return {
    sourceStarts,
    deliveries,
    artifacts,
    lifecycle,
    triggers,
    options,
  };
}

test("committed Monitor state and matched delivery publish typed platform events", async () => {
  const fixture = createFixture();
  const events: string[] = [];
  let emit: ((event: MonitorSourceEvent) => void) | undefined;
  fixture.options.hookEvents = {
    publish(event) {
      events.push(event);
    },
  };
  fixture.options.limits = { batchWindowMs: 1 };
  fixture.options.sources = {
    async open(_definition, listener) {
      emit = listener;
      return { close() {} };
    },
  };
  const opened = await createMonitorRegistry(fixture.options);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const created = await opened.value.registry.change({
    type: "create",
    requestId: "event-monitor-create",
    id: "event-monitor",
    expectedRevision: 0,
    scope: "session",
    source: { kind: "terminal", terminalId: "terminal-1" },
    delivery: { kind: "session", sessionId: "result-session" },
  });
  assert.equal(created.ok, true);
  emit?.({ type: "terminal.line", payload: { line: "ready" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ["monitor.state_changed", "monitor.matched"]);
  await opened.value.close();
  await fixture.triggers.close();
  await fixture.lifecycle.shutdown("quit");
});

test("create is revisioned and replays the same request without another source", async () => {
  const fixture = createFixture();
  const opened = await createMonitorRegistry(fixture.options);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const command = {
    type: "create" as const,
    requestId: "create-build-log",
    id: "build-log",
    expectedRevision: 0,
    scope: "session" as const,
    source: { kind: "terminal" as const, terminalId: "terminal-7" },
    matcher: { kind: "literal" as const, value: "READY" },
    delivery: { kind: "session" as const, sessionId: "result-session" },
  };
  const created = await opened.value.registry.change(command);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.replayed, false);
  assert.equal(created.value.monitor.revision, 1);

  const replayed = await opened.value.registry.change(command);
  assert.equal(replayed.ok, true);
  if (replayed.ok) assert.equal(replayed.value.replayed, true);
  assert.deepEqual(fixture.sourceStarts, ["build-log"]);

  const inspected = await opened.value.registry.inspect({ id: "build-log" });
  assert.equal(inspected.ok, true);
  if (inspected.ok) {
    assert.equal(inspected.value.monitors[0]?.state, "active");
    assert.equal(inspected.value.monitors[0]?.source.kind, "terminal");
  }

  await opened.value.close();
  await fixture.triggers.close();
  await fixture.lifecycle.shutdown("quit");
});

test("pause fences callbacks before waiting for source release", async () => {
  const fixture = createFixture();
  let emit:
    ((event: { type: string; payload: { text: string } }) => void) | undefined;
  let finishClose: (() => void) | undefined;
  fixture.options.sources = {
    async open(definition, publish) {
      fixture.sourceStarts.push(definition.id);
      emit = publish;
      return {
        close() {
          return new Promise<void>((resolve) => {
            finishClose = resolve;
          });
        },
      };
    },
  };
  const opened = await createMonitorRegistry(fixture.options);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const created = await opened.value.registry.change({
    type: "create",
    requestId: "pause-create",
    id: "pause-monitor",
    expectedRevision: 0,
    scope: "session",
    source: { kind: "terminal", terminalId: "terminal-8" },
    matcher: { kind: "literal", value: "READY" },
    delivery: { kind: "session", sessionId: "result-session" },
  });
  assert.equal(created.ok, true);

  let settled = false;
  const pausing = opened.value.registry
    .change({
      type: "pause",
      requestId: "pause-control",
      id: "pause-monitor",
      expectedRevision: 1,
    })
    .finally(() => {
      settled = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false);
  emit?.({ type: "terminal.line", payload: { text: "READY" } });
  finishClose?.();

  const paused = await pausing;
  assert.equal(paused.ok, true);
  if (paused.ok) {
    assert.equal(paused.value.monitor.revision, 2);
    assert.equal(paused.value.monitor.state, "paused");
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(fixture.deliveries, []);

  await opened.value.close();
  await fixture.triggers.close();
  await fixture.lifecycle.shutdown("quit");
});

test("terminal source frames CRLF lines and delivers redacted Artifact evidence", async () => {
  let listener: ((event: TerminalObservation) => unknown) | undefined;
  let observationClosed = false;
  const terminalSource: TerminalObservationSource = {
    async observe(
      _request: { terminalId: string; afterSequence?: number },
      next,
    ) {
      listener = next;
      return {
        ok: true as const,
        value: {
          close: () => {
            observationClosed = true;
          },
        },
      };
    },
  };
  const fixture = createFixture();
  const requests: MonitorDeliveryRequest[] = [];
  fixture.options.sources = createTerminalMonitorSourceFactory(terminalSource);
  fixture.options.delivery = {
    async deliver(request) {
      requests.push(request);
      return { ok: true, value: { state: "delivered" } };
    },
  };
  const opened = await createMonitorRegistry({
    ...fixture.options,
    limits: { batchWindowMs: 10 },
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const created = await opened.value.registry.change({
    type: "create",
    requestId: "terminal-lines-create",
    id: "terminal-lines",
    expectedRevision: 0,
    scope: "session",
    source: { kind: "terminal", terminalId: "terminal-9", framing: "line" },
    matcher: { kind: "literal", value: "READY" },
    delivery: { kind: "session", sessionId: "result-session" },
  });
  assert.equal(created.ok, true);

  listener?.({
    kind: "output",
    terminalId: "terminal-9",
    sequence: 1,
    stream: "stdout",
    text: "token=super-secret\r",
    byteLength: 19,
    startByte: 0,
    endByte: 19,
  });
  listener?.({
    kind: "output",
    terminalId: "terminal-9",
    sequence: 2,
    stream: "stdout",
    text: "\nRE",
    byteLength: 3,
    startByte: 19,
    endByte: 22,
  });
  listener?.({
    kind: "output",
    terminalId: "terminal-9",
    sequence: 3,
    stream: "stdout",
    text: "ADY 💥 token=super-secret\r\n",
    byteLength: 31,
    startByte: 22,
    endByte: 34,
  });
  for (let spin = 0; requests.length === 0 && spin < 50; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.trust, "untrusted");
  assert.equal(requests[0]?.authority, "none");
  const evidence = await fixture.artifacts.get(requests[0]!.evidence.id);
  assert.equal(evidence.ok, true);
  if (evidence.ok) {
    const body = Buffer.from(evidence.value.body).toString("utf8");
    assert.match(body, /READY 💥/u);
    assert.doesNotMatch(body, /super-secret/u);
  }

  await opened.value.close();
  assert.equal(observationClosed, true);
  listener?.({
    kind: "output",
    terminalId: "terminal-9",
    sequence: 4,
    stream: "stdout",
    text: "READY after close\n",
    byteLength: 18,
    startByte: 34,
    endByte: 52,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests.length, 1);

  await fixture.triggers.close();
  await fixture.lifecycle.shutdown("quit");
});

test(
  "real Windows terminal observation preserves UTF-8 CRLF line delivery",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const fixture = createFixture();
    const deliveries: MonitorDeliveryRequest[] = [];
    fixture.options.sources = createTerminalMonitorSourceFactory({
      async observe(request, listener) {
        const child = spawn(
          process.execPath,
          [
            "-e",
            "process.stdout.write('alpha\\r');setTimeout(()=>process.stdout.write('\\nREADY 💥\\r\\npartial'),10);setTimeout(()=>process.exit(0),20)",
          ],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        );
        let sequence = 0;
        let offset = 0;
        let settled = false;
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (text: string) => {
          const byteLength = Buffer.byteLength(text);
          listener({
            kind: "output",
            terminalId: request.terminalId,
            sequence: ++sequence,
            stream: "stdout",
            text,
            byteLength,
            startByte: offset,
            endByte: offset + byteLength,
          });
          offset += byteLength;
        });
        const closed = new Promise<void>((resolve) => {
          child.once("close", (code) => {
            settled = true;
            listener({
              kind: "settled",
              terminalId: request.terminalId,
              sequence: ++sequence,
              snapshot: {
                status: code === 0 ? "done" : "failed",
                exitCode: code ?? 1,
              },
              consumed: false,
            });
            resolve();
          });
        });
        return {
          ok: true,
          value: {
            async close() {
              if (!settled) child.kill();
              await closed;
            },
          },
        };
      },
    });
    fixture.options.delivery = {
      async deliver(request) {
        deliveries.push(request);
        return { ok: true, value: { state: "delivered" } };
      },
    };
    const opened = await createMonitorRegistry({
      ...fixture.options,
      limits: { batchWindowMs: 10 },
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    await opened.value.registry.change({
      type: "create",
      requestId: "real-terminal-create",
      id: "real-terminal",
      expectedRevision: 0,
      scope: "session",
      source: {
        kind: "terminal",
        terminalId: "real-terminal-id",
        framing: "line",
      },
      matcher: { kind: "literal", value: "READY" },
      delivery: { kind: "session", sessionId: "result-session" },
    });
    for (let spin = 0; deliveries.length === 0 && spin < 200; spin += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(deliveries.length, 1);
    const evidence = await fixture.artifacts.get(deliveries[0]!.evidence.id);
    assert.equal(evidence.ok, true);
    if (evidence.ok) {
      assert.match(
        Buffer.from(evidence.value.body).toString("utf8"),
        /READY 💥/u,
      );
    }

    await opened.value.close();
    await fixture.triggers.close();
    await fixture.lifecycle.shutdown("quit");
  },
);

test("terminal observation gap discards unavailable partial line before settle", async () => {
  let listener: ((event: TerminalObservation) => unknown) | undefined;
  const fixture = createFixture();
  const deliveries: MonitorDeliveryRequest[] = [];
  fixture.options.sources = createTerminalMonitorSourceFactory({
    async observe(_request, next) {
      listener = next;
      return { ok: true, value: { close() {} } };
    },
  });
  fixture.options.delivery = {
    async deliver(request) {
      deliveries.push(request);
      return { ok: true, value: { state: "delivered" } };
    },
  };
  const opened = await createMonitorRegistry({
    ...fixture.options,
    limits: { batchWindowMs: 10 },
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  await opened.value.registry.change({
    type: "create",
    requestId: "gap-create",
    id: "gap",
    expectedRevision: 0,
    scope: "session",
    source: { kind: "terminal", terminalId: "gap-terminal", framing: "line" },
    delivery: { kind: "session", sessionId: "result-session" },
  });
  listener?.({
    kind: "output",
    terminalId: "gap-terminal",
    sequence: 1,
    stream: "stdout",
    text: "unavailable-partial",
    byteLength: 19,
    startByte: 0,
    endByte: 19,
  });
  listener?.({
    kind: "gap",
    terminalId: "gap-terminal",
    sequence: 3,
    fromSequence: 2,
    toSequence: 3,
  });
  listener?.({
    kind: "settled",
    terminalId: "gap-terminal",
    sequence: 4,
    snapshot: { status: "done", exitCode: 0 },
    consumed: false,
  });
  for (let spin = 0; deliveries.length === 0 && spin < 100; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const evidence = await fixture.artifacts.get(deliveries[0]!.evidence.id);
  assert.equal(evidence.ok, true);
  if (evidence.ok) {
    const body = Buffer.from(evidence.value.body).toString("utf8");
    assert.match(body, /terminal\.gap/u);
    assert.match(body, /terminal\.settled/u);
    assert.doesNotMatch(body, /unavailable-partial/u);
  }

  await opened.value.close();
  await fixture.triggers.close();
  await fixture.lifecycle.shutdown("quit");
});

test("real Windows file monitor reconciles created directories without following ignored junctions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-monitor-root-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-monitor-outside-"));
  const fixture = createFixture();
  const requests: MonitorDeliveryRequest[] = [];
  fixture.options.sources = createFileSystemMonitorSourceFactory({
    reconcileIntervalMs: 50,
  });
  fixture.options.delivery = {
    async deliver(request) {
      requests.push(request);
      return { ok: true, value: { state: "delivered" } };
    },
  };
  const opened = await createMonitorRegistry({
    ...fixture.options,
    limits: { batchWindowMs: 20 },
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  try {
    const created = await opened.value.registry.change({
      type: "create",
      requestId: "file-created-dir",
      id: "file-created-dir",
      expectedRevision: 0,
      scope: "session",
      source: { kind: "file", root, recursive: true },
      matcher: { kind: "field", field: "path", equals: "created/ready.txt" },
      delivery: { kind: "session", sessionId: "result-session" },
    });
    assert.equal(created.ok, true);

    await mkdir(join(root, "created"));
    await writeFile(join(root, "created", "ready.txt"), "READY", "utf8");
    for (let spin = 0; requests.length === 0 && spin < 100; spin += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(requests.length, 1);
    const evidence = await fixture.artifacts.get(requests[0]!.evidence.id);
    assert.equal(evidence.ok, true);
    if (evidence.ok) {
      assert.match(
        Buffer.from(evidence.value.body).toString("utf8"),
        /created\/ready\.txt/u,
      );
    }

    await mkdir(join(root, ".git"));
    await mkdir(join(root, "state"));
    await mkdir(join(root, "artifacts"));
    await writeFile(join(root, ".git", "ready.txt"), "READY", "utf8");
    await writeFile(join(root, "state", "ready.txt"), "READY", "utf8");
    await writeFile(join(root, "artifacts", "ready.txt"), "READY", "utf8");
    await symlink(outside, join(root, "junction"), "junction");
    await writeFile(join(outside, "ready.txt"), "READY", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(requests.length, 1);
  } finally {
    await opened.value.close();
    await fixture.triggers.close();
    await fixture.lifecycle.shutdown("quit");
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("filesystem source refuses root replacement and junction roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-monitor-replace-"));
  const moved = `${root}-moved`;
  const rootLink = `${root}-link`;
  let parcelCallback:
    | ((
        error: Error | null,
        events: readonly {
          type: "create" | "update" | "delete";
          path: string;
        }[],
      ) => void)
    | undefined;
  let unsubscribed = false;
  const fixture = createFixture();
  const deliveries: MonitorDeliveryRequest[] = [];
  fixture.options.sources = createFileSystemMonitorSourceFactory({
    reconcileIntervalMs: 10_000,
    async loadWatcher() {
      return {
        async subscribe(_directory, callback) {
          parcelCallback = callback;
          return {
            async unsubscribe() {
              unsubscribed = true;
            },
          };
        },
      };
    },
  });
  fixture.options.delivery = {
    async deliver(request) {
      deliveries.push(request);
      return { ok: true, value: { state: "delivered" } };
    },
  };
  const opened = await createMonitorRegistry({
    ...fixture.options,
    limits: { batchWindowMs: 10 },
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  try {
    const created = await opened.value.registry.change({
      type: "create",
      requestId: "root-replace-create",
      id: "root-replace",
      expectedRevision: 0,
      scope: "session",
      source: { kind: "file", root },
      matcher: { kind: "field", field: "code", equals: "root_replaced" },
      delivery: { kind: "session", sessionId: "result-session" },
    });
    assert.equal(created.ok, true);
    await rename(root, moved);
    await mkdir(root);
    parcelCallback?.(null, [
      { type: "create", path: join(root, "replacement.txt") },
    ]);
    for (let spin = 0; deliveries.length === 0 && spin < 100; spin += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(deliveries.length, 1);
    assert.equal(unsubscribed, true);
    await writeFile(join(root, "replacement.txt"), "ignored", "utf8");
    parcelCallback?.(null, [
      { type: "create", path: join(root, "replacement.txt") },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(deliveries.length, 1);

    await symlink(moved, rootLink, "junction");
    const junction = await opened.value.registry.change({
      type: "create",
      requestId: "root-junction-create",
      id: "root-junction",
      expectedRevision: 0,
      scope: "session",
      source: { kind: "file", root: rootLink },
      delivery: { kind: "session", sessionId: "result-session" },
    });
    assert.equal(junction.ok, false);
  } finally {
    await opened.value.close();
    await fixture.triggers.close();
    await fixture.lifecycle.shutdown("quit");
    await rm(rootLink, { force: true });
    await rm(root, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  }
});

test("named poll adapter backs off offline without overlap and rejects arbitrary targets", async () => {
  let requestsStarted = 0;
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  const server = createServer(async (_request, response) => {
    requestsStarted += 1;
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    if (requestsStarted === 1)
      await new Promise((resolve) => setTimeout(resolve, 70));
    if (requestsStarted === 2) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"offline":true}');
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ ready: requestsStarted >= 3, token: "super-secret" }),
      );
    }
    activeRequests -= 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/status`;
  let policyChecks = 0;
  const fixture = createFixture();
  const deliveries: MonitorDeliveryRequest[] = [];
  fixture.options.sources = createPollMonitorSourceFactory({
    minimumIntervalMs: 25,
    maximumBackoffMs: 100,
    adapters: {
      "ci-status": createJsonPollAdapter({
        endpoint,
        async authorize(request) {
          policyChecks += 1;
          return {
            ok: true,
            value: {
              canonicalUrl: request.url,
              addresses: [{ address: "127.0.0.1", family: 4 }],
            },
          };
        },
        async pinnedFetch(request) {
          return fetch(request.canonicalUrl, {
            method: "GET",
            redirect: request.redirect,
            cache: "no-store",
            signal: request.signal,
            headers: request.headers,
          });
        },
      }),
    },
  });
  fixture.options.delivery = {
    async deliver(request) {
      deliveries.push(request);
      return { ok: true, value: { state: "delivered" } };
    },
  };
  const opened = await createMonitorRegistry({
    ...fixture.options,
    limits: { batchWindowMs: 10, pollMinimumMs: 25 },
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  try {
    const arbitrary = await opened.value.registry.change({
      type: "create",
      requestId: "poll-arbitrary",
      id: "poll-arbitrary",
      expectedRevision: 0,
      scope: "session",
      source: {
        kind: "poll",
        adapter: "ci-status",
        intervalMs: 25,
        input: { url: "https://example.invalid", command: "whoami" },
      },
      delivery: { kind: "session", sessionId: "result-session" },
    });
    assert.equal(arbitrary.ok, false);

    const created = await opened.value.registry.change({
      type: "create",
      requestId: "poll-create",
      id: "poll-ci",
      expectedRevision: 0,
      scope: "session",
      source: {
        kind: "poll",
        adapter: "ci-status",
        intervalMs: 25,
        input: { job: "build" },
      },
      matcher: { kind: "field", field: "ready", equals: true },
      delivery: { kind: "session", sessionId: "result-session" },
    });
    assert.equal(created.ok, true);
    for (let spin = 0; deliveries.length === 0 && spin < 150; spin += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(deliveries.length, 1);
    assert.equal(maximumActiveRequests, 1);
    assert.ok(requestsStarted >= 3);
    assert.ok(
      policyChecks === requestsStarted || policyChecks === requestsStarted + 1,
      `policy checks ${policyChecks}, HTTP requests ${requestsStarted}`,
    );
    const evidence = await fixture.artifacts.get(deliveries[0]!.evidence.id);
    assert.equal(evidence.ok, true);
    if (evidence.ok) {
      const body = Buffer.from(evidence.value.body).toString("utf8");
      assert.match(body, /"ready":true/u);
      assert.doesNotMatch(body, /super-secret/u);
    }
  } finally {
    await opened.value.close();
    await fixture.triggers.close();
    await fixture.lifecycle.shutdown("quit");
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("WebSocket source pins lookup, caps payload, disables compression, and reauthorizes reconnect", async () => {
  const server = new WebSocketServer({ port: 0, perMessageDeflate: true });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `ws://phase7.invalid:${address.port}`;
  const url = `${origin}/events`;
  let connections = 0;
  const hosts: (string | undefined)[] = [];
  const extensions: (string | undefined)[] = [];
  server.on("connection", (socket, request) => {
    connections += 1;
    hosts.push(request.headers.host);
    extensions.push(request.headers["sec-websocket-extensions"]);
    if (connections === 1) socket.send("x".repeat(128));
    else socket.send("READY token=super-secret");
  });

  const fixture = createFixture();
  const deliveries: MonitorDeliveryRequest[] = [];
  let policyChecks = 0;
  fixture.options.sources = createWebSocketMonitorSourceFactory({
    allowedOrigins: [origin],
    control: {
      async authorize(request) {
        policyChecks += 1;
        return {
          ok: true,
          value: {
            canonicalUrl: request.url,
            addresses: [{ address: "127.0.0.1", family: 4 as const }],
          },
        };
      },
    },
    limits: {
      maxMessageBytes: 32,
      maxFragments: 4,
      maxBufferedChunks: 8,
      maxBufferedMessages: 4,
      maxBufferedBytes: 128,
      reconnectBaseMs: 10,
      reconnectMaxMs: 20,
      maxReconnectAttempts: 3,
      reconnectWindowMs: 1_000,
      handshakeTimeoutMs: 500,
      idleTimeoutMs: 500,
      lifetimeMs: 2_000,
    },
  });
  fixture.options.delivery = {
    async deliver(request) {
      deliveries.push(request);
      return { ok: true, value: { state: "delivered" } };
    },
  };
  const opened = await createMonitorRegistry({
    ...fixture.options,
    configuration: {
      maxActive: 128,
      maxRemote: 16,
      batchWindowMs: 10,
      pollMinimumMs: 5_000,
      allowedWebSocketOrigins: [origin],
      allowLoopback: true,
    },
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  try {
    const credentialed = await opened.value.registry.change({
      type: "create",
      requestId: "ws-credentialed-url",
      id: "ws-credentialed-url",
      expectedRevision: 0,
      scope: "session",
      source: {
        kind: "websocket",
        url: `ws://user:pass@phase7.invalid:${address.port}/`,
      },
      delivery: { kind: "session", sessionId: "result-session" },
    });
    assert.equal(credentialed.ok, false);

    const created = await opened.value.registry.change({
      type: "create",
      requestId: "ws-create",
      id: "ws-events",
      expectedRevision: 0,
      scope: "session",
      source: { kind: "websocket", url },
      matcher: { kind: "literal", value: "READY" },
      delivery: { kind: "session", sessionId: "result-session" },
    });
    assert.equal(created.ok, true);
    for (let spin = 0; deliveries.length === 0 && spin < 150; spin += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(deliveries.length, 1);
    assert.ok(connections >= 2);
    assert.equal(policyChecks, connections);
    assert.ok(hosts.every((host) => host === `phase7.invalid:${address.port}`));
    assert.ok(extensions.every((extension) => extension === undefined));
    const evidence = await fixture.artifacts.get(deliveries[0]!.evidence.id);
    assert.equal(evidence.ok, true);
    if (evidence.ok) {
      const body = Buffer.from(evidence.value.body).toString("utf8");
      assert.match(body, /READY/u);
      assert.doesNotMatch(body, /super-secret/u);
    }
  } finally {
    await opened.value.close();
    await fixture.triggers.close();
    await fixture.lifecycle.shutdown("quit");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("WebSocket source never follows redirects", async () => {
  const target = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => target.once("listening", resolve));
  const targetAddress = target.address();
  assert.ok(targetAddress && typeof targetAddress === "object");
  let targetConnections = 0;
  target.on("connection", () => {
    targetConnections += 1;
  });
  const redirect = createServer();
  redirect.on("upgrade", (_request, socket) => {
    socket.end(
      `HTTP/1.1 302 Found\r\nLocation: ws://127.0.0.1:${targetAddress.port}/target\r\nConnection: close\r\n\r\n`,
    );
  });
  await new Promise<void>((resolve) =>
    redirect.listen(0, "127.0.0.1", resolve),
  );
  const redirectAddress = redirect.address();
  assert.ok(redirectAddress && typeof redirectAddress === "object");
  const origin = `ws://redirect.invalid:${redirectAddress.port}`;
  const fixture = createFixture();
  const deliveries: MonitorDeliveryRequest[] = [];
  fixture.options.sources = createWebSocketMonitorSourceFactory({
    allowedOrigins: [origin],
    control: {
      async authorize(request) {
        return {
          ok: true,
          value: {
            canonicalUrl: request.url,
            addresses: [{ address: "127.0.0.1", family: 4 }],
          },
        };
      },
    },
    random: () => 1,
    limits: {
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
      maxReconnectAttempts: 1,
      reconnectWindowMs: 1_000,
      handshakeTimeoutMs: 500,
      idleTimeoutMs: 500,
      lifetimeMs: 1_000,
    },
  });
  fixture.options.delivery = {
    async deliver(request) {
      deliveries.push(request);
      return { ok: true, value: { state: "delivered" } };
    },
  };
  const opened = await createMonitorRegistry({
    ...fixture.options,
    configuration: {
      maxActive: 128,
      maxRemote: 16,
      batchWindowMs: 10,
      pollMinimumMs: 5_000,
      allowedWebSocketOrigins: [origin],
      allowLoopback: true,
    },
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  try {
    const created = await opened.value.registry.change({
      type: "create",
      requestId: "ws-redirect-create",
      id: "ws-redirect",
      expectedRevision: 0,
      scope: "session",
      source: { kind: "websocket", url: `${origin}/redirect` },
      matcher: { kind: "literal", value: "READY" },
      delivery: { kind: "session", sessionId: "result-session" },
    });
    assert.equal(created.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(targetConnections, 0);
    assert.deepEqual(deliveries, []);
  } finally {
    await opened.value.close();
    await fixture.triggers.close();
    await fixture.lifecycle.shutdown("quit");
    await new Promise<void>((resolve) => redirect.close(() => resolve()));
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

test("durable definitions restore blocked until authority is revalidated", async () => {
  const state = createMemoryStateStore();
  const first = createFixture();
  const opened = await createMonitorRegistry({ ...first.options, state });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const session = await opened.value.registry.change({
    type: "create",
    requestId: "restore-session-create",
    id: "restore-session",
    expectedRevision: 0,
    scope: "session",
    source: { kind: "terminal", terminalId: "terminal-restore" },
    delivery: { kind: "session", sessionId: "result-session" },
  });
  assert.equal(session.ok, true);
  const durableCommand = {
    type: "create",
    requestId: "restore-durable-create",
    id: "restore-durable",
    expectedRevision: 0,
    scope: "durable" as const,
    source: { kind: "file" as const, root: "C:/monitor-test" },
    matcher: { kind: "literal" as const, value: "READY" },
    delivery: { kind: "session" as const, sessionId: "result-session" },
  } as const;
  const durable = await opened.value.registry.change(durableCommand);
  assert.equal(durable.ok, true);
  await opened.value.close();
  await first.triggers.close();
  await first.lifecycle.shutdown("reload");

  const exported = await state.export({ format: "snapshot" });
  assert.equal(exported.ok, true);
  if (exported.ok) {
    const definitions = exported.value.snapshot.records.filter(
      ({ collection }) => collection.startsWith("monitor.definitions."),
    );
    assert.deepEqual(
      definitions.map(({ key }) => key),
      ["restore-durable"],
    );
    const metadata = JSON.stringify(definitions[0]?.metadata);
    assert.doesNotMatch(metadata, /restore-session/u);
    assert.doesNotMatch(metadata, /observed-secret/u);
  }

  let allowed = false;
  const restored = createFixture();
  restored.options.authority = {
    async authorize() {
      return allowed
        ? { ok: true, value: { allowed: true } }
        : {
            ok: false,
            error: {
              code: "authority_denied",
              message: "Project trust changed.",
              retryable: false,
            },
          };
    },
  };
  const reopened = await createMonitorRegistry({ ...restored.options, state });
  assert.equal(reopened.ok, true);
  if (!reopened.ok) return;
  const blocked = await reopened.value.registry.inspect({
    id: "restore-durable",
  });
  assert.equal(blocked.ok, true);
  if (blocked.ok) {
    assert.equal(blocked.value.monitors[0]?.state, "blocked");
    assert.match(blocked.value.monitors[0]?.blockedReason ?? "", /authority/u);
  }
  assert.deepEqual(restored.sourceStarts, []);

  allowed = true;
  const resumed = await reopened.value.registry.change({
    type: "resume",
    requestId: "restore-resume",
    id: "restore-durable",
    expectedRevision: 1,
  });
  assert.equal(resumed.ok, true);
  if (resumed.ok) assert.equal(resumed.value.monitor.state, "active");
  assert.deepEqual(restored.sourceStarts, ["restore-durable"]);

  await reopened.value.close();
  await restored.triggers.close();
  await restored.lifecycle.shutdown("quit");

  const replayFixture = createFixture();
  const replayRuntime = await createMonitorRegistry({
    ...replayFixture.options,
    state,
  });
  assert.equal(replayRuntime.ok, true);
  if (!replayRuntime.ok) return;
  const replay = await replayRuntime.value.registry.change(durableCommand);
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.value.replayed, true);
    assert.equal(replay.value.monitor.revision, 1);
  }
  assert.deepEqual(replayFixture.sourceStarts, ["restore-durable"]);
  await replayRuntime.value.close();
  await replayFixture.triggers.close();
  await replayFixture.lifecycle.shutdown("quit");
});

test("replace, resume, stop, and delete transition one revision at a time", async () => {
  const fixture = createFixture();
  const closedSources: string[] = [];
  fixture.options.sources = {
    async open(definition) {
      fixture.sourceStarts.push(
        `${definition.id}:${definition.source.kind === "terminal" ? definition.source.terminalId : "other"}`,
      );
      const sourceId =
        definition.source.kind === "terminal"
          ? definition.source.terminalId
          : definition.source.kind;
      return {
        close: () => {
          closedSources.push(sourceId);
        },
      };
    },
  };
  const opened = await createMonitorRegistry(fixture.options);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  await opened.value.registry.change({
    type: "create",
    requestId: "states-create",
    id: "states",
    expectedRevision: 0,
    scope: "session",
    source: { kind: "terminal", terminalId: "terminal-a" },
    delivery: { kind: "session", sessionId: "result-session" },
  });
  const paused = await opened.value.registry.change({
    type: "pause",
    requestId: "states-pause",
    id: "states",
    expectedRevision: 1,
  });
  assert.equal(paused.ok, true);
  const resumed = await opened.value.registry.change({
    type: "resume",
    requestId: "states-resume",
    id: "states",
    expectedRevision: 2,
  });
  assert.equal(resumed.ok, true);
  const replaced = await opened.value.registry.change({
    type: "replace",
    requestId: "states-replace",
    id: "states",
    expectedRevision: 3,
    scope: "session",
    source: { kind: "terminal", terminalId: "terminal-b" },
    delivery: { kind: "session", sessionId: "result-session" },
  });
  assert.equal(replaced.ok, true);
  if (replaced.ok) assert.equal(replaced.value.monitor.revision, 4);
  assert.deepEqual(closedSources, ["terminal-a", "terminal-a"]);

  const stopped = await opened.value.registry.change({
    type: "stop",
    requestId: "states-stop",
    id: "states",
    expectedRevision: 4,
  });
  assert.equal(stopped.ok, true);
  if (stopped.ok) assert.equal(stopped.value.monitor.state, "stopped");
  const cannotResume = await opened.value.registry.change({
    type: "resume",
    requestId: "states-resume-stopped",
    id: "states",
    expectedRevision: 5,
  });
  assert.equal(cannotResume.ok, false);

  const deleteCommand = {
    type: "delete" as const,
    requestId: "states-delete",
    id: "states",
    expectedRevision: 5,
  };
  const deleted = await opened.value.registry.change(deleteCommand);
  assert.equal(deleted.ok, true);
  if (deleted.ok) assert.equal(deleted.value.monitor.state, "deleted");
  const replayed = await opened.value.registry.change(deleteCommand);
  assert.equal(replayed.ok, true);
  if (replayed.ok) assert.equal(replayed.value.replayed, true);
  const inspected = await opened.value.registry.inspect();
  assert.equal(inspected.ok, true);
  if (inspected.ok) assert.deepEqual(inspected.value.monitors, []);
  assert.deepEqual(closedSources, ["terminal-a", "terminal-a", "terminal-b"]);

  await opened.value.close();
  await fixture.triggers.close();
  await fixture.lifecycle.shutdown("quit");
});

test("bursts are bounded and host-stamped self events are suppressed", async () => {
  const fixture = createFixture();
  let emit!: (event: MonitorSourceEvent) => void;
  fixture.options.sources = {
    async open(_definition, publish) {
      emit = publish;
      return { close() {} };
    },
  };
  const delivered: MonitorDeliveryRequest[] = [];
  fixture.options.delivery = {
    async deliver(request) {
      delivered.push(request);
      return { ok: true, value: { state: "delivered" } };
    },
  };
  const opened = await createMonitorRegistry({
    ...fixture.options,
    limits: { batchWindowMs: 10, maxBatchCount: 4 },
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  await opened.value.registry.change({
    type: "create",
    requestId: "burst-create",
    id: "burst",
    expectedRevision: 0,
    scope: "session",
    source: { kind: "terminal", terminalId: "burst-terminal" },
    delivery: { kind: "session", sessionId: "result-session" },
  });
  emit?.({
    type: "terminal.line",
    payload: { line: "self" },
    causedByMonitorId: "burst",
  });
  for (let index = 0; index < 10; index += 1) {
    emit?.({ type: "terminal.line", payload: { line: `event-${index}` } });
  }
  for (let spin = 0; delivered.length < 3 && spin < 100; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(delivered.length, 3);
  assert.equal(new Set(delivered.map(({ deliveryId }) => deliveryId)).size, 3);
  assert.deepEqual(
    delivered.map(({ evidence }) => evidence.metadata?.eventCount),
    [4, 4, 2],
  );

  await opened.value.close();
  await fixture.triggers.close();
  await fixture.lifecycle.shutdown("quit");
});

test("close aborts and waits an active delivery callback", async () => {
  const fixture = createFixture();
  let emit!: (event: MonitorSourceEvent) => void;
  fixture.options.sources = {
    async open(_definition, publish) {
      emit = publish;
      return { close() {} };
    },
  };
  let deliveryStarted = false;
  let deliveryFinished = false;
  let deliverySignalAborted = false;
  fixture.options.delivery = {
    async deliver(_request, signal) {
      deliveryStarted = true;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      deliverySignalAborted = signal?.aborted === true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      deliveryFinished = true;
      return { ok: true, value: { state: "delivered" } };
    },
  };
  const opened = await createMonitorRegistry({
    ...fixture.options,
    limits: { batchWindowMs: 1 },
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  await opened.value.registry.change({
    type: "create",
    requestId: "close-callback-create",
    id: "close-callback",
    expectedRevision: 0,
    scope: "session",
    source: { kind: "terminal", terminalId: "close-terminal" },
    delivery: { kind: "session", sessionId: "result-session" },
  });
  emit?.({ type: "terminal.line", payload: { line: "READY" } });
  for (let spin = 0; !deliveryStarted && spin < 50; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(deliveryStarted, true);

  await opened.value.close();
  assert.equal(deliverySignalAborted, true);
  assert.equal(deliveryFinished, true);
  emit?.({ type: "terminal.line", payload: { line: "after close" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(deliveryStarted, true);

  await fixture.triggers.close();
  await fixture.lifecycle.shutdown("quit");
});

test("empty registry owns no monitor resources", async () => {
  const fixture = createFixture();
  const opened = await createMonitorRegistry(fixture.options);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const inspected = await opened.value.registry.inspect();
  assert.deepEqual(inspected, {
    ok: true,
    value: { monitors: [], closed: false },
  });
  assert.deepEqual(fixture.sourceStarts, []);
  assert.deepEqual(fixture.deliveries, []);

  await opened.value.close();
  await fixture.triggers.close();
  await fixture.lifecycle.shutdown("quit");
});

test("empty production source router performs no native or network import", async () => {
  let watcherImports = 0;
  let WebSocketImports = 0;
  const fixture = createFixture();
  fixture.options.sources = createProductionMonitorSourceFactory({
    filesystem: {
      async loadWatcher() {
        watcherImports += 1;
        throw new Error("must stay lazy");
      },
    },
    websocket: {
      allowedOrigins: ["wss://events.example.test"],
      control: {
        async authorize() {
          return {
            ok: false,
            error: {
              code: "policy_denied",
              message: "denied",
              retryable: false,
            },
          };
        },
      },
      async loadClient() {
        WebSocketImports += 1;
        throw new Error("must stay lazy");
      },
    },
  });
  const opened = await createMonitorRegistry(fixture.options);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(watcherImports, 0);
  assert.equal(WebSocketImports, 0);

  await opened.value.close();
  await fixture.triggers.close();
  await fixture.lifecycle.shutdown("quit");
});

test("SessionBroker delivery uses stable request identity and reports offline queueing", async () => {
  const requestIds: string[] = [];
  const broker: Pick<SessionBroker, "send"> = {
    async send(request) {
      requestIds.push(request.requestId);
      return {
        ok: true,
        value: {
          requestId: request.requestId,
          body: {
            id: "b".repeat(64),
            sha256: "b".repeat(64),
            size: 10,
            createdAt: 1,
          },
          deliveries: request.recipients.map((recipient, index) => ({
            recipient,
            messageId: `message-${index}`,
            mailboxPosition: index + 1,
            state: "queued" as const,
          })),
          replayed: requestIds.length > 1,
        },
      };
    },
  };
  const delivery = createSessionBrokerMonitorDelivery(broker);
  const request: MonitorDeliveryRequest = {
    deliveryId: "a".repeat(64),
    route: { kind: "session", sessionId: "result-session" },
    monitorId: "broker-monitor",
    revision: 1,
    summary: "One bounded untrusted batch.",
    evidence: {
      id: "c".repeat(64),
      sha256: "c".repeat(64),
      size: 128,
      createdAt: 1,
    },
    trust: "untrusted",
    authority: "none",
  };
  const first = await delivery.deliver(request);
  const replay = await delivery.deliver(request);

  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.value.state, "offline");
  assert.equal(replay.ok, true);
  assert.deepEqual(requestIds, [
    `monitor-delivery:${request.deliveryId}`,
    `monitor-delivery:${request.deliveryId}`,
  ]);
});

function storageFailureState(state: StateStore) {
  let fail = false;
  return {
    state: {
      ...state,
      async transact(transaction) {
        if (fail) {
          fail = false;
          return {
            ok: false as const,
            error: {
              code: "STORAGE_FAILED" as const,
              message: "Injected persistence failure.",
              retryable: false,
            },
          };
        }
        return state.transact(transaction);
      },
    } satisfies StateStore,
    failNext() {
      fail = true;
    },
  };
}

test("close seals an authority-blocked mutation before it can bind or start", async () => {
  const fixture = createFixture();
  let finishAuthority!: () => void;
  fixture.options.authority = {
    async authorize() {
      await new Promise<void>((resolve) => {
        finishAuthority = resolve;
      });
      return { ok: true, value: { allowed: true } };
    },
  };
  const opened = await createMonitorRegistry({
    ...fixture.options,
    limits: { closeDrainMs: 20 },
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const changing = opened.value.registry.change({
    type: "create",
    requestId: "close-authority-create",
    id: "close-authority",
    expectedRevision: 0,
    scope: "session",
    source: { kind: "terminal", terminalId: "close-authority-terminal" },
    delivery: { kind: "session", sessionId: "result-session" },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const closing = opened.value.close();
  finishAuthority();

  const [changed, report] = await Promise.all([changing, closing]);
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.error.code, "closed");
  assert.deepEqual(fixture.sourceStarts, []);
  assert.equal(report.unresolvedSources, 0);

  await fixture.triggers.close();
  await fixture.lifecycle.shutdown("quit");
});

test("durable definitions and request receipts are isolated by Project Identity", async () => {
  const state = createMemoryStateStore();
  const projectA = createFixture();
  const openedA = await createMonitorRegistry({ ...projectA.options, state });
  assert.equal(openedA.ok, true);
  if (!openedA.ok) return;
  const command = {
    type: "create" as const,
    requestId: "project-isolation-create",
    id: "project-isolation",
    expectedRevision: 0,
    scope: "durable" as const,
    source: { kind: "file" as const, root: "C:/monitor-test" },
    delivery: { kind: "session" as const, sessionId: "result-session" },
  };
  assert.equal((await openedA.value.registry.change(command)).ok, true);
  await openedA.value.close();
  await projectA.triggers.close();
  await projectA.lifecycle.shutdown("reload");

  const projectB = createFixture();
  projectB.options.binding = {
    ...projectB.options.binding,
    projectId: "non-git:other-project",
    cwd: "C:/other-project",
  };
  const openedB = await createMonitorRegistry({ ...projectB.options, state });
  assert.equal(openedB.ok, true);
  if (!openedB.ok) return;
  const inspected = await openedB.value.registry.inspect();
  assert.equal(inspected.ok, true);
  if (inspected.ok) assert.deepEqual(inspected.value.monitors, []);
  const foreignReplay = await openedB.value.registry.change(command);
  assert.equal(foreignReplay.ok, true);
  if (foreignReplay.ok) assert.equal(foreignReplay.value.replayed, false);

  const exported = await state.export({ format: "snapshot" });
  assert.equal(exported.ok, true);
  if (exported.ok) {
    const collections = exported.value.snapshot.records
      .map(({ collection }) => collection)
      .filter((collection) => collection.startsWith("monitor."));
    assert.equal(new Set(collections).size, 4);
    assert.ok(
      collections.every((collection) => /\.[a-f0-9]{64}$/u.test(collection)),
    );
  }

  await openedB.value.close();
  await projectB.triggers.close();
  await projectB.lifecycle.shutdown("quit");
});

test("failed durable commits leave live source and registry revision unchanged", async () => {
  const backing = createMemoryStateStore();
  const injected = storageFailureState(backing);
  const fixture = createFixture();
  const closedSources: string[] = [];
  fixture.options.sources = {
    async open(definition) {
      const source = definition.source;
      const identity =
        source.kind === "terminal" ? source.terminalId : source.kind;
      fixture.sourceStarts.push(identity);
      return {
        close() {
          closedSources.push(identity);
        },
      };
    },
  };
  const opened = await createMonitorRegistry({
    ...fixture.options,
    state: injected.state,
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const created = await opened.value.registry.change({
    type: "create",
    requestId: "rollback-create",
    id: "rollback",
    expectedRevision: 0,
    scope: "durable",
    source: { kind: "file", root: "C:/monitor-test" },
    delivery: { kind: "session", sessionId: "result-session" },
  });
  assert.equal(created.ok, true);
  assert.deepEqual(fixture.sourceStarts, ["file"]);

  injected.failNext();
  const replaced = await opened.value.registry.change({
    type: "replace",
    requestId: "rollback-replace",
    id: "rollback",
    expectedRevision: 1,
    scope: "durable",
    source: { kind: "file", root: "C:/monitor-test-next" },
    delivery: { kind: "session", sessionId: "result-session" },
  });
  assert.equal(replaced.ok, false);
  assert.deepEqual(fixture.sourceStarts, ["file"]);
  assert.deepEqual(closedSources, []);

  injected.failNext();
  const paused = await opened.value.registry.change({
    type: "pause",
    requestId: "rollback-pause",
    id: "rollback",
    expectedRevision: 1,
  });
  assert.equal(paused.ok, false);
  assert.deepEqual(closedSources, []);
  const inspected = await opened.value.registry.inspect({ id: "rollback" });
  assert.equal(inspected.ok, true);
  if (inspected.ok) {
    assert.equal(inspected.value.monitors[0]?.revision, 1);
    assert.equal(inspected.value.monitors[0]?.state, "active");
    assert.equal(inspected.value.monitors[0]?.source.kind, "file");
  }

  assert.equal(
    (
      await opened.value.registry.change({
        type: "pause",
        requestId: "rollback-pause-success",
        id: "rollback",
        expectedRevision: 1,
      })
    ).ok,
    true,
  );
  injected.failNext();
  assert.equal(
    (
      await opened.value.registry.change({
        type: "resume",
        requestId: "rollback-resume",
        id: "rollback",
        expectedRevision: 2,
      })
    ).ok,
    false,
  );
  assert.deepEqual(fixture.sourceStarts, ["file"]);
  assert.equal(
    (
      await opened.value.registry.change({
        type: "resume",
        requestId: "rollback-resume-success",
        id: "rollback",
        expectedRevision: 2,
      })
    ).ok,
    true,
  );
  assert.deepEqual(fixture.sourceStarts, ["file", "file"]);

  for (const type of ["stop", "delete"] as const) {
    injected.failNext();
    const outcome: MonitorOutcome<MonitorChangeReceipt> =
      await opened.value.registry.change({
        type,
        requestId: `rollback-${type}`,
        id: "rollback",
        expectedRevision: 3,
      });
    assert.equal(outcome.ok, false);
    const current = await opened.value.registry.inspect({ id: "rollback" });
    assert.equal(current.ok, true);
    if (current.ok) {
      assert.equal(current.value.monitors[0]?.revision, 3);
      assert.equal(current.value.monitors[0]?.state, "active");
    }
  }
  assert.deepEqual(closedSources, ["file"]);

  await opened.value.close();
  await fixture.triggers.close();
  await fixture.lifecycle.shutdown("quit");
});

test("command and evidence decoding never invokes accessors and rejects cycles/proxies", async () => {
  const fixture = createFixture();
  let emit!: (event: MonitorSourceEvent) => void;
  fixture.options.sources = {
    async open(_definition, publish) {
      emit = publish;
      return { close() {} };
    },
  };
  const delivered: MonitorDeliveryRequest[] = [];
  fixture.options.delivery = {
    async deliver(request) {
      delivered.push(request);
      return { ok: true, value: { state: "delivered" } };
    },
  };
  const opened = await createMonitorRegistry({
    ...fixture.options,
    limits: { batchWindowMs: 1 },
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  let commandGetterReads = 0;
  const hostileSource: Record<string, unknown> = {};
  Object.defineProperty(hostileSource, "kind", {
    enumerable: true,
    get() {
      commandGetterReads += 1;
      return "terminal";
    },
  });
  const hostile = await opened.value.registry.change({
    type: "create",
    requestId: "hostile-command",
    id: "hostile-command",
    expectedRevision: 0,
    scope: "session",
    source: hostileSource,
    delivery: { kind: "session", sessionId: "result-session" },
  } as unknown as MonitorCommand);
  assert.equal(hostile.ok, false);
  assert.equal(commandGetterReads, 0);

  const cyclicInput: Record<string, unknown> = {};
  cyclicInput.self = cyclicInput;
  const cyclic = await opened.value.registry.change({
    type: "create",
    requestId: "cyclic-command",
    id: "cyclic-command",
    expectedRevision: 0,
    scope: "session",
    source: {
      kind: "poll",
      adapter: "adapter",
      intervalMs: 5_000,
      input: cyclicInput,
    },
    delivery: { kind: "session", sessionId: "result-session" },
  } as unknown as MonitorCommand);
  assert.equal(cyclic.ok, false);
  const proxied = await opened.value.registry.change(
    new Proxy({}, {}) as MonitorCommand,
  );
  assert.equal(proxied.ok, false);

  assert.equal(
    (
      await opened.value.registry.change({
        type: "create",
        requestId: "safe-evidence-create",
        id: "safe-evidence",
        expectedRevision: 0,
        scope: "session",
        source: { kind: "terminal", terminalId: "safe-evidence-terminal" },
        delivery: { kind: "session", sessionId: "result-session" },
      })
    ).ok,
    true,
  );
  let evidenceGetterReads = 0;
  const payload: Record<string, unknown> = {
    text: "READY\u001b[31m token=super-secret\u0000",
  };
  Object.defineProperty(payload, "secret", {
    enumerable: true,
    get() {
      evidenceGetterReads += 1;
      return "must-not-run";
    },
  });
  payload.self = payload;
  emit({ type: "terminal.line", payload: payload as never });
  for (let spin = 0; delivered.length === 0 && spin < 100; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(evidenceGetterReads, 0);
  assert.equal(delivered.length, 1);
  const artifact = await fixture.artifacts.get(delivered[0]!.evidence.id);
  assert.equal(artifact.ok, true);
  if (artifact.ok) {
    const body = Buffer.from(artifact.value.body).toString("utf8");
    assert.doesNotMatch(body, /super-secret|must-not-run|\\u001b|\\u0000/u);
    assert.match(body, /\[REDACTED\]|\[CYCLE\]|\[ACCESSOR\]/u);
  }

  await opened.value.close();
  await fixture.triggers.close();
  await fixture.lifecycle.shutdown("quit");
});

test("hung delivery cannot make close unbounded and unresolved work is reported", async () => {
  const fixture = createFixture();
  let emit!: (event: MonitorSourceEvent) => void;
  fixture.options.sources = {
    async open(_definition, publish) {
      emit = publish;
      return { close() {} };
    },
  };
  let deliveryCalls = 0;
  fixture.options.delivery = {
    async deliver() {
      deliveryCalls += 1;
      return new Promise<never>(() => undefined);
    },
  };
  const opened = await createMonitorRegistry({
    ...fixture.options,
    limits: { batchWindowMs: 1, callbackDrainMs: 20, closeDrainMs: 50 },
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  await opened.value.registry.change({
    type: "create",
    requestId: "hung-close-create",
    id: "hung-close",
    expectedRevision: 0,
    scope: "session",
    source: { kind: "terminal", terminalId: "hung-close-terminal" },
    delivery: { kind: "session", sessionId: "result-session" },
  });
  emit({ type: "terminal.line", payload: { text: "READY" } });
  for (let spin = 0; deliveryCalls === 0 && spin < 100; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));

  const startedAt = Date.now();
  const report = await opened.value.close();
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(report.unresolvedCallbacks, 1);
  assert.ok(report.dropped >= 1);
  emit({ type: "terminal.line", payload: { text: "after close" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(deliveryCalls, 1);

  await fixture.triggers.close();
  await fixture.lifecycle.shutdown("quit");
});

test("Trigger publish rejection increments Monitor dropped and error accounting", async () => {
  const fixture = createFixture();
  await fixture.triggers.close();
  fixture.triggers = createTriggerEngine({
    hostId: "queue-accounting-host",
    maxQueueCount: 1,
    maxActiveConsumers: 1,
  });
  fixture.options.triggers = fixture.triggers;
  let emit!: (event: MonitorSourceEvent) => void;
  fixture.options.sources = {
    async open(_definition, publish) {
      emit = publish;
      return { close() {} };
    },
  };
  fixture.options.delivery = {
    async deliver(_request, signal) {
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { ok: true, value: { state: "delivered" } };
    },
  };
  const opened = await createMonitorRegistry({
    ...fixture.options,
    limits: { batchWindowMs: 1, callbackDrainMs: 20 },
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  await opened.value.registry.change({
    type: "create",
    requestId: "queue-accounting-create",
    id: "queue-accounting",
    expectedRevision: 0,
    scope: "session",
    source: { kind: "terminal", terminalId: "queue-accounting-terminal" },
    delivery: { kind: "session", sessionId: "result-session" },
  });
  for (let index = 0; index < 20; index += 1)
    emit({ type: "terminal.line", payload: { index } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const inspected = await opened.value.registry.inspect({
    id: "queue-accounting",
  });
  assert.equal(inspected.ok, true);
  if (inspected.ok) {
    assert.ok((inspected.value.monitors[0]?.dropped ?? 0) > 0);
    assert.match(
      inspected.value.monitors[0]?.lastError ?? "",
      /publish|queue|trigger/i,
    );
  }

  await opened.value.close();
  await fixture.triggers.close();
  await fixture.lifecycle.shutdown("quit");
});

test("JSON poll adapter rejects ambient fetch and requires pinned destination evidence", () => {
  assert.throws(
    () =>
      createJsonPollAdapter({
        endpoint: "https://poll.example.test/status",
        async authorize(request: { readonly url: string }) {
          return {
            ok: true,
            value: {
              canonicalUrl: request.url,
              addresses: [{ address: "192.0.2.10", family: 4 }],
            },
          };
        },
      } as never),
    /pinned fetch/i,
  );
});

test("malformed persisted state is quarantined without retaining its secret payload", async () => {
  const state = createMemoryStateStore();
  const fixture = createFixture();
  const namespace = createHash("sha256")
    .update(fixture.options.binding.projectId)
    .digest("hex");
  const definitionCollection = `monitor.definitions.${namespace}`;
  const seeded = await state.transact({
    transactionId: "seed-malformed-monitor",
    operations: [
      {
        type: "put-record",
        collection: definitionCollection,
        key: "malformed",
        expectedVersion: null,
        metadata: {
          schemaVersion: 99,
          projectId: fixture.options.binding.projectId,
          secret: "super-secret",
        },
      },
    ],
  });
  assert.equal(seeded.ok, true);

  const opened = await createMonitorRegistry({ ...fixture.options, state });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const inspected = await opened.value.registry.inspect();
  assert.equal(inspected.ok, true);
  if (inspected.ok) assert.deepEqual(inspected.value.monitors, []);
  const exported = await state.export({ format: "snapshot" });
  assert.equal(exported.ok, true);
  if (exported.ok) {
    assert.equal(
      exported.value.snapshot.records.some(
        ({ collection }) => collection === definitionCollection,
      ),
      false,
    );
    const quarantine = exported.value.snapshot.records.find(({ collection }) =>
      collection.startsWith("monitor.quarantine."),
    );
    assert.ok(quarantine);
    assert.doesNotMatch(JSON.stringify(quarantine?.metadata), /super-secret/u);
  }

  await opened.value.close();
  await fixture.triggers.close();
  await fixture.lifecycle.shutdown("quit");
});

test("durable request receipt retention stays within its configured bound", async () => {
  const state = createMemoryStateStore();
  const fixture = createFixture();
  const opened = await createMonitorRegistry({
    ...fixture.options,
    state,
    limits: { maxReceipts: 2 },
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(
    (
      await opened.value.registry.change({
        type: "create",
        requestId: "retention-create",
        id: "retention",
        expectedRevision: 0,
        scope: "durable",
        source: { kind: "file", root: "C:/monitor-test" },
        delivery: { kind: "session", sessionId: "result-session" },
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await opened.value.registry.change({
        type: "pause",
        requestId: "retention-pause",
        id: "retention",
        expectedRevision: 1,
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await opened.value.registry.change({
        type: "resume",
        requestId: "retention-resume",
        id: "retention",
        expectedRevision: 2,
      })
    ).ok,
    true,
  );
  const exported = await state.export({ format: "snapshot" });
  assert.equal(exported.ok, true);
  if (exported.ok) {
    assert.equal(
      exported.value.snapshot.records.filter(({ collection }) =>
        collection.startsWith("monitor.requests."),
      ).length,
      2,
    );
  }

  await opened.value.close();
  await fixture.triggers.close();
  await fixture.lifecycle.shutdown("quit");
});

test("failed source replacement rolls durable state and runtime back to prior truth", async () => {
  const state = createMemoryStateStore();
  const fixture = createFixture();
  const starts: string[] = [];
  fixture.options.sources = {
    async open(definition) {
      const root =
        definition.source.kind === "file" ? definition.source.root : "other";
      starts.push(root);
      if (root.endsWith("-failed")) throw new Error("injected start failure");
      return { close() {} };
    },
  };
  const opened = await createMonitorRegistry({ ...fixture.options, state });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(
    (
      await opened.value.registry.change({
        type: "create",
        requestId: "runtime-rollback-create",
        id: "runtime-rollback",
        expectedRevision: 0,
        scope: "durable",
        source: { kind: "file", root: "C:/monitor-test" },
        delivery: { kind: "session", sessionId: "result-session" },
      })
    ).ok,
    true,
  );
  const replaced = await opened.value.registry.change({
    type: "replace",
    requestId: "runtime-rollback-replace",
    id: "runtime-rollback",
    expectedRevision: 1,
    scope: "durable",
    source: { kind: "file", root: "C:/monitor-test-failed" },
    delivery: { kind: "session", sessionId: "result-session" },
  });
  assert.equal(replaced.ok, false);
  assert.deepEqual(starts, [
    "C:/monitor-test",
    "C:/monitor-test-failed",
    "C:/monitor-test",
  ]);
  const inspected = await opened.value.registry.inspect({
    id: "runtime-rollback",
  });
  assert.equal(inspected.ok, true);
  if (inspected.ok) {
    assert.equal(inspected.value.monitors[0]?.revision, 1);
    assert.deepEqual(inspected.value.monitors[0]?.source, {
      kind: "file",
      root: "C:/monitor-test",
    });
  }
  const exported = await state.export({ format: "snapshot" });
  assert.equal(exported.ok, true);
  if (exported.ok) {
    const definition = exported.value.snapshot.records.find(({ collection }) =>
      collection.startsWith("monitor.definitions."),
    );
    assert.doesNotMatch(JSON.stringify(definition?.metadata), /-failed/u);
  }

  await opened.value.close();
  await fixture.triggers.close();
  await fixture.lifecycle.shutdown("quit");
});

test("WebSocket close during policy await never loads or opens a client", async () => {
  let finishPolicy!: () => void;
  let clientLoads = 0;
  const factory = createWebSocketMonitorSourceFactory({
    allowedOrigins: ["wss://events.example.test"],
    control: {
      async authorize(request) {
        await new Promise<void>((resolve) => {
          finishPolicy = resolve;
        });
        return {
          ok: true,
          value: {
            canonicalUrl: request.url,
            addresses: [{ address: "192.0.2.10", family: 4 }],
          },
        };
      },
    },
    async loadClient() {
      clientLoads += 1;
      return import("ws");
    },
  });
  const controller = new AbortController();
  const opening = factory.open(
    {
      id: "ws-close-race",
      revision: 1,
      scope: "session",
      state: "active",
      source: {
        kind: "websocket",
        url: "wss://events.example.test/socket",
      },
      delivery: { kind: "session", sessionId: "result-session" },
    },
    () => undefined,
    controller.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  finishPolicy();
  const lease = await opening;
  await lease.close();
  assert.equal(clientLoads, 0);
});
