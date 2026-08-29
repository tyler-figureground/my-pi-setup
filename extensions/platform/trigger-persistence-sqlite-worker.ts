import { createSqliteStateStore } from "./src/core/persistence/index.ts";
import { createStateStoreTriggerPersistence } from "./src/automation/triggers/state-store-persistence.ts";
import { createHmacTriggerRecordAuthenticator } from "./src/automation/triggers/record-authentication.ts";

const [path, claimantId, nowText, leaseUntilText, authenticationKey] =
  process.argv.slice(2);
const now = Number(nowText);
const leaseUntil = Number(leaseUntilText);
if (
  !path ||
  !claimantId ||
  !authenticationKey ||
  !/^[a-f0-9]{64}$/.test(authenticationKey) ||
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
  authenticator: createHmacTriggerRecordAuthenticator(async () =>
    Buffer.from(authenticationKey, "hex"),
  ),
});
const result = await persistence.claimPage({
  claimantId,
  now,
  leaseUntil,
  limit: 1,
});
process.stdout.write(JSON.stringify(result));
