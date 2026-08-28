import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createFileSystemArtifactStore,
  createInMemoryArtifactStore,
} from "./src/core/artifacts/index.ts";
import { createLifecycleSupervisor } from "./src/core/lifecycle/supervisor.ts";
import {
  createMemoryStateStore,
  createSqliteStateStore,
} from "./src/core/persistence/index.ts";
import type { ResolvedProjectIdentity } from "./src/core/projects/index.ts";
import { CHILD_EXECUTION_ROLES } from "../shared/execution-role.ts";
import {
  createSessionBrokerModule,
  issueHostSessionProof,
  type HostSessionProof,
  type MessageSummary,
  type SendMessageRequest,
  type SessionBrokerResult,
} from "./src/messaging/index.ts";

function project(projectId: string): ResolvedProjectIdentity {
  return {
    kind: "non-git",
    projectId,
    requestedCwd: `C:/${projectId}`,
    canonicalCwd: `c:/${projectId}`,
    cwdWasAliased: false,
  };
}

function delivery(name: string) {
  return {
    snapshot: () => ({
      name,
      status: "idle" as const,
      capabilities: [{ id: "pi.delivery/inbox", version: 1 }],
    }),
    subscribe: () => () => {},
    async deliverOnce() {
      return {
        ok: true as const,
        value: { state: "accepted" as const, durableReceipt: "fixture" },
      };
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("attached sessions discover opted-in presence in the current project", async () => {
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore(),
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
  });
  const alpha = await module.attach(
    {
      piSessionId: "session-alpha",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one/alpha",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("Alpha"),
  );
  const beta = await module.attach(
    {
      piSessionId: "session-beta",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one/beta",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("Beta"),
  );

  assert.equal(alpha.ok, true);
  assert.equal(beta.ok, true);
  if (!alpha.ok || !beta.ok) return;
  const discovered = await alpha.value.discover();
  assert.equal(discovered.ok, true);
  if (!discovered.ok) return;
  assert.deepEqual(
    discovered.value.map(
      ({ address, name, executionRole, visibleBecause }) => ({
        piSessionId: address.piSessionId,
        name,
        executionRole,
        visibleBecause,
      }),
    ),
    [
      {
        piSessionId: "session-alpha",
        name: "Alpha",
        executionRole: "parent",
        visibleBecause: "same-project",
      },
      {
        piSessionId: "session-beta",
        name: "Beta",
        executionRole: "parent",
        visibleBecause: "same-project",
      },
    ],
  );

  await lifecycle.shutdown("quit");
});

test("host runtime updates refresh fenced session presence", async () => {
  let now = 1_000;
  let listener:
    | ((snapshot: {
        name: string;
        status: "idle" | "running";
        capabilities: readonly { id: string; version: number }[];
      }) => void)
    | undefined;
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore({ now: () => now }),
    artifacts: createInMemoryArtifactStore({ clock: () => now }),
    lifecycle,
    clock: () => now,
  });
  const attached = await module.attach(
    {
      piSessionId: "session-live",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    {
      snapshot: () => ({
        name: "Live",
        status: "idle",
        capabilities: [{ id: "pi.delivery/inbox", version: 1 }],
      }),
      subscribe(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      async deliverOnce() {
        return {
          ok: true as const,
          value: { state: "accepted" as const, durableReceipt: "fixture" },
        };
      },
    },
  );
  assert.equal(attached.ok, true);
  if (!attached.ok) return;

  now = 2_000;
  listener?.({
    name: "Live",
    status: "running",
    capabilities: [{ id: "pi.delivery/inbox", version: 1 }],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const discovered = await attached.value.discover();
  assert.equal(discovered.ok, true);
  if (discovered.ok) {
    assert.equal(discovered.value[0]?.status, "running");
    assert.equal(discovered.value[0]?.lastHeartbeatAt, 2_000);
  }
  await lifecycle.shutdown("quit");
});

test("send durably enqueues an ordered no-authority envelope", async () => {
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore(),
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
  });
  const sender = await module.attach(
    {
      piSessionId: "session-sender",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one/sender",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("Sender"),
  );
  const recipient = await module.attach(
    {
      piSessionId: "session-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one/recipient",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("Recipient"),
  );
  assert.equal(sender.ok, true);
  assert.equal(recipient.ok, true);
  if (!sender.ok || !recipient.ok) return;
  const sessions = await sender.value.discover();
  assert.equal(sessions.ok, true);
  if (!sessions.ok) return;
  const target = sessions.value.find(
    ({ address }) => address.piSessionId === "session-recipient",
  );
  assert.ok(target);

  const sent = await sender.value.send({
    requestId: "tool-call-1",
    recipients: [
      {
        piSessionId: target.address.piSessionId,
        expectedIncarnation: target.incarnation,
      },
    ],
    summary: "Review finished",
    body: { kind: "text", text: "No material findings." },
  });

  assert.equal(sent.ok, true);
  if (!sent.ok) return;
  assert.equal(sent.value.requestId, "tool-call-1");
  assert.equal(sent.value.replayed, false);
  assert.match(sent.value.body.id, /^[a-f0-9]{64}$/);
  assert.deepEqual(sent.value.deliveries, [
    {
      recipient: {
        piSessionId: "session-recipient",
        expectedIncarnation: target.incarnation,
      },
      messageId: sent.value.deliveries[0]?.messageId,
      mailboxPosition: 1,
      state: "queued",
    },
  ]);

  let mailbox = await recipient.value.messages();
  const deliveryDeadline = Date.now() + 2_000;
  while (
    mailbox.ok &&
    mailbox.value[0]?.state !== "delivered" &&
    Date.now() < deliveryDeadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    mailbox = await recipient.value.messages();
  }
  assert.equal(mailbox.ok, true);
  if (mailbox.ok) {
    assert.equal(mailbox.value.length, 1);
    assert.deepEqual(mailbox.value[0]?.envelope, {
      id: sent.value.deliveries[0]?.messageId,
      mailboxPosition: 1,
      sender: {
        piSessionId: "session-sender",
        incarnation: sessions.value.find(
          ({ address }) => address.piSessionId === "session-sender",
        )?.incarnation,
        executionRole: "parent",
        projectId: "project-one",
        name: "Sender",
      },
      recipient: { piSessionId: "session-recipient" },
      sentAt: mailbox.value[0]?.envelope.sentAt,
      summary: "Review finished",
      body: sent.value.body,
      delivery: { mode: "pi/inbox", version: 1 },
      trust: "untrusted",
      authority: "none",
    });
    assert.equal(mailbox.value[0]?.state, "delivered");
    assert.equal(mailbox.value[0]?.attempts, 1);
  }

  await lifecycle.shutdown("quit");
});

test("host request IDs replay once and reject changed content", async () => {
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore(),
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
  });
  const sender = await module.attach(
    {
      piSessionId: "idempotent-sender",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("Sender"),
  );
  const recipient = await module.attach(
    {
      piSessionId: "idempotent-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("Recipient"),
  );
  assert.equal(sender.ok, true);
  assert.equal(recipient.ok, true);
  if (!sender.ok || !recipient.ok) return;
  const request = {
    requestId: "stable-tool-call",
    recipients: [{ piSessionId: "idempotent-recipient" }],
    summary: "One durable request",
    body: { kind: "text" as const, text: "same content" },
  };

  const first = await sender.value.send(request);
  const replay = await sender.value.send(request);
  const changed = await sender.value.send({
    ...request,
    summary: "Changed content",
  });

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (first.ok && replay.ok) {
    assert.equal(first.value.replayed, false);
    assert.equal(replay.value.replayed, true);
    assert.equal(replay.value.body.id, first.value.body.id);
    assert.deepEqual(replay.value.deliveries, first.value.deliveries);
  }
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.error.code, "invalid_request");
  const mailbox = await recipient.value.messages();
  assert.equal(mailbox.ok, true);
  if (mailbox.ok) assert.equal(mailbox.value.length, 1);

  await lifecycle.shutdown("quit");
});

test("send rejects authority-shaped fields and hard limit violations", async () => {
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore(),
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
  });
  const sender = await module.attach(
    {
      piSessionId: "bounded-sender",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("Sender"),
  );
  const recipient = await module.attach(
    {
      piSessionId: "bounded-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("Recipient"),
  );
  assert.equal(sender.ok, true);
  assert.equal(recipient.ok, true);
  if (!sender.ok || !recipient.ok) return;

  const spoofed = await sender.value.send({
    requestId: "spoofed",
    recipients: [{ piSessionId: "bounded-recipient" }],
    summary: "forged",
    body: { kind: "text", text: "content" },
    sender: { piSessionId: "someone-else" },
    proof: "forged",
    authority: "user",
  } as unknown as SendMessageRequest);
  const tooMany = await sender.value.send({
    requestId: "too-many",
    recipients: Array.from({ length: 33 }, (_, index) => ({
      piSessionId: `recipient-${index}`,
    })),
    summary: "fanout",
    body: { kind: "text", text: "content" },
  });
  const tooLarge = await sender.value.send({
    requestId: "too-large",
    recipients: [{ piSessionId: "bounded-recipient" }],
    summary: "large",
    body: {
      kind: "bytes",
      bytes: new Uint8Array(1024 * 1024 + 1),
      mediaType: "application/octet-stream",
    },
  });

  assert.equal(spoofed.ok, false);
  if (!spoofed.ok) assert.equal(spoofed.error.code, "invalid_request");
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.equal(tooMany.error.code, "invalid_request");
  assert.equal(tooLarge.ok, false);
  if (!tooLarge.ok) assert.equal(tooLarge.error.code, "message_too_large");
  const mailbox = await recipient.value.messages();
  assert.equal(mailbox.ok, true);
  if (mailbox.ok) assert.deepEqual(mailbox.value, []);

  await lifecycle.shutdown("quit");
});

test("offline mailbox pumps in recipient order after a new incarnation attaches", async () => {
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore(),
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
    limits: { heartbeatMs: 10, deliveryClaimTtlMs: 50 },
  });
  const sender = await module.attach(
    {
      piSessionId: "offline-sender",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("Sender"),
  );
  const originalRecipient = await module.attach(
    {
      piSessionId: "offline-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("Original recipient"),
  );
  assert.equal(sender.ok, true);
  assert.equal(originalRecipient.ok, true);
  if (!sender.ok || !originalRecipient.ok) return;
  await originalRecipient.value.close("resume");

  const first = await sender.value.send({
    requestId: "offline-1",
    recipients: [{ piSessionId: "offline-recipient" }],
    summary: "First",
    body: { kind: "text", text: "first body" },
  });
  const second = await sender.value.send({
    requestId: "offline-2",
    recipients: [{ piSessionId: "offline-recipient" }],
    summary: "Second",
    body: { kind: "text", text: "second body" },
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;

  const delivered: Array<{
    readonly id: string;
    readonly position: number;
    readonly renderedContent: string;
  }> = [];
  const resumed = await module.attach(
    {
      piSessionId: "offline-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    {
      snapshot: () => ({
        name: "Resumed recipient",
        status: "idle",
        capabilities: [{ id: "pi.delivery/inbox", version: 1 }],
      }),
      subscribe: () => () => {},
      async deliverOnce(item) {
        delivered.push({
          id: item.envelope.id,
          position: item.envelope.mailboxPosition,
          renderedContent: item.renderedContent,
        });
        return {
          ok: true as const,
          value: {
            state: "accepted" as const,
            durableReceipt: `receipt-${item.envelope.id}`,
          },
        };
      },
    },
  );
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;

  const deadline = Date.now() + 2_000;
  while (delivered.length < 2 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(
    delivered.map(({ id, position }) => ({ id, position })),
    [
      { id: first.value.deliveries[0]?.messageId, position: 1 },
      { id: second.value.deliveries[0]?.messageId, position: 2 },
    ],
  );
  assert.match(delivered[0]?.renderedContent ?? "", /untrusted data/);
  assert.match(delivered[0]?.renderedContent ?? "", /authority: none/);

  const mailbox = await resumed.value.messages();
  assert.equal(mailbox.ok, true);
  if (mailbox.ok) {
    assert.deepEqual(
      mailbox.value.map(({ envelope, state, attempts }) => ({
        position: envelope.mailboxPosition,
        state,
        attempts,
      })),
      [
        { position: 1, state: "delivered", attempts: 1 },
        { position: 2, state: "delivered", attempts: 1 },
      ],
    );
  }

  await lifecycle.shutdown("quit");
});

test("explicit fanout is all-or-none and inspectable outbound", async () => {
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore(),
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
  });
  const attach = (piSessionId: string, name: string) =>
    module.attach(
      {
        piSessionId,
        proof: issueHostSessionProof(),
        executionRole: "parent",
        project: project("project-one"),
        cwd: "C:/project-one",
        exposure: {
          discoverableBy: "same-project",
          acceptsFrom: "same-project",
        },
      },
      delivery(name),
    );
  const sender = await attach("fanout-sender", "Sender");
  const firstRecipient = await attach("fanout-first", "First");
  const secondRecipient = await attach("fanout-second", "Second");
  assert.equal(sender.ok, true);
  assert.equal(firstRecipient.ok, true);
  assert.equal(secondRecipient.ok, true);
  if (!sender.ok || !firstRecipient.ok || !secondRecipient.ok) return;
  await firstRecipient.value.close("quit");
  await secondRecipient.value.close("quit");

  const fanout = await sender.value.send({
    requestId: "fanout-success",
    recipients: [
      { piSessionId: "fanout-first" },
      { piSessionId: "fanout-second" },
    ],
    summary: "Shared result",
    body: { kind: "text", text: "One canonical body." },
  });
  const rejected = await sender.value.send({
    requestId: "fanout-rejected",
    recipients: [
      { piSessionId: "fanout-first" },
      { piSessionId: "missing-recipient" },
    ],
    summary: "Must not partially enqueue",
    body: { kind: "text", text: "No partial delivery." },
  });

  assert.equal(fanout.ok, true);
  if (fanout.ok) {
    assert.equal(fanout.value.deliveries.length, 2);
    assert.equal(fanout.value.deliveries[0]?.mailboxPosition, 1);
    assert.equal(fanout.value.deliveries[1]?.mailboxPosition, 1);
  }
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "recipient_not_found");

  const outbound = await sender.value.messages({ direction: "outbound" });
  assert.equal(outbound.ok, true);
  if (outbound.ok) {
    assert.deepEqual(
      outbound.value.map(({ envelope }) => ({
        recipient: envelope.recipient.piSessionId,
        position: envelope.mailboxPosition,
        bodyId: envelope.body.id,
      })),
      [
        {
          recipient: "fanout-first",
          position: 1,
          bodyId: fanout.ok ? fanout.value.body.id : "",
        },
        {
          recipient: "fanout-second",
          position: 2,
          bodyId: fanout.ok ? fanout.value.body.id : "",
        },
      ],
    );
  }

  await lifecycle.shutdown("quit");
});

test("offline mailbox rejects sends at its durable pending limit", async () => {
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore(),
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
    limits: { maxPendingPerRecipient: 1 },
  });
  const sender = await module.attach(
    {
      piSessionId: "capacity-sender",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("Sender"),
  );
  const recipient = await module.attach(
    {
      piSessionId: "capacity-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("Recipient"),
  );
  assert.equal(sender.ok, true);
  assert.equal(recipient.ok, true);
  if (!sender.ok || !recipient.ok) return;
  await recipient.value.close("quit");

  const first = await sender.value.send({
    requestId: "capacity-1",
    recipients: [{ piSessionId: "capacity-recipient" }],
    summary: "First",
    body: { kind: "text", text: "first" },
  });
  const full = await sender.value.send({
    requestId: "capacity-2",
    recipients: [{ piSessionId: "capacity-recipient" }],
    summary: "Second",
    body: { kind: "text", text: "second" },
  });

  assert.equal(first.ok, true);
  assert.equal(full.ok, false);
  if (!full.ok) assert.equal(full.error.code, "mailbox_full");
  const outbound = await sender.value.messages({ direction: "outbound" });
  assert.equal(outbound.ok, true);
  if (outbound.ok) assert.equal(outbound.value.length, 1);

  await lifecycle.shutdown("quit");
});

test("discovery defaults to opted-in same-project visibility", async () => {
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore(),
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
  });
  const attach = (
    piSessionId: string,
    projectId: string,
    discoverableBy: "none" | "same-project" | "local-user",
  ) =>
    module.attach(
      {
        piSessionId,
        proof: issueHostSessionProof(),
        executionRole: "parent",
        project: project(projectId),
        cwd: `C:/${projectId}`,
        exposure: { discoverableBy, acceptsFrom: discoverableBy },
      },
      delivery(piSessionId),
    );
  const requester = await attach(
    "visible-requester",
    "project-one",
    "same-project",
  );
  await attach("hidden-peer", "project-one", "none");
  await attach("cross-visible", "project-two", "local-user");
  await attach("cross-private", "project-two", "same-project");
  assert.equal(requester.ok, true);
  if (!requester.ok) return;

  const current = await requester.value.discover();
  const allVisible = await requester.value.discover({ project: "all-visible" });
  assert.equal(current.ok, true);
  assert.equal(allVisible.ok, true);
  if (current.ok) {
    assert.deepEqual(
      current.value.map(({ address }) => address.piSessionId),
      ["visible-requester"],
    );
  }
  if (allVisible.ok) {
    assert.deepEqual(
      allVisible.value.map(({ address, visibleBecause }) => ({
        id: address.piSessionId,
        visibleBecause,
      })),
      [
        { id: "cross-visible", visibleBecause: "local-user" },
        { id: "visible-requester", visibleBecause: "same-project" },
      ],
    );
  }

  await lifecycle.shutdown("quit");
});

test("discovery pages beyond one thousand nonmatching presence records", async () => {
  const lifecycle = createLifecycleSupervisor();
  const state = createMemoryStateStore();
  const module = createSessionBrokerModule({
    state,
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
  });
  const requester = await module.attach(
    {
      piSessionId: "requester",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: { discoverableBy: "same-project", acceptsFrom: "same-project" },
    },
    delivery("Requester"),
  );
  assert.equal(requester.ok, true);
  if (!requester.ok) return;
  const now = Date.now();
  for (let start = 0; start <= 1_000; start += 100) {
    const operations = Array.from(
      { length: Math.min(100, 1_001 - start) },
      (_, offset) => {
        const index = start + offset;
        return {
          type: "put-record" as const,
          collection: "session-broker.presence",
          key: `session-${index.toString().padStart(4, "0")}`,
          metadata: {
            incarnation: `incarnation-${index}`,
            proofVerifier: `proof-${index}`,
            executionRole: "parent",
            projectId: "project-one",
            cwd: "C:/project-one",
            exposure: {
              discoverableBy: "same-project",
              acceptsFrom: "same-project",
            },
            snapshot: {
              name: `Session ${index}`,
              status: "idle",
              capabilities:
                index === 1_000
                  ? [{ id: "fixture/rare", version: 1 }]
                  : [{ id: "fixture/common", version: 1 }],
            },
            lastHeartbeatAt: now,
            online: true,
          },
          expectedVersion: null,
        };
      },
    );
    const seeded = await state.transact({
      transactionId: `seed-presence-${start}`,
      operations,
    });
    assert.equal(seeded.ok, true);
  }

  const discovered = await requester.value.discover({
    capability: "fixture/rare",
    limit: 1,
  });

  assert.equal(discovered.ok, true);
  if (discovered.ok) {
    assert.equal(discovered.value[0]?.address.piSessionId, "session-1000");
  }
  await lifecycle.shutdown("quit");
});

test("process proof and lease fence reject forged or stale session handles", async () => {
  let now = 0;
  const lifecycle = createLifecycleSupervisor();
  const state = createMemoryStateStore({ now: () => now });
  const module = createSessionBrokerModule({
    state,
    artifacts: createInMemoryArtifactStore({ clock: () => now }),
    lifecycle,
    clock: () => now,
    limits: { sessionTtlMs: 20, heartbeatMs: 10_000 },
  });
  const binding = {
    piSessionId: "fenced-session",
    executionRole: "parent" as const,
    project: project("project-one"),
    cwd: "C:/project-one",
    exposure: {
      discoverableBy: "same-project" as const,
      acceptsFrom: "same-project" as const,
    },
  };
  const forged = await module.attach(
    {
      ...binding,
      proof: Object.freeze({}) as HostSessionProof,
    },
    delivery("Forged"),
  );
  const first = await module.attach(
    { ...binding, proof: issueHostSessionProof() },
    delivery("First"),
  );
  const held = await module.attach(
    { ...binding, proof: issueHostSessionProof() },
    delivery("Held"),
  );
  assert.equal(forged.ok, false);
  if (!forged.ok) assert.equal(forged.error.code, "invalid_request");
  assert.equal(first.ok, true);
  assert.equal(held.ok, false);
  if (!held.ok) assert.equal(held.error.code, "identity_held");
  if (!first.ok) return;

  now = 21;
  const replacement = await module.attach(
    { ...binding, proof: issueHostSessionProof() },
    delivery("Replacement"),
  );
  assert.equal(replacement.ok, true);
  const stale = await first.value.discover();
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "identity_lost");

  await lifecycle.shutdown("quit");
});

test("transient delivery retries the head before advancing and clears its error", async () => {
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore(),
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
    limits: { heartbeatMs: 10, deliveryClaimTtlMs: 50 },
  });
  const sender = await module.attach(
    {
      piSessionId: "retry-sender",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("Sender"),
  );
  let shouldFail = true;
  const accepted: string[] = [];
  const recipient = await module.attach(
    {
      piSessionId: "retry-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    {
      snapshot: () => ({
        name: "Recipient",
        status: "idle",
        capabilities: [{ id: "pi.delivery/inbox", version: 1 }],
      }),
      subscribe: () => () => {},
      async deliverOnce(item) {
        if (shouldFail) {
          shouldFail = false;
          return {
            ok: false as const,
            error: {
              code: "temporarily_unavailable" as const,
              message: "try again",
              retryable: true,
            },
          };
        }
        accepted.push(item.envelope.id);
        return {
          ok: true as const,
          value: {
            state: "accepted" as const,
            durableReceipt: `receipt-${item.envelope.id}`,
          },
        };
      },
    },
  );
  assert.equal(sender.ok, true);
  assert.equal(recipient.ok, true);
  if (!sender.ok || !recipient.ok) return;

  const first = await sender.value.send({
    requestId: "retry-first",
    recipients: [{ piSessionId: "retry-recipient" }],
    summary: "First",
    body: { kind: "text", text: "first" },
  });
  const second = await sender.value.send({
    requestId: "retry-second",
    recipients: [{ piSessionId: "retry-recipient" }],
    summary: "Second",
    body: { kind: "text", text: "second" },
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;

  let mailbox = await recipient.value.messages();
  const deadline = Date.now() + 2_000;
  while (
    mailbox.ok &&
    mailbox.value.some(({ state }) => state !== "delivered") &&
    Date.now() < deadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    mailbox = await recipient.value.messages();
  }
  assert.equal(mailbox.ok, true);
  if (mailbox.ok) {
    assert.deepEqual(accepted, [
      first.value.deliveries[0]?.messageId,
      second.value.deliveries[0]?.messageId,
    ]);
    assert.deepEqual(
      mailbox.value.map(({ state, attempts }) => ({ state, attempts })),
      [
        { state: "delivered", attempts: 2 },
        { state: "delivered", attempts: 1 },
      ],
    );
    assert.equal(Object.hasOwn(mailbox.value[0] ?? {}, "lastErrorCode"), false);
  }

  await lifecycle.shutdown("quit");
});

test("send snapshots caller-owned binary input before yielding", async () => {
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore(),
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
  });
  const sender = await module.attach(
    {
      piSessionId: "snapshot-sender",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("Sender"),
  );
  const recipient = await module.attach(
    {
      piSessionId: "snapshot-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("Recipient"),
  );
  assert.equal(sender.ok, true);
  assert.equal(recipient.ok, true);
  if (!sender.ok || !recipient.ok) return;
  const bytes = new Uint8Array([65]);
  const request = {
    requestId: "snapshot-request",
    recipients: [{ piSessionId: "snapshot-recipient" }],
    summary: "Snapshot",
    body: {
      kind: "bytes" as const,
      bytes,
      mediaType: "application/octet-stream",
    },
  };

  const sending = sender.value.send(request);
  bytes[0] = 66;
  const first = await sending;
  bytes[0] = 65;
  const replay = await sender.value.send(request);

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (first.ok && replay.ok) {
    assert.equal(replay.value.replayed, true);
    assert.equal(replay.value.body.id, first.value.body.id);
  }

  await lifecycle.shutdown("quit");
});

test("send sanitizes secret canaries before durable persistence", async () => {
  const lifecycle = createLifecycleSupervisor();
  const state = createMemoryStateStore();
  const artifacts = createInMemoryArtifactStore();
  const rendered: string[] = [];
  const module = createSessionBrokerModule({ state, artifacts, lifecycle });
  const canary = "Q7vK9mP2xR8sT4wY6zB3cD5fG1hJ0nL";
  const sessionCanary = "SessionCanary-42";
  const attach = (piSessionId: string, secretBearing = false) =>
    module.attach(
      {
        piSessionId,
        proof: issueHostSessionProof(),
        executionRole: "parent",
        project: project("project-one"),
        cwd: "C:/project-one",
        exposure: {
          discoverableBy: "same-project",
          acceptsFrom: "same-project",
        },
      },
      secretBearing
        ? {
            snapshot: () => ({
              name: `Tracker session=${sessionCanary}`,
              status: "idle" as const,
              capabilities: [
                {
                  id: `pi.delivery/inbox/session=${sessionCanary}`,
                  version: 1,
                  parameters: {
                    session: sessionCanary,
                    callback: `https://example.test/cb?session=${sessionCanary}`,
                  },
                },
                { id: "pi.delivery/inbox", version: 1 },
              ],
            }),
            subscribe: () => () => {},
            async deliverOnce(item: { renderedContent: string }) {
              rendered.push(item.renderedContent);
              return {
                ok: true as const,
                value: {
                  state: "accepted" as const,
                  durableReceipt: `adapter-receipt-${canary}`,
                },
              };
            },
          }
        : delivery(piSessionId),
    );
  const sender = await attach("sanitized-sender");
  const recipient = await attach("sanitized-recipient", true);
  assert.equal(sender.ok, true);
  assert.equal(recipient.ok, true);
  if (!sender.ok || !recipient.ok) return;

  const sent = await sender.value.send({
    requestId: "sanitized-send",
    recipients: [{ piSessionId: "sanitized-recipient" }],
    summary: `callback=https://example.test/cb?session=${sessionCanary}`,
    body: {
      kind: "text",
      text: `callback=https://example.test/cb?session=${sessionCanary}`,
      mediaType: `text/${canary}`,
    },
    delivery: {
      mode: "pi/inbox",
      version: 1,
      options: { session: sessionCanary, nested: { password: canary } },
    },
  });
  assert.equal(sent.ok, true);
  if (!sent.ok) return;
  const rejectedBinary = await sender.value.send({
    requestId: "sanitized-binary",
    recipients: [{ piSessionId: "sanitized-recipient" }],
    summary: "binary",
    body: {
      kind: "bytes",
      bytes: Buffer.from(canary),
      mediaType: "application/octet-stream",
    },
  });
  assert.equal(rejectedBinary.ok, false);
  const missing = await sender.value.send({
    requestId: "sanitized-missing-recipient",
    recipients: [{ piSessionId: `missing?session=${sessionCanary}` }],
    summary: "missing",
    body: { kind: "text", text: "body" },
  });
  assert.equal(missing.ok, false);
  if (!missing.ok)
    assert.equal(missing.error.message.includes(sessionCanary), false);

  const stored = await artifacts.get(sent.value.body.id);
  assert.equal(stored.ok, true);
  if (stored.ok) {
    const body = Buffer.from(stored.value.body).toString("utf8");
    assert.equal(body.includes(canary), false);
    assert.equal(body.includes(sessionCanary), false);
    assert.equal(stored.value.metadata.metadata?.classification, "sanitized");
  }
  let outbound = await sender.value.messages({ direction: "outbound" });
  const deliveryDeadline = Date.now() + 1_000;
  while (
    outbound.ok &&
    outbound.value[0]?.state !== "delivered" &&
    Date.now() < deliveryDeadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    outbound = await sender.value.messages({ direction: "outbound" });
  }
  const exported = await state.export({ format: "snapshot" });
  assert.equal(exported.ok, true);
  if (exported.ok && exported.value.format === "snapshot") {
    assert.equal(
      [canary, sessionCanary].some((value) =>
        JSON.stringify(exported.value.snapshot).includes(value),
      ),
      false,
    );
  }
  const discovered = await sender.value.discover({ status: "all" });
  assert.equal(discovered.ok, true);
  if (discovered.ok) {
    assert.equal(
      [canary, sessionCanary].some((value) =>
        JSON.stringify(discovered.value).includes(value),
      ),
      false,
    );
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    [canary, sessionCanary].some((value) =>
      rendered.join("\n").includes(value),
    ),
    false,
  );
  assert.equal(
    outbound.ok &&
      [canary, sessionCanary].some((value) =>
        JSON.stringify(outbound.value).includes(value),
      ),
    false,
  );

  await lifecycle.shutdown("quit");
});

test("dependency errors are secret-sanitized and byte-bounded", async () => {
  const canary = "DependencySessionCanary-42";
  const artifacts = createInMemoryArtifactStore();
  const artifactStore = {
    ...artifacts,
    async collect() {
      return {
        ok: false as const,
        error: {
          code: "io_error" as const,
          message: `https://example.test/?session=${canary}${"x".repeat(10_000)}`,
          retryable: true,
          details: { session: canary },
        },
      };
    },
  };
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore(),
    artifacts: artifactStore,
    lifecycle,
  });
  const attach = (piSessionId: string) =>
    module.attach(
      {
        piSessionId,
        proof: issueHostSessionProof(),
        executionRole: "parent",
        project: project("project-one"),
        cwd: "C:/project-one",
        exposure: {
          discoverableBy: "same-project",
          acceptsFrom: "same-project",
        },
      },
      delivery(piSessionId),
    );
  const sender = await attach("error-sender");
  const recipient = await attach("error-recipient");
  assert.equal(sender.ok, true);
  assert.equal(recipient.ok, true);
  if (!sender.ok || !recipient.ok) return;

  const sent = await sender.value.send({
    requestId: "bounded-error",
    recipients: [{ piSessionId: "error-recipient" }],
    summary: "Error",
    body: { kind: "text", text: "body" },
  });

  assert.equal(sent.ok, false);
  if (!sent.ok) {
    assert.equal(sent.error.code, "artifact_failed");
    assert.equal(sent.error.message.includes(canary), false);
    assert.ok(Buffer.byteLength(sent.error.message) <= 2_048);
    assert.equal(
      JSON.stringify(sent.error.details ?? {}).includes(canary),
      false,
    );
  }
  await lifecycle.shutdown("quit");
});

test("concurrent distinct sends retry one native SQLite mailbox commit", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "session-broker-distinct-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const opened = createSqliteStateStore({
    path: join(directory, "state.sqlite"),
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: opened.value,
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
  });
  const attach = (piSessionId: string) =>
    module.attach(
      {
        piSessionId,
        proof: issueHostSessionProof(),
        executionRole: "parent",
        project: project("project-one"),
        cwd: "C:/project-one",
        exposure: {
          discoverableBy: "same-project",
          acceptsFrom: "same-project",
        },
      },
      delivery(piSessionId),
    );
  const firstSender = await attach("distinct-sender-a");
  const secondSender = await attach("distinct-sender-b");
  const recipient = await attach("distinct-recipient");
  assert.equal(firstSender.ok, true);
  assert.equal(secondSender.ok, true);
  assert.equal(recipient.ok, true);
  if (!firstSender.ok || !secondSender.ok || !recipient.ok) return;
  await recipient.value.close("quit");

  const [first, second] = await Promise.all([
    firstSender.value.send({
      requestId: "distinct-a",
      recipients: [{ piSessionId: "distinct-recipient" }],
      summary: "A",
      body: { kind: "text", text: "A" },
    }),
    secondSender.value.send({
      requestId: "distinct-b",
      recipients: [{ piSessionId: "distinct-recipient" }],
      summary: "B",
      body: { kind: "text", text: "B" },
    }),
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.notEqual(
      first.value.deliveries[0]?.mailboxPosition,
      second.value.deliveries[0]?.mailboxPosition,
    );
  }
  await lifecycle.shutdown("quit");
});

test("expired orphan body artifacts are reclaimed before a later send", async () => {
  let now = 0;
  let failCommits = true;
  const baseState = createMemoryStateStore({ now: () => now });
  const state = {
    ...baseState,
    transact(input: Parameters<typeof baseState.transact>[0]) {
      if (
        failCommits &&
        input.transactionId.startsWith("session-broker.send:")
      ) {
        return Promise.resolve({
          ok: false as const,
          error: {
            code: "VERSION_CONFLICT" as const,
            message: "fixture conflict",
            retryable: true,
          },
        });
      }
      return baseState.transact(input);
    },
  };
  const artifacts = createInMemoryArtifactStore({ clock: () => now });
  const storedIds: string[] = [];
  const artifactStore = {
    ...artifacts,
    async put(input: Parameters<typeof artifacts.put>[0]) {
      const result = await artifacts.put(input);
      if (result.ok) storedIds.push(result.value.id);
      return result;
    },
  };
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state,
    artifacts: artifactStore,
    lifecycle,
    clock: () => now,
    limits: { sessionTtlMs: 90 * 24 * 60 * 60 * 1_000 },
  });
  const attach = (piSessionId: string) =>
    module.attach(
      {
        piSessionId,
        proof: issueHostSessionProof(),
        executionRole: "parent",
        project: project("project-one"),
        cwd: "C:/project-one",
        exposure: {
          discoverableBy: "same-project",
          acceptsFrom: "same-project",
        },
      },
      delivery(piSessionId),
    );
  const sender = await attach("orphan-sender");
  const recipient = await attach("orphan-recipient");
  assert.equal(sender.ok, true);
  assert.equal(recipient.ok, true);
  if (!sender.ok || !recipient.ok) return;
  await recipient.value.close("quit");

  const failed = await sender.value.send({
    requestId: "orphan-failed",
    recipients: [{ piSessionId: "orphan-recipient" }],
    summary: "orphan",
    body: { kind: "text", text: "first body" },
  });
  assert.equal(failed.ok, false);
  assert.equal(storedIds.length, 1);
  assert.equal((await artifacts.get(storedIds[0]!)).ok, true);

  now = 30 * 24 * 60 * 60 * 1_000 + 1;
  failCommits = false;
  const sent = await sender.value.send({
    requestId: "orphan-success",
    recipients: [{ piSessionId: "orphan-recipient" }],
    summary: "success",
    body: { kind: "text", text: "second body" },
  });

  assert.equal(sent.ok, true);
  const reclaimed = await artifacts.get(storedIds[0]!);
  assert.equal(reclaimed.ok, false);
  if (!reclaimed.ok) assert.equal(reclaimed.error.code, "artifact_not_found");
  await lifecycle.shutdown("quit");
});

test("two Node processes durably send through one native SQLite mailbox", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "session-broker-processes-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "state.sqlite");
  const artifactRoot = join(directory, "artifacts");
  const opened = createSqliteStateStore({ path: databasePath });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: opened.value,
    artifacts: createFileSystemArtifactStore({ root: artifactRoot }),
    lifecycle,
  });
  const recipient = await module.attach(
    {
      piSessionId: "process-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("process-project"),
      cwd: "C:/process-project",
      exposure: { discoverableBy: "same-project", acceptsFrom: "same-project" },
    },
    delivery("Process recipient"),
  );
  assert.equal(recipient.ok, true);
  if (!recipient.ok) return;
  await recipient.value.close("quit");

  const fixture = fileURLToPath(
    new URL("./fixtures/session-broker-process.ts", import.meta.url),
  );
  const start = (senderId: string, requestId: string) => {
    const child = fork(
      fixture,
      [databasePath, artifactRoot, senderId, "process-recipient", requestId],
      {
        execArgv: ["--experimental-strip-types"],
        silent: true,
      },
    );
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    t.after(() => {
      if (!child.killed) child.kill();
    });
    return { child, stderr: () => stderr };
  };
  const nextMessage = <T>(child: ChildProcess) =>
    new Promise<T>((resolve, reject) => {
      child.once("error", reject);
      child.once("message", (message) => resolve(message as T));
    });
  const first = start("process-sender-a", "process-request-a");
  const second = start("process-sender-b", "process-request-b");
  const ready = await Promise.all([
    nextMessage<{ type: string }>(first.child),
    nextMessage<{ type: string }>(second.child),
  ]);
  assert.deepEqual(ready, [{ type: "ready" }, { type: "ready" }]);
  first.child.send({ type: "send" });
  second.child.send({ type: "send" });
  const results = await Promise.all([
    nextMessage<{ type: string; result: SessionBrokerResult<unknown> }>(
      first.child,
    ),
    nextMessage<{ type: string; result: SessionBrokerResult<unknown> }>(
      second.child,
    ),
  ]);

  assert.equal(results[0]?.result.ok, true, first.stderr());
  assert.equal(results[1]?.result.ok, true, second.stderr());
  const mailbox = await module.attach(
    {
      piSessionId: "process-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("process-project"),
      cwd: "C:/process-project",
      exposure: { discoverableBy: "same-project", acceptsFrom: "same-project" },
    },
    {
      ...delivery("Process replacement"),
      async deliverOnce() {
        return {
          ok: false as const,
          error: {
            code: "temporarily_unavailable" as const,
            message: "fixture hold",
            retryable: true,
          },
        };
      },
    },
  );
  assert.equal(mailbox.ok, true);
  if (mailbox.ok) {
    let messages = await mailbox.value.messages({ limit: 10 });
    const deadline = Date.now() + 1_000;
    while (messages.ok && messages.value.length < 2 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      messages = await mailbox.value.messages({ limit: 10 });
    }
    assert.equal(messages.ok, true);
    if (messages.ok) assert.equal(messages.value.length, 2);
  }
  await lifecycle.shutdown("quit");
});

test("inbound state filtering pages until it fills the requested limit", async () => {
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore(),
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
  });
  const attach = (piSessionId: string) =>
    module.attach(
      {
        piSessionId,
        proof: issueHostSessionProof(),
        executionRole: "parent",
        project: project("project-one"),
        cwd: "C:/project-one",
        exposure: {
          discoverableBy: "same-project",
          acceptsFrom: "same-project",
        },
      },
      delivery(piSessionId),
    );
  const sender = await attach("filter-sender");
  const recipient = await attach("filter-recipient");
  assert.equal(sender.ok, true);
  assert.equal(recipient.ok, true);
  if (!sender.ok || !recipient.ok) return;
  for (let index = 0; index < 5; index += 1) {
    assert.equal(
      (
        await sender.value.send({
          requestId: `delivered-${index}`,
          recipients: [{ piSessionId: "filter-recipient" }],
          summary: "delivered",
          body: { kind: "text", text: "body" },
        })
      ).ok,
      true,
    );
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  await recipient.value.close("quit");
  for (let index = 0; index < 3; index += 1) {
    assert.equal(
      (
        await sender.value.send({
          requestId: `queued-${index}`,
          recipients: [{ piSessionId: "filter-recipient" }],
          summary: `queued-${index}`,
          body: { kind: "text", text: "body" },
        })
      ).ok,
      true,
    );
  }

  const queued = await recipient.value.messages({ state: "queued", limit: 3 });
  assert.equal(queued.ok, false, "closed broker must stay fenced");
  const replacement = await module.attach(
    {
      piSessionId: "filter-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: { discoverableBy: "same-project", acceptsFrom: "same-project" },
    },
    {
      ...delivery("filter-recipient"),
      async deliverOnce() {
        return {
          ok: false as const,
          error: {
            code: "temporarily_unavailable" as const,
            message: "fixture offline",
            retryable: true,
          },
        };
      },
    },
  );
  assert.equal(replacement.ok, true);
  if (replacement.ok) {
    let matches = await replacement.value.messages({
      state: "queued",
      limit: 3,
    });
    const deadline = Date.now() + 1_000;
    while (matches.ok && matches.value.length < 3 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      matches = await replacement.value.messages({ state: "queued", limit: 3 });
    }
    assert.equal(matches.ok, true);
    if (matches.ok) assert.equal(matches.value.length, 3);
  }
  await lifecycle.shutdown("quit");
});

test("only Parent execution roles can attach a session broker", async () => {
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore(),
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
  });

  for (const executionRole of CHILD_EXECUTION_ROLES) {
    const attached = await module.attach(
      {
        piSessionId: `child-${executionRole}`,
        proof: issueHostSessionProof(),
        executionRole,
        project: project("project-one"),
        cwd: "C:/project-one",
        exposure: {
          discoverableBy: "same-project",
          acceptsFrom: "same-project",
        },
      },
      delivery(executionRole),
    );
    assert.equal(attached.ok, false, executionRole);
    if (!attached.ok) assert.equal(attached.error.code, "invalid_request");
  }

  await lifecycle.shutdown("quit");
});

test("queued mail is quarantined when its recipient reattaches in another project", async () => {
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore(),
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
    limits: { heartbeatMs: 10 },
  });
  const attach = (piSessionId: string, projectId: string) =>
    module.attach(
      {
        piSessionId,
        proof: issueHostSessionProof(),
        executionRole: "parent",
        project: project(projectId),
        cwd: `C:/${projectId}`,
        exposure: {
          discoverableBy: "local-user",
          acceptsFrom: "local-user",
        },
      },
      delivery(piSessionId),
    );
  const sender = await attach("project-bound-sender", "project-a");
  const originalRecipient = await attach(
    "project-bound-recipient",
    "project-a",
  );
  assert.equal(sender.ok, true);
  assert.equal(originalRecipient.ok, true);
  if (!sender.ok || !originalRecipient.ok) return;
  await originalRecipient.value.close("resume");

  const sent = await sender.value.send({
    requestId: "project-bound-mail",
    recipients: [{ piSessionId: "project-bound-recipient" }],
    summary: "Project A only",
    body: { kind: "text", text: "private to project A" },
  });
  assert.equal(sent.ok, true);
  if (!sent.ok) return;

  let deliveryCalls = 0;
  const replacement = await module.attach(
    {
      piSessionId: "project-bound-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-b"),
      cwd: "C:/project-b",
      exposure: {
        discoverableBy: "local-user",
        acceptsFrom: "local-user",
      },
    },
    {
      ...delivery("Replacement"),
      async deliverOnce() {
        deliveryCalls += 1;
        return {
          ok: true as const,
          value: { state: "accepted" as const, durableReceipt: "unexpected" },
        };
      },
    },
  );
  assert.equal(replacement.ok, true);
  if (!replacement.ok) return;

  let outbound = await sender.value.messages({ direction: "outbound" });
  const deadline = Date.now() + 2_000;
  while (
    outbound.ok &&
    outbound.value[0]?.state !== "failed" &&
    Date.now() < deadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    outbound = await sender.value.messages({ direction: "outbound" });
  }
  assert.equal(deliveryCalls, 0);
  assert.equal(outbound.ok, true);
  if (outbound.ok) {
    assert.equal(outbound.value[0]?.state, "failed");
    assert.equal(outbound.value[0]?.lastErrorCode, "recipient_project_changed");
  }

  await lifecycle.shutdown("quit");
});

test("oversized durable receipts fail within the hard delivery attempt ceiling", async () => {
  const lifecycle = createLifecycleSupervisor();
  const state = createMemoryStateStore();
  const module = createSessionBrokerModule({
    state,
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
    limits: {
      heartbeatMs: 5,
      deliveryClaimTtlMs: 5,
      maxDeliveryAttempts: 2,
    },
  });
  const sender = await module.attach(
    {
      piSessionId: "receipt-sender",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("Sender"),
  );
  let attempts = 0;
  const recipient = await module.attach(
    {
      piSessionId: "receipt-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    {
      ...delivery("Recipient"),
      async deliverOnce() {
        attempts += 1;
        return {
          ok: true as const,
          value: {
            state: "accepted" as const,
            durableReceipt: "r".repeat(128 * 1024),
          },
        };
      },
    },
  );
  assert.equal(sender.ok, true);
  assert.equal(recipient.ok, true);
  if (!sender.ok || !recipient.ok) return;

  const sent = await sender.value.send({
    requestId: "oversized-receipt",
    recipients: [{ piSessionId: "receipt-recipient" }],
    summary: "Receipt bound",
    body: { kind: "text", text: "body" },
  });
  assert.equal(sent.ok, true);
  if (!sent.ok) return;

  const snapshot = await state.export({ format: "snapshot" });
  assert.equal(snapshot.ok, true);
  if (snapshot.ok && snapshot.value.format === "snapshot") {
    const message = snapshot.value.snapshot.records.find(
      ({ collection }) => collection === "session-broker.messages",
    );
    assert.equal(message?.metadata.recipientProjectId, "project-one");
  }

  let mailbox = await sender.value.messages({ direction: "outbound" });
  const deadline = Date.now() + 2_000;
  while (
    mailbox.ok &&
    mailbox.value[0]?.state !== "failed" &&
    Date.now() < deadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    mailbox = await sender.value.messages({ direction: "outbound" });
  }
  assert.equal(mailbox.ok, true);
  if (mailbox.ok) {
    assert.equal(mailbox.value[0]?.state, "failed");
    assert.equal(mailbox.value[0]?.attempts, 2);
    assert.equal(mailbox.value[0]?.lastErrorCode, "invalid_delivery_receipt");
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(attempts, 2);

  await lifecycle.shutdown("quit");
});

test("concurrent identical request IDs deterministically replay on native SQLite", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "session-broker-request-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const opened = createSqliteStateStore({
    path: join(directory, "state.sqlite"),
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: opened.value,
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
  });
  const attach = (piSessionId: string) =>
    module.attach(
      {
        piSessionId,
        proof: issueHostSessionProof(),
        executionRole: "parent",
        project: project("project-one"),
        cwd: "C:/project-one",
        exposure: {
          discoverableBy: "same-project",
          acceptsFrom: "same-project",
        },
      },
      delivery(piSessionId),
    );
  const sender = await attach("concurrent-sender");
  const recipient = await attach("concurrent-recipient");
  assert.equal(sender.ok, true);
  assert.equal(recipient.ok, true);
  if (!sender.ok || !recipient.ok) return;
  await recipient.value.close("quit");

  const request = {
    requestId: "same-concurrent-request",
    recipients: [{ piSessionId: "concurrent-recipient" }],
    summary: "One intent",
    body: { kind: "text" as const, text: "one body" },
  };
  const [first, second] = await Promise.all([
    sender.value.send(request),
    sender.value.send(request),
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.deepEqual([first.value.replayed, second.value.replayed].sort(), [
      false,
      true,
    ]);
    assert.equal(first.value.body.id, second.value.body.id);
    assert.deepEqual(first.value.deliveries, second.value.deliveries);
  }
  const outbound = await sender.value.messages({ direction: "outbound" });
  assert.equal(outbound.ok, true);
  if (outbound.ok) assert.equal(outbound.value.length, 1);

  await lifecycle.shutdown("quit");
});

test("close is bounded and fences an abort-ignoring delivery completion", async () => {
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore(),
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
    limits: { heartbeatMs: 10, deliveryClaimTtlMs: 30 },
  });
  const sender = await module.attach(
    {
      piSessionId: "bounded-close-sender",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("Sender"),
  );
  const started = deferred<void>();
  const held = deferred<{
    ok: true;
    value: { state: "accepted"; durableReceipt: string };
  }>();
  const recipient = await module.attach(
    {
      piSessionId: "bounded-close-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    {
      ...delivery("Recipient"),
      deliverOnce() {
        started.resolve(undefined);
        return held.promise;
      },
    },
  );
  assert.equal(sender.ok, true);
  assert.equal(recipient.ok, true);
  if (!sender.ok || !recipient.ok) return;

  const sent = await sender.value.send({
    requestId: "bounded-close",
    recipients: [{ piSessionId: "bounded-close-recipient" }],
    summary: "Close safely",
    body: { kind: "text", text: "body" },
  });
  assert.equal(sent.ok, true);
  if (!sent.ok) return;
  await started.promise;

  const closePromise = recipient.value.close("quit");
  const closeRace = await Promise.race([
    closePromise.then(() => "closed" as const),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 750),
    ),
  ]);
  held.resolve({
    ok: true,
    value: { state: "accepted", durableReceipt: "late-receipt" },
  });
  await closePromise;
  assert.equal(closeRace, "closed");

  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  let replacementDeliveries = 0;
  const replacement = await module.attach(
    {
      piSessionId: "bounded-close-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    {
      ...delivery("Replacement"),
      async deliverOnce() {
        replacementDeliveries += 1;
        return {
          ok: true as const,
          value: {
            state: "accepted" as const,
            durableReceipt: "replacement-receipt",
          },
        };
      },
    },
  );
  assert.equal(replacement.ok, true);
  if (!replacement.ok) return;

  let outbound = await sender.value.messages({ direction: "outbound" });
  const deadline = Date.now() + 2_000;
  while (
    outbound.ok &&
    outbound.value[0]?.state !== "delivered" &&
    Date.now() < deadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    outbound = await sender.value.messages({ direction: "outbound" });
  }
  assert.equal(replacementDeliveries, 1);
  assert.equal(outbound.ok, true);
  if (outbound.ok) {
    assert.equal(outbound.value[0]?.state, "delivered");
    assert.equal(outbound.value[0]?.attempts, 2);
  }

  await lifecycle.shutdown("quit");
});

test("close hard deadline bounds refresh, final presence query, and lease release", async () => {
  for (const phase of ["refresh", "query", "release"] as const) {
    const base = createMemoryStateStore();
    let stall = false;
    let listener:
      | ((
          snapshot: ReturnType<ReturnType<typeof delivery>["snapshot"]>,
        ) => void)
      | undefined;
    const state = {
      ...base,
      query(input: Parameters<typeof base.query>[0]) {
        if (
          stall &&
          phase !== "release" &&
          input.type === "record" &&
          input.collection === "session-broker.presence"
        ) {
          return new Promise<never>(() => {});
        }
        return base.query(input);
      },
      transact(input: Parameters<typeof base.transact>[0]) {
        if (
          stall &&
          phase === "release" &&
          input.operations.some(
            (operation) => operation.type === "release-lease",
          )
        ) {
          return new Promise<never>(() => {});
        }
        return base.transact(input);
      },
    };
    const lifecycle = createLifecycleSupervisor();
    const module = createSessionBrokerModule({
      state,
      artifacts: createInMemoryArtifactStore(),
      lifecycle,
      limits: { heartbeatMs: 1_000_000 },
    });
    const attached = await module.attach(
      {
        piSessionId: `deadline-${phase}`,
        proof: issueHostSessionProof(),
        executionRole: "parent",
        project: project("project-one"),
        cwd: "C:/project-one",
        exposure: {
          discoverableBy: "same-project",
          acceptsFrom: "same-project",
        },
      },
      {
        ...delivery(`Deadline ${phase}`),
        subscribe(next) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
    );
    assert.equal(attached.ok, true, phase);
    if (!attached.ok) continue;
    stall = true;
    if (phase === "refresh") {
      listener?.(delivery("refresh").snapshot());
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const startedAt = Date.now();
    const result = await attached.value.close("quit");
    const elapsed = Date.now() - startedAt;

    assert.equal(result.ok, false, phase);
    if (!result.ok) assert.equal(result.error.code, "storage_failed", phase);
    assert.ok(elapsed < 750, `${phase} close took ${elapsed}ms`);
  }
});

test("close stays bounded under a native SQLite writer lock", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "session-broker-close-lock-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "state.sqlite");
  const opened = createSqliteStateStore({ path: databasePath });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: opened.value,
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
    limits: { heartbeatMs: 1_000_000 },
  });
  const attached = await module.attach(
    {
      piSessionId: "native-locked-close",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: { discoverableBy: "same-project", acceptsFrom: "same-project" },
    },
    delivery("Locked close"),
  );
  assert.equal(attached.ok, true);
  if (!attached.ok) return;
  const lock = new DatabaseSync(databasePath);
  lock.exec("PRAGMA busy_timeout = 0");
  lock.exec("BEGIN IMMEDIATE");

  const startedAt = Date.now();
  const closed = await attached.value.close("quit");
  const elapsed = Date.now() - startedAt;
  lock.exec("ROLLBACK");
  lock.close();

  assert.equal(closed.ok, false);
  assert.ok(elapsed < 750, `native locked close took ${elapsed}ms`);
});

test("outbound fanout pagination has a stable cursor beyond one thousand messages", async () => {
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore(),
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
  });
  const attach = (piSessionId: string) =>
    module.attach(
      {
        piSessionId,
        proof: issueHostSessionProof(),
        executionRole: "parent",
        project: project("project-one"),
        cwd: "C:/project-one",
        exposure: {
          discoverableBy: "same-project",
          acceptsFrom: "same-project",
        },
      },
      delivery(piSessionId),
    );
  const sender = await attach("pagination-sender");
  const firstRecipient = await attach("pagination-first");
  const secondRecipient = await attach("pagination-second");
  assert.equal(sender.ok, true);
  assert.equal(firstRecipient.ok, true);
  assert.equal(secondRecipient.ok, true);
  if (!sender.ok || !firstRecipient.ok || !secondRecipient.ok) return;
  await firstRecipient.value.close("quit");
  await secondRecipient.value.close("quit");

  for (let index = 0; index < 501; index += 1) {
    const sent = await sender.value.send({
      requestId: `pagination-${index}`,
      recipients: [
        { piSessionId: "pagination-first" },
        { piSessionId: "pagination-second" },
      ],
      summary: `Message ${index}`,
      body: { kind: "text", text: "body" },
    });
    assert.equal(sent.ok, true, `send ${index}`);
  }

  const found: string[] = [];
  let afterPosition = 0;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const page: SessionBrokerResult<readonly MessageSummary[]> =
      await sender.value.messages({
        direction: "outbound",
        afterPosition,
        limit: 100,
      });
    assert.equal(page.ok, true);
    if (!page.ok || page.value.length === 0) break;
    for (const message of page.value) {
      assert.ok(message.envelope.mailboxPosition > afterPosition);
      found.push(message.envelope.id);
      afterPosition = message.envelope.mailboxPosition;
    }
  }

  assert.equal(found.length, 1_002);
  assert.equal(new Set(found).size, 1_002);

  await lifecycle.shutdown("quit");
});

test("outbound query uses a sender index and bounds candidate work by limit", async () => {
  const base = createMemoryStateStore();
  let tracking = false;
  let messageCollectionScans = 0;
  let messageLookups = 0;
  const outboundQueryLimits: number[] = [];
  const state = {
    ...base,
    query(input: Parameters<typeof base.query>[0]) {
      if (tracking) {
        if (
          input.type === "records" &&
          input.collection === "session-broker.messages"
        ) {
          messageCollectionScans += 1;
        }
        if (
          input.type === "record" &&
          input.collection === "session-broker.messages"
        ) {
          messageLookups += 1;
        }
        if (
          input.type === "events" &&
          input.stream.startsWith("session-broker.outbound:")
        ) {
          outboundQueryLimits.push(input.limit ?? 100);
        }
      }
      return base.query(input);
    },
  };
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state,
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
  });
  const attach = (piSessionId: string) =>
    module.attach(
      {
        piSessionId,
        proof: issueHostSessionProof(),
        executionRole: "parent",
        project: project("project-one"),
        cwd: "C:/project-one",
        exposure: {
          discoverableBy: "same-project",
          acceptsFrom: "same-project",
        },
      },
      delivery(piSessionId),
    );
  const sender = await attach("indexed-sender");
  const recipient = await attach("indexed-recipient");
  assert.equal(sender.ok, true);
  assert.equal(recipient.ok, true);
  if (!sender.ok || !recipient.ok) return;
  await recipient.value.close("quit");
  for (let index = 0; index < 20; index += 1) {
    const sent = await sender.value.send({
      requestId: `indexed-${index}`,
      recipients: [{ piSessionId: "indexed-recipient" }],
      summary: `Message ${index}`,
      body: { kind: "text", text: "body" },
    });
    assert.equal(sent.ok, true);
  }

  tracking = true;
  const outbound = await sender.value.messages({
    direction: "outbound",
    limit: 2,
  });
  tracking = false;

  assert.equal(outbound.ok, true);
  if (outbound.ok) assert.equal(outbound.value.length, 2);
  assert.equal(messageCollectionScans, 0);
  assert.ok(messageLookups <= 2, `performed ${messageLookups} message lookups`);
  assert.deepEqual(outboundQueryLimits, [2]);
  await lifecycle.shutdown("quit");
});

test("rendered delivery enforces its final UTF-8 byte cap after JSON escaping", async () => {
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore(),
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
    limits: { maxInlineBodyBytes: 512 },
  });
  const sender = await module.attach(
    {
      piSessionId: "render-cap-sender",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("Sender"),
  );
  let renderedContent = "";
  const delivered = deferred<void>();
  const recipient = await module.attach(
    {
      piSessionId: "render-cap-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    {
      ...delivery("Recipient"),
      async deliverOnce(item) {
        renderedContent = item.renderedContent;
        delivered.resolve(undefined);
        return {
          ok: true as const,
          value: { state: "accepted" as const, durableReceipt: "bounded" },
        };
      },
    },
  );
  assert.equal(sender.ok, true);
  assert.equal(recipient.ok, true);
  if (!sender.ok || !recipient.ok) return;

  const sent = await sender.value.send({
    requestId: "render-cap",
    recipients: [{ piSessionId: "render-cap-recipient" }],
    summary: "Escaped body",
    body: { kind: "text", text: "\0".repeat(512) },
  });
  assert.equal(sent.ok, true);
  if (!sent.ok) return;
  await delivered.promise;

  assert.ok(Buffer.byteLength(renderedContent) <= 512);
  assert.match(renderedContent, /untrusted data/);
  assert.match(renderedContent, new RegExp(sent.value.body.id));

  await lifecycle.shutdown("quit");
});

test("attach snapshots caller-owned binding and runtime state before yielding", async () => {
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore(),
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
  });
  const runtime = {
    name: "Original",
    status: "idle" as const,
    capabilities: [{ id: "pi.delivery/inbox", version: 1 }],
  };
  const binding = {
    piSessionId: "snapshot-attach-original",
    proof: issueHostSessionProof(),
    executionRole: "parent" as const,
    project: project("project-a"),
    cwd: "C:/project-a",
    exposure: {
      discoverableBy: "same-project" as const,
      acceptsFrom: "same-project" as const,
    },
  };

  const attaching = module.attach(binding, {
    snapshot: () => runtime,
    subscribe: () => () => {},
    async deliverOnce() {
      return {
        ok: true as const,
        value: { state: "accepted" as const, durableReceipt: "fixture" },
      };
    },
  });
  binding.piSessionId = "snapshot-attach-mutated";
  binding.project = project("project-b");
  runtime.name = "Mutated";
  runtime.capabilities[0]!.id = "pi.delivery/steer";

  const attached = await attaching;
  assert.equal(attached.ok, true);
  if (!attached.ok) return;
  const discovered = await attached.value.discover();
  assert.equal(discovered.ok, true);
  if (discovered.ok) {
    assert.deepEqual(
      discovered.value.map(({ address, projectId, name, capabilities }) => ({
        piSessionId: address.piSessionId,
        projectId,
        name,
        capability: capabilities[0]?.id,
      })),
      [
        {
          piSessionId: "snapshot-attach-original",
          projectId: "project-a",
          name: "Original",
          capability: "pi.delivery/inbox",
        },
      ],
    );
  }

  await lifecycle.shutdown("quit");
});

test("an expired body Artifact is classified expired and does not block the mailbox", async () => {
  let now = 0;
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore({ now: () => now }),
    artifacts: createInMemoryArtifactStore({ clock: () => now }),
    lifecycle,
    clock: () => now,
    limits: {
      heartbeatMs: 1_000_000_000,
      sessionTtlMs: 90 * 24 * 60 * 60 * 1_000,
    },
  });
  const sender = await module.attach(
    {
      piSessionId: "expiry-sender",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("Sender"),
  );
  const originalRecipient = await module.attach(
    {
      piSessionId: "expiry-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("Recipient"),
  );
  assert.equal(sender.ok, true);
  assert.equal(originalRecipient.ok, true);
  if (!sender.ok || !originalRecipient.ok) return;
  await originalRecipient.value.close("resume");

  const expired = await sender.value.send({
    requestId: "expired-head",
    recipients: [{ piSessionId: "expiry-recipient" }],
    summary: "Expired",
    body: { kind: "text", text: "old body" },
  });
  now = 30 * 24 * 60 * 60 * 1_000 + 1;
  const live = await sender.value.send({
    requestId: "live-second",
    recipients: [{ piSessionId: "expiry-recipient" }],
    summary: "Live",
    body: { kind: "text", text: "new body" },
  });
  assert.equal(expired.ok, true);
  assert.equal(live.ok, true);
  if (!expired.ok || !live.ok) return;

  const delivered: string[] = [];
  const replacement = await module.attach(
    {
      piSessionId: "expiry-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    {
      ...delivery("Replacement"),
      async deliverOnce(item) {
        delivered.push(item.envelope.id);
        return {
          ok: true as const,
          value: { state: "accepted" as const, durableReceipt: "live" },
        };
      },
    },
  );
  assert.equal(replacement.ok, true);
  if (!replacement.ok) return;

  let outbound = await sender.value.messages({ direction: "outbound" });
  const deadline = Date.now() + 2_000;
  while (
    outbound.ok &&
    outbound.value.some(
      ({ state }) => state !== "expired" && state !== "delivered",
    ) &&
    Date.now() < deadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    outbound = await sender.value.messages({ direction: "outbound" });
  }
  assert.deepEqual(delivered, [live.value.deliveries[0]?.messageId]);
  assert.equal(outbound.ok, true);
  if (outbound.ok) {
    assert.deepEqual(
      outbound.value.map(({ state, lastErrorCode }) => ({
        state,
        lastErrorCode,
      })),
      [
        { state: "expired", lastErrorCode: "artifact_expired" },
        { state: "delivered", lastErrorCode: undefined },
      ],
    );
  }

  await lifecycle.shutdown("quit");
});

test("send rejects a recipient whose incarnation and acceptance change before commit", async () => {
  const base = createMemoryStateStore();
  let changed = false;
  const state = {
    ...base,
    async transact(input: Parameters<typeof base.transact>[0]) {
      if (!changed && input.transactionId.startsWith("session-broker.send:")) {
        changed = true;
        const current = await base.query({
          type: "record",
          collection: "session-broker.presence",
          key: "toctou-recipient",
        });
        assert.equal(current.ok, true);
        if (!current.ok || current.value.type !== "record") {
          throw new Error("recipient fixture presence query failed");
        }
        assert.ok(current.value.record);
        const replaced = await base.transact({
          transactionId: "replace-recipient-before-send-commit",
          operations: [
            {
              type: "put-record",
              collection: "session-broker.presence",
              key: "toctou-recipient",
              metadata: {
                ...current.value.record.metadata,
                incarnation: "replacement-incarnation",
                exposure: {
                  discoverableBy: "none",
                  acceptsFrom: "none",
                },
              },
              expectedVersion: current.value.record.version,
            },
          ],
        });
        assert.equal(replaced.ok, true);
      }
      return base.transact(input);
    },
  };
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state,
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
    limits: { heartbeatMs: 1_000_000 },
  });
  const sender = await module.attach(
    {
      piSessionId: "toctou-sender",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: { discoverableBy: "same-project", acceptsFrom: "same-project" },
    },
    delivery("Sender"),
  );
  let deliveryCalls = 0;
  const recipient = await module.attach(
    {
      piSessionId: "toctou-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: { discoverableBy: "same-project", acceptsFrom: "same-project" },
    },
    {
      ...delivery("Recipient"),
      async deliverOnce() {
        deliveryCalls += 1;
        return {
          ok: true as const,
          value: { state: "accepted" as const, durableReceipt: "unexpected" },
        };
      },
    },
  );
  assert.equal(sender.ok, true);
  assert.equal(recipient.ok, true);
  if (!sender.ok || !recipient.ok) return;

  const sent = await sender.value.send({
    requestId: "recipient-toctou",
    recipients: [{ piSessionId: "toctou-recipient" }],
    summary: "Must stay on one incarnation",
    body: { kind: "text", text: "body" },
  });

  assert.equal(sent.ok, false);
  if (!sent.ok) assert.equal(sent.error.code, "recipient_incarnation_changed");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(deliveryCalls, 0);
  await lifecycle.shutdown("quit");
});

test("outbound history is isolated by sender project and incarnation", async () => {
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore(),
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
  });
  const attach = (piSessionId: string, projectId: string) =>
    module.attach(
      {
        piSessionId,
        proof: issueHostSessionProof(),
        executionRole: "parent",
        project: project(projectId),
        cwd: `C:/${projectId}`,
        exposure: { discoverableBy: "local-user", acceptsFrom: "local-user" },
      },
      delivery(piSessionId),
    );
  const projectASender = await attach("reused-sender", "project-a");
  const recipient = await attach("history-recipient", "project-a");
  assert.equal(projectASender.ok, true);
  assert.equal(recipient.ok, true);
  if (!projectASender.ok || !recipient.ok) return;
  const sent = await projectASender.value.send({
    requestId: "project-a-history",
    recipients: [{ piSessionId: "history-recipient" }],
    summary: "Project A",
    body: { kind: "text", text: "private history" },
  });
  assert.equal(sent.ok, true);
  await projectASender.value.close("resume");

  const projectBSender = await attach("reused-sender", "project-b");
  assert.equal(projectBSender.ok, true);
  if (!projectBSender.ok) return;
  const outbound = await projectBSender.value.messages({
    direction: "outbound",
  });

  assert.equal(outbound.ok, true);
  if (outbound.ok) assert.deepEqual(outbound.value, []);
  await lifecycle.shutdown("quit");
});

test("when-idle mail consumes no delivery attempt while recipient is busy", async () => {
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: createMemoryStateStore(),
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
    limits: { heartbeatMs: 1_000_000 },
  });
  const sender = await module.attach(
    {
      piSessionId: "idle-sender",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: { discoverableBy: "same-project", acceptsFrom: "same-project" },
    },
    delivery("Sender"),
  );
  let idle = false;
  let deliveryCalls = 0;
  let listener:
    | ((snapshot: {
        readonly status: "idle" | "running";
        readonly capabilities: readonly {
          readonly id: string;
          readonly version: number;
        }[];
      }) => void)
    | undefined;
  const snapshot = () => ({
    status: idle ? ("idle" as const) : ("running" as const),
    capabilities: [{ id: "pi.delivery/when-idle", version: 1 }],
  });
  const recipient = await module.attach(
    {
      piSessionId: "idle-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: { discoverableBy: "same-project", acceptsFrom: "same-project" },
    },
    {
      snapshot,
      subscribe(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      async deliverOnce() {
        deliveryCalls += 1;
        if (!idle) {
          return {
            ok: false as const,
            error: {
              code: "temporarily_unavailable" as const,
              message: "busy",
              retryable: true,
            },
          };
        }
        return {
          ok: true as const,
          value: { state: "accepted" as const, durableReceipt: "idle-receipt" },
        };
      },
    },
  );
  assert.equal(sender.ok, true);
  assert.equal(recipient.ok, true);
  if (!sender.ok || !recipient.ok) return;
  const sent = await sender.value.send({
    requestId: "wait-until-idle",
    recipients: [{ piSessionId: "idle-recipient" }],
    summary: "Wait",
    body: { kind: "text", text: "body" },
    delivery: { mode: "pi/when-idle", version: 1 },
  });
  assert.equal(sent.ok, true);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const waiting = await recipient.value.messages();
  assert.equal(waiting.ok, true);
  if (waiting.ok) {
    assert.equal(waiting.value[0]?.state, "queued");
    assert.equal(waiting.value[0]?.attempts, 0);
  }
  assert.equal(deliveryCalls, 0);

  idle = true;
  listener?.(snapshot());
  let delivered = await recipient.value.messages();
  const deadline = Date.now() + 1_000;
  while (
    delivered.ok &&
    delivered.value[0]?.state !== "delivered" &&
    Date.now() < deadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    delivered = await recipient.value.messages();
  }
  assert.equal(delivered.ok, true);
  if (delivered.ok) assert.equal(delivered.value[0]?.attempts, 1);
  assert.equal(deliveryCalls, 1);
  await lifecycle.shutdown("quit");
});

test("delivery finish retries a concurrent enqueue and keeps the immediate pump wake", async () => {
  const base = createMemoryStateStore();
  const mailboxRead = deferred<void>();
  const releaseMailboxRead = deferred<void>();
  let interceptFinishMailboxRead = false;
  const state = {
    ...base,
    async query(input: Parameters<typeof base.query>[0]) {
      const result = await base.query(input);
      if (
        interceptFinishMailboxRead &&
        input.type === "record" &&
        input.collection === "session-broker.mailboxes" &&
        input.key === "finish-race-recipient"
      ) {
        interceptFinishMailboxRead = false;
        mailboxRead.resolve(undefined);
        await releaseMailboxRead.promise;
      }
      return result;
    },
  };
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state,
    artifacts: createInMemoryArtifactStore(),
    lifecycle,
    limits: { heartbeatMs: 1_000_000 },
  });
  const sender = await module.attach(
    {
      piSessionId: "finish-race-sender",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: { discoverableBy: "same-project", acceptsFrom: "same-project" },
    },
    delivery("Sender"),
  );
  const firstDeliveryStarted = deferred<void>();
  const releaseFirstDelivery = deferred<void>();
  const delivered: string[] = [];
  const recipient = await module.attach(
    {
      piSessionId: "finish-race-recipient",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: { discoverableBy: "same-project", acceptsFrom: "same-project" },
    },
    {
      ...delivery("Recipient"),
      async deliverOnce(item) {
        if (delivered.length === 0) {
          firstDeliveryStarted.resolve(undefined);
          await releaseFirstDelivery.promise;
        }
        delivered.push(item.envelope.id);
        return {
          ok: true as const,
          value: {
            state: "accepted" as const,
            durableReceipt: `receipt-${item.envelope.id}`,
          },
        };
      },
    },
  );
  assert.equal(sender.ok, true);
  assert.equal(recipient.ok, true);
  if (!sender.ok || !recipient.ok) return;
  const first = await sender.value.send({
    requestId: "finish-race-first",
    recipients: [{ piSessionId: "finish-race-recipient" }],
    summary: "First",
    body: { kind: "text", text: "first" },
  });
  assert.equal(first.ok, true);
  await firstDeliveryStarted.promise;
  interceptFinishMailboxRead = true;
  releaseFirstDelivery.resolve(undefined);
  await mailboxRead.promise;

  const second = await sender.value.send({
    requestId: "finish-race-second",
    recipients: [{ piSessionId: "finish-race-recipient" }],
    summary: "Second",
    body: { kind: "text", text: "second" },
  });
  assert.equal(second.ok, true);
  releaseMailboxRead.resolve(undefined);

  let mailbox = await recipient.value.messages({ limit: 2 });
  const deadline = Date.now() + 1_000;
  while (
    mailbox.ok &&
    mailbox.value.some(({ state }) => state !== "delivered") &&
    Date.now() < deadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    mailbox = await recipient.value.messages({ limit: 2 });
  }
  assert.equal(mailbox.ok, true);
  if (mailbox.ok) {
    assert.deepEqual(
      mailbox.value.map(({ state }) => state),
      ["delivered", "delivered"],
    );
  }
  assert.deepEqual(delivered, [
    first.ok ? first.value.deliveries[0]?.messageId : undefined,
    second.ok ? second.value.deliveries[0]?.messageId : undefined,
  ]);
  const snapshot = await base.export({ format: "snapshot" });
  assert.equal(snapshot.ok, true);
  if (snapshot.ok && snapshot.value.format === "snapshot") {
    const mailboxRecord = snapshot.value.snapshot.records.find(
      ({ collection, key }) =>
        collection === "session-broker.mailboxes" &&
        key === "finish-race-recipient",
    );
    assert.equal(mailboxRecord?.metadata.pending, 0);
  }
  await lifecycle.shutdown("quit");
});

test("bounded retention removes old terminal history without losing pending mail", async () => {
  let now = 0;
  const state = createMemoryStateStore({ now: () => now });
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state,
    artifacts: createInMemoryArtifactStore({ clock: () => now }),
    lifecycle,
    clock: () => now,
    limits: {
      heartbeatMs: 1_000_000_000,
      sessionTtlMs: 90 * 24 * 60 * 60 * 1_000,
    },
  });
  const attach = (piSessionId: string, deliver = delivery(piSessionId)) =>
    module.attach(
      {
        piSessionId,
        proof: issueHostSessionProof(),
        executionRole: "parent",
        project: project("project-one"),
        cwd: "C:/project-one",
        exposure: {
          discoverableBy: "same-project",
          acceptsFrom: "same-project",
        },
      },
      deliver,
    );
  const sender = await attach("retention-sender");
  const deliveredRecipient = await attach("retention-delivered");
  const pendingRecipient = await attach("retention-pending");
  const stalePresence = await attach("retention-stale-presence");
  assert.equal(sender.ok, true);
  assert.equal(deliveredRecipient.ok, true);
  assert.equal(pendingRecipient.ok, true);
  assert.equal(stalePresence.ok, true);
  if (
    !sender.ok ||
    !deliveredRecipient.ok ||
    !pendingRecipient.ok ||
    !stalePresence.ok
  ) {
    return;
  }
  await pendingRecipient.value.close("quit");
  await stalePresence.value.close("quit");
  const terminal = await sender.value.send({
    requestId: "retention-terminal-request",
    recipients: [{ piSessionId: "retention-delivered" }],
    summary: "terminal-retention-marker",
    body: { kind: "text", text: "terminal" },
  });
  const pending = await sender.value.send({
    requestId: "retention-pending-request",
    recipients: [{ piSessionId: "retention-pending" }],
    summary: "pending-retention-marker",
    body: { kind: "text", text: "pending" },
  });
  assert.equal(terminal.ok, true);
  assert.equal(pending.ok, true);
  if (!terminal.ok || !pending.ok) return;
  let terminalHistory = await sender.value.messages({ direction: "outbound" });
  while (
    terminalHistory.ok &&
    terminalHistory.value.find(
      ({ envelope }) => envelope.id === terminal.value.deliveries[0]?.messageId,
    )?.state !== "delivered"
  ) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminalHistory = await sender.value.messages({ direction: "outbound" });
  }
  await deliveredRecipient.value.close("quit");
  const beforeMaintenance = await state.diagnose();
  assert.equal(beforeMaintenance.ok, true);

  now = 30 * 24 * 60 * 60 * 1_000 + 1;
  const janitor = await attach("retention-janitor");
  assert.equal(janitor.ok, true);
  if (!janitor.ok) return;
  const retained = await state.export({ format: "snapshot" });
  assert.equal(retained.ok, true);
  if (!retained.ok || retained.value.format !== "snapshot") return;
  const records = retained.value.snapshot.records;
  const messages = records.filter(
    ({ collection }) => collection === "session-broker.messages",
  );
  assert.equal(
    messages.some(
      ({ metadata }) =>
        (metadata.envelope as { summary?: unknown }).summary ===
        "terminal-retention-marker",
    ),
    false,
  );
  assert.equal(
    messages.some(
      ({ metadata }) =>
        (metadata.envelope as { summary?: unknown }).summary ===
        "pending-retention-marker",
    ),
    true,
  );
  assert.equal(
    records.some(
      ({ collection, key }) =>
        collection === "session-broker.presence" &&
        key === "retention-stale-presence",
    ),
    false,
  );
  const requests = records.filter(
    ({ collection }) => collection === "session-broker.requests",
  );
  assert.equal(requests.length, 1);
  assert.equal(
    JSON.stringify(requests[0]?.metadata).includes(
      pending.value.deliveries[0]!.messageId,
    ),
    true,
  );
  const mailbox = records.find(
    ({ collection, key }) =>
      collection === "session-broker.mailboxes" && key === "retention-pending",
  );
  assert.equal(mailbox?.metadata.pending, 1);
  const afterMaintenance = await state.diagnose();
  assert.equal(afterMaintenance.ok, true);
  if (beforeMaintenance.ok && afterMaintenance.ok) {
    assert.equal(
      afterMaintenance.value.counts.transactions <
        beforeMaintenance.value.counts.transactions,
      true,
    );
  }

  const replacementDelivered = await attach("retention-delivered");
  assert.equal(replacementDelivered.ok, true);
  if (!replacementDelivered.ok) return;
  const reusedRequest = await sender.value.send({
    requestId: "retention-terminal-request",
    recipients: [{ piSessionId: "retention-delivered" }],
    summary: "terminal-retention-marker",
    body: { kind: "text", text: "terminal" },
  });
  assert.equal(reusedRequest.ok, true);
  if (reusedRequest.ok) assert.equal(reusedRequest.value.replayed, false);

  const deliveredAfterRetention: string[] = [];
  const resumed = await attach("retention-pending", {
    ...delivery("Resumed"),
    async deliverOnce() {
      deliveredAfterRetention.push("unexpected");
      return {
        ok: true as const,
        value: { state: "accepted" as const, durableReceipt: "retained" },
      };
    },
  });
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  const deadline = Date.now() + 1_000;
  let resumedMailbox = await resumed.value.messages();
  while (
    resumedMailbox.ok &&
    resumedMailbox.value[0]?.state !== "expired" &&
    Date.now() < deadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    resumedMailbox = await resumed.value.messages();
  }
  assert.deepEqual(deliveredAfterRetention, []);
  assert.equal(resumedMailbox.ok, true);
  if (resumedMailbox.ok) {
    assert.equal(
      resumedMailbox.value[0]?.envelope.id,
      pending.value.deliveries[0]?.messageId,
    );
    assert.equal(resumedMailbox.value[0]?.state, "expired");
    assert.equal(resumedMailbox.value[0]?.lastErrorCode, "artifact_expired");
  }
  await lifecycle.shutdown("quit");
});

test("native SQLite retention removes terminal records and outbound index events", async (t) => {
  let now = 0;
  const directory = mkdtempSync(join(tmpdir(), "session-broker-retention-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const opened = createSqliteStateStore({
    path: join(directory, "state.sqlite"),
    now: () => now,
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state: opened.value,
    artifacts: createInMemoryArtifactStore({ clock: () => now }),
    lifecycle,
    clock: () => now,
    limits: {
      heartbeatMs: 1_000_000_000,
      sessionTtlMs: 90 * 24 * 60 * 60 * 1_000,
    },
  });
  const attach = (piSessionId: string) =>
    module.attach(
      {
        piSessionId,
        proof: issueHostSessionProof(),
        executionRole: "parent",
        project: project("project-one"),
        cwd: "C:/project-one",
        exposure: {
          discoverableBy: "same-project",
          acceptsFrom: "same-project",
        },
      },
      delivery(piSessionId),
    );
  const sender = await attach("native-retention-sender");
  const recipient = await attach("native-retention-recipient");
  assert.equal(sender.ok, true);
  assert.equal(recipient.ok, true);
  if (!sender.ok || !recipient.ok) return;
  const sent = await sender.value.send({
    requestId: "native-retention-request",
    recipients: [{ piSessionId: "native-retention-recipient" }],
    summary: "Native retention",
    body: { kind: "text", text: "body" },
  });
  assert.equal(sent.ok, true);
  if (!sent.ok) return;
  let outbound = await sender.value.messages({ direction: "outbound" });
  while (outbound.ok && outbound.value[0]?.state !== "delivered") {
    await new Promise<void>((resolve) => setImmediate(resolve));
    outbound = await sender.value.messages({ direction: "outbound" });
  }
  await recipient.value.close("quit");

  now = 30 * 24 * 60 * 60 * 1_000 + 1;
  const janitor = await attach("native-retention-janitor");
  assert.equal(janitor.ok, true);
  const retained = await opened.value.export({ format: "snapshot" });
  assert.equal(retained.ok, true);
  if (retained.ok && retained.value.format === "snapshot") {
    assert.equal(
      retained.value.snapshot.records.some(({ collection }) =>
        ["session-broker.messages", "session-broker.requests"].includes(
          collection,
        ),
      ),
      false,
    );
  }
  const history = await sender.value.messages({ direction: "outbound" });
  assert.equal(history.ok, true);
  if (history.ok) assert.deepEqual(history.value, []);

  const database = new DatabaseSync(join(directory, "state.sqlite"));
  try {
    const count = (sql: string, ...parameters: string[]) =>
      Number(
        (database.prepare(sql).get(...parameters) as { count: number }).count,
      );
    assert.equal(
      count(
        `SELECT COUNT(*) AS count FROM transactions
         WHERE request_json LIKE ? OR result_json LIKE ?`,
        "%Native retention%",
        "%Native retention%",
      ),
      0,
    );
    assert.equal(
      count(
        `SELECT COUNT(*) AS count FROM event_ids ids
         WHERE NOT EXISTS (
           SELECT 1 FROM events WHERE events.event_id = ids.event_id
         )`,
      ),
      0,
    );
    assert.equal(
      count(
        `SELECT COUNT(*) AS count FROM record_heads heads
         WHERE heads.collection IN (
           'session-broker.messages',
           'session-broker.requests',
           'session-broker.presence',
           'session-broker.mailboxes'
         ) AND NOT EXISTS (
           SELECT 1 FROM records
           WHERE records.collection = heads.collection
             AND records.record_key = heads.record_key
         )`,
      ),
      0,
    );
  } finally {
    database.close();
  }
  await lifecycle.shutdown("quit");
});

test("hourly messaging maintenance bounds heartbeat transaction receipts", async () => {
  let now = 0;
  const state = createMemoryStateStore({ now: () => now });
  const lifecycle = createLifecycleSupervisor();
  const module = createSessionBrokerModule({
    state,
    artifacts: createInMemoryArtifactStore({ clock: () => now }),
    lifecycle,
    clock: () => now,
    limits: {
      heartbeatMs: 1,
      sessionTtlMs: 90 * 24 * 60 * 60 * 1_000,
    },
  });
  const attached = await module.attach(
    {
      piSessionId: "heartbeat-retention",
      proof: issueHostSessionProof(),
      executionRole: "parent",
      project: project("project-one"),
      cwd: "C:/project-one",
      exposure: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
    },
    delivery("heartbeat-retention"),
  );
  assert.equal(attached.ok, true);
  if (!attached.ok) return;

  const growthDeadline = Date.now() + 2_000;
  let before = await state.diagnose();
  while (
    before.ok &&
    before.value.counts.transactions < 25 &&
    Date.now() < growthDeadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    before = await state.diagnose();
  }
  assert.equal(before.ok, true);
  if (!before.ok) return;
  assert.equal(before.value.counts.transactions >= 25, true);

  now = 31 * 24 * 60 * 60 * 1_000;
  const cleanupDeadline = Date.now() + 2_000;
  let after = await state.diagnose();
  while (
    after.ok &&
    after.value.counts.transactions >= before.value.counts.transactions / 2 &&
    Date.now() < cleanupDeadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    after = await state.diagnose();
  }
  assert.equal(after.ok, true);
  if (after.ok) {
    assert.equal(
      after.value.counts.transactions < before.value.counts.transactions / 2,
      true,
    );
  }
  await lifecycle.shutdown("quit");
});
