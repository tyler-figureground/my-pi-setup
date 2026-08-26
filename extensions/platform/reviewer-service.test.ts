import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { ReviewCapture } from "./src/review/index.ts";
import {
  bindLocalReviewer,
  localReviewerFor,
} from "./src/review/reviewer-service.ts";

const capture: ReviewCapture = {
  requested: { kind: "uncommitted" },
  resolved: { kind: "uncommitted", targetId: "snapshot", head: "a".repeat(40) },
  projectId: "git:fixture",
  root: "C:\\fixture",
  diff: "",
  files: [],
  sourceFingerprint: "fingerprint",
  freshness: { kind: "not-applicable" },
  capturedAt: 1,
};

test("local reviewer crosses the shared event bus and unbinds cleanly", async () => {
  const events = createEventBus();
  const unbind = bindLocalReviewer(events, {
    review: async () => ({ candidates: [], rawOutput: "ok" }),
  });
  const result = await localReviewerFor(events).review({
    runId: "review",
    capture,
    evidence: [],
    pass: "primary",
  });
  assert.equal(result.rawOutput, "ok");
  unbind();
  await assert.rejects(
    () =>
      localReviewerFor(events).review({
        runId: "review",
        capture,
        evidence: [],
        pass: "primary",
      }),
    /requires the subagent extension/i,
  );
});
