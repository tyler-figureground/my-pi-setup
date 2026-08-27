import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryStateStore } from "./src/core/persistence/index.ts";
import { createMcpCredentialReferences } from "./src/mcp/references.ts";

test("MCP credential references persist as metadata without token values", async () => {
  const store = createMemoryStateStore();
  const references = createMcpCredentialReferences({
    store,
    scope: "project-fixture",
  });
  assert.equal(await references.get("docs"), undefined);
  await references.set("docs", "credential:opaque-reference");
  assert.equal(await references.get("docs"), "credential:opaque-reference");
  const snapshot = await store.export({ format: "snapshot" });
  assert.equal(snapshot.ok, true);
  if (snapshot.ok) {
    const encoded = JSON.stringify(snapshot.value);
    assert.equal(encoded.includes("credential:opaque-reference"), true);
    assert.equal(encoded.includes("access_token"), false);
  }
  await references.remove("docs");
  assert.equal(await references.get("docs"), undefined);
});
