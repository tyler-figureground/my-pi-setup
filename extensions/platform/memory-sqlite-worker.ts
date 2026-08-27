import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
import {
  coreMemoryKinds,
  createHostMemoryBindingFactory,
  createMemoryStoreModule,
} from "./src/memory/index.ts";
import { createSqliteMemoryPersistenceAdapter } from "./src/memory/sqlite-memory-persistence.ts";

const [path, gate, requestId, content] = process.argv.slice(2);
if (!path || !gate || !requestId || !content) process.exit(2);
const opened = createSqliteMemoryPersistenceAdapter({ path });
if (!opened.ok) {
  process.stdout.write(`${JSON.stringify(opened)}\n`);
  process.exit(1);
}
let held = false;
const persistence = {
  ...opened.value,
  async findCandidates(
    ...args: Parameters<typeof opened.value.findCandidates>
  ) {
    const result = await opened.value.findCandidates(...args);
    if (!held) {
      held = true;
      process.stdout.write("READY\n");
      while (!existsSync(gate)) await delay(2);
    }
    return result;
  },
};
const memory = createMemoryStoreModule({
  persistence,
  artifacts: createInMemoryArtifactStore(),
}).bind(
  createHostMemoryBindingFactory().issue({
    executionRole: "parent",
    project: {
      kind: "non-git",
      projectId: "non-git:sqlite-project-one",
      requestedCwd: "C:/sqlite-project-one",
      canonicalCwd: "C:/sqlite-project-one",
      cwdWasAliased: false,
    },
    ingress: "direct-user",
    sessionId: "sqlite-worker",
  }),
);
let result;
for (let attempt = 0; attempt < 4; attempt += 1) {
  result = await memory.remember({
    requestId,
    kind: coreMemoryKinds.projectFact,
    scope: "project",
    content,
  });
  if (result.ok || !result.error.retryable) break;
  await delay(25 * (attempt + 1));
}
process.stdout.write(`${JSON.stringify(result)}\n`);
