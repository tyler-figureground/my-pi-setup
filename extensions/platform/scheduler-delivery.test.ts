import assert from "node:assert/strict";
import test from "node:test";
import { createSessionBrokerScheduleDelivery } from "./src/automation/scheduler/delivery.ts";

test("Schedule delivery uses one stable mailbox receipt without prompt or authority", async () => {
  const requests: unknown[] = [];
  const hostIdentities: unknown[] = [];
  const delivery = createSessionBrokerScheduleDelivery({
    async send(request, _signal, hostAutomation) {
      requests.push(request);
      hostIdentities.push(hostAutomation);
      return {
        ok: true,
        value: {
          requestId: request.requestId,
          body: {
            id: "artifact-body",
            sha256: "b".repeat(64),
            size: 10,
            mediaType: "text/plain",
            createdAt: 1,
          },
          deliveries: [
            {
              recipient: request.recipients[0]!,
              messageId: "message-1",
              mailboxPosition: 1,
              state: "queued",
            },
          ],
          replayed: false,
        },
      };
    },
  });

  const result = await delivery.deliver(
    {
      deliveryId: "a".repeat(64),
      generation: "3".repeat(64),
      route: { kind: "session", sessionId: "parent-session" },
      scheduleId: "daily-check",
      occurrenceId: "a".repeat(64),
      artifact: {
        id: "result-artifact",
        sha256: "c".repeat(64),
        size: 42,
        mediaType: "text/plain",
      },
    },
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: { state: "offline" },
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(hostIdentities, [
    { producerId: "scheduler", idempotencyKey: "a".repeat(64) },
  ]);
  const encoded = JSON.stringify(requests[0]);
  assert.match(encoded, /schedule-delivery:/);
  assert.match(encoded, /result-artifact/);
  assert.match(encoded, /Trust: untrusted/);
  assert.match(encoded, /Authority: none/);
  assert.doesNotMatch(encoded, /prompt/i);
  assert.doesNotMatch(encoded, /approval/i);
  assert.doesNotMatch(encoded, /hostAutomation/i);
});

test("Schedule delivery returns bounded generic broker failure", async () => {
  const delivery = createSessionBrokerScheduleDelivery({
    async send() {
      return {
        ok: false,
        error: {
          code: "delivery_failed" as const,
          message: "token=DO_NOT_ECHO",
          retryable: true,
        },
      };
    },
  });
  const result = await delivery.deliver(
    {
      deliveryId: "d".repeat(64),
      generation: "8".repeat(64),
      route: { kind: "session", sessionId: "parent-session" },
      scheduleId: "daily-check",
      occurrenceId: "d".repeat(64),
      artifact: {
        id: "result-artifact",
        sha256: "e".repeat(64),
        size: 42,
      },
    },
    new AbortController().signal,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.retryable, true);
    assert.equal(result.error.message.includes("DO_NOT_ECHO"), false);
  }
});
