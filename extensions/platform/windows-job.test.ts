import assert from "node:assert/strict";
import test from "node:test";

// Koffi's type registry is process-wide; extension reload creates fresh module
// instances. Each instance must reuse the registered job types instead of
// failing with "Duplicate type name 'PI_JOB_HANDLE'" (which broke every stdio
// MCP server after a reload).
const BINDINGS_SLOT = Symbol.for("pi.platform.windowsJobBindings");

test(
  "Windows job bindings survive a second module instance and a cleared cache",
  { skip: process.platform !== "win32" && "Windows job objects only" },
  async () => {
    for (const instance of ["first", "second"]) {
      const mod = await import(
        `./src/core/processes/windows-job.ts?instance=${instance}`
      );
      const job = await mod.createWindowsKillOnCloseJob();
      job.close();
    }

    delete (globalThis as Record<symbol, unknown>)[BINDINGS_SLOT];
    const retryInstance = "retry";
    const retried = await import(
      `./src/core/processes/windows-job.ts?instance=${retryInstance}`
    );
    const job = await retried.createWindowsKillOnCloseJob();
    job.terminate();
    job.close();
    assert.ok(
      (globalThis as Record<symbol, unknown>)[BINDINGS_SLOT],
      "bindings are shared through the process-wide slot",
    );
  },
);
