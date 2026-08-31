import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  artifactProducerFor,
  bindArtifactProducer,
} from "../platform/src/artifacts/producer-service.ts";
import { buildWorkflowResultMessage } from "./prompt.ts";
import type { WorkflowDetails } from "./model.ts";

test("Workflow Artifact producer binding is host-local and completion renders reference only", async () => {
  const events = createEventBus();
  let body = "";
  const unbind = bindArtifactProducer(events, {
    async put(input) {
      body = String(input.body);
      return {
        ok: true,
        value: {
          id: "a".repeat(64),
          sha256: "a".repeat(64),
          size: Buffer.byteLength(body),
          createdAt: 1,
          filename: input.filename,
          mediaType: input.mediaType,
        },
      };
    },
  });
  const producer = artifactProducerFor(events);
  assert.ok(producer);
  const stored = await producer.put({
    body: JSON.stringify({ result: "BODY-CANARY" }),
    filename: "workflow-result.json",
    mediaType: "application/json",
    title: "Workflow",
    creator: "workflow",
    kind: "json",
    sensitivity: "internal",
  });
  assert.equal(stored.ok, true);
  assert.match(body, /BODY-CANARY/);

  const details: WorkflowDetails = {
    runId: "wf_1",
    name: "fixture",
    background: false,
    status: "completed",
    startedAt: 1,
    finishedAt: 2,
    phases: [],
    agents: [],
    platformArtifactId: "a".repeat(64),
  };
  const message = buildWorkflowResultMessage(details, "C:/runs/wf_1");
  assert.match(message, new RegExp(`Artifact: ${"a".repeat(64)}`));
  assert.equal(message.includes("BODY-CANARY"), false);
  unbind();
  assert.equal(artifactProducerFor(events), undefined);
});
