import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadPlatformFlags } from "./src/config.ts";

test("Phase 5 config loads global and trusted-project MCP/browser settings without secret fields", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-phase5-config-"));
  const agentDir = path.join(root, "agent");
  const project = path.join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(path.join(project, ".git"), { recursive: true });
  await mkdir(path.join(project, ".pi"), { recursive: true });
  await writeFile(
    path.join(agentDir, "platform.json"),
    JSON.stringify({
      mcp: true,
      browser: true,
      mcpServers: [
        {
          id: "local",
          transport: { kind: "stdio", command: "fixture", args: ["--stdio"] },
          tools: { effects: { lookup: "network-read" } },
        },
      ],
      browserSettings: {
        executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
        profileName: "phase5",
        allowedOrigins: ["https://example.test"],
        allowLoopback: false,
      },
    }),
  );
  await writeFile(
    path.join(project, ".pi", "platform.json"),
    JSON.stringify({
      mcpServers: [
        {
          id: "remote",
          transport: {
            kind: "http",
            url: "https://mcp.example.test/mcp",
            allowedOrigins: ["https://mcp.example.test"],
          },
          credentialReference: "credential:remote-token",
          bearerToken: "must-not-be-accepted",
        },
      ],
      browserSettings: {
        allowedOrigins: ["http://127.0.0.1:4173"],
        allowLoopback: true,
      },
    }),
  );
  try {
    const untrusted = loadPlatformFlags({
      cwd: project,
      agentDir,
      projectTrusted: false,
    });
    assert.equal(untrusted.flags.mcp, true);
    assert.equal(untrusted.flags.browser, true);
    assert.deepEqual(
      untrusted.mcpServers.map(({ id }) => id),
      ["local"],
    );
    assert.deepEqual(untrusted.browser, {
      executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
      profileName: "phase5",
      allowedOrigins: ["https://example.test"],
      allowLoopback: false,
    });

    const trusted = loadPlatformFlags({
      cwd: project,
      agentDir,
      projectTrusted: true,
    });
    assert.deepEqual(
      trusted.mcpServers.map(({ id }) => id),
      ["local"],
    );
    assert.equal(
      trusted.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("bearerToken"),
      ),
      true,
    );
    assert.deepEqual(trusted.browser.allowedOrigins, [
      "https://example.test",
      "http://127.0.0.1:4173",
    ]);
    assert.equal(trusted.browser.allowLoopback, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
