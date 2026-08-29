import { appendFileSync, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { ResolvedAgentProfile } from "../shared/agent-profile.ts";
import type { ScheduledAgentExecutor } from "../shared/scheduled-agent.ts";
import {
  createScheduler,
  type HostAuthority,
  type ResultDelivery,
  type SchedulerClock,
} from "./src/automation/scheduler/index.ts";
import { createFileSystemArtifactStore } from "./src/core/artifacts/index.ts";
import { createSqliteStateStore } from "./src/core/persistence/index.ts";

const [databasePath, artifactRoot, gate, marker, ownerId, nowText] =
  process.argv.slice(2);
if (!databasePath || !artifactRoot || !gate || !marker || !ownerId || !nowText)
  process.exit(2);

const now = Number(nowText);
class WorkerClock implements SchedulerClock {
  #wake: (() => void) | undefined;
  now = () => now;
  arm(_at: number, wake: () => void) {
    this.#wake = wake;
    return () => {
      if (this.#wake === wake) this.#wake = undefined;
    };
  }
  fire() {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}

const project = {
  kind: "non-git" as const,
  projectId: "non-git:scheduler-project",
  requestedCwd: "C:/scheduler-project",
  canonicalCwd: "C:/scheduler-project",
  cwdWasAliased: false,
};
const profile: ResolvedAgentProfile = {
  description: "SQLite scheduled worker",
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
let executions = 0;
const executor: ScheduledAgentExecutor = {
  async run() {
    executions += 1;
    appendFileSync(marker, `${ownerId}\n`, "utf8");
    return {
      ok: true,
      value: {
        status: "completed",
        output: ownerId,
        outputBytes: ownerId.length,
      },
    };
  },
};
let deliveries = 0;
const delivery: ResultDelivery = {
  async deliver() {
    deliveries += 1;
    return { ok: true, value: { state: "offline" } };
  },
};
const openedState = createSqliteStateStore({
  path: databasePath,
  now: () => now,
  busyTimeoutMs: 5_000,
});
if (!openedState.ok) throw new Error(openedState.error.message);
const clock = new WorkerClock();
const opened = await createScheduler({
  state: openedState.value,
  artifacts: createFileSystemArtifactStore({
    root: artifactRoot,
    clock: () => now,
  }),
  clock,
  authority,
  executor,
  delivery,
  ownerId,
  binding: {
    project,
    cwd: project.canonicalCwd,
    creatorSessionId: ownerId,
    resultRoute: { kind: "session", sessionId: "offline-session" },
  },
});
if (!opened.ok) throw new Error(opened.error.message);
process.stdout.write("READY\n");
while (!existsSync(gate)) await delay(2);
clock.fire();
for (
  let attempt = 0;
  attempt < 100 && executions + deliveries === 0;
  attempt += 1
)
  await delay(5);
await delay(100);
process.stdout.write(`${JSON.stringify({ executions, deliveries })}\n`);
await opened.value.close();
