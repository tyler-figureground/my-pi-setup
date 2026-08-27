import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createKeyringCredentialVault } from "./src/external/keyring-credentials.ts";

const windowsTest = process.platform === "win32" ? test : test.skip;

windowsTest(
  "OS credential vault persists a synthetic token by opaque bound reference and revokes it",
  async () => {
    const serviceName = `pi-phase5-test-${randomUUID()}`;
    const binding = {
      integration: "mcp" as const,
      resourceId: "fixture",
      origin: "https://mcp.example.test",
    };
    const secret = `synthetic-${"x".repeat(6_000)}`;
    const first = createKeyringCredentialVault({ serviceName });
    const stored = await first.store({ binding, secret });
    assert.equal(stored.ok, true, JSON.stringify(stored));
    if (!stored.ok) return;
    try {
      assert.equal(JSON.stringify(stored).includes(secret), false);
      const second = createKeyringCredentialVault({ serviceName });
      assert.equal(
        await second.resolve(stored.value.reference, binding),
        secret,
      );
      assert.equal(
        await second.replace(
          stored.value.reference,
          binding,
          "rotated-synthetic-token",
        ),
        true,
      );
      assert.equal(
        await first.resolve(stored.value.reference, binding),
        "rotated-synthetic-token",
      );
      const status = await second.inspect(stored.value.reference);
      assert.equal(status.exists, true);
      assert.equal(JSON.stringify(status).includes(secret), false);
      assert.equal(await second.remove(stored.value.reference, binding), true);
      assert.equal(
        await first.resolve(stored.value.reference, binding),
        undefined,
      );
    } finally {
      await first.remove(stored.value.reference, binding);
    }
  },
);
