import assert from "node:assert/strict";
import test from "node:test";
import {
  bindTerminalObservationSource,
  terminalObservationSourceFor,
  type TerminalObservationSource,
} from "./src/observation-service.ts";

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
