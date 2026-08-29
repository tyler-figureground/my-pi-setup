import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isAlias, parseDocument, visit } from "yaml";
import type {
  HookConfigSource,
  HookDiagnostic,
  HookRegistration,
  ValidationResult,
} from "./model.ts";
import {
  isRecord,
  measurePlainData,
  redact,
  resolveLimits,
  validateRegistration,
} from "./validation.ts";

type ConfigLimits = ReturnType<typeof resolveLimits>;

function sourceDiagnostic(
  source: HookConfigSource,
  severity: HookDiagnostic["severity"],
  code: string,
  message: string,
  hookId?: string,
): HookDiagnostic {
  return {
    severity,
    code,
    source: redact(source.path),
    ...(hookId ? { hookId } : {}),
    message: redact(message),
  };
}

function invalidSource(
  source: HookConfigSource,
  diagnostics: readonly HookDiagnostic[],
): Pick<ValidationResult, "hooks" | "diagnostics" | "sources"> {
  return {
    hooks: [],
    diagnostics,
    sources: [
      {
        scope: source.scope,
        path: source.path,
        status: "invalid",
        hookCount: 0,
      },
    ],
  };
}

async function loadSource(source: HookConfigSource, limits: ConfigLimits) {
  if (!isRecord(source)) {
    return {
      hooks: [],
      diagnostics: [
        {
          severity: "error",
          code: "invalid-config-source",
          source: "TriggerEngine",
          message: "Config source must be a plain object.",
        },
      ],
      sources: [],
    } satisfies Pick<ValidationResult, "hooks" | "diagnostics" | "sources">;
  }
  if (
    (source.scope !== "global" && source.scope !== "project") ||
    typeof source.path !== "string" ||
    (source.scope === "project" && typeof source.trusted !== "boolean") ||
    (source.scope === "global" &&
      source.trusted !== undefined &&
      source.trusted !== true) ||
    (source.optional !== undefined && typeof source.optional !== "boolean") ||
    (source.root !== undefined &&
      (typeof source.root !== "string" || !isAbsolute(source.root)))
  ) {
    return invalidSource(source, [
      sourceDiagnostic(
        source,
        "error",
        "invalid-config-source",
        "Config source requires global/project scope, path, project trust confirmation, and optional boolean.",
      ),
    ]);
  }
  if (source.scope === "project" && source.trusted !== true) {
    return {
      hooks: [],
      diagnostics: [
        sourceDiagnostic(
          source,
          "warning",
          "untrusted-project-skipped",
          "Untrusted project hook config was not read or loaded.",
        ),
      ],
      sources: [
        {
          scope: source.scope,
          path: source.path,
          status: "untrusted-skipped",
          hookCount: 0,
        },
      ],
    } satisfies Pick<ValidationResult, "hooks" | "diagnostics" | "sources">;
  }
  if (
    source.path.trim() === "" ||
    source.path.length > 32_768 ||
    !isAbsolute(source.path)
  ) {
    return invalidSource(source, [
      sourceDiagnostic(
        source,
        "error",
        "invalid-config-path",
        "Hook config path must be absolute.",
      ),
    ]);
  }

  let size: number;
  let fileDevice: number;
  let fileInode: number;
  let canonicalSource: string;
  try {
    const metadata = await lstat(source.path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      return invalidSource(source, [
        sourceDiagnostic(
          source,
          "error",
          "unsafe-config-path",
          "Hook config must be a regular file, not a link.",
        ),
      ]);
    }
    size = metadata.size;
    fileDevice = metadata.dev;
    fileInode = metadata.ino;
    canonicalSource = await realpath(source.path);
    if (source.root) {
      const canonicalRoot = await realpath(source.root);
      const nested = relative(canonicalRoot, canonicalSource);
      if (
        nested === ".." ||
        nested.startsWith(`..${sep}`) ||
        isAbsolute(nested)
      ) {
        return invalidSource(source, [
          sourceDiagnostic(
            source,
            "error",
            "unsafe-config-path",
            "Hook config resolves outside its trusted root.",
          ),
        ]);
      }
    }
  } catch (error) {
    const code =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "";
    if (code === "ENOENT" && source.optional !== false) {
      return {
        hooks: [],
        diagnostics: [
          sourceDiagnostic(
            source,
            "info",
            "config-missing",
            "Optional hook config does not exist.",
          ),
        ],
        sources: [
          {
            scope: source.scope,
            path: source.path,
            status: "missing",
            hookCount: 0,
          },
        ],
      } satisfies Pick<ValidationResult, "hooks" | "diagnostics" | "sources">;
    }
    return invalidSource(source, [
      sourceDiagnostic(
        source,
        "error",
        "config-read-error",
        `Could not inspect hook config: ${error instanceof Error ? error.message : String(error)}.`,
      ),
    ]);
  }
  if (!Number.isSafeInteger(size) || size > limits.maxConfigBytes) {
    return invalidSource(source, [
      sourceDiagnostic(
        source,
        "error",
        "config-too-large",
        `Hook config exceeds ${limits.maxConfigBytes} bytes.`,
      ),
    ]);
  }

  let text: string;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      canonicalSource,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== fileDevice ||
      opened.ino !== fileInode
    ) {
      return invalidSource(source, [
        sourceDiagnostic(
          source,
          "error",
          "unsafe-config-path",
          "Hook config identity changed before open.",
        ),
      ]);
    }
    if (opened.size > limits.maxConfigBytes) {
      return invalidSource(source, [
        sourceDiagnostic(
          source,
          "error",
          "config-too-large",
          `Hook config exceeds ${limits.maxConfigBytes} bytes.`,
        ),
      ]);
    }
    text = await handle.readFile({ encoding: "utf8" });
    const [canonicalAfter, after] = await Promise.all([
      realpath(source.path),
      lstat(source.path),
    ]);
    if (
      resolve(canonicalAfter) !== resolve(canonicalSource) ||
      after.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino
    ) {
      return invalidSource(source, [
        sourceDiagnostic(
          source,
          "error",
          "unsafe-config-path",
          "Hook config identity changed during read.",
        ),
      ]);
    }
  } catch (error) {
    return invalidSource(source, [
      sourceDiagnostic(
        source,
        "error",
        "config-read-error",
        `Could not read hook config: ${error instanceof Error ? error.message : String(error)}.`,
      ),
    ]);
  } finally {
    await handle?.close().catch(() => undefined);
  }
  if (Buffer.byteLength(text) > limits.maxConfigBytes) {
    return invalidSource(source, [
      sourceDiagnostic(
        source,
        "error",
        "config-too-large",
        `Hook config exceeds ${limits.maxConfigBytes} bytes.`,
      ),
    ]);
  }

  let document: ReturnType<typeof parseDocument>;
  let hasAlias = false;
  try {
    document = parseDocument(text, {
      schema: "core",
      strict: true,
      uniqueKeys: true,
      prettyErrors: false,
    });
    visit(document, (_key, node) => {
      if (isAlias(node)) hasAlias = true;
    });
  } catch {
    return invalidSource(source, [
      sourceDiagnostic(
        source,
        "error",
        "yaml-syntax",
        "YAML parsing failed within configured safety bounds.",
      ),
    ]);
  }
  if (hasAlias) {
    return invalidSource(source, [
      sourceDiagnostic(
        source,
        "error",
        "yaml-alias-disabled",
        "YAML anchors and aliases are disabled.",
      ),
    ]);
  }
  if (document.errors.length > 0) {
    const positions = document.errors
      .flatMap((error) => error.linePos?.slice(0, 1) ?? [])
      .map(({ line, col }) => `${line}:${col}`)
      .join(", ");
    return invalidSource(source, [
      sourceDiagnostic(
        source,
        "error",
        "yaml-syntax",
        positions
          ? `YAML syntax is invalid at ${positions}.`
          : "YAML syntax is invalid.",
      ),
    ]);
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0, mapAsMap: false });
  } catch {
    return invalidSource(source, [
      sourceDiagnostic(
        source,
        "error",
        "yaml-invalid",
        "YAML could not be converted to bounded plain data.",
      ),
    ]);
  }
  const measurement = measurePlainData(
    value,
    limits.maxConfigDepth,
    limits.maxConfigNodes,
  );
  if (!measurement.valid) {
    const code =
      measurement.reason === "depth limit exceeded"
        ? "config-depth-limit"
        : measurement.reason === "node limit exceeded"
          ? "config-node-limit"
          : "config-not-plain";
    return invalidSource(source, [
      sourceDiagnostic(
        source,
        "error",
        code,
        `Hook config rejected: ${measurement.reason}.`,
      ),
    ]);
  }
  if (!isRecord(value)) {
    return invalidSource(source, [
      sourceDiagnostic(
        source,
        "error",
        "invalid-config",
        "Hook config must be a mapping.",
      ),
    ]);
  }
  const rootUnknown = Object.keys(value).filter(
    (key) => key !== "version" && key !== "hooks",
  );
  if (
    rootUnknown.length > 0 ||
    (value.version !== 1 && value.version !== 2) ||
    !Array.isArray(value.hooks)
  ) {
    return invalidSource(source, [
      sourceDiagnostic(
        source,
        "error",
        "invalid-config-schema",
        rootUnknown.length > 0
          ? `Unsupported config fields: ${rootUnknown.join(", ")}.`
          : "Hook config requires version: 1 or 2 and a hooks array.",
      ),
    ]);
  }
  if (value.hooks.length > limits.maxHooks) {
    return invalidSource(source, [
      sourceDiagnostic(
        source,
        "error",
        "hook-limit",
        `Hook config exceeds ${limits.maxHooks} hooks.`,
      ),
    ]);
  }

  const hooks: HookRegistration[] = [];
  const diagnostics: HookDiagnostic[] = [];
  canonicalSource = resolve(canonicalSource);
  for (const [hookIndex, hook] of value.hooks.entries()) {
    let compiledHook = hook;
    if (value.version === 1 && isRecord(hook) && "actions" in hook) {
      diagnostics.push(
        sourceDiagnostic(
          source,
          "error",
          "invalid-config-schema",
          "Version 1 hooks use action, not actions.",
          typeof hook.id === "string" ? hook.id : undefined,
        ),
      );
      continue;
    }
    if (value.version === 2) {
      if (
        !isRecord(hook) ||
        "action" in hook ||
        "timeoutMs" in hook ||
        !Array.isArray(hook.actions) ||
        hook.actions.length === 0 ||
        hook.actions.length > 32 ||
        !Number.isSafeInteger(hook.deadlineMs)
      ) {
        diagnostics.push(
          sourceDiagnostic(
            source,
            "error",
            "invalid-config-schema",
            "Version 2 hooks require 1 through 32 actions and deadlineMs; action and timeoutMs are unsupported.",
            isRecord(hook) && typeof hook.id === "string" ? hook.id : undefined,
          ),
        );
        continue;
      }
      compiledHook = {
        ...hook,
        action: structuredClone(hook.actions[0]),
        timeoutMs: hook.deadlineMs,
      };
    }
    const checked = validateRegistration(
      {
        hook: compiledHook,
        provenance: {
          scope: source.scope,
          source: canonicalSource,
          trusted: true,
          documentIndex: 0,
          hookIndex,
        },
      },
      limits,
    );
    diagnostics.push(...checked.diagnostics);
    if (checked.registration) hooks.push(checked.registration);
  }
  const duplicateIds = hooks
    .map(({ hook }) => hook.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  for (const id of [...new Set(duplicateIds)]) {
    diagnostics.push(
      sourceDiagnostic(
        source,
        "error",
        "duplicate-id",
        `Duplicate hook id ${JSON.stringify(id)}.`,
        id,
      ),
    );
  }
  if (diagnostics.some(({ severity }) => severity === "error")) {
    return invalidSource(source, diagnostics);
  }
  return {
    hooks,
    diagnostics,
    sources: [
      {
        scope: source.scope,
        path: source.path,
        status: "valid",
        hookCount: hooks.length,
        identity: {
          canonicalPath: canonicalSource,
          device: fileDevice,
          inode: fileInode,
          digest: createHash("sha256").update(text).digest("hex"),
        },
      },
    ],
  } satisfies Pick<ValidationResult, "hooks" | "diagnostics" | "sources">;
}

export async function validateConfigSources(
  sources: readonly HookConfigSource[],
  limits: ConfigLimits,
  reservedIds: ReadonlySet<string>,
) {
  if (!Array.isArray(sources) || sources.length > 16) {
    return {
      valid: false,
      hooks: [],
      diagnostics: [
        {
          severity: "error",
          code: "config-source-limit",
          source: "TriggerEngine",
          message: "Config sources must be an array of at most 16 entries.",
        },
      ],
      sources: [],
    } satisfies ValidationResult;
  }
  const hooks: HookRegistration[] = [];
  const diagnostics: HookDiagnostic[] = [];
  const sourceResults: ValidationResult["sources"][number][] = [];
  for (const [sourceIndex, source] of sources.entries()) {
    const loaded = await loadSource(source, limits);
    hooks.push(
      ...loaded.hooks.map((registration) => ({
        ...registration,
        provenance: { ...registration.provenance, sourceIndex },
      })),
    );
    diagnostics.push(...loaded.diagnostics);
    sourceResults.push(...loaded.sources);
  }
  const seen = new Set(reservedIds);
  for (const registration of hooks) {
    if (seen.has(registration.hook.id)) {
      diagnostics.push({
        severity: "error",
        code: "duplicate-id",
        source: registration.provenance.source,
        hookId: registration.hook.id,
        message: `Duplicate hook id ${JSON.stringify(registration.hook.id)} across sources.`,
      });
    }
    seen.add(registration.hook.id);
  }
  if (seen.size > limits.maxHooks) {
    diagnostics.push({
      severity: "error",
      code: "hook-limit",
      source: "TriggerEngine",
      message: `Combined hook count exceeds ${limits.maxHooks}.`,
    });
  }
  const valid = !diagnostics.some(({ severity }) => severity === "error");
  return {
    valid,
    hooks: valid ? hooks : [],
    diagnostics,
    sources: sourceResults,
  } satisfies ValidationResult;
}
