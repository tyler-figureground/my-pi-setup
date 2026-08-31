import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
import { createArtifactCapability } from "./src/wiring/artifacts.ts";
import { parseArtifactArguments } from "./src/wiring/artifacts-command.ts";
import type {
  ArtifactPublisher,
  ArtifactUserAuthorityToken,
  PublicationApproval,
} from "./src/artifacts/index.ts";

function fixture() {
  const commands = new Map<
    string,
    (args: string, ctx: never) => Promise<void>
  >();
  const entries: Array<{ type: string; data: unknown }> = [];
  const tools: Array<{
    name: string;
    execute: (
      id: string,
      input: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<unknown>;
  }> = [];
  const api = {
    registerCommand(
      name: string,
      definition: { handler: (args: string, ctx: never) => Promise<void> },
    ) {
      commands.set(name, definition.handler);
    },
    registerEntryRenderer() {},
    registerTool(tool: {
      name: string;
      execute: (
        id: string,
        input: unknown,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: unknown,
      ) => Promise<unknown>;
    }) {
      tools.push(tool);
    },
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
  } as unknown as ExtensionAPI;
  return { api, commands, entries, tools };
}

test("Artifact command parser preserves quoted Windows paths with spaces", () => {
  assert.deepEqual(
    parseArtifactArguments(
      'create "C:/Users/Tyler/My Artifacts/report.md" text/markdown',
    ),
    ["create", "C:/Users/Tyler/My Artifacts/report.md", "text/markdown"],
  );
});

const sensitivity = {
  verdict: "clear" as const,
  scannerVersion: "phase-9-v1",
  digest: "a".repeat(64),
  findings: [],
};

test("/artifacts opens only after exact confirmation and keeps share URL out of session entries", async () => {
  const { api, commands, entries } = fixture();
  const store = createInMemoryArtifactStore({ clock: () => 1 });
  const artifact = await store.put({
    body: "# report",
    filename: "report.md",
    mediaType: "text/markdown",
  });
  assert.equal(artifact.ok, true);
  if (!artifact.ok) return;
  const approvals: ArtifactUserAuthorityToken[] = [];
  const approval: PublicationApproval = {
    operation: "publish",
    scope: "scope-1",
    artifactId: artifact.value.id,
    outboundArtifactId: artifact.value.id,
    target: "local",
    providerId: "local-loopback",
    interactive: false,
    live: false,
    access: "private",
    expiresAt: 61_000,
    sensitivity,
  };
  const publisher: ArtifactPublisher = {
    async close() {},
    async publish(input) {
      if (!input.authority)
        return {
          ok: false,
          error: {
            code: "approval_required",
            message: "confirmation required",
            retryable: false,
            approval,
          },
        };
      approvals.push(input.authority);
      return {
        ok: true,
        value: {
          publication: {
            handle: "publication-1",
            sourceArtifactId: artifact.value.id,
            outboundArtifactId: artifact.value.id,
            target: "local",
            access: "private",
            interactive: false,
            live: false,
            state: "active",
            createdAt: 1,
            expiresAt: input.expiresAt,
            observedAt: 1,
            sensitivity,
          },
          shareUrl: "http://127.0.0.1:1234/open#capability-canary",
          revocationHandle: "publication-1",
        },
      };
    },
    async refresh() {
      throw new Error("unused");
    },
    async status() {
      throw new Error("unused");
    },
    async revoke() {
      throw new Error("unused");
    },
  };
  const capability = createArtifactCapability(api, {
    defaultExpiryMs: 60_000,
    maxExpiryMs: 600_000,
    clock: () => 1_000,
  });
  capability.start({ artifacts: store, publisher });
  const notifications: string[] = [];
  const handler = commands.get("artifacts")!;
  await handler(`open ${artifact.value.id}`, {
    mode: "rpc",
    hasUI: true,
    ui: {
      confirm: async () => true,
      notify: (message: string) => notifications.push(message),
    },
  } as never);

  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.scope, approval.scope);
  assert.equal(
    notifications.some((message) => message.includes("capability-canary")),
    true,
  );
  assert.equal(JSON.stringify(entries).includes("capability-canary"), false);
  assert.equal(entries[0]?.type, "artifact-reference");
});

test("/artifacts rejects print/JSON clearly and points to metadata tool", async () => {
  const { api, commands } = fixture();
  const store = createInMemoryArtifactStore();
  const capability = createArtifactCapability(api, {
    defaultExpiryMs: 60_000,
    maxExpiryMs: 600_000,
  });
  capability.start({
    artifacts: store,
    publisher: {
      close: async () => {},
      publish: async () => {
        throw new Error("unused");
      },
      refresh: async () => {
        throw new Error("unused");
      },
      status: async () => {
        throw new Error("unused");
      },
      revoke: async () => {
        throw new Error("unused");
      },
    },
  });
  await assert.rejects(
    commands.get("artifacts")!("list", {
      mode: "json",
      hasUI: false,
      ui: { notify() {} },
    } as never),
    /use artifact_inspect/,
  );
});

test("artifact_inspect returns bounded metadata and never loads body", async () => {
  const { api, tools } = fixture();
  const store = createInMemoryArtifactStore({ clock: () => 1 });
  const artifact = await store.put({
    body: "BODY-CANARY",
    filename: "report.md",
    mediaType: "text/markdown",
  });
  assert.equal(artifact.ok, true);
  const capability = createArtifactCapability(api, {
    defaultExpiryMs: 60_000,
    maxExpiryMs: 600_000,
  });
  capability.start({
    artifacts: store,
    publisher: {
      close: async () => {},
      publish: async () => {
        throw new Error("unused");
      },
      refresh: async () => {
        throw new Error("unused");
      },
      status: async () => {
        throw new Error("unused");
      },
      revoke: async () => {
        throw new Error("unused");
      },
    },
  });
  const tool = tools.find(({ name }) => name === "artifact_inspect")!;
  const result = await tool.execute(
    "id",
    { limit: 10 },
    undefined,
    undefined,
    {},
  );
  assert.equal(JSON.stringify(result).includes("BODY-CANARY"), false);
  assert.equal(JSON.stringify(result).includes("report.md"), true);
});
