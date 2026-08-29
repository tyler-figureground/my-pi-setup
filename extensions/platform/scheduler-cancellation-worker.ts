import { appendFileSync } from "node:fs";
import type { ResolvedAgentProfile } from "../shared/agent-profile.ts";
import type { ScheduledAgentExecutor } from "../shared/scheduled-agent.ts";
import {
  createScheduler,
  createSystemSchedulerClock,
  type HostAuthority,
  type ResultDelivery,
} from "./src/automation/scheduler/index.ts";
import { createFileSystemArtifactStore } from "./src/core/artifacts/index.ts";
import { createSqliteStateStore } from "./src/core/persistence/index.ts";

const [databasePath, artifactRoot, marker, ownerId] = process.argv.slice(2);
if (!databasePath || !artifactRoot || !marker || !ownerId) process.exit(2);

const project = {
  kind: "non-git" as const,
  projectId: "non-git:scheduler-project",
  requestedCwd: "C:/scheduler-project",
  canonicalCwd: "C:/scheduler-project",
  cwdWasAliased: false,
};
const profile: ResolvedAgentProfile = {
  description: "SQLite cancellation worker",
  identity: {
    name: "nightly",
    contentDigest: "a".repeat(64),
    catalogGeneration: 1,
    source: { scope: "user", path: "C:/agent/profiles/nightly.yaml" },
  },
  defaults: { backend: "pi" },
  policy: {
    role: "scheduled",
    instructions: [],
    skills: [],
    tools: { denied: [] },
    limits: {},
    workspace: "current",
  },
};
const authority: HostAuthority = {
  async authorize() {
    return { ok: true, value: { project, projectTrusted: true, profile } };
  },
};
let signalCancelled!: () => void;
const cancelled = new Promise<void>((resolve) => {
  signalCancelled = resolve;
});
const executor: ScheduledAgentExecutor = {
  run(_request, signal) {
    appendFileSync(marker, `STARTED:${ownerId}\n`, "utf8");
    return new Promise((resolve) => {
      signal?.addEventListener(
        "abort",
        () => {
          appendFileSync(marker, `ABORTED:${ownerId}\n`, "utf8");
          setTimeout(() => {
            resolve({
              ok: false,
              error: {
                code: "cancelled",
                message: "Native scheduled child cancelled.",
                retryable: false,
              },
            });
            signalCancelled();
          }, 30);
        },
        { once: true },
      );
    });
  },
};
const delivery: ResultDelivery = {
  async deliver() {
    return { ok: true, value: { state: "offline" } };
  },
};
const openedState = createSqliteStateStore({
  path: databasePath,
  now: Date.now,
  busyTimeoutMs: 5_000,
});
if (!openedState.ok) throw new Error(openedState.error.message);
const opened = await createScheduler({
  state: openedState.value,
  artifacts: createFileSystemArtifactStore({ root: artifactRoot }),
  clock: createSystemSchedulerClock(),
  authority,
  executor,
  delivery,
  ownerId,
  binding: {
    project,
    cwd: project.canonicalCwd,
    creatorSessionId: `${ownerId}-session`,
    resultRoute: { kind: "session", sessionId: "offline-session" },
  },
});
if (!opened.ok) throw new Error(opened.error.message);
process.stdout.write("READY\n");
const keepAlive = setInterval(() => undefined, 1_000);
await cancelled;
clearInterval(keepAlive);
await opened.value.close();
process.stdout.write(`${JSON.stringify({ cancelled: true })}\n`);
