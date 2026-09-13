import assert from "node:assert/strict";
import test from "node:test";
import type { WindowsProcessTreeSnapshot } from "./src/core/processes/windows-tree.ts";
import { officialMcpAdapterTestSeams } from "./src/mcp/official-adapter.ts";

const windowsTest = process.platform === "win32" ? test : test.skip;

const idleServer = {
  command: process.execPath,
  args: ["-e", "setInterval(() => {}, 1000)"],
  stderr: "pipe" as const,
};

const rootStartedAt = "133700000000000001";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectUnhandledRejections(run: () => Promise<void>) {
  const rejections: unknown[] = [];
  const record = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", record);
  try {
    await run();
    // Let pending microtasks and a few tracker ticks surface late rejections.
    await sleep(250);
  } finally {
    process.off("unhandledRejection", record);
  }
  return rejections;
}

windowsTest(
  "MCP STDIO descendant tracking survives a failed Windows process inspection",
  async () => {
    let calls = 0;
    const snapshotTree = async (
      pid: number,
    ): Promise<WindowsProcessTreeSnapshot> => {
      calls++;
      if (calls === 1)
        return { root: { pid, startedAt: rootStartedAt }, descendants: [] };
      throw new Error("Windows process inspection timed out.");
    };
    const transport = new officialMcpAdapterTestSeams.OwnedStdioClientTransport(
      idleServer,
      { snapshotTree, trackingIdleMs: 5 },
    );
    try {
      const rejections = await collectUnhandledRejections(async () => {
        await transport.start();
        assert.equal((await transport.rootIdentity)?.startedAt, rootStartedAt);
      });
      assert.ok(calls > 2, `tracker should keep polling, saw ${calls} calls`);
      assert.deepEqual(rejections.map(String), []);
    } finally {
      await transport.close();
    }
  },
);

windowsTest(
  "MCP STDIO root identity failure stays observable without an unhandled rejection",
  async () => {
    const transport = new officialMcpAdapterTestSeams.OwnedStdioClientTransport(
      idleServer,
      {
        snapshotTree: async () => {
          throw new Error("Windows process inspection timed out.");
        },
      },
    );
    try {
      const rejections = await collectUnhandledRejections(() =>
        transport.start(),
      );
      assert.deepEqual(rejections.map(String), []);
      await assert.rejects(
        () => transport.rootIdentity ?? Promise.resolve(undefined),
        /inspection timed out/,
      );
    } finally {
      await transport.close();
    }
  },
);

windowsTest(
  "MCP STDIO descendant tracking rests between inspections and stops on close",
  async () => {
    let calls = 0;
    const transport = new officialMcpAdapterTestSeams.OwnedStdioClientTransport(
      idleServer,
      {
        snapshotTree: async (pid) => {
          calls++;
          return { root: { pid, startedAt: rootStartedAt }, descendants: [] };
        },
        trackingIdleMs: 100,
      },
    );
    try {
      await transport.start();
      await transport.rootIdentity;
      calls = 0;
      await sleep(450);
      // ~4 inspections at a 100ms rest; back-to-back polling would run far more.
      assert.ok(calls >= 2, `tracker should poll, saw ${calls} calls`);
      assert.ok(calls <= 6, `tracker should rest, saw ${calls} calls`);
    } finally {
      await transport.close();
    }
    const afterClose = calls;
    await sleep(300);
    assert.equal(calls, afterClose, "tracker kept polling after close");
  },
);
