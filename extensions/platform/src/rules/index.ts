import path from "node:path";
import { minimatch } from "minimatch";
import { isCollection, isPair, parseDocument } from "yaml";
import type { ResolvedProjectIdentity } from "../core/projects/index.ts";

export const MAX_RULE_ACTIVATION_PATHS = 32;

export interface RuleCatalogStorage {
  listMarkdownFiles(root: string, limit: number): Promise<readonly string[]>;
  canonicalize(candidate: string): Promise<string>;
  readFrontmatter(
    filePath: string,
    limit: number,
  ): Promise<{ readonly prefix: string; readonly size: number }>;
  readContent(filePath: string, limit: number): Promise<string>;
}

export interface RuleSource {
  readonly kind: "user" | "project";
  readonly trust: "user" | "trusted-project" | "untrusted-project";
  readonly path: string;
}

export interface RuleMetadata {
  readonly id: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly priority: number;
  readonly source: RuleSource;
}

export interface RuleDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly source?: RuleSource;
  readonly ruleId?: string;
}

export interface RuleDiscovery {
  readonly rules: readonly RuleMetadata[];
  readonly diagnostics: readonly RuleDiagnostic[];
}

export interface RuleActivation {
  readonly rules: ReadonlyArray<RuleMetadata & { readonly content: string }>;
  readonly diagnostics: readonly RuleDiagnostic[];
}

export interface RuleInspection {
  readonly rules: ReadonlyArray<
    RuleMetadata & { readonly active: boolean; readonly reason: string }
  >;
  readonly diagnostics: readonly RuleDiagnostic[];
}

export interface RuleCatalog {
  discover(): Promise<RuleDiscovery>;
  activate(input: {
    readonly paths: ReadonlyArray<
      string | { readonly path: string; readonly renamedFrom?: string }
    >;
    readonly contextEpoch: string;
  }): Promise<RuleActivation>;
  inspect(): RuleInspection;
  reload(): Promise<RuleDiscovery>;
}

export interface RuleCatalogOptions {
  readonly storage: RuleCatalogStorage;
  readonly project: ResolvedProjectIdentity;
  readonly locations: {
    readonly user?: string;
    readonly project?: string;
    readonly projectTrusted: boolean;
  };
  readonly limits?: Partial<RuleCatalogLimits>;
}

export interface RuleCatalogLimits {
  readonly maxFiles: number;
  readonly maxFrontmatterBytes: number;
  readonly maxContentBytes: number;
  readonly maxPatternsPerRule: number;
  readonly maxPatternBytes: number;
  readonly maxActivationRules: number;
  readonly maxActivationBytes: number;
}

const DEFAULT_LIMITS: RuleCatalogLimits = {
  maxFiles: 128,
  maxFrontmatterBytes: 16 * 1024,
  maxContentBytes: 128 * 1024,
  maxPatternsPerRule: 32,
  maxPatternBytes: 256,
  maxActivationRules: 16,
  maxActivationBytes: 256 * 1024,
};

const SOURCE_ORDER: Record<RuleSource["kind"], number> = {
  project: 0,
  user: 1,
};

function resolveLimits(input: Partial<RuleCatalogLimits> | undefined) {
  const bounded = (value: number | undefined, maximum: number) => {
    if (value === undefined) return maximum;
    if (!Number.isInteger(value) || value < 1) {
      throw new Error("Rule catalog limits must be positive integers");
    }
    return Math.min(value, maximum);
  };
  return {
    maxFiles: bounded(input?.maxFiles, DEFAULT_LIMITS.maxFiles),
    maxFrontmatterBytes: bounded(
      input?.maxFrontmatterBytes,
      DEFAULT_LIMITS.maxFrontmatterBytes,
    ),
    maxContentBytes: bounded(
      input?.maxContentBytes,
      DEFAULT_LIMITS.maxContentBytes,
    ),
    maxPatternsPerRule: bounded(
      input?.maxPatternsPerRule,
      DEFAULT_LIMITS.maxPatternsPerRule,
    ),
    maxPatternBytes: bounded(
      input?.maxPatternBytes,
      DEFAULT_LIMITS.maxPatternBytes,
    ),
    maxActivationRules: bounded(
      input?.maxActivationRules,
      DEFAULT_LIMITS.maxActivationRules,
    ),
    maxActivationBytes: bounded(
      input?.maxActivationBytes,
      DEFAULT_LIMITS.maxActivationBytes,
    ),
  };
}

function normalizePath(filePath: string) {
  return path.resolve(filePath).replaceAll("\\", "/");
}

function projectRoot(project: ResolvedProjectIdentity) {
  if (project.kind === "git") return project.currentWorktree;
  return project.canonicalCwd;
}

function comparisonPath(filePath: string) {
  const normalized = normalizePath(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isContained(root: string, candidate: string) {
  const comparedRoot = comparisonPath(root).replace(/\/$/, "");
  const comparedCandidate = comparisonPath(candidate);
  return (
    comparedCandidate === comparedRoot ||
    comparedCandidate.startsWith(`${comparedRoot}/`)
  );
}

function compareText(left: string, right: string) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sourceFor(kind: RuleSource["kind"], filePath: string): RuleSource {
  return {
    kind,
    trust: kind === "user" ? "user" : "trusted-project",
    path: normalizePath(filePath),
  };
}

function malformed(source: RuleSource, message: string): RuleDiagnostic {
  return { code: "malformed_rule", message, source };
}

function stringArray(value: unknown, field: string, limits: RuleCatalogLimits) {
  if (value === undefined) return field === "include" ? ["**/*"] : [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  if (value.length > limits.maxPatternsPerRule) {
    throw new Error(
      `${field} exceeds ${limits.maxPatternsPerRule} pattern limit`,
    );
  }
  for (const pattern of value) {
    if (Buffer.byteLength(pattern) > limits.maxPatternBytes) {
      throw new Error(
        `${field} pattern exceeds ${limits.maxPatternBytes} bytes`,
      );
    }
    if (
      pattern.length === 0 ||
      /[\0\r\n]/.test(pattern) ||
      pattern.startsWith("!") ||
      pattern.includes("\\") ||
      path.posix.isAbsolute(pattern) ||
      /^[a-z]:\//i.test(pattern) ||
      pattern.split("/").includes("..") ||
      pattern
        .split("/")
        .some(
          (segment: string) =>
            segment !== "**" && (segment.match(/\*/g)?.length ?? 0) > 1,
        )
    ) {
      throw new Error(
        `${field} contains unsafe pattern ${JSON.stringify(pattern)}`,
      );
    }
  }
  return [...value];
}

function frontmatterBoundary(markdown: string, limits: RuleCatalogLimits) {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    throw new Error("Markdown rule must begin with YAML frontmatter");
  }
  const contentStart = markdown.startsWith("---\r\n") ? 5 : 4;
  const closing = /\r?\n---(?:\r?\n|$)/g;
  closing.lastIndex = contentStart;
  const match = closing.exec(markdown);
  if (!match || match.index > limits.maxFrontmatterBytes) {
    throw new Error(
      `YAML frontmatter exceeds ${limits.maxFrontmatterBytes} byte limit or is unterminated`,
    );
  }
  return {
    yamlStart: contentStart,
    yamlEnd: match.index,
    bodyStart: closing.lastIndex,
  };
}

function assertBoundedYaml(root: unknown) {
  const pending = [{ node: root, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > 256) throw new Error("YAML frontmatter exceeds 256 node limit");
    if (current.depth > 4) {
      throw new Error("YAML frontmatter exceeds depth limit of 4");
    }
    if (isPair(current.node)) {
      pending.push(
        { node: current.node.key, depth: current.depth + 1 },
        { node: current.node.value, depth: current.depth + 1 },
      );
    } else if (isCollection(current.node)) {
      for (const item of current.node.items) {
        pending.push({ node: item, depth: current.depth + 1 });
      }
    }
  }
}

function parseMetadata(
  prefix: string,
  source: RuleSource,
  limits: RuleCatalogLimits,
): RuleMetadata {
  const boundary = frontmatterBoundary(prefix, limits);
  const yaml = prefix.slice(boundary.yamlStart, boundary.yamlEnd);
  if (Buffer.byteLength(yaml) > limits.maxFrontmatterBytes) {
    throw new Error(
      `YAML frontmatter exceeds ${limits.maxFrontmatterBytes} bytes`,
    );
  }
  const document = parseDocument(yaml, {
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(document.errors[0]?.message ?? "Invalid YAML frontmatter");
  }
  assertBoundedYaml(document.contents);
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("YAML frontmatter must be a mapping");
  }
  const fields = value as Record<string, unknown>;
  const unknown = Object.keys(fields).filter(
    (key) => !["id", "include", "exclude", "priority"].includes(key),
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown frontmatter field ${JSON.stringify(unknown[0])}`);
  }
  if (
    typeof fields.id !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(fields.id)
  ) {
    throw new Error(
      "id must be 1-128 letters, digits, dots, underscores, or hyphens",
    );
  }
  const priority = fields.priority ?? 0;
  if (
    typeof priority !== "number" ||
    !Number.isInteger(priority) ||
    priority < -1000 ||
    priority > 1000
  ) {
    throw new Error("priority must be an integer from -1000 through 1000");
  }
  const include = stringArray(fields.include, "include", limits);
  const exclude = stringArray(fields.exclude, "exclude", limits);
  if (include.length + exclude.length > limits.maxPatternsPerRule) {
    throw new Error(
      `Rule exceeds ${limits.maxPatternsPerRule} total pattern limit`,
    );
  }
  return {
    id: fields.id,
    include,
    exclude,
    priority,
    source,
  };
}

function patternSpecificity(pattern: string) {
  const segments = pattern.split("/");
  const literalSegments = segments.filter(
    (segment) => !/[?*\[\]{}()!+@]/.test(segment),
  ).length;
  const literalCharacters = pattern.replace(/[?*\[\]{}()!+@]/g, "").length;
  const wildcardCharacters = pattern.length - literalCharacters;
  return (
    literalSegments * 10_000 +
    literalCharacters * 100 +
    segments.length * 10 -
    wildcardCharacters
  );
}

function matchingPattern(patterns: readonly string[], relativePath: string) {
  return patterns
    .filter((pattern) => {
      const rooted = pattern.startsWith("/");
      let normalizedPattern = pattern.replace(/^\//, "");
      if (normalizedPattern.endsWith("/")) normalizedPattern += "**";
      return minimatch(relativePath, normalizedPattern, {
        dot: true,
        matchBase: !rooted && !normalizedPattern.includes("/"),
        nocase: process.platform === "win32",
        windowsPathsNoEscape: true,
        nocomment: true,
        nonegate: true,
        nobrace: true,
        noext: true,
      });
    })
    .sort(
      (left, right) =>
        patternSpecificity(right) - patternSpecificity(left) ||
        compareText(left, right),
    )[0];
}

function sameMetadata(left: RuleMetadata, right: RuleMetadata) {
  return (
    left.id === right.id &&
    left.priority === right.priority &&
    JSON.stringify(left.include) === JSON.stringify(right.include) &&
    JSON.stringify(left.exclude) === JSON.stringify(right.exclude)
  );
}

function rejectDuplicateIds(
  rules: RuleMetadata[],
  diagnostics: RuleDiagnostic[],
) {
  const byId = new Map<string, RuleMetadata[]>();
  for (const rule of rules) {
    const group = byId.get(rule.id) ?? [];
    group.push(rule);
    byId.set(rule.id, group);
  }
  const rejected = new Set<string>();
  for (const [ruleId, group] of byId) {
    if (group.length < 2) continue;
    rejected.add(ruleId);
    const duplicate = group.every((rule) => sameMetadata(rule, group[0]!));
    diagnostics.push({
      code: duplicate ? "duplicate_rule_id" : "conflicting_rule_id",
      message: duplicate
        ? `Duplicate rule id ${JSON.stringify(ruleId)}`
        : `Conflicting metadata for rule id ${JSON.stringify(ruleId)}`,
      ruleId,
    });
  }
  return rules.filter((rule) => !rejected.has(rule.id));
}

export function createRuleCatalog(options: RuleCatalogOptions): RuleCatalog {
  const limits = resolveLimits(options.limits);
  let indexed: RuleMetadata[] = [];
  let diagnostics: RuleDiagnostic[] = [];
  let inspectionReasons = new Map<
    string,
    { active: boolean; reason: string }
  >();
  let injectedByEpoch = new Map<string, Set<string>>();
  let operationQueue = Promise.resolve();

  async function exclusive<T>(operation: () => Promise<T>) {
    const previous = operationQueue;
    let release = () => {};
    operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async function discoverUnlocked() {
    const nextRules: RuleMetadata[] = [];
    const nextDiagnostics: RuleDiagnostic[] = [];
    const roots: Array<{ kind: RuleSource["kind"]; root: string }> = [];
    if (options.locations.project && options.locations.projectTrusted) {
      roots.push({ kind: "project", root: options.locations.project });
    } else if (options.locations.project) {
      nextDiagnostics.push({
        code: "untrusted_project_rules_ignored",
        message: "Project rules ignored because project is not trusted",
        source: {
          kind: "project",
          trust: "untrusted-project",
          path: normalizePath(options.locations.project),
        },
      });
    }
    if (options.locations.user) {
      roots.push({ kind: "user", root: options.locations.user });
    }

    let remainingFiles = limits.maxFiles;
    for (const input of roots) {
      let canonicalRoot: string;
      try {
        canonicalRoot = await options.storage.canonicalize(input.root);
      } catch (error) {
        nextDiagnostics.push({
          code: "source_unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (
        input.kind === "project" &&
        (!projectRoot(options.project) ||
          !isContained(projectRoot(options.project)!, canonicalRoot))
      ) {
        nextDiagnostics.push({
          code: "unsafe_project_source",
          message:
            "Project rule location resolves outside canonical project root",
        });
        continue;
      }
      let files: readonly string[];
      try {
        files = await options.storage.listMarkdownFiles(
          canonicalRoot,
          remainingFiles + 1,
        );
      } catch (error) {
        nextDiagnostics.push({
          code: "source_unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const sorted = [...files].map(normalizePath).sort();
      if (sorted.length > remainingFiles) {
        nextDiagnostics.push({
          code: "file_limit_exceeded",
          message: `Catalog exceeds ${limits.maxFiles} file limit`,
        });
      }
      const acceptedFiles = sorted.slice(0, remainingFiles);
      remainingFiles -= acceptedFiles.length;
      for (const lexicalFile of acceptedFiles) {
        let canonicalFile = lexicalFile;
        try {
          canonicalFile = await options.storage.canonicalize(lexicalFile);
          const source = sourceFor(input.kind, canonicalFile);
          if (!isContained(canonicalRoot, canonicalFile)) {
            nextDiagnostics.push({
              code: "unsafe_rule_path",
              message: "Rule file resolves outside its canonical source root",
              source,
            });
            continue;
          }
          const read = await options.storage.readFrontmatter(
            canonicalFile,
            limits.maxFrontmatterBytes,
          );
          if (read.size > limits.maxContentBytes) {
            nextDiagnostics.push(
              malformed(
                source,
                `Rule exceeds ${limits.maxContentBytes} content byte limit`,
              ),
            );
            continue;
          }
          nextRules.push(parseMetadata(read.prefix, source, limits));
        } catch (error) {
          nextDiagnostics.push(
            malformed(
              sourceFor(input.kind, canonicalFile),
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
      }
    }

    const acceptedRules = rejectDuplicateIds(nextRules, nextDiagnostics);
    acceptedRules.sort(
      (left, right) =>
        SOURCE_ORDER[left.source.kind] - SOURCE_ORDER[right.source.kind] ||
        compareText(left.id, right.id) ||
        compareText(left.source.path, right.source.path),
    );
    indexed = acceptedRules;
    diagnostics = nextDiagnostics;
    inspectionReasons = new Map();
    injectedByEpoch = new Map();
    return { rules: indexed, diagnostics };
  }

  async function relativeActivationPaths(
    entries: ReadonlyArray<
      string | { readonly path: string; readonly renamedFrom?: string }
    >,
  ) {
    const root = projectRoot(options.project);
    if (!root)
      return { paths: [] as string[], diagnostics: [] as RuleDiagnostic[] };
    const canonicalRoot = normalizePath(root);
    const canonicalCwd = normalizePath(options.project.canonicalCwd);
    const requestedRoot = normalizePath(options.project.requestedCwd);
    const relativePaths: string[] = [];
    const pathDiagnostics: RuleDiagnostic[] = [];
    for (const entry of entries) {
      const candidates =
        typeof entry === "string"
          ? [entry]
          : [entry.path, ...(entry.renamedFrom ? [entry.renamedFrom] : [])];
      for (const inputPath of candidates) {
        let lexical: string;
        if (!path.isAbsolute(inputPath)) {
          lexical = path.resolve(canonicalCwd, inputPath);
        } else if (isContained(canonicalRoot, inputPath)) {
          lexical = path.resolve(inputPath);
        } else if (isContained(requestedRoot, inputPath)) {
          lexical = path.resolve(
            canonicalCwd,
            path.relative(requestedRoot, normalizePath(inputPath)),
          );
        } else {
          lexical = path.resolve(inputPath);
        }
        try {
          const canonical = await options.storage.canonicalize(lexical);
          if (!isContained(canonicalRoot, canonical)) {
            pathDiagnostics.push({
              code: "activation_path_outside_project",
              message: `Activation path resolves outside canonical project root: ${inputPath}`,
            });
            continue;
          }
          const relative = path
            .relative(canonicalRoot, canonical)
            .replaceAll("\\", "/");
          if (relative && !relative.startsWith("../"))
            relativePaths.push(relative);
        } catch (error) {
          pathDiagnostics.push({
            code: "activation_path_unavailable",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return { paths: [...new Set(relativePaths)], diagnostics: pathDiagnostics };
  }

  return {
    discover() {
      return exclusive(discoverUnlocked);
    },
    activate(input) {
      return exclusive(async () => {
        if (
          !input.contextEpoch ||
          Buffer.byteLength(input.contextEpoch) > 128 ||
          input.paths.length > MAX_RULE_ACTIVATION_PATHS
        ) {
          return {
            rules: [],
            diagnostics: [
              {
                code: "invalid_activation",
                message: `Activation requires a 1-128 byte context epoch and at most ${MAX_RULE_ACTIVATION_PATHS} paths`,
              },
            ],
          };
        }
        const resolved = await relativeActivationPaths(input.paths);
        const matches: Array<{
          rule: RuleMetadata;
          pattern: string;
          specificity: number;
        }> = [];
        inspectionReasons = new Map();
        for (const rule of indexed) {
          let selected:
            | { pattern: string; specificity: number; relativePath: string }
            | undefined;
          let excludedBy: string | undefined;
          for (const relativePath of resolved.paths) {
            const excluded = matchingPattern(rule.exclude, relativePath);
            if (excluded) {
              excludedBy ??= excluded;
              continue;
            }
            const included = matchingPattern(rule.include, relativePath);
            if (!included) continue;
            const specificity = patternSpecificity(included);
            if (
              !selected ||
              specificity > selected.specificity ||
              (specificity === selected.specificity &&
                included < selected.pattern)
            ) {
              selected = { pattern: included, specificity, relativePath };
            }
          }
          if (selected) {
            matches.push({
              rule,
              pattern: selected.pattern,
              specificity: selected.specificity,
            });
            inspectionReasons.set(rule.source.path, {
              active: true,
              reason: `matched ${selected.pattern}`,
            });
          } else if (excludedBy) {
            inspectionReasons.set(rule.source.path, {
              active: false,
              reason: `excluded by ${excludedBy}`,
            });
          } else {
            inspectionReasons.set(rule.source.path, {
              active: false,
              reason: "no include pattern matched",
            });
          }
        }
        matches.sort(
          (left, right) =>
            right.specificity - left.specificity ||
            right.rule.priority - left.rule.priority ||
            SOURCE_ORDER[left.rule.source.kind] -
              SOURCE_ORDER[right.rule.source.kind] ||
            compareText(left.rule.id, right.rule.id) ||
            compareText(left.rule.source.path, right.rule.source.path),
        );
        let injected = injectedByEpoch.get(input.contextEpoch);
        if (!injected) {
          injected = new Set();
          injectedByEpoch.set(input.contextEpoch, injected);
          while (injectedByEpoch.size > 16) {
            const oldest = injectedByEpoch.keys().next().value;
            if (oldest === undefined) break;
            injectedByEpoch.delete(oldest);
          }
        }
        const activated: Array<RuleMetadata & { content: string }> = [];
        const activationDiagnostics = [...resolved.diagnostics];
        let activationBytes = 0;
        for (const match of matches) {
          if (activated.length >= limits.maxActivationRules) {
            activationDiagnostics.push({
              code: "activation_limit_exceeded",
              message: `Activation exceeds ${limits.maxActivationRules} rule limit`,
            });
            break;
          }
          const injectionKey = `${match.rule.id}\0${match.rule.source.path}`;
          if (injected.has(injectionKey)) continue;
          try {
            const canonical = await options.storage.canonicalize(
              match.rule.source.path,
            );
            if (normalizePath(canonical) !== match.rule.source.path) {
              throw new Error(
                "Rule path changed after discovery; reload required",
              );
            }
            const markdown = await options.storage.readContent(
              match.rule.source.path,
              limits.maxContentBytes,
            );
            if (Buffer.byteLength(markdown) > limits.maxContentBytes) {
              throw new Error(
                `Rule exceeds ${limits.maxContentBytes} content bytes`,
              );
            }
            const current = parseMetadata(markdown, match.rule.source, limits);
            if (!sameMetadata(current, match.rule)) {
              throw new Error(
                "Rule metadata changed after discovery; reload required",
              );
            }
            const boundary = frontmatterBoundary(markdown, limits);
            const content = markdown.slice(boundary.bodyStart);
            const contentBytes = Buffer.byteLength(content);
            if (activationBytes + contentBytes > limits.maxActivationBytes) {
              activationDiagnostics.push({
                code: "activation_limit_exceeded",
                message: `Activation exceeds ${limits.maxActivationBytes} body byte limit`,
                source: match.rule.source,
                ruleId: match.rule.id,
              });
              break;
            }
            activated.push({ ...match.rule, content });
            activationBytes += contentBytes;
            injected.add(injectionKey);
          } catch (error) {
            activationDiagnostics.push({
              code: "rule_activation_failed",
              message: error instanceof Error ? error.message : String(error),
              source: match.rule.source,
              ruleId: match.rule.id,
            });
            inspectionReasons.set(match.rule.source.path, {
              active: false,
              reason: "content rejected during activation",
            });
          }
        }
        return { rules: activated, diagnostics: activationDiagnostics };
      });
    },
    inspect() {
      return {
        rules: indexed.map((rule) => {
          const state = inspectionReasons.get(rule.source.path);
          return {
            ...rule,
            active: state?.active ?? false,
            reason: state?.reason ?? "not activated",
          };
        }),
        diagnostics,
      };
    },
    reload() {
      return exclusive(discoverUnlocked);
    },
  };
}

export {
  createFileSystemRuleCatalog,
  createFileSystemRuleStorage,
} from "./filesystem.ts";
