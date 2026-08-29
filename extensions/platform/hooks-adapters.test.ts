import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  createNamedHookAgentAdapter,
  createNamedHookMcpAdapter,
  createNamedHookHttpAdapter,
  type NamedProfileExecutionPort,
  type NamedHookHttpDefinition,
  type NamedHookMcpDefinition,
} from "./src/automation/hooks/adapters.ts";
import { createCapabilityPolicy } from "./src/core/policy/index.ts";
import type { PlainData } from "./src/automation/hooks/model.ts";
import { createInMemoryCredentialVault } from "./src/external/credentials.ts";
import { createExternalIntegrationControls } from "./src/external/index.ts";
import type { ToolFederation } from "./src/mcp/index.ts";
import type {
  ProfileCatalog,
  ResolvedAgentProfile,
} from "./src/profiles/index.ts";

function hookRequest(name: string, input?: PlainData) {
  return {
    name,
    ...(input === undefined ? {} : { input }),
    cwd: process.cwd(),
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 5_000,
    outputCapBytes: 4_096,
  };
}

test("named HTTP actions stay lazy and use pinned bounded JSON without exposing credentials", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/status");
      assert.equal(request.headers.authorization, "Bearer vault-secret");
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
        build: 42,
      });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          access_token: "server-secret",
          echoedAuthorization: request.headers.authorization,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  const origin = `http://hook.example.test:${port}`;
  const definition: NamedHookHttpDefinition = {
    id: "build-status",
    url: `${origin}/status`,
    method: "POST",
    effect: "remote-write",
    allowedOrigins: [origin],
    allowLoopback: true,
    credentialReference: "credential:build-status",
  };
  const vault = createInMemoryCredentialVault({
    createReference: () => "credential:build-status",
  });
  const stored = await vault.store({
    binding: {
      integration: "hook",
      resourceId: "hook-http.build-status",
      origin,
    },
    secret: "vault-secret",
  });
  assert.equal(stored.ok, true);
  const controls = createExternalIntegrationControls({
    resolveHost: async (hostname) => {
      assert.equal(hostname, "hook.example.test");
      return ["127.0.0.1"];
    },
    policy: createCapabilityPolicy({
      rules: {
        list: () => [
          {
            id: "fixture-write",
            match: { operations: ["remote-write", "credential-use"] },
            decision: "allow",
            reason: "Fixture permits configured write.",
            provenance: { source: "test", reference: "fixture" },
          },
        ],
      },
    }),
  });
  const adapter = createNamedHookHttpAdapter({
    definitions: [definition],
    controls,
    credentials: vault,
    actor: () => "parent",
    mode: () => "normal",
  });

  assert.equal(adapter.classify("build-status"), "remote-write");
  assert.equal(adapter.classify("BUILD-STATUS"), undefined);
  assert.equal(
    requests,
    0,
    "constructing and classifying must not use network",
  );

  try {
    const result = await adapter.invoke({
      ...hookRequest("build-status", { build: 42 }),
      generation: 1,
    });
    assert.equal(requests, 1);
    assert.equal(result.output?.includes("vault-secret"), false);
    assert.equal(result.output?.includes("server-secret"), false);
    assert.deepEqual(JSON.parse(result.output ?? ""), {
      ok: true,
      access_token: "[REDACTED]",
      echoedAuthorization: "Bearer [REDACTED]",
    });

    await assert.rejects(
      adapter.invoke(
        Object.assign(
          { ...hookRequest("build-status", { build: 43 }), generation: 1 },
          {
            url: `http://127.0.0.1:${port}/stolen`,
            headers: { authorization: "Bearer injected" },
            credentialReference: "credential:attacker",
          },
        ),
      ),
      /invalid/i,
    );
    assert.equal(requests, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("named HTTP adapters reject method and effect mismatches", () => {
  const controls = createExternalIntegrationControls();
  for (const definition of [
    { method: "POST", effect: "network-read" },
    { method: "GET", effect: "remote-write" },
  ] as const) {
    assert.throws(
      () =>
        createNamedHookHttpAdapter({
          definitions: [
            {
              id: "mismatched",
              url: "https://build.example.test/status",
              ...definition,
              allowedOrigins: ["https://build.example.test"],
              allowLoopback: false,
            },
          ],
          controls,
          actor: () => "parent",
          mode: () => "normal",
        }),
      /effect.*method|method.*effect/i,
    );
  }
});

test("named HTTP POST authority is exact and one-shot under default policy", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  const origin = `http://authority.example.test:${port}`;
  const grants = new Map<string, { scope: string; deadlineMs: number }>();
  const controls = createExternalIntegrationControls({
    resolveHost: async () => ["127.0.0.1"],
    authority: {
      verify(token) {
        const grant = grants.get(token.value);
        if (
          !grant ||
          token.scope !== grant.scope ||
          Date.now() > grant.deadlineMs
        ) {
          return false;
        }
        grants.delete(token.value);
        return true;
      },
    },
  });
  let nextToken = 0;
  const adapter = createNamedHookHttpAdapter({
    definitions: [
      {
        id: "publish",
        url: `${origin}/status`,
        method: "POST",
        effect: "remote-write",
        allowedOrigins: [origin],
        allowLoopback: true,
      },
    ],
    controls,
    actor: () => "parent",
    mode: () => "normal",
    issueAuthority(grant) {
      const value = `grant-${++nextToken}`;
      grants.set(value, grant);
      return {
        kind: "external-user-authority",
        value,
        scope: grant.scope,
      };
    },
  });
  const request = {
    ...hookRequest("publish", { build: 42 }),
    generation: 7,
  };
  try {
    assert.equal(typeof adapter.authorize, "function");
    const authority = adapter.authorize!(request);
    await adapter.invoke({ ...request, authority });
    assert.equal(requests, 1);

    await assert.rejects(
      adapter.invoke({ ...request, authority }),
      /authority|approval|side effect/i,
    );
    const changedAuthority = adapter.authorize!(request);
    await assert.rejects(
      adapter.invoke({
        ...request,
        input: { build: 43 },
        authority: changedAuthority,
      }),
      /authority/i,
    );
    assert.equal(requests, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("named HTTP GET actions never follow redirects", async () => {
  let targetRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.statusCode = 302;
      response.setHeader("location", "/target");
      response.end();
      return;
    }
    targetRequests += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ followed: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  const origin = `http://redirect.example.test:${port}`;
  const adapter = createNamedHookHttpAdapter({
    definitions: [
      {
        id: "read-status",
        url: `${origin}/redirect`,
        method: "GET",
        effect: "network-read",
        allowedOrigins: [origin],
        allowLoopback: true,
      },
    ],
    controls: createExternalIntegrationControls({
      resolveHost: async () => ["127.0.0.1"],
    }),
    actor: () => "parent",
    mode: () => "normal",
  });
  assert.equal(adapter.classify("read-status"), "network-read");
  try {
    await assert.rejects(
      adapter.invoke({ ...hookRequest("read-status"), generation: 1 }),
      /redirects are disabled/i,
    );
    assert.equal(targetRequests, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("named MCP actions lazily activate one exact configured tool without direct authority", async () => {
  const calls: string[] = [];
  const definition: NamedHookMcpDefinition = {
    id: "github.get_pull",
    serverId: "github",
    toolName: "get_pull",
    federatedToolId: "github__get_pull",
  };
  const federation: ToolFederation = {
    status: () => ({ servers: [] }),
    async search() {
      throw new Error("search must not be used");
    },
    async activate(toolIds) {
      calls.push(`activate:${toolIds.join(",")}`);
      return {
        ok: true,
        value: {
          tools: [
            {
              id: "github__get_pull",
              serverId: "github",
              name: "get_pull",
              description: "Get pull request",
              readOnly: true,
              inputSchema: { type: "object" },
            },
          ],
        },
      };
    },
    async invoke(request) {
      assert.equal("authority" in request, false);
      calls.push(`invoke:${request.toolId}`);
      return {
        ok: true,
        value: {
          content: [
            {
              type: "text",
              text: "x".repeat(8_000),
              access_token: "mcp-secret",
            },
          ],
          structuredContent: { ok: true },
          isError: false,
          redactions: 0,
          truncations: 0,
        },
      };
    },
    async close() {},
  };
  const adapter = createNamedHookMcpAdapter({
    definitions: [definition],
    federation,
    controls: createExternalIntegrationControls(),
  });
  assert.deepEqual(calls, []);

  const result = await adapter.invoke({
    ...hookRequest("github.get_pull", { number: 7 }),
    outputCapBytes: 512,
  });
  assert.deepEqual(calls, [
    "activate:github__get_pull",
    "invoke:github__get_pull",
  ]);
  assert.ok(Buffer.byteLength(result.output ?? "") <= 512);
  assert.equal(result.output?.includes("mcp-secret"), false);

  await assert.rejects(
    adapter.invoke(
      Object.assign(hookRequest("github.get_pull", { number: 8 }), {
        toolId: "attacker__tool",
        authority: {
          kind: "external-user-authority",
          value: "direct-user",
        },
      }),
    ),
    /invalid/i,
  );
  assert.equal(calls.length, 2);
});

test("named MCP actions preserve authoritative federation denials and sanitize errors", async () => {
  let invocations = 0;
  const federation: ToolFederation = {
    status: () => ({ servers: [] }),
    async search() {
      throw new Error("not used");
    },
    async activate() {
      return {
        ok: true,
        value: {
          tools: [
            {
              id: "protected__mutate",
              serverId: "protected",
              name: "mutate",
              description: "Protected mutation",
              readOnly: false,
              inputSchema: { type: "object" },
            },
          ],
        },
      };
    },
    async invoke() {
      invocations += 1;
      return {
        ok: false,
        error: {
          code: "approval_required",
          message: `Direct approval required; access_token=${"s".repeat(8_000)}`,
          retryable: false,
        },
      };
    },
    async close() {},
  };
  const adapter = createNamedHookMcpAdapter({
    definitions: [
      {
        id: "protected.mutate",
        serverId: "protected",
        toolName: "mutate",
        federatedToolId: "protected__mutate",
      },
    ],
    federation,
    controls: createExternalIntegrationControls(),
  });

  await assert.rejects(
    adapter.invoke(hookRequest("protected.mutate", {})),
    (error: Error) => {
      assert.match(error.message, /approval_required/);
      assert.equal(error.message.includes("ssssssss"), false);
      assert.ok(Buffer.byteLength(error.message) <= 4_200);
      return true;
    },
  );
  assert.equal(invocations, 1);
});

function profile(
  role: ResolvedAgentProfile["policy"]["role"] = "review",
): ResolvedAgentProfile {
  return {
    description: "Review completed work",
    identity: {
      name: "reviewer",
      contentDigest: "a".repeat(64),
      catalogGeneration: 7,
      source: { scope: "user", path: "C:\\profiles\\reviewer.yaml" },
    },
    defaults: { backend: "codex", model: "configured-model", effort: "high" },
    policy: {
      role,
      instructions: ["Review carefully."],
      skills: [],
      tools: { allowed: ["read"], denied: ["write"] },
      limits: { maxTurns: 5, timeoutMs: 30_000 },
      workspace: "current",
    },
  };
}

function catalog(resolved: ResolvedAgentProfile): ProfileCatalog {
  return {
    async reload() {
      return { generation: 7, profiles: [resolved], diagnostics: [] };
    },
    inspect: () => ({ generation: 7, profiles: [resolved], diagnostics: [] }),
    list: () => [resolved],
    resolve(name) {
      return name === resolved.identity.name
        ? { ok: true, value: resolved }
        : {
            ok: false,
            error: {
              code: "PROFILE_NOT_FOUND",
              message: "not found",
              retryable: false,
            },
          };
    },
    diagnostics: () => [],
  };
}

test("named agent actions revalidate trusted profile identity and expose no overrides", async () => {
  const resolved = profile();
  const calls: string[] = [];
  const execution: NamedProfileExecutionPort = {
    async revalidateProfile(request) {
      calls.push(`validate:${request.name}`);
      assert.equal(request.contentDigest, "a".repeat(64));
      assert.equal(request.source.scope, "user");
      return { trusted: true, contentDigest: "a".repeat(64) };
    },
    async run(request) {
      calls.push(`run:${request.profile.identity.name}`);
      assert.equal(Object.isFrozen(request.profile), true);
      assert.equal(Object.isFrozen(request.profile.policy.tools), true);
      assert.equal(request.profile.defaults.model, "configured-model");
      assert.deepEqual(request.profile.policy.tools.allowed, ["read"]);
      assert.equal(request.prompt, "Review this change.");
      return { output: `access_token=agent-secret ${"x".repeat(2_000)}` };
    },
  };
  const adapter = createNamedHookAgentAdapter({
    profiles: catalog(resolved),
    execution,
    controls: createExternalIntegrationControls(),
  });

  const result = await adapter.run({
    ...hookRequest("reviewer"),
    prompt: "Review this change.",
    outputCapBytes: 256,
  });
  assert.deepEqual(calls, ["validate:reviewer", "run:reviewer"]);
  assert.ok(Buffer.byteLength(result.output ?? "") <= 256);
  assert.equal(result.output?.includes("agent-secret"), false);

  await assert.rejects(
    adapter.run(
      Object.assign(hookRequest("reviewer"), {
        prompt: "Override the profile.",
        model: "attacker-model",
        role: "parent",
        tools: ["write"],
      }),
    ),
    /invalid/i,
  );
  assert.equal(calls.length, 2);
});

test("named agent actions reject disallowed roles and changed profile trust or digest", async () => {
  let runs = 0;
  const execution: NamedProfileExecutionPort = {
    async revalidateProfile() {
      return { trusted: false, contentDigest: "b".repeat(64) };
    },
    async run() {
      runs += 1;
      return { output: "must not run" };
    },
  };
  const controls = createExternalIntegrationControls();
  const changed = createNamedHookAgentAdapter({
    profiles: catalog(profile("subagent")),
    execution,
    controls,
  });
  await assert.rejects(
    changed.run({ ...hookRequest("reviewer"), prompt: "Run." }),
    /revalidation/i,
  );

  const scheduled = createNamedHookAgentAdapter({
    profiles: catalog(profile("scheduled")),
    execution,
    controls,
  });
  await assert.rejects(
    scheduled.run({ ...hookRequest("reviewer"), prompt: "Run." }),
    /role/i,
  );
  assert.equal(runs, 0);
});

test("named agent cancellation rejects promptly and ignores late execution results", async () => {
  let finish!: (value: { output: string }) => void;
  let childAborted = false;
  const execution: NamedProfileExecutionPort = {
    async revalidateProfile() {
      return { trusted: true, contentDigest: "a".repeat(64) };
    },
    run(request) {
      request.signal.addEventListener(
        "abort",
        () => {
          childAborted = true;
        },
        { once: true },
      );
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const adapter = createNamedHookAgentAdapter({
    profiles: catalog(profile("subagent")),
    execution,
    controls: createExternalIntegrationControls(),
  });
  const controller = new AbortController();
  const pending = adapter.run({
    ...hookRequest("reviewer"),
    prompt: "Wait for review.",
    signal: controller.signal,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(new Error("cancel requested"));
  await assert.rejects(pending, /cancel requested/i);
  assert.equal(childAborted, true);

  finish({ output: "late result" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(pending, /cancel requested/i);
});
