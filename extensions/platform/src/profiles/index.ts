import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import type {
  ProfileBackend,
  ProfileEffort,
  ProfileScope,
  ResolvedAgentProfile,
  WorkspacePolicy,
} from "../../../shared/agent-profile.ts";
import {
  failure,
  success,
  type ModuleError,
  type Outcome,
} from "../core/result.ts";

export type {
  ProfileBackend,
  ProfileEffort,
  ProfileScope,
  ResolvedAgentProfile,
  WorkspacePolicy,
} from "../../../shared/agent-profile.ts";

const PROFILE_CONFIG_MAX_BYTES = 64 * 1024;
const PROFILE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const BACKENDS = new Set(["pi", "claude", "codex"]);
const EFFORTS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const ROLES = new Set([
  "subagent",
  "workflow",
  "review",
  "scheduled",
  "goal-worker",
]);

export interface ProfileDiagnostic {
  readonly severity: "error" | "warning" | "info";
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly name?: string;
}

export interface ProfileCatalogSnapshot {
  readonly generation: number;
  readonly profiles: readonly ResolvedAgentProfile[];
  readonly diagnostics: readonly ProfileDiagnostic[];
}

export interface ProfileCatalogError extends ModuleError<
  "PROFILE_NOT_FOUND" | "PROFILE_INVALID"
> {}

export interface ProfileCatalog {
  reload(context: {
    readonly projectRoot: string;
    readonly projectTrusted: boolean;
  }): Promise<ProfileCatalogSnapshot>;
  inspect(): ProfileCatalogSnapshot;
  list(): readonly ResolvedAgentProfile[];
  resolve(name: string): Outcome<ResolvedAgentProfile, ProfileCatalogError>;
  diagnostics(): readonly ProfileDiagnostic[];
}

export interface ProfileCatalogOptions {
  readonly agentDir: string;
  readonly managedProfiles?: readonly {
    readonly path: string;
    readonly root: string;
  }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function measurePlainData(value: unknown) {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes++;
    if (nodes > 2_048) throw new Error("Profile YAML exceeds 2048 nodes.");
    if (current.depth > 32) throw new Error("Profile YAML exceeds depth 32.");
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    } else if (isRecord(current.value)) {
      for (const child of Object.values(current.value)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function strings(value: unknown, field: string, optional = false) {
  if (value === undefined && optional) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
  const result = value.map((item) => item.trim());
  if (result.some((item) => item.length === 0 || item.length > 256)) {
    throw new Error(`${field} entries must be non-empty and bounded.`);
  }
  if (new Set(result).size !== result.length) {
    throw new Error(`${field} entries must be unique.`);
  }
  return result;
}

async function readProfileMaterial(
  sourceDirectory: string,
  relativePath: string,
  kind: "instruction" | "skill",
) {
  if (
    relativePath.includes("\0") ||
    path.isAbsolute(relativePath) ||
    relativePath.length > 4_096
  ) {
    throw new Error(`${kind} path must be a bounded relative path.`);
  }
  const requested = path.resolve(sourceDirectory, relativePath);
  const before = await lstat(requested);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > PROFILE_CONFIG_MAX_BYTES
  ) {
    throw new Error(`${kind} path must be a bounded regular file, not a link.`);
  }
  const canonicalRoot = await realpath(sourceDirectory);
  const canonicalPath = await realpath(requested);
  const nested = path.relative(canonicalRoot, canonicalPath);
  if (
    nested === ".." ||
    nested.startsWith(`..${path.sep}`) ||
    path.isAbsolute(nested)
  ) {
    throw new Error(`${kind} path resolves outside the profile source.`);
  }
  const handle = await open(
    canonicalPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > PROFILE_CONFIG_MAX_BYTES
    ) {
      throw new Error(`${kind} path identity changed before open.`);
    }
    const content = await handle.readFile("utf8");
    const after = await lstat(requested);
    if (
      after.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      (await realpath(requested)) !== canonicalPath
    ) {
      throw new Error(`${kind} path identity changed during read.`);
    }
    return { path: requested, content };
  } finally {
    await handle.close();
  }
}

function optionalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
) {
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(
      `${field} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value as number;
}

async function decodeProfile(
  value: unknown,
  source: { scope: ProfileScope; path: string },
  sourceText: string,
  generation: number,
): Promise<ResolvedAgentProfile> {
  measurePlainData(value);
  if (!isRecord(value)) throw new Error("Profile must be an object.");
  const allowedFields = new Set([
    "name",
    "description",
    "backend",
    "model",
    "effort",
    "instructions",
    "skills",
    "allowedTools",
    "disallowedTools",
    "maxTurns",
    "timeoutMs",
    "workspacePolicy",
    "role",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowedFields.has(key));
  if (unknown.length > 0)
    throw new Error(`Unknown profile field ${JSON.stringify(unknown[0])}.`);
  if (typeof value.name !== "string" || !PROFILE_NAME.test(value.name)) {
    throw new Error("name must use lowercase letters, digits, and hyphens.");
  }
  if (
    typeof value.description !== "string" ||
    value.description.trim().length === 0 ||
    value.description.length > 1_024
  ) {
    throw new Error("description must be a non-empty bounded string.");
  }
  if (typeof value.backend !== "string" || !BACKENDS.has(value.backend)) {
    throw new Error("backend must be pi, claude, or codex.");
  }
  if (
    value.model !== undefined &&
    (typeof value.model !== "string" ||
      value.model.length === 0 ||
      value.model.length > 256)
  ) {
    throw new Error("model must be a bounded string.");
  }
  if (value.effort !== undefined && !EFFORTS.has(String(value.effort))) {
    throw new Error("effort is invalid.");
  }
  if (!isRecord(value.instructions)) {
    throw new Error("instructions must be an object.");
  }
  const instructionUnknown = Object.keys(value.instructions).filter(
    (key) => !["inline", "files"].includes(key),
  );
  if (instructionUnknown.length > 0) {
    throw new Error(
      `Unknown instructions field ${JSON.stringify(instructionUnknown[0])}.`,
    );
  }
  const inline = value.instructions.inline;
  if (
    inline !== undefined &&
    (typeof inline !== "string" ||
      inline.length === 0 ||
      inline.length > 64 * 1024)
  ) {
    throw new Error("instructions.inline must be a bounded string.");
  }
  const instructionFiles =
    strings(value.instructions.files, "instructions.files", true) ?? [];
  const skillFiles = strings(value.skills, "skills") ?? [];
  if (instructionFiles.length > 16 || skillFiles.length > 16) {
    throw new Error(
      "A profile may reference at most 16 instruction or skill files.",
    );
  }
  const sourceDirectory = path.dirname(source.path);
  const resolvedInstructionFiles = await Promise.all(
    instructionFiles.map((file) =>
      readProfileMaterial(sourceDirectory, file, "instruction"),
    ),
  );
  const skills = await Promise.all(
    skillFiles.map(async (file) => {
      const material = await readProfileMaterial(
        sourceDirectory,
        file,
        "skill",
      );
      return { path: material.path, content: material.content };
    }),
  );
  const allowedTools = strings(value.allowedTools, "allowedTools", true);
  const disallowedTools =
    strings(value.disallowedTools, "disallowedTools", true) ?? [];
  if (allowedTools?.some((tool) => disallowedTools.includes(tool))) {
    throw new Error("allowedTools and disallowedTools must not overlap.");
  }
  const workspacePolicy = value.workspacePolicy ?? "isolated";
  if (workspacePolicy !== "isolated" && workspacePolicy !== "current") {
    throw new Error("workspacePolicy must be isolated or current.");
  }
  const role = value.role ?? "subagent";
  if (typeof role !== "string" || !ROLES.has(role)) {
    throw new Error("role is invalid.");
  }
  const instructions = [
    ...(inline === undefined ? [] : [inline]),
    ...resolvedInstructionFiles.map((material) => material.content),
  ];
  const maxTurns = optionalInteger(value.maxTurns, "maxTurns", 1, 10_000);
  const timeoutMs = optionalInteger(
    value.timeoutMs,
    "timeoutMs",
    1_000,
    86_400_000,
  );
  const promptBytes = Buffer.byteLength(
    [...instructions, ...skills.map((skill) => skill.content)].join("\0"),
    "utf8",
  );
  if (promptBytes > 256 * 1024) {
    throw new Error("Profile instruction and skill content exceeds 256KB.");
  }
  const contentDigest = createHash("sha256")
    .update(sourceText)
    .update("\0")
    .update(JSON.stringify({ instructions, skills }))
    .digest("hex");
  return Object.freeze({
    description: value.description.trim(),
    identity: Object.freeze({
      name: value.name,
      contentDigest,
      catalogGeneration: generation,
      source: Object.freeze(source),
    }),
    defaults: Object.freeze({
      backend: value.backend as ProfileBackend,
      ...(typeof value.model === "string" ? { model: value.model } : {}),
      ...(typeof value.effort === "string"
        ? { effort: value.effort as ProfileEffort }
        : {}),
    }),
    policy: Object.freeze({
      role: role as ResolvedAgentProfile["policy"]["role"],
      instructions: Object.freeze(instructions),
      skills: Object.freeze(skills.map((skill) => Object.freeze({ ...skill }))),
      tools: Object.freeze({
        ...(allowedTools ? { allowed: Object.freeze([...allowedTools]) } : {}),
        denied: Object.freeze([...disallowedTools]),
      }),
      limits: Object.freeze({
        ...(maxTurns === undefined ? {} : { maxTurns }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }),
      workspace: workspacePolicy as WorkspacePolicy,
    }),
  });
}

async function loadProfileSource(
  sourcePath: string,
  scope: ProfileScope,
  root: string,
  diagnostics: ProfileDiagnostic[],
  generation: number,
) {
  try {
    const before = await lstat(sourcePath);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > PROFILE_CONFIG_MAX_BYTES
    ) {
      throw new Error(
        "Profile source must be a bounded regular file, not a link.",
      );
    }
    const canonicalRoot = await realpath(root);
    const canonicalSource = await realpath(sourcePath);
    const nested = path.relative(canonicalRoot, canonicalSource);
    if (
      nested === ".." ||
      nested.startsWith(`..${path.sep}`) ||
      path.isAbsolute(nested)
    ) {
      throw new Error("Profile source resolves outside its trusted root.");
    }
    const handle = await open(
      canonicalSource,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    let text: string;
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size > PROFILE_CONFIG_MAX_BYTES
      ) {
        throw new Error("Profile source identity changed before open.");
      }
      text = await handle.readFile("utf8");
      const after = await lstat(sourcePath);
      if (
        after.isSymbolicLink() ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        (await realpath(sourcePath)) !== canonicalSource
      ) {
        throw new Error("Profile source identity changed during read.");
      }
    } finally {
      await handle.close();
    }
    const document = parseDocument(text, { prettyErrors: false });
    if (document.errors.length > 0) throw document.errors[0];
    return await decodeProfile(
      document.toJS({ maxAliasCount: 0 }),
      { scope, path: canonicalSource },
      text,
      generation,
    );
  } catch (error) {
    diagnostics.push({
      severity: "error",
      code: "invalid-profile",
      path: sourcePath,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function loadDirectory(
  directory: string,
  scope: ProfileScope,
  trustedRoot: string,
  diagnostics: ProfileDiagnostic[],
  generation: number,
) {
  let entries;
  try {
    const directoryMetadata = await lstat(directory);
    if (
      !directoryMetadata.isDirectory() ||
      directoryMetadata.isSymbolicLink()
    ) {
      throw new Error("Profile directory must be a directory, not a link.");
    }
    const canonicalRoot = await realpath(trustedRoot);
    const canonicalDirectory = await realpath(directory);
    const nested = path.relative(canonicalRoot, canonicalDirectory);
    if (
      nested === ".." ||
      nested.startsWith(`..${path.sep}`) ||
      path.isAbsolute(nested)
    ) {
      throw new Error("Profile directory resolves outside its trusted root.");
    }
    entries = await readdir(directory, { withFileTypes: true });
    const profileEntries = entries.filter((candidate) =>
      /\.ya?ml$/i.test(candidate.name),
    );
    if (profileEntries.length > 128) {
      throw new Error("Profile directory exceeds 128 YAML files.");
    }
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    diagnostics.push({
      severity: "error",
      code: "profile-directory-unavailable",
      path: directory,
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  const profiles: ResolvedAgentProfile[] = [];
  for (const entry of entries
    .filter((candidate) => /\.ya?ml$/i.test(candidate.name))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const sourcePath = path.join(directory, entry.name);
    if (!entry.isFile()) {
      diagnostics.push({
        severity: "error",
        code: "invalid-profile",
        path: sourcePath,
        message: "Profile source must be a regular file.",
      });
      continue;
    }
    const profile = await loadProfileSource(
      sourcePath,
      scope,
      trustedRoot,
      diagnostics,
      generation,
    );
    if (profile) profiles.push(profile);
  }
  return profiles;
}

function rejectScopeCollisions(
  candidates: readonly ResolvedAgentProfile[],
  diagnostics: ProfileDiagnostic[],
) {
  const counts = new Map<string, ResolvedAgentProfile[]>();
  for (const profile of candidates) {
    const name = profile.identity.name;
    const group = counts.get(name) ?? [];
    group.push(profile);
    counts.set(name, group);
  }
  const accepted: ResolvedAgentProfile[] = [];
  for (const [name, group] of counts) {
    if (group.length === 1) {
      accepted.push(group[0]!);
      continue;
    }
    diagnostics.push({
      severity: "error",
      code: "profile-name-collision",
      path: group.map((profile) => profile.identity.source.path).join(", "),
      name,
      message: `Profile name ${JSON.stringify(name)} is defined more than once in ${group[0]!.identity.source.scope} scope.`,
    });
  }
  return accepted;
}

export function createProfileCatalog(
  options: ProfileCatalogOptions,
): ProfileCatalog {
  let profiles: readonly ResolvedAgentProfile[] = [];
  let currentDiagnostics: readonly ProfileDiagnostic[] = [];
  let generation = 0;
  return {
    async reload(context) {
      const diagnostics: ProfileDiagnostic[] = [];
      const nextGeneration = generation + 1;
      const user = await loadDirectory(
        path.join(options.agentDir, "agents"),
        "user",
        options.agentDir,
        diagnostics,
        nextGeneration,
      );
      const project = context.projectTrusted
        ? await loadDirectory(
            path.join(context.projectRoot, ".pi", "agents"),
            "project",
            context.projectRoot,
            diagnostics,
            nextGeneration,
          )
        : [];
      const managed: ResolvedAgentProfile[] = [];
      for (const source of options.managedProfiles ?? []) {
        const profile = await loadProfileSource(
          path.resolve(source.path),
          "managed",
          path.resolve(source.root),
          diagnostics,
          nextGeneration,
        );
        if (profile) managed.push(profile);
      }
      const byName = new Map<string, ResolvedAgentProfile>();
      for (const profile of [
        ...rejectScopeCollisions(user, diagnostics),
        ...rejectScopeCollisions(project, diagnostics),
        ...rejectScopeCollisions(managed, diagnostics),
      ]) {
        const shadowed = byName.get(profile.identity.name);
        if (shadowed) {
          diagnostics.push({
            severity: "info",
            code: "profile-shadowed",
            path: shadowed.identity.source.path,
            name: profile.identity.name,
            message: `${shadowed.identity.source.scope} profile is shadowed by ${profile.identity.source.scope} precedence.`,
          });
        }
        byName.set(profile.identity.name, profile);
      }
      profiles = Object.freeze(
        [...byName.values()].sort((a, b) =>
          a.identity.name.localeCompare(b.identity.name),
        ),
      );
      currentDiagnostics = Object.freeze(diagnostics);
      generation = nextGeneration;
      return { generation, profiles, diagnostics: currentDiagnostics };
    },
    inspect: () => ({ generation, profiles, diagnostics: currentDiagnostics }),
    list: () => profiles,
    resolve(name) {
      const profile = profiles.find(
        (candidate) => candidate.identity.name === name,
      );
      return profile
        ? success(profile)
        : failure({
            code: "PROFILE_NOT_FOUND",
            message: `Profile ${JSON.stringify(name)} was not found.`,
            retryable: false,
          });
    },
    diagnostics: () => currentDiagnostics,
  };
}
