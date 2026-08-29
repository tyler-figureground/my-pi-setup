import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createProfileCatalog } from "./src/profiles/index.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-profiles-"));
  const agentDir = path.join(root, "agent");
  const projectRoot = path.join(root, "project");
  await mkdir(path.join(agentDir, "agents"), { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  return {
    root,
    agentDir,
    projectRoot,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("ProfileCatalog resolves one bounded user profile with source provenance", async () => {
  const f = await fixture();
  try {
    await writeFile(
      path.join(f.agentDir, "agents", "reviewer.yaml"),
      [
        "name: reviewer",
        "description: Review changes",
        "backend: pi",
        "model: anthropic/claude-sonnet-4-5",
        "effort: high",
        "instructions:",
        "  inline: Review correctness and security.",
        "skills: []",
        "allowedTools: [read, rg]",
        "disallowedTools: [bash]",
        "maxTurns: 12",
        "timeoutMs: 60000",
        "workspacePolicy: isolated",
        "role: review",
        "",
      ].join("\n"),
      "utf8",
    );

    const catalog = createProfileCatalog({ agentDir: f.agentDir });
    const snapshot = await catalog.reload({
      projectRoot: f.projectRoot,
      projectTrusted: false,
    });
    const resolved = catalog.resolve("reviewer");

    assert.equal(snapshot.profiles.length, 1);
    assert.equal(snapshot.diagnostics.length, 0);
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(resolved.value.description, "Review changes");
    assert.deepEqual(resolved.value.defaults, {
      backend: "pi",
      model: "anthropic/claude-sonnet-4-5",
      effort: "high",
    });
    assert.deepEqual(resolved.value.policy, {
      role: "review",
      instructions: ["Review correctness and security."],
      skills: [],
      tools: { allowed: ["read", "rg"], denied: ["bash"] },
      limits: { maxTurns: 12, timeoutMs: 60000 },
      workspace: "isolated",
    });
    assert.equal(resolved.value.identity.name, "reviewer");
    assert.equal(resolved.value.identity.catalogGeneration, 1);
    assert.match(resolved.value.identity.contentDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(resolved.value.identity.source, {
      scope: "user",
      path: path.join(f.agentDir, "agents", "reviewer.yaml"),
    });
  } finally {
    await f.cleanup();
  }
});

test("ProfileCatalog revalidates source bytes and referenced material without following stale cache", async () => {
  const f = await fixture();
  try {
    const profileDirectory = path.join(f.agentDir, "agents");
    const source = path.join(profileDirectory, "scheduled.yaml");
    const instructions = path.join(profileDirectory, "scheduled.md");
    await writeFile(instructions, "first instruction", "utf8");
    await writeFile(
      source,
      "name: scheduled\ndescription: Scheduled\nbackend: pi\ninstructions: { files: [scheduled.md] }\nskills: []\nrole: scheduled\n",
      "utf8",
    );
    const catalog = createProfileCatalog({ agentDir: f.agentDir });
    const context = { projectRoot: f.projectRoot, projectTrusted: false };
    await catalog.reload(context);
    const pinned = catalog.resolve("scheduled");
    assert.equal(pinned.ok, true);
    if (!pinned.ok) return;

    await writeFile(instructions, "changed instruction", "utf8");
    const changed = await catalog.revalidate!("scheduled", context);
    assert.equal(changed.ok, true);
    if (changed.ok) {
      assert.notEqual(
        changed.value.identity.contentDigest,
        pinned.value.identity.contentDigest,
      );
    }

    await unlink(source);
    const missing = await catalog.revalidate!("scheduled", context);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, "PROFILE_NOT_FOUND");
  } finally {
    await f.cleanup();
  }
});

test("ProfileCatalog reload publishes a new immutable generation without mutating running resolutions", async () => {
  const f = await fixture();
  try {
    const source = path.join(f.agentDir, "agents", "reload.yaml");
    await writeFile(
      source,
      "name: reload\ndescription: First\nbackend: pi\ninstructions: { inline: first }\nskills: []\n",
      "utf8",
    );
    const catalog = createProfileCatalog({ agentDir: f.agentDir });
    await catalog.reload({ projectRoot: f.projectRoot, projectTrusted: false });
    const first = catalog.resolve("reload");
    assert.equal(first.ok, true);
    if (!first.ok) return;
    await writeFile(
      source,
      "name: reload\ndescription: Second\nbackend: pi\ninstructions: { inline: second }\nskills: []\n",
      "utf8",
    );
    const secondSnapshot = await catalog.reload({
      projectRoot: f.projectRoot,
      projectTrusted: false,
    });
    const second = catalog.resolve("reload");
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(first.value.description, "First");
    assert.equal(first.value.identity.catalogGeneration, 1);
    assert.equal(second.value.description, "Second");
    assert.equal(second.value.identity.catalogGeneration, 2);
    assert.notEqual(
      first.value.identity.contentDigest,
      second.value.identity.contentDigest,
    );
    assert.equal(secondSnapshot.generation, 2);
    assert.equal(Object.isFrozen(first.value.policy), true);
  } finally {
    await f.cleanup();
  }
});

test("ProfileCatalog rejects a trusted-project agents junction outside project root", async () => {
  const f = await fixture();
  try {
    const outside = path.join(f.root, "outside-agents");
    await mkdir(outside);
    await writeFile(
      path.join(outside, "escape.yaml"),
      "name: escape\ndescription: Escape\nbackend: pi\ninstructions: { inline: bad }\nskills: []\n",
      "utf8",
    );
    await mkdir(path.join(f.projectRoot, ".pi"));
    await symlink(
      outside,
      path.join(f.projectRoot, ".pi", "agents"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const catalog = createProfileCatalog({ agentDir: f.agentDir });
    const snapshot = await catalog.reload({
      projectRoot: f.projectRoot,
      projectTrusted: true,
    });
    assert.equal(catalog.resolve("escape").ok, false);
    assert.equal(
      snapshot.diagnostics.some(
        (diagnostic) => diagnostic.code === "profile-directory-unavailable",
      ),
      true,
    );
  } finally {
    await f.cleanup();
  }
});

test("ProfileCatalog rejects same-scope name collisions instead of partially applying one", async () => {
  const f = await fixture();
  try {
    for (const file of ["a.yaml", "b.yaml"]) {
      await writeFile(
        path.join(f.agentDir, "agents", file),
        "name: duplicate\ndescription: Duplicate\nbackend: pi\ninstructions: { inline: one }\nskills: []\n",
        "utf8",
      );
    }
    const catalog = createProfileCatalog({ agentDir: f.agentDir });
    const snapshot = await catalog.reload({
      projectRoot: f.projectRoot,
      projectTrusted: false,
    });

    assert.equal(catalog.resolve("duplicate").ok, false);
    assert.equal(snapshot.profiles.length, 0);
    assert.equal(
      snapshot.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "profile-name-collision" &&
          diagnostic.name === "duplicate",
      ),
      true,
    );
  } finally {
    await f.cleanup();
  }
});

test("ProfileCatalog resolves instruction and skill files relative to the profile source", async () => {
  const f = await fixture();
  try {
    const profileDirectory = path.join(f.agentDir, "agents");
    const skillDirectory = path.join(profileDirectory, "skills", "security");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      path.join(profileDirectory, "review-notes.md"),
      "Check race conditions.",
      "utf8",
    );
    await writeFile(
      path.join(skillDirectory, "SKILL.md"),
      "# Security\n\nTreat trust as host authority.",
      "utf8",
    );
    await writeFile(
      path.join(profileDirectory, "reviewer.yaml"),
      [
        "name: reviewer",
        "description: Reviewer",
        "backend: pi",
        "instructions:",
        "  inline: Start with public behavior.",
        "  files: [review-notes.md]",
        "skills: [skills/security/SKILL.md]",
        "",
      ].join("\n"),
      "utf8",
    );

    const catalog = createProfileCatalog({ agentDir: f.agentDir });
    await catalog.reload({ projectRoot: f.projectRoot, projectTrusted: false });
    const resolved = catalog.resolve("reviewer");
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.deepEqual(resolved.value.policy.instructions, [
        "Start with public behavior.",
        "Check race conditions.",
      ]);
      assert.deepEqual(resolved.value.policy.skills, [
        {
          path: path.join(skillDirectory, "SKILL.md"),
          content: "# Security\n\nTreat trust as host authority.",
        },
      ]);
    }
  } finally {
    await f.cleanup();
  }
});

test("ProfileCatalog gives managed profiles precedence over trusted project and user profiles", async () => {
  const f = await fixture();
  try {
    const projectDirectory = path.join(f.projectRoot, ".pi", "agents");
    const managedDirectory = path.join(f.root, "managed");
    const managedPath = path.join(managedDirectory, "reviewer.yaml");
    await mkdir(projectDirectory, { recursive: true });
    await mkdir(managedDirectory, { recursive: true });
    for (const [profilePath, description] of [
      [path.join(f.agentDir, "agents", "reviewer.yaml"), "User"],
      [path.join(projectDirectory, "reviewer.yaml"), "Project"],
      [managedPath, "Managed"],
    ] as const) {
      await writeFile(
        profilePath,
        `name: reviewer\ndescription: ${description}\nbackend: pi\ninstructions: { inline: ${description} }\nskills: []\n`,
        "utf8",
      );
    }

    const catalog = createProfileCatalog({
      agentDir: f.agentDir,
      managedProfiles: [{ path: managedPath, root: managedDirectory }],
    });
    await catalog.reload({ projectRoot: f.projectRoot, projectTrusted: true });
    const resolved = catalog.resolve("reviewer");
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.value.description, "Managed");
      assert.equal(resolved.value.identity.source.scope, "managed");
    }
  } finally {
    await f.cleanup();
  }
});

test("ProfileCatalog applies project-over-user precedence only for trusted projects", async () => {
  const f = await fixture();
  try {
    const userPath = path.join(f.agentDir, "agents", "reviewer.yaml");
    const projectDirectory = path.join(f.projectRoot, ".pi", "agents");
    const projectPath = path.join(projectDirectory, "reviewer.yaml");
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(
      userPath,
      "name: reviewer\ndescription: User reviewer\nbackend: pi\ninstructions: { inline: user }\nskills: []\n",
      "utf8",
    );
    await writeFile(
      projectPath,
      "name: reviewer\ndescription: Project reviewer\nbackend: claude\ninstructions: { inline: project }\nskills: []\n",
      "utf8",
    );

    const catalog = createProfileCatalog({ agentDir: f.agentDir });
    await catalog.reload({ projectRoot: f.projectRoot, projectTrusted: false });
    const untrusted = catalog.resolve("reviewer");
    assert.equal(untrusted.ok, true);
    if (untrusted.ok) {
      assert.equal(untrusted.value.description, "User reviewer");
      assert.equal(untrusted.value.identity.source.scope, "user");
    }

    await catalog.reload({ projectRoot: f.projectRoot, projectTrusted: true });
    const trusted = catalog.resolve("reviewer");
    assert.equal(trusted.ok, true);
    if (trusted.ok) {
      assert.equal(trusted.value.description, "Project reviewer");
      assert.equal(trusted.value.identity.source.scope, "project");
    }
  } finally {
    await f.cleanup();
  }
});
