import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  createRuleCatalog,
  type RuleCatalogStorage,
} from "./src/rules/index.ts";
import type { ResolvedProjectIdentity } from "./src/core/projects/index.ts";

const projectRoot = path.resolve("C:/fixture/project").replaceAll("\\", "/");

const project: ResolvedProjectIdentity = {
  kind: "non-git",
  projectId: "non-git:fixture",
  requestedCwd: projectRoot,
  canonicalCwd: projectRoot,
  cwdWasAliased: false,
};

function memoryStorage(
  files: Record<string, string>,
  reads: Array<{ kind: "frontmatter" | "content"; path: string }>,
): RuleCatalogStorage {
  const entries = () =>
    Object.entries(files).map(
      ([filePath, content]) =>
        [path.resolve(filePath).replaceAll("\\", "/"), content] as const,
    );
  const contentAt = (filePath: string) =>
    entries().find(([candidate]) => candidate === filePath)?.[1];
  return {
    async listMarkdownFiles(root) {
      const prefix = `${root.replaceAll("\\", "/")}/`;
      return entries()
        .map(([filePath]) => filePath)
        .filter(
          (filePath) => filePath.startsWith(prefix) && filePath.endsWith(".md"),
        );
    },
    async canonicalize(candidate) {
      return path.resolve(candidate).replaceAll("\\", "/");
    },
    async readFrontmatter(filePath, limit) {
      reads.push({ kind: "frontmatter", path: filePath });
      const content = contentAt(filePath);
      if (content === undefined) throw new Error(`Missing fixture ${filePath}`);
      return {
        prefix: content.slice(0, limit + 1),
        size: Buffer.byteLength(content),
      };
    },
    async readContent(filePath, limit) {
      reads.push({ kind: "content", path: filePath });
      const content = contentAt(filePath);
      if (content === undefined) throw new Error(`Missing fixture ${filePath}`);
      return content.slice(0, limit + 1);
    },
  };
}

function rule(frontmatter: string, body: string) {
  return `---\n${frontmatter}\n---\n${body}`;
}

test("discover indexes rule metadata without reading rule content", async () => {
  const userRoot = path.resolve("C:/fixture/user-rules").replaceAll("\\", "/");
  const projectRulesRoot = `${projectRoot}/.pi/rules`;
  const reads: Array<{ kind: "frontmatter" | "content"; path: string }> = [];
  const storage = memoryStorage(
    {
      [`${userRoot}/typescript.md`]: rule(
        'id: typescript\ninclude: ["src/**/*.ts"]\npriority: 4',
        "Use strict TypeScript.",
      ),
      [`${projectRulesRoot}/tests.md`]: rule(
        'id: tests\ninclude: ["**/*.test.ts"]',
        "Write behavior tests.",
      ),
    },
    reads,
  );
  const catalog = createRuleCatalog({
    storage,
    project,
    locations: {
      user: userRoot,
      project: projectRulesRoot,
      projectTrusted: true,
    },
  });

  const discovered = await catalog.discover();

  assert.deepEqual(
    discovered.rules.map(({ id, priority, source }) => ({
      id,
      priority,
      source: source.kind,
    })),
    [
      { id: "tests", priority: 0, source: "project" },
      { id: "typescript", priority: 4, source: "user" },
    ],
  );
  assert.deepEqual(discovered.diagnostics, []);
  assert.deepEqual(
    reads.map(({ kind }) => kind),
    ["frontmatter", "frontmatter"],
  );
});

test("activate lazily reads matching rules in specificity, priority, and source order once per epoch", async () => {
  const userRoot = path.resolve("C:/fixture/user-rules").replaceAll("\\", "/");
  const projectRulesRoot = `${projectRoot}/.pi/rules`;
  const reads: Array<{ kind: "frontmatter" | "content"; path: string }> = [];
  const storage = memoryStorage(
    {
      [`${userRoot}/general.md`]: rule(
        'id: general\ninclude: ["src/**/*.ts"]\npriority: 100',
        "General TypeScript rule.",
      ),
      [`${projectRulesRoot}/specific.md`]: rule(
        'id: specific\ninclude: ["src/domain/*.ts"]\npriority: -10',
        "Domain rule.",
      ),
      [`${projectRulesRoot}/excluded.md`]: rule(
        'id: excluded\ninclude: ["src/**/*.ts"]\nexclude: ["src/domain/**"]',
        "Must remain unread.",
      ),
    },
    reads,
  );
  const catalog = createRuleCatalog({
    storage,
    project,
    locations: {
      user: userRoot,
      project: projectRulesRoot,
      projectTrusted: true,
    },
  });
  await catalog.discover();

  const first = await catalog.activate({
    paths: ["src/domain/order.ts"],
    contextEpoch: "turn-1",
  });
  const repeated = await catalog.activate({
    paths: ["src/domain/order.ts"],
    contextEpoch: "turn-1",
  });
  const nextEpoch = await catalog.activate({
    paths: ["src/domain/order.ts"],
    contextEpoch: "turn-2",
  });

  assert.deepEqual(
    first.rules.map(({ id, content }) => ({ id, content })),
    [
      { id: "specific", content: "Domain rule." },
      { id: "general", content: "General TypeScript rule." },
    ],
  );
  assert.deepEqual(repeated.rules, []);
  assert.deepEqual(
    nextEpoch.rules.map(({ id }) => id),
    ["specific", "general"],
  );
  assert.deepEqual(
    reads
      .filter(({ kind }) => kind === "content")
      .map(({ path: filePath }) => path.basename(filePath)),
    ["specific.md", "general.md", "specific.md", "general.md"],
  );
  assert.deepEqual(
    catalog
      .inspect()
      .rules.map(({ id, active, reason }) => ({ id, active, reason })),
    [
      { id: "excluded", active: false, reason: "excluded by src/domain/**" },
      { id: "specific", active: true, reason: "matched src/domain/*.ts" },
      { id: "general", active: true, reason: "matched src/**/*.ts" },
    ],
  );
});

test("discover rejects each malformed, conflicting, and over-limit rule atomically", async () => {
  const userRoot = path.resolve("C:/fixture/user-rules").replaceAll("\\", "/");
  const projectRulesRoot = `${projectRoot}/.pi/rules`;
  const reads: Array<{ kind: "frontmatter" | "content"; path: string }> = [];
  const storage = memoryStorage(
    {
      [`${projectRulesRoot}/a-duplicate.md`]: rule(
        'id: duplicate\ninclude: ["src/**"]',
        "first",
      ),
      [`${projectRulesRoot}/b-duplicate.md`]: rule(
        'id: duplicate\ninclude: ["src/**"]',
        "second",
      ),
      [`${projectRulesRoot}/a-conflict.md`]: rule(
        'id: conflict\ninclude: ["src/**"]',
        "first",
      ),
      [`${userRoot}/b-conflict.md`]: rule(
        'id: conflict\ninclude: ["docs/**"]',
        "second",
      ),
      [`${projectRulesRoot}/bad-priority.md`]: rule(
        "id: bad-priority\npriority: 1.5",
        "bad",
      ),
      [`${projectRulesRoot}/too-many-patterns.md`]: rule(
        'id: too-many\ninclude: ["a", "b", "c"]',
        "bad",
      ),
      [`${projectRulesRoot}/too-large.md`]: rule(
        "id: too-large",
        "x".repeat(100),
      ),
      [`${projectRulesRoot}/pathological-glob.md`]: rule(
        'id: pathological-glob\ninclude: ["a*a*a*a*a*c"]',
        "bad",
      ),
      [`${projectRulesRoot}/valid.md`]: rule("id: valid", "valid"),
    },
    reads,
  );
  const catalog = createRuleCatalog({
    storage,
    project,
    locations: {
      user: userRoot,
      project: projectRulesRoot,
      projectTrusted: true,
    },
    limits: {
      maxContentBytes: 80,
      maxPatternsPerRule: 2,
    },
  });

  const discovered = await catalog.discover();

  assert.deepEqual(
    discovered.rules.map(({ id }) => id),
    ["valid"],
  );
  assert.deepEqual(
    [...new Set(discovered.diagnostics.map(({ code }) => code))].sort(),
    ["conflicting_rule_id", "duplicate_rule_id", "malformed_rule"],
  );
  assert.equal(
    reads.some(({ kind }) => kind === "content"),
    false,
  );
});

test("untrusted project locations are not read and reload replaces index and epoch state", async () => {
  const userRoot = path.resolve("C:/fixture/user-rules").replaceAll("\\", "/");
  const projectRulesRoot = `${projectRoot}/.pi/rules`;
  const reads: Array<{ kind: "frontmatter" | "content"; path: string }> = [];
  const files: Record<string, string> = {
    [`${userRoot}/user.md`]: rule('id: user\ninclude: ["src/**"]', "user-v1"),
    [`${projectRulesRoot}/project.md`]: rule("id: project", "untrusted"),
  };
  const catalog = createRuleCatalog({
    storage: memoryStorage(files, reads),
    project,
    locations: {
      user: userRoot,
      project: projectRulesRoot,
      projectTrusted: false,
    },
  });

  const discovered = await catalog.discover();
  const first = await catalog.activate({
    paths: ["src/a.ts"],
    contextEpoch: "same",
  });
  files[`${userRoot}/user.md`] = rule(
    'id: user\ninclude: ["src/**"]',
    "user-v2",
  );
  const reloaded = await catalog.reload();
  const afterReload = await catalog.activate({
    paths: ["src/a.ts"],
    contextEpoch: "same",
  });

  assert.deepEqual(
    discovered.rules.map(({ id }) => id),
    ["user"],
  );
  assert.equal(
    discovered.diagnostics.some(
      ({ code }) => code === "untrusted_project_rules_ignored",
    ),
    true,
  );
  assert.equal(
    reads.some(({ path: filePath }) => filePath.includes("/.pi/rules/")),
    false,
  );
  assert.equal(first.rules[0]?.content, "user-v1");
  assert.deepEqual(
    reloaded.rules.map(({ id }) => id),
    ["user"],
  );
  assert.equal(afterReload.rules[0]?.content, "user-v2");
});

test("activation matches renamed worktree-relative paths and rejects canonical escapes", async () => {
  const canonicalRoot = path
    .resolve("C:/canonical/worktree")
    .replaceAll("\\", "/");
  const requestedRoot = path
    .resolve("C:/aliases/worktree")
    .replaceAll("\\", "/");
  const projectRulesRoot = `${canonicalRoot}/.pi/rules`;
  const linkedProject: ResolvedProjectIdentity = {
    kind: "git",
    projectId: "git:fixture",
    requestedCwd: requestedRoot,
    canonicalCwd: canonicalRoot,
    cwdWasAliased: true,
    repositoryRoot: canonicalRoot,
    mainWorktree: path.resolve("C:/canonical/main").replaceAll("\\", "/"),
    commonGitDir: path.resolve("C:/canonical/main/.git").replaceAll("\\", "/"),
    currentWorktree: canonicalRoot,
    worktreeGitDir: path
      .resolve("C:/canonical/main/.git/worktrees/linked")
      .replaceAll("\\", "/"),
    bare: false,
  };
  const reads: Array<{ kind: "frontmatter" | "content"; path: string }> = [];
  const base = memoryStorage(
    {
      [`${projectRulesRoot}/legacy.md`]: rule(
        'id: legacy\ninclude: ["src/legacy/**"]',
        "Legacy rename guidance.",
      ),
    },
    reads,
  );
  const storage: RuleCatalogStorage = {
    ...base,
    async canonicalize(candidate) {
      const normalized = path.resolve(candidate).replaceAll("\\", "/");
      if (normalized.endsWith("/src/escape.ts")) {
        return path.resolve("C:/outside/escape.ts").replaceAll("\\", "/");
      }
      return base.canonicalize(candidate);
    },
  };
  const catalog = createRuleCatalog({
    storage,
    project: linkedProject,
    locations: { project: projectRulesRoot, projectTrusted: true },
  });
  await catalog.discover();

  const renamed = await catalog.activate({
    paths: [
      {
        path: `${requestedRoot}/src/current/name.ts`,
        renamedFrom: "src/legacy/name.ts",
      },
    ],
    contextEpoch: "rename",
  });
  const escaped = await catalog.activate({
    paths: ["src/escape.ts", "../outside.ts"],
    contextEpoch: "escape",
  });

  assert.deepEqual(
    renamed.rules.map(({ id }) => id),
    ["legacy"],
  );
  assert.deepEqual(escaped.rules, []);
  assert.equal(
    escaped.diagnostics.filter(
      ({ code }) => code === "activation_path_outside_project",
    ).length,
    2,
  );
});

test("relative activation resolves from session cwd while matching from worktree root", async () => {
  const worktree = path.resolve("C:/fixture/mono").replaceAll("\\", "/");
  const cwd = `${worktree}/packages/app`;
  const rulesRoot = `${worktree}/.pi/rules`;
  const reads: Array<{ kind: "frontmatter" | "content"; path: string }> = [];
  const catalog = createRuleCatalog({
    storage: memoryStorage(
      {
        [`${rulesRoot}/app.md`]: rule(
          'id: app\ninclude: ["packages/app/src/**"]',
          "App rule.",
        ),
      },
      reads,
    ),
    project: {
      kind: "git",
      projectId: "git:mono",
      requestedCwd: cwd,
      canonicalCwd: cwd,
      cwdWasAliased: false,
      repositoryRoot: worktree,
      mainWorktree: worktree,
      commonGitDir: `${worktree}/.git`,
      currentWorktree: worktree,
      worktreeGitDir: `${worktree}/.git`,
      bare: false,
    },
    locations: { project: rulesRoot, projectTrusted: true },
  });
  await catalog.discover();

  const relative = await catalog.activate({
    paths: ["src/index.ts"],
    contextEpoch: "relative",
  });
  const absolute = await catalog.activate({
    paths: [`${cwd}/src/index.ts`],
    contextEpoch: "absolute",
  });

  assert.deepEqual(
    relative.rules.map(({ id }) => id),
    ["app"],
  );
  assert.deepEqual(
    absolute.rules.map(({ id }) => id),
    ["app"],
  );
});

test("discovery enforces catalog file, frontmatter, content, and pattern limits", async () => {
  const projectRulesRoot = `${projectRoot}/.pi/rules`;
  const files: Record<string, string> = {
    [`${projectRulesRoot}/a-frontmatter.md`]: rule(
      `id: ${"a".repeat(100)}`,
      "body",
    ),
    [`${projectRulesRoot}/b-pattern.md`]: rule(
      'id: pattern\ninclude: ["src/**"]',
      "body",
    ),
    [`${projectRulesRoot}/c-never-indexed.md`]: rule("id: third", "body"),
  };
  const catalog = createRuleCatalog({
    storage: memoryStorage(files, []),
    project,
    locations: { project: projectRulesRoot, projectTrusted: true },
    limits: {
      maxFiles: 2,
      maxFrontmatterBytes: 64,
      maxContentBytes: 256,
      maxPatternsPerRule: 2,
      maxPatternBytes: 5,
    },
  });

  const discovered = await catalog.discover();

  assert.deepEqual(discovered.rules, []);
  assert.equal(
    discovered.diagnostics.some(({ code }) => code === "file_limit_exceeded"),
    true,
  );
  assert.equal(
    discovered.diagnostics.some(({ message }) =>
      message.includes("frontmatter exceeds"),
    ),
    true,
  );
  assert.equal(
    discovered.diagnostics.some(({ message }) =>
      message.includes("pattern exceeds"),
    ),
    true,
  );
});

test("equal-specificity rules use priority then project-before-user source ordering", async () => {
  const userRoot = path.resolve("C:/fixture/user-rules").replaceAll("\\", "/");
  const projectRulesRoot = `${projectRoot}/.pi/rules`;
  const catalog = createRuleCatalog({
    storage: memoryStorage(
      {
        [`${projectRulesRoot}/project.md`]: rule(
          'id: project\ninclude: ["*.ts"]\npriority: 5',
          "project",
        ),
        [`${userRoot}/user-peer.md`]: rule(
          'id: user-peer\ninclude: ["*.ts"]\npriority: 5',
          "user peer",
        ),
        [`${userRoot}/user-low.md`]: rule(
          'id: user-low\ninclude: ["*.ts"]\npriority: 4',
          "user low",
        ),
      },
      [],
    ),
    project,
    locations: {
      user: userRoot,
      project: projectRulesRoot,
      projectTrusted: true,
    },
  });
  await catalog.discover();

  const activated = await catalog.activate({
    paths: ["nested/example.ts"],
    contextEpoch: "ordering",
  });

  assert.deepEqual(
    activated.rules.map(({ id }) => id),
    ["project", "user-peer", "user-low"],
  );
});

test("one activation enforces aggregate rule-count and body-byte limits", async () => {
  const userRoot = path.resolve("C:/fixture/user-rules").replaceAll("\\", "/");
  const reads: Array<{ kind: "frontmatter" | "content"; path: string }> = [];
  const files = Object.fromEntries(
    ["a", "b", "c"].map((id) => [
      `${userRoot}/${id}.md`,
      rule(`id: ${id}\ninclude: ["src/**"]`, id.repeat(20)),
    ]),
  );
  const catalog = createRuleCatalog({
    storage: memoryStorage(files, reads),
    project,
    locations: { user: userRoot, projectTrusted: false },
    limits: { maxActivationRules: 2, maxActivationBytes: 64 },
  });
  await catalog.discover();

  const activation = await catalog.activate({
    paths: ["src/index.ts"],
    contextEpoch: "bounded",
  });

  assert.equal(activation.rules.length, 2);
  assert.ok(
    activation.diagnostics.some(
      ({ code }) => code === "activation_limit_exceeded",
    ),
  );
  assert.ok(
    Buffer.byteLength(
      activation.rules.map(({ content }) => content).join(""),
    ) <= 64,
  );
});

test("parallel activations inject a matching rule once per context epoch", async () => {
  const projectRulesRoot = `${projectRoot}/.pi/rules`;
  const reads: Array<{ kind: "frontmatter" | "content"; path: string }> = [];
  const catalog = createRuleCatalog({
    storage: memoryStorage(
      {
        [`${projectRulesRoot}/parallel.md`]: rule(
          'id: parallel\ninclude: ["src/**"]',
          "once",
        ),
      },
      reads,
    ),
    project,
    locations: { project: projectRulesRoot, projectTrusted: true },
  });
  await catalog.discover();

  const activations = await Promise.all([
    catalog.activate({ paths: ["src/a.ts"], contextEpoch: "parallel" }),
    catalog.activate({ paths: ["src/b.ts"], contextEpoch: "parallel" }),
  ]);

  assert.equal(activations.flatMap(({ rules }) => rules).length, 1);
  assert.equal(reads.filter(({ kind }) => kind === "content").length, 1);
});
