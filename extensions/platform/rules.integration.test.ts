import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ResolvedProjectIdentity } from "./src/core/projects/index.ts";
import { createFileSystemRuleCatalog } from "./src/rules/filesystem.ts";

function normalized(filePath: string) {
  return path.resolve(filePath).replaceAll("\\", "/");
}

function markdown(frontmatter: string, body: string) {
  return `---\n${frontmatter}\n---\n${body}`;
}

async function identity(root: string): Promise<ResolvedProjectIdentity> {
  const canonicalRoot = normalized(await realpath(root));
  return {
    kind: "non-git",
    projectId: "non-git:filesystem-fixture",
    requestedCwd: normalized(root),
    canonicalCwd: canonicalRoot,
    cwdWasAliased: normalized(root) !== canonicalRoot,
  };
}

async function detachDirectoryLink(link: string) {
  if (process.platform === "win32") await rmdir(link);
  else await unlink(link);
}

test("filesystem catalog delays full Markdown validation until matching activation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-rules-lazy-"));
  const rulesRoot = path.join(directory, ".pi", "rules");
  const rulePath = path.join(rulesRoot, "typescript.md");
  await mkdir(rulesRoot, { recursive: true });
  await writeFile(
    rulePath,
    markdown('id: typescript\ninclude: ["src/**"]', "version one"),
  );
  try {
    const catalog = createFileSystemRuleCatalog({
      project: await identity(directory),
      locations: { project: rulesRoot, projectTrusted: true },
    });

    const discovered = await catalog.discover();
    await writeFile(
      rulePath,
      markdown('id: typescript\ninclude: ["src/**"]', "version two"),
    );
    const activated = await catalog.activate({
      paths: ["src/index.ts"],
      contextEpoch: "turn-1",
    });

    assert.deepEqual(discovered.diagnostics, []);
    assert.deepEqual(
      discovered.rules.map(({ id }) => id),
      ["typescript"],
    );
    assert.equal(discovered.rules[0]?.source.trust, "trusted-project");
    assert.equal(activated.rules[0]?.content, "version two");

    await writeFile(
      rulePath,
      markdown(
        'id: typescript\ninclude: ["src/**"]\npriority: 1',
        "changed metadata",
      ),
    );
    const changedWithoutReload = await catalog.activate({
      paths: ["src/index.ts"],
      contextEpoch: "turn-2",
    });
    assert.deepEqual(changedWithoutReload.rules, []);
    assert.equal(
      changedWithoutReload.diagnostics[0]?.code,
      "rule_activation_failed",
    );

    await catalog.reload();
    const changedAfterReload = await catalog.activate({
      paths: ["src/index.ts"],
      contextEpoch: "turn-2",
    });
    assert.equal(changedAfterReload.rules[0]?.content, "changed metadata");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("filesystem catalog rejects traversal and native directory-link bypasses", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-rules-containment-"));
  const projectRoot = path.join(directory, "project");
  const external = path.join(directory, "external");
  const linkedRules = path.join(projectRoot, ".pi", "rules");
  await mkdir(path.dirname(linkedRules), { recursive: true });
  await mkdir(external, { recursive: true });
  await writeFile(
    path.join(external, "escape.md"),
    markdown("id: escape", "escape"),
  );
  await symlink(
    external,
    linkedRules,
    process.platform === "win32" ? "junction" : "dir",
  );
  try {
    const catalog = createFileSystemRuleCatalog({
      project: await identity(projectRoot),
      locations: { project: linkedRules, projectTrusted: true },
    });

    const discovered = await catalog.discover();

    assert.deepEqual(discovered.rules, []);
    assert.equal(discovered.diagnostics[0]?.code, "unsafe_project_source");
  } finally {
    await detachDirectoryLink(linkedRules);
    await rm(directory, { recursive: true, force: true });
  }
});

test("filesystem activation canonicalizes path parents before pattern matching", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-rules-paths-"));
  const projectRoot = path.join(directory, "project");
  const rulesRoot = path.join(projectRoot, ".pi", "rules");
  const external = path.join(directory, "external");
  const linked = path.join(projectRoot, "linked");
  await mkdir(rulesRoot, { recursive: true });
  await mkdir(external, { recursive: true });
  await writeFile(
    path.join(rulesRoot, "linked.md"),
    markdown('id: linked\ninclude: ["linked/**"]', "must not activate"),
  );
  await symlink(
    external,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  try {
    const catalog = createFileSystemRuleCatalog({
      project: await identity(projectRoot),
      locations: { project: rulesRoot, projectTrusted: true },
    });
    await catalog.discover();

    const activated = await catalog.activate({
      paths: ["linked/missing.ts", "../external/missing.ts"],
      contextEpoch: "turn",
    });

    assert.deepEqual(activated.rules, []);
    assert.equal(
      activated.diagnostics.filter(
        ({ code }) => code === "activation_path_outside_project",
      ).length,
      2,
    );
  } finally {
    await detachDirectoryLink(linked);
    await rm(directory, { recursive: true, force: true });
  }
});
