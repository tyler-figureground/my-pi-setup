import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryCredentialVault } from "./src/external/credentials.ts";

const binding = {
  integration: "mcp" as const,
  resourceId: "docs",
  origin: "https://mcp.example.test",
};

test("credential vault returns opaque references and resolves secrets only for the exact binding", async () => {
  const vault = createInMemoryCredentialVault({
    createReference: () => "credential:fixture-reference",
  });
  const secret = "secret-access-token";
  const stored = await vault.store({ binding, secret });

  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  assert.equal(stored.value.reference, "credential:fixture-reference");
  assert.equal(JSON.stringify(stored).includes(secret), false);

  const status = await vault.inspect(stored.value.reference);
  assert.deepEqual(status, {
    exists: true,
    reference: "credential:fixture-reference",
    binding,
  });
  assert.equal(JSON.stringify(status).includes(secret), false);

  assert.equal(await vault.resolve(stored.value.reference, binding), secret);
  assert.equal(
    await vault.resolve(stored.value.reference, {
      ...binding,
      origin: "https://attacker.example.test",
    }),
    undefined,
  );
  assert.equal(
    await vault.replace(stored.value.reference, binding, "rotated-token"),
    true,
  );
  assert.equal(
    await vault.resolve(stored.value.reference, binding),
    "rotated-token",
  );

  assert.equal(await vault.remove(stored.value.reference, binding), true);
  assert.equal(await vault.resolve(stored.value.reference, binding), undefined);
});
