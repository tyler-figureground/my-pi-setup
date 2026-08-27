import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
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
  const module = createSessionBrokerModule({ state, artifacts, lifecycle });
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
  const sender = await attach("sanitized-sender");
  const recipient = await attach("sanitized-recipient");
  assert.equal(sender.ok, true);
  assert.equal(recipient.ok, true);
  if (!sender.ok || !recipient.ok) return;

  const canary = "sk-abcdefghijklmnopqrstuvwxyz123456";
  const sent = await sender.value.send({
    requestId: "sanitized-send",
    recipients: [{ piSessionId: "sanitized-recipient" }],
    summary: `authorization: Bearer ${canary}`,
    body: { kind: "text", text: `api_key=${canary}` },
    delivery: {
      mode: "pi/inbox",
      version: 1,
      options: { nested: { password: canary } },
    },
  });
  assert.equal(sent.ok, true);
  if (!sent.ok) return;

  const stored = await artifacts.get(sent.value.body.id);
  assert.equal(stored.ok, true);
  if (stored.ok) {
    const body = Buffer.from(stored.value.body).toString("utf8");
    assert.equal(body.includes(canary), false);
    assert.equal(stored.value.metadata.metadata?.classification, "sanitized");
  }
  const exported = await state.export({ format: "snapshot" });
  assert.equal(exported.ok, true);
  if (exported.ok && exported.value.format === "snapshot") {
    assert.equal(
      JSON.stringify(exported.value.snapshot).includes(canary),
      false,
    );
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
