import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import type { NamedProfileExecutionPort } from "./src/automation/hooks/adapters.ts";
import {
  bindNamedProfileExecutionPort,
  namedProfileExecutionPortFor,
} from "./src/agents/named-profile-execution-service.ts";
import {
  bindPlatformAgentServices,
  platformAgentServices,
} from "./src/agents/services.ts";

function eventBusWrapper(shared: EventBus): EventBus {
  return {
    emit: (channel, data) => shared.emit(channel, data),
    on: (channel, handler) => shared.on(channel, handler),
  };
}

test("platform agent services cross distinct wrappers and honor provider lifecycle", () => {
  const shared = createEventBus();
  const providerEvents = eventBusWrapper(shared);
  const consumerEvents = eventBusWrapper(shared);
  const services = {};

  assert.equal(platformAgentServices(consumerEvents), undefined);
  const unbind = bindPlatformAgentServices(providerEvents, services);
  assert.equal(platformAgentServices(consumerEvents), services);
  assert.throws(
    () => bindPlatformAgentServices(consumerEvents, {}),
    /already bound/i,
  );

  unbind();
  assert.equal(platformAgentServices(consumerEvents), undefined);
  unbind();
});

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

test("named profile execution crosses distinct event wrappers and stops after unbind", async () => {
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
  const calls: string[] = [];
  const execution: NamedProfileExecutionPort = {
    async revalidateProfile(request) {
      assert.ok(Object.isFrozen(request));
      calls.push(`validate:${request.name}`);
      return { trusted: true, contentDigest: request.contentDigest };
    },
    async run(request) {
      assert.ok(Object.isFrozen(request));
      calls.push(`run:${request.profile.identity.name}`);
      return { output: "done" };
    },
  };
  const unbind = bindNamedProfileExecutionPort(providerEvents, execution);
  const client = namedProfileExecutionPortFor(consumerEvents);
  assert.ok(client);
  assert.notEqual(client, execution);
  const signal = new AbortController().signal;
  const validated = await client.revalidateProfile({
    name: "reviewer",
    contentDigest: "a".repeat(64),
    catalogGeneration: 1,
    source: { scope: "user", path: "C:/profiles/reviewer.yaml" },
    cwd: "C:/fixture",
    signal,
  });
  assert.equal(validated.trusted, true);
  const result = await client.run({
    profile: {
      description: "Reviewer",
      identity: {
        name: "reviewer",
        contentDigest: "a".repeat(64),
        catalogGeneration: 1,
        source: { scope: "user", path: "C:/profiles/reviewer.yaml" },
      },
      defaults: { backend: "pi" },
      policy: {
        role: "review",
        instructions: [],
        skills: [],
        tools: { denied: [] },
        limits: {},
        workspace: "current",
      },
    },
    prompt: "Review.",
    cwd: "C:/fixture",
    signal,
    deadlineMs: Date.now() + 1_000,
    outputCapBytes: 1_024,
  });
  assert.equal(result.output, "done");
  assert.deepEqual(calls, ["validate:reviewer", "run:reviewer"]);
  assert.deepEqual(
    emitted.map((value) => (value as { kind: string }).kind),
    ["query", "revalidate", "run"],
  );
  assert.ok(
    emitted.every(
      (value) =>
        (value as { version: number }).version === 1 &&
        (value as { claimed: boolean }).claimed,
    ),
  );
  assert.ok(
    emitted
      .filter(
        (value) =>
          (value as { kind: string }).kind === "revalidate" ||
          (value as { kind: string }).kind === "run",
      )
      .every((value) => {
        const request = (value as { request: object }).request;
        return (
          !Object.hasOwn(request, "model") &&
          !Object.hasOwn(request, "authority")
        );
      }),
  );
  assert.throws(
    () => bindNamedProfileExecutionPort(consumerEvents, port()),
    /already bound/i,
  );

  unbind();
  assert.equal(namedProfileExecutionPortFor(consumerEvents), undefined);
  await assert.rejects(
    () =>
      client.revalidateProfile({
        name: "reviewer",
        contentDigest: "a".repeat(64),
        catalogGeneration: 1,
        source: { scope: "user", path: "C:/profiles/reviewer.yaml" },
        cwd: "C:/fixture",
        signal,
      }),
    /unavailable/i,
  );
});

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
