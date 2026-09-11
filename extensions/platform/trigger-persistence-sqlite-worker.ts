/**
 * Test-only child process, not runtime code.
 * `trigger-persistence.integration.test.ts` spawns it
 * (`node --experimental-strip-types`) to claim Trigger Event records from a
 * shared SQLite StateStore in a separate process: two racing claimants must
 * get exactly one claim, and a crashed claimant's Lease is recoverable only
 * after it expires.
 *
 * Args: db path, claimant id, fixed `now`, lease-until, 64-hex HMAC key.
 * Claims one page (limit 1) and prints the result as JSON. Exit 2 = bad args.
 */

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
