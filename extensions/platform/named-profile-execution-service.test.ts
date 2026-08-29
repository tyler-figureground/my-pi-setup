import assert from "node:assert/strict";
import test from "node:test";
import type { NamedProfileExecutionPort } from "./src/automation/hooks/adapters.ts";
import {
  bindNamedProfileExecutionPort,
  namedProfileExecutionPortFor,
} from "./src/agents/named-profile-execution-service.ts";

function port(): NamedProfileExecutionPort {
  return {
    async revalidateProfile(request) {
      return { trusted: true, contentDigest: request.contentDigest };
    },
    async run() {
      return { output: "done" };
    },
  };
}

test("named profile execution binding is loader-local and identity-safe", () => {
  const firstLoader = {};
  const secondLoader = {};
  const first = port();
  const second = port();

  const unbindFirst = bindNamedProfileExecutionPort(firstLoader, first);
  const unbindSecond = bindNamedProfileExecutionPort(secondLoader, second);

  assert.equal(namedProfileExecutionPortFor(firstLoader), first);
  assert.equal(namedProfileExecutionPortFor(secondLoader), second);
  assert.throws(
    () => bindNamedProfileExecutionPort(firstLoader, second),
    /already bound/i,
  );

  unbindFirst();
  assert.equal(namedProfileExecutionPortFor(firstLoader), undefined);
  assert.equal(namedProfileExecutionPortFor(secondLoader), second);

  unbindFirst();
  unbindSecond();
  assert.equal(namedProfileExecutionPortFor(secondLoader), undefined);
});
