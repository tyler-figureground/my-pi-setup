import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createPiSessionDeliveryAdapter } from "./src/messaging/pi-delivery.ts";

function delivery(id = "mail-1", renderedContent = "Delivered body") {
  return {
    envelope: {
      id,
      mailboxPosition: 7,
      sender: {
        piSessionId: "sender-session",
        incarnation: "sender-incarnation",
        executionRole: "review" as const,
        projectId: "project-one",
        name: "Reviewer",
      },
      recipient: { piSessionId: "recipient-session" },
      sentAt: 1_700_000_000_000,
      summary: "Review finished",
      body: {
        id: "artifact-1",
        sha256: "a".repeat(64),
        size: 14,
        createdAt: 1_700_000_000_000,
        mediaType: "text/plain",
      },
      delivery: { mode: "pi/inbox", version: 1 },
      trust: "untrusted" as const,
      authority: "none" as const,
    },
    renderedContent,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function materializedSession(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "pi-delivery-"));
  const sessionFile = join(directory, "session.jsonl");
  writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "recipient-session",
      timestamp: "2026-08-27T00:00:00.000Z",
      cwd: "C:/project-one",
    })}\n`,
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return sessionFile;
}

test("accepts only after Pi records one visible custom message in session JSONL", async (t) => {
  const sessionFile = materializedSession(t);
  const entries: SessionEntry[] = [];
  const calls: Array<{ message: unknown; options: unknown }> = [];
  const adapter = createPiSessionDeliveryAdapter(
    {
      sendMessage(message, options) {
        calls.push({ message, options });
        const entry: SessionEntry = {
          type: "custom_message",
          id: "entry-1",
          parentId: null,
          timestamp: "2026-08-27T00:00:01.000Z",
          ...message,
        };
        entries.push(entry);
        appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
      },
    },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [...entries],
      },
      isIdle: () => false,
    },
  );

  const result = await adapter.deliverOnce(delivery());

  assert.deepEqual(result, {
    ok: true,
    value: {
      state: "accepted",
      durableReceipt: "pi:recipient-session:entry:entry-1:mail:mail-1",
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.options, { triggerTurn: false });
  const sentMessage = calls[0]?.message;
  assert.ok(isRecord(sentMessage));
  assert.ok(isRecord(sentMessage.details));
  assert.match(String(sentMessage.details.payloadSha256), /^[a-f0-9]{64}$/);
  assert.equal(
    sentMessage.details.payloadSha256,
    "1166e203a57c00fbe3b28a11d10cbb59a09c4e6b6408f407611ce29870de1cfa",
  );
  assert.deepEqual(sentMessage, {
    customType: "platform-session-inbox",
    content: "Delivered body",
    display: true,
    details: {
      version: 1,
      mailboxMessageId: "mail-1",
      mailboxPosition: 7,
      payloadSha256: sentMessage.details.payloadSha256,
    },
  });
  const lines = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 2);
});

test("same mailbox message retry returns one stable already-present receipt", async (t) => {
  const sessionFile = materializedSession(t);
  const entries: SessionEntry[] = [];
  let sendCount = 0;
  const adapter = createPiSessionDeliveryAdapter(
    {
      sendMessage(message) {
        sendCount += 1;
        const entry: SessionEntry = {
          type: "custom_message",
          id: "stable-entry",
          parentId: null,
          timestamp: "2026-08-27T00:00:01.000Z",
          ...message,
        };
        entries.push(entry);
        appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
      },
    },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [...entries],
      },
      isIdle: () => true,
    },
  );

  const first = await adapter.deliverOnce(delivery());
  const retry = await adapter.deliverOnce(delivery());

  assert.equal(first.ok, true);
  assert.deepEqual(retry, {
    ok: true,
    value: {
      state: "already-present",
      durableReceipt: "pi:recipient-session:entry:stable-entry:mail:mail-1",
    },
  });
  assert.equal(sendCount, 1);
  assert.equal(entries.length, 1);
  assert.equal(
    readFileSync(sessionFile, "utf8").trimEnd().split("\n").length,
    2,
  );
});

test("rejects mailbox message ID reuse with changed delivery content", async (t) => {
  const sessionFile = materializedSession(t);
  const entries: SessionEntry[] = [];
  let sendCount = 0;
  const adapter = createPiSessionDeliveryAdapter(
    {
      sendMessage(message) {
        sendCount += 1;
        const entry: SessionEntry = {
          type: "custom_message",
          id: `entry-${sendCount}`,
          parentId: null,
          timestamp: "2026-08-27T00:00:01.000Z",
          ...message,
        };
        entries.push(entry);
        appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
      },
    },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [...entries],
      },
      isIdle: () => true,
    },
  );

  assert.equal((await adapter.deliverOnce(delivery())).ok, true);
  const changed = await adapter.deliverOnce(
    delivery("mail-1", "Changed delivered body"),
  );

  assert.equal(changed.ok, false);
  if (!changed.ok) {
    assert.deepEqual(changed.error, {
      code: "permanently_unavailable",
      message: "Mailbox message ID was already used for different content.",
      retryable: false,
    });
  }
  assert.equal(sendCount, 1);
  assert.equal(entries.length, 1);
});

test("rejects duplicate Pi entries created for one mailbox message", async (t) => {
  const sessionFile = materializedSession(t);
  const entries: SessionEntry[] = [];
  const adapter = createPiSessionDeliveryAdapter(
    {
      sendMessage(message) {
        for (const id of ["duplicate-1", "duplicate-2"]) {
          const entry: SessionEntry = {
            type: "custom_message",
            id,
            parentId: null,
            timestamp: "2026-08-27T00:00:01.000Z",
            ...message,
          };
          entries.push(entry);
          appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
        }
      },
    },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [...entries],
      },
      isIdle: () => true,
    },
  );

  const result = await adapter.deliverOnce(delivery());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.error, {
      code: "permanently_unavailable",
      message: "Mailbox message ID has duplicate Pi delivery entries.",
      retryable: false,
    });
  }
});

test("fails closed on a torn session JSONL tail without injecting", async (t) => {
  const sessionFile = materializedSession(t);
  appendFileSync(sessionFile, '{"type":"custom_message"');
  let sendCount = 0;
  const adapter = createPiSessionDeliveryAdapter(
    { sendMessage: () => void (sendCount += 1) },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [],
      },
      isIdle: () => true,
    },
  );

  const result = await adapter.deliverOnce(delivery());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "permanently_unavailable");
    assert.equal(result.error.retryable, false);
    assert.match(result.error.message, /manual recovery/i);
  }
  assert.equal(sendCount, 0);
  assert.deepEqual(adapter.snapshot().capabilities, []);
});

test("compaction suspends delivery until a documented terminal event", async (t) => {
  const sessionFile = materializedSession(t);
  let sendCount = 0;
  const adapter = createPiSessionDeliveryAdapter(
    { sendMessage: () => void (sendCount += 1) },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [],
      },
      isIdle: () => true,
    },
  );

  adapter.handleEvent({ type: "session_before_compact" });
  const suspended = await adapter.deliverOnce(delivery());

  assert.deepEqual(adapter.snapshot().capabilities, []);
  assert.equal(suspended.ok, false);
  if (!suspended.ok) {
    assert.equal(suspended.error.code, "temporarily_unavailable");
  }
  assert.equal(sendCount, 0);

  adapter.handleEvent({ type: "session_compact_failed" });
  assert.deepEqual(adapter.snapshot().capabilities, [
    { id: "pi.delivery/inbox", version: 1 },
    { id: "pi.delivery/when-idle", version: 1 },
    { id: "pi.delivery/follow-up", version: 1 },
    { id: "pi.delivery/steer", version: 1 },
  ]);
});

test("tree suspension and generation shutdown fail closed", async (t) => {
  const sessionFile = materializedSession(t);
  let sendCount = 0;
  const adapter = createPiSessionDeliveryAdapter(
    { sendMessage: () => void (sendCount += 1) },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [],
      },
      isIdle: () => true,
    },
  );

  adapter.handleEvent({ type: "session_before_tree" });
  adapter.handleEvent({ type: "session_compact_failed" });
  assert.deepEqual(adapter.snapshot().capabilities, []);

  adapter.handleEvent({ type: "session_tree" });
  assert.equal(adapter.snapshot().capabilities.length, 4);

  adapter.handleEvent({ type: "session_shutdown" });
  adapter.handleEvent({ type: "session_tree" });
  const stopped = await adapter.deliverOnce(delivery());

  assert.equal(adapter.snapshot().status, "stopping");
  assert.deepEqual(adapter.snapshot().capabilities, []);
  assert.equal(stopped.ok, false);
  assert.equal(sendCount, 0);
});

test("overlapping structural signals cannot reopen an unmatched tree gate", (t) => {
  const sessionFile = materializedSession(t);
  const adapter = createPiSessionDeliveryAdapter(
    { sendMessage: () => {} },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [],
      },
      isIdle: () => true,
    },
  );

  adapter.handleEvent({ type: "session_before_tree" });
  adapter.handleEvent({ type: "session_before_compact" });
  adapter.handleEvent({ type: "session_compact_failed" });

  assert.deepEqual(adapter.snapshot().capabilities, []);
  adapter.handleEvent({ type: "session_tree" });
  assert.equal(adapter.snapshot().capabilities.length, 4);
});

test("an already-aborted delivery creates no transcript effect", async (t) => {
  const sessionFile = materializedSession(t);
  let sendCount = 0;
  const controller = new AbortController();
  controller.abort(new Error("Broker stopped."));
  const adapter = createPiSessionDeliveryAdapter(
    { sendMessage: () => void (sendCount += 1) },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [],
      },
      isIdle: () => true,
    },
  );

  const result = await adapter.deliverOnce(delivery(), controller.signal);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.error, {
      code: "cancelled",
      message: "Pi delivery was cancelled.",
      retryable: false,
    });
  }
  assert.equal(sendCount, 0);
});

test("stale Pi generation errors fail closed without calling old API", async () => {
  let sendCount = 0;
  const adapter = createPiSessionDeliveryAdapter(
    { sendMessage: () => void (sendCount += 1) },
    {
      sessionManager: {
        getSessionFile() {
          throw new Error("Extension API is no longer valid after reload.");
        },
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [],
      },
      isIdle: () => true,
    },
  );

  const result = await adapter.deliverOnce(delivery());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "temporarily_unavailable");
    assert.equal(result.error.retryable, true);
  }
  assert.equal(sendCount, 0);
  assert.deepEqual(adapter.snapshot(), {
    status: "stopping",
    capabilities: [],
  });
});

test("publishes capability changes across structural lifecycle events", (t) => {
  const sessionFile = materializedSession(t);
  const adapter = createPiSessionDeliveryAdapter(
    { sendMessage: () => {} },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [],
      },
      isIdle: () => true,
    },
  );
  const capabilities: number[] = [];
  const unsubscribe = adapter.subscribe((snapshot) => {
    capabilities.push(snapshot.capabilities.length);
  });

  adapter.handleEvent({ type: "session_before_compact" });
  adapter.handleEvent({ type: "session_compact" });
  unsubscribe();
  adapter.handleEvent({ type: "session_before_tree" });

  assert.deepEqual(capabilities, [0, 4]);
});

test("serializes reentrant deliveries before creating transcript effects", async (t) => {
  const sessionFile = materializedSession(t);
  const entries: SessionEntry[] = [];
  const recordedIds: string[] = [];
  let sendCount = 0;
  let nestedDelivery: Promise<unknown> | undefined;
  let adapter: ReturnType<typeof createPiSessionDeliveryAdapter>;
  adapter = createPiSessionDeliveryAdapter(
    {
      sendMessage(message) {
        sendCount += 1;
        if (sendCount === 1) {
          nestedDelivery = adapter.deliverOnce(delivery("mail-2", "Second"));
        }
        assert.ok(isRecord(message.details));
        recordedIds.push(String(message.details.mailboxMessageId));
        const entry: SessionEntry = {
          type: "custom_message",
          id: `serialized-${sendCount}`,
          parentId: null,
          timestamp: "2026-08-27T00:00:01.000Z",
          ...message,
        };
        entries.push(entry);
        appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
      },
    },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [...entries],
      },
      isIdle: () => true,
    },
  );

  const first = await adapter.deliverOnce(delivery());
  await nestedDelivery;

  assert.equal(first.ok, true);
  assert.deepEqual(recordedIds, ["mail-1", "mail-2"]);
});

test("rejects a live entry whose visible payload differs from durable JSONL", async (t) => {
  const sessionFile = materializedSession(t);
  const entries: SessionEntry[] = [];
  const adapter = createPiSessionDeliveryAdapter(
    {
      sendMessage(message) {
        const diskEntry: SessionEntry = {
          type: "custom_message",
          id: "entry-mismatch",
          parentId: null,
          timestamp: "2026-08-27T00:00:01.000Z",
          ...message,
        };
        entries.push({ ...diskEntry, display: false });
        appendFileSync(sessionFile, `${JSON.stringify(diskEntry)}\n`);
      },
    },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [...entries],
      },
      isIdle: () => true,
    },
  );

  const result = await adapter.deliverOnce(delivery());

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "temporarily_unavailable");
});

test("session replacement during delivery cannot acknowledge old generation JSONL", async (t) => {
  const sessionFile = materializedSession(t);
  const replacementFile = join(sessionFile, "..", "replacement.jsonl");
  writeFileSync(
    replacementFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "replacement-session",
      timestamp: "2026-08-27T00:00:00.000Z",
      cwd: "C:/project-one",
    })}\n`,
  );
  const entries: SessionEntry[] = [];
  let replaced = false;
  const adapter = createPiSessionDeliveryAdapter(
    {
      sendMessage(message) {
        const entry: SessionEntry = {
          type: "custom_message",
          id: "old-generation-entry",
          parentId: null,
          timestamp: "2026-08-27T00:00:01.000Z",
          ...message,
        };
        entries.push(entry);
        appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
        replaced = true;
      },
    },
    {
      sessionManager: {
        getSessionFile: () => (replaced ? replacementFile : sessionFile),
        getSessionId: () =>
          replaced ? "replacement-session" : "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [...entries],
      },
      isIdle: () => true,
    },
  );

  const result = await adapter.deliverOnce(delivery());

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "temporarily_unavailable");
});

test("rejects a live-only mailbox marker with a changed payload hash", async (t) => {
  const sessionFile = materializedSession(t);
  const entries: SessionEntry[] = [
    {
      type: "custom_message",
      id: "memory-only-entry",
      parentId: null,
      timestamp: "2026-08-27T00:00:01.000Z",
      customType: "platform-session-inbox",
      content: "Different body",
      display: true,
      details: {
        version: 1,
        mailboxMessageId: "mail-1",
        mailboxPosition: 7,
        payloadSha256: "f".repeat(64),
      },
    },
  ];
  let sendCount = 0;
  const adapter = createPiSessionDeliveryAdapter(
    { sendMessage: () => void (sendCount += 1) },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [...entries],
      },
      isIdle: () => true,
    },
  );

  const result = await adapter.deliverOnce(delivery());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "permanently_unavailable");
    assert.equal(result.error.retryable, false);
  }
  assert.equal(sendCount, 0);
});

test("recreated adapter reconciles a durable crash-gap entry without resending", async (t) => {
  const sessionFile = materializedSession(t);
  const entries: SessionEntry[] = [];
  let sendCount = 0;
  const context = {
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "recipient-session",
      getSessionName: () => "Recipient",
      getEntries: () => [...entries],
    },
    isIdle: () => true,
  };
  const firstGeneration = createPiSessionDeliveryAdapter(
    {
      sendMessage(message) {
        sendCount += 1;
        const entry: SessionEntry = {
          type: "custom_message",
          id: "crash-gap-entry",
          parentId: null,
          timestamp: "2026-08-27T00:00:01.000Z",
          ...message,
        };
        entries.push(entry);
        appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
      },
    },
    context,
  );
  assert.equal((await firstGeneration.deliverOnce(delivery())).ok, true);

  const resumedGeneration = createPiSessionDeliveryAdapter(
    { sendMessage: () => void (sendCount += 1) },
    context,
  );
  const reconciled = await resumedGeneration.deliverOnce(delivery());

  assert.deepEqual(reconciled, {
    ok: true,
    value: {
      state: "already-present",
      durableReceipt: "pi:recipient-session:entry:crash-gap-entry:mail:mail-1",
    },
  });
  assert.equal(sendCount, 1);
});

test("in-memory and unmaterialized sessions never inject delivery", async (t) => {
  const sessionFile = materializedSession(t);
  rmSync(sessionFile);
  let sendCount = 0;
  const sessionManager = {
    getSessionId: () => "recipient-session",
    getSessionName: () => "Recipient",
    getEntries: () => [],
  };
  const inMemory = createPiSessionDeliveryAdapter(
    { sendMessage: () => void (sendCount += 1) },
    {
      sessionManager: { ...sessionManager, getSessionFile: () => undefined },
      isIdle: () => true,
    },
  );
  const unmaterialized = createPiSessionDeliveryAdapter(
    { sendMessage: () => void (sendCount += 1) },
    {
      sessionManager: { ...sessionManager, getSessionFile: () => sessionFile },
      isIdle: () => true,
    },
  );

  const unsupported = await inMemory.deliverOnce(delivery());
  const unavailable = await unmaterialized.deliverOnce(delivery());

  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.equal(unsupported.error.code, "unsupported_mode");
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) {
    assert.equal(unavailable.error.code, "temporarily_unavailable");
  }
  assert.deepEqual(inMemory.snapshot().capabilities, []);
  assert.deepEqual(unmaterialized.snapshot().capabilities, []);
  assert.equal(sendCount, 0);
});

test("follow-up and steer notify only after durable inbox readback", async (t) => {
  const sessionFile = materializedSession(t);
  const entries: SessionEntry[] = [];
  const calls: Array<{ message: unknown; options: unknown }> = [];
  const adapter = createPiSessionDeliveryAdapter(
    {
      sendMessage(message, options) {
        calls.push({ message, options });
        if (isRecord(message) && message.display === true) {
          const entry: SessionEntry = {
            type: "custom_message",
            id: `entry-${calls.length}`,
            parentId: null,
            timestamp: "2026-08-27T00:00:01.000Z",
            ...message,
          };
          entries.push(entry);
          appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
        }
      },
    },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [...entries],
      },
      isIdle: () => false,
    },
  );

  for (const mode of ["pi/steer", "pi/follow-up"] as const) {
    const result = await adapter.deliverOnce({
      ...delivery(`mail-${mode}`),
      envelope: {
        ...delivery(`mail-${mode}`).envelope,
        delivery: { mode, version: 1 },
      },
    });
    assert.equal(result.ok, true);
  }
  assert.equal(calls.length, 4);
  assert.deepEqual(
    calls.map(({ message }) =>
      isRecord(message) ? message.display : undefined,
    ),
    [true, false, true, false],
  );
  assert.deepEqual(calls[1]?.options, {
    deliverAs: "steer",
    triggerTurn: true,
  });
  assert.deepEqual(calls[3]?.options, {
    deliverAs: "followUp",
    triggerTurn: true,
  });
});

test("when-idle records durably only after session becomes idle", async (t) => {
  const sessionFile = materializedSession(t);
  const entries: SessionEntry[] = [];
  let idle = false;
  let sendCount = 0;
  const adapter = createPiSessionDeliveryAdapter(
    {
      sendMessage(message) {
        sendCount += 1;
        const entry: SessionEntry = {
          type: "custom_message",
          id: "idle-entry",
          parentId: null,
          timestamp: "2026-08-27T00:00:01.000Z",
          ...message,
        };
        entries.push(entry);
        appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
      },
    },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [...entries],
      },
      isIdle: () => idle,
    },
  );
  const idleDelivery = {
    ...delivery("mail-idle"),
    envelope: {
      ...delivery("mail-idle").envelope,
      delivery: { mode: "pi/when-idle", version: 1 },
    },
  };

  const waiting = await adapter.deliverOnce(idleDelivery);
  assert.equal(waiting.ok, false);
  assert.equal(sendCount, 0);
  idle = true;
  adapter.handleEvent({ type: "agent_settled" });
  const accepted = await adapter.deliverOnce(idleDelivery);
  assert.equal(accepted.ok, true);
  assert.equal(sendCount, 1);
});

test("queued notification can never substitute for durable receipt", async (t) => {
  const sessionFile = materializedSession(t);
  const entries: SessionEntry[] = [];
  const calls: Array<{ message: unknown; options: unknown }> = [];
  const adapter = createPiSessionDeliveryAdapter(
    {
      sendMessage(message, options) {
        calls.push({ message, options });
        if (isRecord(message)) {
          entries.push({
            type: "custom_message",
            id: "memory-only",
            parentId: null,
            timestamp: "2026-08-27T00:00:01.000Z",
            ...message,
          });
        }
      },
    },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [...entries],
      },
      isIdle: () => false,
    },
  );
  const followUp = {
    ...delivery("mail-no-receipt"),
    envelope: {
      ...delivery("mail-no-receipt").envelope,
      delivery: { mode: "pi/follow-up", version: 1 },
    },
  };

  const result = await adapter.deliverOnce(followUp);

  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.options, { triggerTurn: false });
});

test("live-only append/readback failure never returns success or duplicates", async (t) => {
  const sessionFile = materializedSession(t);
  const entries: SessionEntry[] = [];
  let sendCount = 0;
  const adapter = createPiSessionDeliveryAdapter(
    {
      sendMessage(message) {
        sendCount += 1;
        entries.push({
          type: "custom_message",
          id: "memory-only-entry",
          parentId: null,
          timestamp: "2026-08-27T00:00:01.000Z",
          ...message,
        });
      },
    },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [...entries],
      },
      isIdle: () => true,
    },
  );

  const first = await adapter.deliverOnce(delivery());
  const retry = await adapter.deliverOnce(delivery());

  assert.equal(first.ok, false);
  assert.equal(retry.ok, false);
  if (!retry.ok) assert.equal(retry.error.code, "temporarily_unavailable");
  assert.equal(sendCount, 1);
  assert.equal(entries.length, 1);
});

test("bounded scanner rejects an oversized JSONL line", async (t) => {
  const sessionFile = materializedSession(t);
  appendFileSync(
    sessionFile,
    `${JSON.stringify({ type: "custom", id: "large", data: "x".repeat(1024 * 1024) })}\n`,
  );
  let sendCount = 0;
  const adapter = createPiSessionDeliveryAdapter(
    { sendMessage: () => void (sendCount += 1) },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [],
      },
      isIdle: () => true,
    },
  );

  const result = await adapter.deliverOnce(delivery());

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "permanently_unavailable");
  assert.equal(sendCount, 0);
});

test("fatal UTF-8 validation rejects malformed complete JSONL before append", async (t) => {
  const sessionFile = materializedSession(t);
  appendFileSync(
    sessionFile,
    Buffer.from([
      ...Buffer.from('{"type":"custom","id":"bad","data":"'),
      0xc3,
      0x28,
      ...Buffer.from('"}\n'),
    ]),
  );
  let sendCount = 0;
  const adapter = createPiSessionDeliveryAdapter(
    { sendMessage: () => void (sendCount += 1) },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [],
      },
      isIdle: () => true,
    },
  );

  const result = await adapter.deliverOnce(delivery());

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "permanently_unavailable");
  assert.equal(sendCount, 0);
});

test("does not await Pi sendMessage return value", async (t) => {
  const sessionFile = materializedSession(t);
  const entries: SessionEntry[] = [];
  const adapter = createPiSessionDeliveryAdapter(
    {
      sendMessage(message) {
        const entry: SessionEntry = {
          type: "custom_message",
          id: "fire-and-readback-entry",
          parentId: null,
          timestamp: "2026-08-27T00:00:01.000Z",
          ...message,
        };
        entries.push(entry);
        appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
        return new Promise<void>(() => {});
      },
    },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [...entries],
      },
      isIdle: () => true,
    },
  );

  const result = await Promise.race([
    adapter.deliverOnce(delivery()),
    new Promise<"timed-out">((resolve) =>
      setTimeout(() => resolve("timed-out"), 100),
    ),
  ]);

  assert.notEqual(result, "timed-out");
  if (result !== "timed-out") assert.equal(result.ok, true);
});

test("flush failure never returns a delivery receipt", async (t) => {
  const sessionFile = materializedSession(t);
  const entries: SessionEntry[] = [];
  const adapter = createPiSessionDeliveryAdapter(
    {
      sendMessage(message) {
        entries.push({
          type: "custom_message",
          id: "unflushed-entry",
          parentId: null,
          timestamp: "2026-08-27T00:00:01.000Z",
          ...message,
        });
        rmSync(sessionFile);
        mkdirSync(sessionFile);
      },
    },
    {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "recipient-session",
        getSessionName: () => "Recipient",
        getEntries: () => [...entries],
      },
      isIdle: () => true,
    },
  );

  const result = await adapter.deliverOnce(delivery());

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "temporarily_unavailable");
});
