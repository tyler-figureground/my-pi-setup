import { createSqliteStateStore } from "./src/core/persistence/index.ts";
import { createStateStoreTriggerPersistence } from "./src/automation/triggers/state-store-persistence.ts";

const [path, claimantId, nowText, leaseUntilText] = process.argv.slice(2);
const now = Number(nowText);
const leaseUntil = Number(leaseUntilText);
if (
  !path ||
  !claimantId ||
  !Number.isSafeInteger(now) ||
  !Number.isSafeInteger(leaseUntil)
) {
  process.exit(2);
}

const opened = createSqliteStateStore({ path, now: () => now });
if (!opened.ok) {
  process.stdout.write(JSON.stringify(opened));
  process.exit(1);
}
const persistence = createStateStoreTriggerPersistence(opened.value, {
  now: () => now,
});
const result = await persistence.claimPage({
  claimantId,
  now,
  leaseUntil,
  limit: 1,
});
process.stdout.write(JSON.stringify(result));
