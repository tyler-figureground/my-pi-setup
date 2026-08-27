import { createFileSystemArtifactStore } from "../src/core/artifacts/index.ts";
import { createLifecycleSupervisor } from "../src/core/lifecycle/supervisor.ts";
import { createSqliteStateStore } from "../src/core/persistence/index.ts";
import type { ResolvedProjectIdentity } from "../src/core/projects/index.ts";
import {
  createSessionBrokerModule,
  issueHostSessionProof,
} from "../src/messaging/index.ts";

const [databasePath, artifactRoot, senderId, recipientId, requestId] =
  process.argv.slice(2);
if (!databasePath || !artifactRoot || !senderId || !recipientId || !requestId) {
  throw new Error("SessionBroker process fixture arguments are incomplete.");
}

const project: ResolvedProjectIdentity = {
  kind: "non-git",
  projectId: "process-project",
  requestedCwd: "C:/process-project",
  canonicalCwd: "c:/process-project",
  cwdWasAliased: false,
};
const opened = createSqliteStateStore({ path: databasePath });
if (!opened.ok) throw new Error(opened.error.message);
const lifecycle = createLifecycleSupervisor();
const module = createSessionBrokerModule({
  state: opened.value,
  artifacts: createFileSystemArtifactStore({ root: artifactRoot }),
  lifecycle,
});
const attached = await module.attach(
  {
    piSessionId: senderId,
    proof: issueHostSessionProof(),
    executionRole: "parent",
    project,
    cwd: "C:/process-project",
    exposure: {
      discoverableBy: "same-project",
      acceptsFrom: "same-project",
    },
  },
  {
    snapshot: () => ({
      name: senderId,
      status: "idle" as const,
      capabilities: [{ id: "pi.delivery/inbox", version: 1 }],
    }),
    subscribe: () => () => {},
    async deliverOnce() {
      return {
        ok: true as const,
        value: { state: "accepted" as const, durableReceipt: "fixture" },
      };
    },
  },
);
if (!attached.ok) throw new Error(attached.error.message);

process.send?.({ type: "ready" });
process.on("message", async (message) => {
  if (
    typeof message !== "object" ||
    message === null ||
    !("type" in message) ||
    message.type !== "send"
  ) {
    return;
  }
  const result = await attached.value.send({
    requestId,
    recipients: [{ piSessionId: recipientId }],
    summary: `Process send ${senderId}`,
    body: { kind: "text", text: `body-${senderId}` },
  });
  await attached.value.close("quit");
  await lifecycle.shutdown("quit");
  process.send?.({ type: "result", result });
  process.disconnect?.();
});
