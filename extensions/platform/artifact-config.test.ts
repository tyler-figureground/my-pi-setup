import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeArtifactConfiguration,
  defaultPlatformArtifactConfiguration,
} from "./src/artifacts/config.ts";

test("Artifact provider config is user-managed, bounded, and exact", () => {
  const decoded = decodeArtifactConfiguration(
    {
      defaultExpiryMs: 60_000,
      maxExpiryMs: 600_000,
      vercel: {
        project: "pi-artifacts",
        teamId: "team_123",
        credentialReference: "credential:vercel-token",
      },
    },
    defaultPlatformArtifactConfiguration,
    "user",
  );
  assert.deepEqual(decoded.diagnostics, []);
  assert.deepEqual(decoded.artifacts.vercel, {
    project: "pi-artifacts",
    teamId: "team_123",
    credentialReference: "credential:vercel-token",
  });

  const project = decodeArtifactConfiguration(
    { vercel: { project: "attacker" } },
    decoded.artifacts,
    "project",
  );
  assert.equal(project.artifacts, decoded.artifacts);
  assert.equal(project.diagnostics.length, 1);

  const invalid = decodeArtifactConfiguration(
    {
      defaultExpiryMs: 700_000,
      maxExpiryMs: 60_000,
      vercel: {
        project: "INVALID",
        credentialReference: "raw-secret",
      },
    },
    defaultPlatformArtifactConfiguration,
    "user",
  );
  assert.equal(invalid.artifacts, defaultPlatformArtifactConfiguration);
  assert.ok(invalid.diagnostics.length >= 2);
});
