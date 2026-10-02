import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createCapabilityPolicy } from "./src/core/policy/index.ts";
import { createRulesCapability } from "./src/wiring/rules.ts";

test("outside-project activation is silent without loading external rules or hiding config errors", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-rules-wiring-"));
  const handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => unknown
  >();
  const notifications: string[] = [];
  const messages: unknown[] = [];
  const root = path.join(directory, "project");
  const agentDir = path.join(directory, "agent");
  const pi = {
    on(
      name: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    sendMessage(message: unknown) {
      messages.push(message);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    sessionManager: {
      getSessionId: () => "rules-test",
      getLeafId: () => "root",
    },
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;
  const capability = createRulesCapability({
    pi,
    agentDir,
    actor: "parent",
    policy: createCapabilityPolicy(),
  });
  try {
    await mkdir(root, { recursive: true });
    const rulesDir = path.join(agentDir, "rules");
    await mkdir(rulesDir, { recursive: true });
    await capability.start({
      project: {
        kind: "non-git",
        projectId: "rules-test",
        requestedCwd: root,
        canonicalCwd: root,
        cwdWasAliased: false,
      },
      projectTrusted: true,
      ctx,
    });
    const outside = path.join(directory, "other-worktree");
    await mkdir(outside);
    for (let attempt = 0; attempt < 2; attempt++) {
      await handlers.get("before_agent_start")!(
        { prompt: `Read \`${outside}\``, systemPrompt: "base" },
        ctx,
      );
      await handlers.get("tool_call")!(
        { toolName: "read", input: { path: outside } },
        ctx,
      );
      await handlers.get("tool_result")!(
        { toolName: "fd", content: [{ type: "text", text: outside }] },
        ctx,
      );
    }
    assert.equal(notifications.length, 0);
    assert.deepEqual(messages, []);
    const activation = await capability
      .catalog()!
      .activate({ paths: [outside], contextEpoch: "verify-boundary" });
    assert.deepEqual(activation.rules, []);
    assert.ok(
      activation.diagnostics.some(
        ({ code }) => code === "activation_path_outside_project",
      ),
    );

    await writeFile(
      path.join(rulesDir, "invalid.md"),
      "---\ninvalid: [\n---\nBad rule\n",
      "utf8",
    );
    await capability.start({
      project: {
        kind: "non-git",
        projectId: "rules-test",
        requestedCwd: root,
        canonicalCwd: root,
        cwdWasAliased: false,
      },
      projectTrusted: true,
      ctx,
    });
    assert.ok(notifications.some((message) => message.startsWith("Rule [")));
  } finally {
    capability.stop();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
