import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import {
  bindTerminalObservationSource,
  terminalObservationSourceFor,
  type TerminalObservationSource,
} from "./src/observation-service.ts";

function eventBusWrapper(shared: EventBus): EventBus {
  return {
    emit: (channel, data) => shared.emit(channel, data),
    on: (channel, handler) => shared.on(channel, handler),
  };
}

test("terminal observation crosses distinct event wrappers and honors source lifecycle", async () => {
  const shared = createEventBus();
  const providerEvents = eventBusWrapper(shared);
  const emitted: unknown[] = [];
  const consumerEvents: EventBus = {
    emit(channel, data) {
      emitted.push(data);
      shared.emit(channel, data);
    },
    on: (channel, handler) => shared.on(channel, handler),
  };
  const source: TerminalObservationSource = {
    async observe(request, listener) {
      assert.ok(Object.isFrozen(request));
      listener({
        kind: "gap",
        terminalId: request.terminalId,
        sequence: 4,
        fromSequence: 1,
        toSequence: 4,
      });
      return { ok: true, value: { close() {} } };
    },
  };

  assert.equal(terminalObservationSourceFor(consumerEvents), undefined);
  const unbind = bindTerminalObservationSource(providerEvents, source);
  const client = terminalObservationSourceFor(consumerEvents);
  assert.ok(client);
  assert.notEqual(client, source);
  const kinds: string[] = [];
  const result = await client.observe({ terminalId: "bt-1" }, (event) =>
    kinds.push(event.kind),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(kinds, ["gap"]);
  assert.deepEqual(
    emitted.map((value) => (value as { kind: string }).kind),
    ["query", "query", "observe"],
  );
  assert.ok(
    emitted.every((value) => (value as { version: number }).version === 1),
  );
  assert.deepEqual(
    emitted.map((value) => (value as { claimed: boolean }).claimed),
    [false, true, true],
  );
  assert.throws(
    () => bindTerminalObservationSource(consumerEvents, source),
    /already bound/i,
  );

  unbind();
  assert.equal(terminalObservationSourceFor(consumerEvents), undefined);
  await assert.rejects(
    () => client.observe({ terminalId: "bt-1" }, () => {}),
    /unavailable/i,
  );
});

test("terminal observation source binding is loader-local and releasable", async () => {
  const eventBus = {};
  let unsubscribed = 0;
  const source: TerminalObservationSource = {
    async observe(request, listener) {
      listener({
        kind: "output",
        terminalId: request.terminalId,
        sequence: 1,
        stream: "stdout",
        text: "ready\n",
        byteLength: 6,
        startByte: 0,
        endByte: 6,
      });
      return {
        ok: true,
        value: { close: () => void unsubscribed++ },
      };
    },
  };

  const release = bindTerminalObservationSource(eventBus, source);
  assert.equal(terminalObservationSourceFor(eventBus), source);
  assert.throws(
    () => bindTerminalObservationSource(eventBus, source),
    /already bound/i,
  );

  const observations: string[] = [];
  const observed = await terminalObservationSourceFor(eventBus)!.observe(
    { terminalId: "bt-1", afterSequence: 0 },
    (event) => observations.push(event.kind),
  );
  assert.equal(observed.ok, true);
  if (observed.ok) observed.value.close();
  assert.deepEqual(observations, ["output"]);
  assert.equal(unsubscribed, 1);

  release();
  assert.equal(terminalObservationSourceFor(eventBus), undefined);
});
