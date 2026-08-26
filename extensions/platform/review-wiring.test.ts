import assert from "node:assert/strict";
import test from "node:test";
import type { LocalReview, ReviewTarget } from "./src/review/index.ts";
import { createReviewCapability } from "./src/wiring/review.ts";

test("/review picker runs an uncommitted review and renders structured findings", async () => {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  let observed: ReviewTarget | undefined;
  const notices: Array<{ message: string; level?: string }> = [];
  const statuses: Array<string | undefined> = [];
  const review: LocalReview = {
    async run(target, options) {
      observed = target;
      options.onProgress?.("reviewing");
      return {
        ok: true,
        value: {
          status: "completed",
          conclusion: "findings",
          target: { kind: "uncommitted", targetId: "snapshot:one" },
          freshness: { kind: "not-applicable" },
          findings: [
            {
              id: "a".repeat(64),
              severity: "high",
              confidence: "high",
              category: "correctness",
              file: "src/value.ts",
              range: { side: "target", startLine: 4, endLine: 4 },
              summary: "Undefined value",
              failureScenario: "Loading the module throws.",
              evidence: ["diff"],
            },
          ],
          rejectedFindingCount: 0,
          artifact: {
            id: "b".repeat(64),
            sha256: "b".repeat(64),
            size: 100,
            createdAt: 1,
            mediaType: "application/json",
          },
        },
      };
    },
  };
  const capability = createReviewCapability(
    {
      registerCommand(name: string, command: { handler: typeof handler }) {
        assert.equal(name, "review");
        handler = command.handler;
      },
    } as never,
    { review },
  );
  assert.ok(handler);
  await handler!("", {
    hasUI: true,
    ui: {
      select: async () => "uncommitted changes",
      notify: (message: string, level?: string) =>
        notices.push({ message, level }),
      setStatus: (_key: string, value?: string) => statuses.push(value),
    },
  });

  assert.deepEqual(observed, { kind: "uncommitted" });
  assert.ok(statuses.includes("reviewing"));
  assert.ok(notices.some(({ message }) => /src\/value\.ts:4/.test(message)));
  assert.ok(notices.some(({ message }) => message.includes("b".repeat(64))));
  await capability.stop();
});

test("/review rejects print and JSON modes instead of running silently", async () => {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  let runs = 0;
  createReviewCapability(
    {
      registerCommand(_name: string, command: { handler: typeof handler }) {
        handler = command.handler;
      },
    } as never,
    {
      review: {
        run: async () => {
          runs++;
          throw new Error("must not run");
        },
      },
    },
  );
  await assert.rejects(
    () => handler!("uncommitted", { hasUI: false, mode: "json", ui: {} }),
    /requires TUI or RPC/i,
  );
  assert.equal(runs, 0);
});

test("/review cancel aborts the active review", async () => {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  let aborted = false;
  const review: LocalReview = {
    run: async (_target, options) =>
      new Promise((resolve) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve({
              ok: false,
              error: {
                code: "cancelled",
                message: "cancelled",
                retryable: true,
              },
            });
          },
          { once: true },
        );
      }),
  };
  createReviewCapability(
    {
      registerCommand(_name: string, command: { handler: typeof handler }) {
        handler = command.handler;
      },
    } as never,
    { review },
  );
  const ctx = {
    hasUI: true,
    ui: {
      notify() {},
      setStatus() {},
      select: async () => "uncommitted changes",
    },
  };
  const running = handler!("uncommitted", ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await handler!("cancel", ctx);
  await running;
  assert.equal(aborted, true);
});
