import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  decodeBrowserConfiguration,
  defaultPlatformBrowserConfiguration,
  type PlatformBrowserConfiguration,
} from "./browser/config.ts";
import { decodeLanguageServerConfiguration } from "./language/config.ts";
import {
  decodeHookActionConfiguration,
  defaultPlatformHookActionConfiguration,
  type PlatformHookActionConfiguration,
} from "./automation/hooks/configuration.ts";
import { decodeMcpServers, type ConfiguredMcpServer } from "./mcp/config.ts";
import {
  decodeMemoryConfiguration,
  defaultPlatformMemoryConfiguration,
  type PlatformMemoryConfiguration,
} from "./memory/config.ts";
import {
  decodeMessagingConfiguration,
  defaultPlatformMessagingConfiguration,
  type PlatformMessagingConfiguration,
} from "./messaging/config.ts";
import type { LanguageServerDefinition } from "./language/model.ts";
import {
  decodeMonitorConfiguration,
  defaultPlatformMonitorConfiguration,
  type PlatformMonitorConfiguration,
} from "./automation/monitors/config.ts";
import {
  decodeSchedulerConfiguration,
  defaultPlatformSchedulerConfiguration,
  type PlatformSchedulerConfiguration,
} from "./automation/scheduler/config.ts";
import {
  decodePlatformFlags,
  defaultPlatformFlags,
  type PlatformDiagnostic,
  type PlatformFlags,
} from "./flags.ts";

const PLATFORM_CONFIG_MAX_BYTES = 64 * 1024;

export interface PlatformPlanConfiguration {
  readonly defaultScope: "user" | "project";
  readonly userDirectory: string;
  readonly projectDirectory: string;
}

export const defaultPlatformPlanConfiguration: PlatformPlanConfiguration =
  Object.freeze({
    defaultScope: "user",
    userDirectory: "plans",
    projectDirectory: join(CONFIG_DIR_NAME, "plans"),
  });

export interface PlatformConfigLocation {
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly agentDir?: string;
}

function findProjectConfig(cwd: string) {
  const requested = resolve(cwd);
  const local = join(requested, CONFIG_DIR_NAME, "platform.json");
  if (existsSync(local)) return { path: local, root: requested };

  let current = requested;
  for (let depth = 0; depth < 64; depth++) {
    if (existsSync(join(current, ".git"))) {
      const candidate = join(current, CONFIG_DIR_NAME, "platform.json");
      return existsSync(candidate)
        ? { path: candidate, root: current }
        : undefined;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

function normalizeComparisonPath(filePath: string) {
  const normalized = resolve(filePath).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isContained(root: string, candidate: string) {
  const comparedRoot = normalizeComparisonPath(root).replace(/\/$/, "");
  const comparedCandidate = normalizeComparisonPath(candidate);
  return (
    comparedCandidate === comparedRoot ||
    comparedCandidate.startsWith(`${comparedRoot}/`)
  );
}

function readTrustedConfig(source: string, root: string) {
  const before = lstatSync(source);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size > PLATFORM_CONFIG_MAX_BYTES
  ) {
    throw new Error(
      "Platform config must be a bounded regular file, not a link.",
    );
  }
  const canonicalRoot = realpathSync(root);
  const canonicalSource = realpathSync(source);
  if (!isContained(canonicalRoot, canonicalSource)) {
    throw new Error("Platform config resolves outside its trusted root.");
  }
  const descriptor = openSync(
    canonicalSource,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > PLATFORM_CONFIG_MAX_BYTES
    ) {
      throw new Error("Platform config identity changed before open.");
    }
    const text = readFileSync(descriptor, "utf8");
    const after = lstatSync(source);
    if (
      after.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      realpathSync(source) !== canonicalSource
    ) {
      throw new Error("Platform config identity changed during read.");
    }
    return text;
  } finally {
    closeSync(descriptor);
  }
}

function decodePlanConfiguration(
  input: unknown,
  base: PlatformPlanConfiguration,
): { plan: PlatformPlanConfiguration; diagnostics: PlatformDiagnostic[] } {
  if (input === undefined) return { plan: base, diagnostics: [] };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      plan: base,
      diagnostics: [
        { path: "plan", message: "Plan config must be an object." },
      ],
    };
  }
  const value = input as Record<string, unknown>;
  const diagnostics: PlatformDiagnostic[] = [];
  const unknown = Object.keys(value).filter(
    (key) =>
      !["defaultScope", "userDirectory", "projectDirectory"].includes(key),
  );
  for (const key of unknown) {
    diagnostics.push({
      path: `plan.${key}`,
      message: `Unknown plan config field ${JSON.stringify(key)}.`,
    });
  }
  const safeDirectory = (
    field: string,
    candidate: unknown,
    fallback: string,
  ) => {
    if (candidate === undefined) return fallback;
    if (
      typeof candidate !== "string" ||
      candidate.length === 0 ||
      candidate.length > 4_096 ||
      isAbsolute(candidate) ||
      candidate.split(/[\\/]/).includes("..") ||
      candidate.includes("\0")
    ) {
      diagnostics.push({
        path: `plan.${field}`,
        message: `${field} must be a bounded relative directory.`,
      });
      return fallback;
    }
    return candidate.split(/[\\/]/).join(sep);
  };
  const defaultScope =
    value.defaultScope === undefined
      ? base.defaultScope
      : value.defaultScope === "user" || value.defaultScope === "project"
        ? value.defaultScope
        : (diagnostics.push({
            path: "plan.defaultScope",
            message: "defaultScope must be user or project.",
          }),
          base.defaultScope);
  return {
    plan: {
      defaultScope,
      userDirectory: safeDirectory(
        "userDirectory",
        value.userDirectory,
        base.userDirectory,
      ),
      projectDirectory: safeDirectory(
        "projectDirectory",
        value.projectDirectory,
        base.projectDirectory,
      ),
    },
    diagnostics,
  };
}

export function loadPlatformFlags(location: PlatformConfigLocation): {
  readonly flags: PlatformFlags;
  readonly plan: PlatformPlanConfiguration;
  readonly languageServers: readonly LanguageServerDefinition[];
  readonly mcpServers: readonly ConfiguredMcpServer[];
  readonly browser: PlatformBrowserConfiguration;
  readonly messaging: PlatformMessagingConfiguration;
  readonly memory: PlatformMemoryConfiguration;
  readonly monitors: PlatformMonitorConfiguration;
  readonly scheduler: PlatformSchedulerConfiguration;
  readonly hookActions: PlatformHookActionConfiguration;
  readonly diagnostics: PlatformDiagnostic[];
} {
  const agentDir = resolve(location.agentDir ?? getAgentDir());
  const sources: Array<{
    path: string;
    root: string;
    scope: "user" | "project";
  }> = [
    {
      path: join(agentDir, "platform.json"),
      root: agentDir,
      scope: "user",
    },
  ];
  if (location.projectTrusted) {
    const projectConfig = findProjectConfig(location.cwd);
    if (projectConfig) sources.push({ ...projectConfig, scope: "project" });
  }
  const diagnostics: PlatformDiagnostic[] = [];
  let flags: PlatformFlags = defaultPlatformFlags;
  let plan = defaultPlatformPlanConfiguration;
  let languageServers: readonly LanguageServerDefinition[] = [];
  let mcpServers: readonly ConfiguredMcpServer[] = [];
  let browser = defaultPlatformBrowserConfiguration;
  let messaging = defaultPlatformMessagingConfiguration;
  let memory = defaultPlatformMemoryConfiguration;
  let monitors = defaultPlatformMonitorConfiguration;
  let scheduler = defaultPlatformSchedulerConfiguration;
  let hookActions = defaultPlatformHookActionConfiguration;
  for (const source of sources) {
    if (!existsSync(source.path)) continue;
    try {
      const parsed = JSON.parse(
        readTrustedConfig(source.path, source.root),
      ) as unknown;
      const object =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined;
      const decoded = decodePlatformFlags(
        object
          ? Object.fromEntries(
              Object.entries(object).filter(
                ([key]) =>
                  ![
                    "plan",
                    "languageServers",
                    "mcpServers",
                    "browserSettings",
                    "messagingSettings",
                    "memorySettings",
                    "monitorSettings",
                    "schedulerSettings",
                    "hookActions",
                  ].includes(key),
              ),
            )
          : parsed,
        flags,
      );
      const decodedPlan = decodePlanConfiguration(object?.plan, plan);
      const decodedLanguage = decodeLanguageServerConfiguration(
        object?.languageServers,
        languageServers,
      );
      const decodedMcp = decodeMcpServers(object?.mcpServers, mcpServers, {
        path: source.path,
        scope: source.scope,
      });
      const decodedBrowser = decodeBrowserConfiguration(
        object?.browserSettings,
        browser,
        source.scope,
      );
      const decodedMessaging = decodeMessagingConfiguration(
        object?.messagingSettings,
        messaging,
        source.scope,
      );
      const decodedMemory = decodeMemoryConfiguration(
        object?.memorySettings,
        memory,
      );
      const decodedMonitors = decodeMonitorConfiguration(
        object?.monitorSettings,
        monitors,
        source.scope,
      );
      const decodedScheduler = decodeSchedulerConfiguration(
        object?.schedulerSettings,
        scheduler,
        source.scope,
      );
      const decodedHookActions = decodeHookActionConfiguration(
        object?.hookActions,
        hookActions,
        source.scope,
      );
      flags = decoded.flags;
      plan = decodedPlan.plan;
      languageServers = decodedLanguage.servers;
      mcpServers = decodedMcp.servers;
      browser = decodedBrowser.browser;
      messaging = decodedMessaging.messaging;
      memory = decodedMemory.memory;
      monitors = decodedMonitors.monitors;
      scheduler = decodedScheduler.scheduler;
      hookActions = {
        http: decodedHookActions.http,
        mcp: decodedHookActions.mcp,
      };
      diagnostics.push(
        ...[
          ...decoded.diagnostics,
          ...decodedPlan.diagnostics,
          ...decodedLanguage.diagnostics,
          ...decodedMcp.diagnostics,
          ...decodedBrowser.diagnostics,
          ...decodedMessaging.diagnostics,
          ...decodedMemory.diagnostics,
          ...decodedMonitors.diagnostics,
          ...decodedScheduler.diagnostics,
          ...decodedHookActions.diagnostics,
        ].map((diagnostic) => ({
          path: `${source.path}:${diagnostic.path}`,
          message: diagnostic.message,
        })),
      );
    } catch (error) {
      diagnostics.push({
        path: source.path,
        message: `Could not parse platform config: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  if ((flags.monitors || flags.scheduler) && !flags.messaging) {
    diagnostics.push({
      path: "platform.json:messaging",
      message:
        "Reactive Monitors and Scheduler require messaging for durable result delivery.",
    });
  }
  return {
    flags,
    plan,
    languageServers,
    mcpServers,
    browser,
    messaging,
    memory,
    monitors,
    scheduler,
    hookActions,
    diagnostics,
  };
}
