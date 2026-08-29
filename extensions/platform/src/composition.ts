import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  createLifecycleSupervisor,
  type LifecycleResource,
  type ReleasableLifecycleSupervisor,
  type LifecycleSupervisor,
} from "./core/lifecycle/supervisor.ts";
import {
  executionRoleFor,
  type ExecutionRole,
} from "../../shared/execution-role.ts";
import {
  defaultPlatformPlanConfiguration,
  loadPlatformFlags,
  type PlatformPlanConfiguration,
} from "./config.ts";
import {
  defaultPlatformBrowserConfiguration,
  type PlatformBrowserConfiguration,
} from "./browser/config.ts";
import {
  defaultPlatformMemoryConfiguration,
  type PlatformMemoryConfiguration,
} from "./memory/config.ts";
import {
  defaultPlatformMessagingConfiguration,
  type PlatformMessagingConfiguration,
} from "./messaging/config.ts";
import type { BrowserAdapter } from "./browser/index.ts";
import type { CredentialVault } from "./external/credentials.ts";
import { createExternalIntegrationControls } from "./external/index.ts";
import type {
  McpServerDefinition,
  McpTransportAdapter,
  ToolFederation,
} from "./mcp/index.ts";
import { bindPlatformAgentServices } from "./agents/services.ts";
import { createFileSystemArtifactStore } from "./core/artifacts/index.ts";
import { createCapabilityPolicy } from "./core/policy/index.ts";
import { createSqliteStateStore } from "./core/persistence/index.ts";
import {
  createProjectIdentity,
  type ProjectIdentity,
  type ResolvedProjectIdentity,
} from "./core/projects/index.ts";
import { decodePlatformFlags } from "./flags.ts";
import { createHooksCapability } from "./wiring/hooks.ts";
import { createMonitorCapability } from "./wiring/monitors.ts";
import { createSchedulerCapability } from "./wiring/scheduler.ts";
import { createKeyringTriggerRecordAuthenticator } from "./automation/triggers/record-authentication.ts";
import { createPlanCapability } from "./wiring/plan.ts";
import { createRulesCapability } from "./wiring/rules.ts";
import type {
  LanguageIntelligence,
  LanguageServerAdapter,
  LanguageServerDefinition,
} from "./language/model.ts";
import { createProfileCatalog } from "./profiles/index.ts";
import type { ProfileCatalog } from "./profiles/index.ts";
import type { LocalReview, ReviewRequest } from "./review/index.ts";
import { localReviewerFor } from "./review/reviewer-service.ts";
import { createLanguageCapability } from "./wiring/language.ts";
import { createReviewCapability } from "./wiring/review.ts";
import { createBrowserCapability } from "./wiring/browser.ts";
import { createMcpCapability } from "./wiring/mcp.ts";
import {
  createMemoryCapability,
  type CurrentWorkspaceLeaseProvider,
} from "./wiring/memory.ts";
import { createMessagingCapability } from "./wiring/messaging.ts";
import { createWorkspaceManager } from "./workspaces/index.ts";
import { createCurrentWorkspaceLeaseProvider } from "./workspaces/current-workspace-lease.ts";
import {
  createHostMemoryBindingFactory,
  createMemoryStoreModule,
} from "./memory/index.ts";
import type {
  MemoryPersistenceAdapter,
  MemoryPersistenceError,
} from "./memory/memory-persistence.ts";
import {
  createSqliteMemoryPersistenceAdapter,
  type SqliteMemoryPersistenceOptions,
} from "./memory/sqlite-memory-persistence.ts";
import type { Outcome } from "./core/result.ts";
import {
  createSessionBrokerModule,
  issueHostSessionProof,
  type SessionBroker,
} from "./messaging/index.ts";
import {
  createPiSessionDeliveryAdapter,
  type PiSessionDeliveryAdapter,
} from "./messaging/pi-delivery.ts";
import {
  createNamedHookAgentAdapter,
  createNamedHookHttpAdapter,
  createNamedHookMcpAdapter,
  defaultPlatformHookActionConfiguration,
  type PlatformHookActionConfiguration,
} from "./automation/hooks/index.ts";
import {
  createTriggerEngine,
  type TriggerEngineRuntime,
} from "./automation/triggers/index.ts";
import { createStateStoreTriggerPersistence } from "./automation/triggers/state-store-persistence.ts";
import {
  createJsonPollAdapter,
  createMonitorRegistry,
  createProductionMonitorSourceFactory,
  createSessionBrokerMonitorDelivery,
  defaultPlatformMonitorConfiguration,
  type MonitorAuthority,
} from "./automation/monitors/index.ts";
import type { PlatformMonitorConfiguration } from "./automation/monitors/config.ts";
import {
  createScheduler,
  createSchedulerHostAuthority,
  createSessionBrokerScheduleDelivery,
  createSystemSchedulerClock,
} from "./automation/scheduler/index.ts";
import {
  defaultPlatformSchedulerConfiguration,
  type PlatformSchedulerConfiguration,
} from "./automation/scheduler/config.ts";
import {
  bindPlatformHookEventSink,
  platformHookEventProducerFor,
  type PlatformHookEventEnvelope,
} from "./automation/platform-hook-event-sink.ts";
import { createPinnedFetch } from "./external/pinned-fetch.ts";
import { terminalObservationSourceFor } from "../../background-terminals/src/observation-service.ts";
import { scheduledAgentExecutorFor } from "../../shared/scheduled-agent.ts";
import { namedProfileExecutionPortFor } from "./agents/named-profile-execution-service.ts";

export function canOwnPlatformDaemons(role: ExecutionRole) {
  return role === "parent";
}

export function platformArtifactRoot(agentDir: string) {
  return process.platform === "win32"
    ? path.join(
        process.env.LOCALAPPDATA ?? os.tmpdir(),
        "pi-agent",
        "artifacts",
      )
    : path.join(
        process.env.XDG_STATE_HOME ??
          path.join(os.homedir(), ".local", "state"),
        "pi-agent",
        "artifacts",
      );
}

export function platformBrowserProfileRoot(agentDir: string) {
  return process.platform === "win32"
    ? path.join(
        process.env.LOCALAPPDATA ?? os.tmpdir(),
        "pi-agent",
        "browser",
        "profiles",
      )
    : path.join(agentDir, "browser", "profiles");
}

function createLazyCredentialVault(): CredentialVault {
  let pending: Promise<CredentialVault> | undefined;
  const vault = () =>
    (pending ??= import("./external/keyring-credentials.ts").then(
      ({ createKeyringCredentialVault }) => createKeyringCredentialVault(),
    ));
  return {
    async store(input) {
      return (await vault()).store(input);
    },
    async resolve(reference, binding) {
      return (await vault()).resolve(reference, binding);
    },
    async inspect(reference) {
      return (await vault()).inspect(reference);
    },
    async replace(reference, binding, secret) {
      return (await vault()).replace(reference, binding, secret);
    },
    async remove(reference, binding) {
      return (await vault()).remove(reference, binding);
    },
  };
}

function createLazyMemoryPersistenceAdapter(
  create: () => Outcome<MemoryPersistenceAdapter, MemoryPersistenceError>,
): MemoryPersistenceAdapter {
  let pending:
    | Promise<Outcome<MemoryPersistenceAdapter, MemoryPersistenceError>>
    | undefined;
  const initialize = () => (pending ??= Promise.resolve().then(create));
  const use = async <T>(
    operation: (
      adapter: MemoryPersistenceAdapter,
    ) => Promise<Outcome<T, MemoryPersistenceError>>,
  ) => {
    const initialized = await initialize();
    if (!initialized.ok) return initialized;
    return operation(initialized.value);
  };
  return {
    purgeExpired: (now) => use((adapter) => adapter.purgeExpired(now)),
    create: (entry, receipt, contradictionIds) =>
      use((adapter) => adapter.create(entry, receipt, contradictionIds)),
    get: (id) => use((adapter) => adapter.get(id)),
    getReceipt: (requestId) => use((adapter) => adapter.getReceipt(requestId)),
    findCandidates: (scope, kind, limit) =>
      use((adapter) => adapter.findCandidates(scope, kind, limit)),
    saveReceipt: (receipt) => use((adapter) => adapter.saveReceipt(receipt)),
    update: (entry, expectedRevision, receipt, contradictionIds) =>
      use((adapter) =>
        adapter.update(entry, expectedRevision, receipt, contradictionIds),
      ),
    forget: (id, expectedRevision, receipt) =>
      use((adapter) => adapter.forget(id, expectedRevision, receipt)),
    list: (input) => use((adapter) => adapter.list(input)),
    savePreview: (preview, receipt, limits) =>
      use((adapter) => adapter.savePreview(preview, receipt, limits)),
    getPreview: (id, now) => use((adapter) => adapter.getPreview(id, now)),
    commitImport: (previewId, entries, receipt) =>
      use((adapter) => adapter.commitImport(previewId, entries, receipt)),
    search: (input) => use((adapter) => adapter.search(input)),
  };
}

function installedBrowserExecutable(configured: string) {
  if (configured) return existsSync(configured) ? configured : "";
  const candidates =
    process.platform === "win32"
      ? [
          "C:/Program Files/Google/Chrome/Application/chrome.exe",
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "";
}

function browserProfileScope(agentDir: string, projectId: string) {
  return createHash("sha256")
    .update(path.resolve(agentDir), "utf8")
    .update("\0")
    .update(projectId, "utf8")
    .digest("hex")
    .slice(0, 24);
}

export function builtInLanguageServers(): readonly LanguageServerDefinition[] {
  const typescriptServer = fileURLToPath(
    new URL(
      "../node_modules/typescript-language-server/lib/cli.mjs",
      import.meta.url,
    ),
  );
  const tsserver = fileURLToPath(
    new URL("../node_modules/typescript-v5/lib/tsserver.js", import.meta.url),
  );
  return [
    {
      id: "typescript",
      command: {
        executable: process.execPath,
        args: [typescriptServer, "--stdio"],
      },
      selectors: [
        {
          languageId: "typescript",
          extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"],
        },
      ],
      queries: [
        "diagnostics",
        "documentSymbols",
        "workspaceSymbols",
        "definition",
        "references",
        "implementations",
        "hover",
        "callHierarchy",
      ],
      initializationOptions: { tsserver: { path: tsserver } },
    },
    {
      id: "ruff",
      command: { executable: "ruff", args: ["server"] },
      selectors: [{ languageId: "python", extensions: [".py", ".pyi"] }],
      queries: ["diagnostics"],
    },
  ];
}

function createDaemonAcquirer(
  role: ExecutionRole,
  lifecycle: LifecycleSupervisor,
) {
  return <T>(resource: LifecycleResource<T>) => {
    if (!canOwnPlatformDaemons(role)) {
      return Promise.reject(
        new Error(
          `Execution role ${JSON.stringify(role)} cannot own platform daemons.`,
        ),
      );
    }
    return lifecycle.acquire(resource);
  };
}

function isReleasableLifecycleSupervisor(
  lifecycle: LifecycleSupervisor,
): lifecycle is ReleasableLifecycleSupervisor {
  return (
    "acquireHandle" in lifecycle &&
    typeof lifecycle.acquireHandle === "function"
  );
}

export interface PlatformExtensionOptions {
  flags?: unknown;
  plan?: Partial<PlatformPlanConfiguration>;
  languageServers?: readonly LanguageServerDefinition[];
  mcpServers?: readonly McpServerDefinition[];
  browser?: PlatformBrowserConfiguration;
  messaging?: PlatformMessagingConfiguration;
  memory?: PlatformMemoryConfiguration;
  monitors?: PlatformMonitorConfiguration;
  scheduler?: PlatformSchedulerConfiguration;
  hookActions?: PlatformHookActionConfiguration;
  mcpAdapter?: McpTransportAdapter;
  browserAdapter?: BrowserAdapter;
  credentialVault?: CredentialVault;
  agentDir?: string;
  createLifecycleSupervisor?: () => LifecycleSupervisor;
  createProjectIdentity?: () => ProjectIdentity;
  createMemoryPersistenceAdapter?: (
    options: SqliteMemoryPersistenceOptions,
  ) => Outcome<MemoryPersistenceAdapter, MemoryPersistenceError>;
  createSessionBrokerModule?: typeof createSessionBrokerModule;
  createSessionDeliveryAdapter?: typeof createPiSessionDeliveryAdapter;
  currentWorkspaceLeaseProvider?: CurrentWorkspaceLeaseProvider;
  createStateStore?: typeof createSqliteStateStore;
  createArtifactStore?: typeof createFileSystemArtifactStore;
  createProfileCatalog?: typeof createProfileCatalog;
  createNamedHookHttpAdapter?: typeof createNamedHookHttpAdapter;
  createNamedHookMcpAdapter?: typeof createNamedHookMcpAdapter;
  createNamedHookAgentAdapter?: typeof createNamedHookAgentAdapter;
  createTriggerEngine?: typeof createTriggerEngine;
  createMonitorRegistry?: typeof createMonitorRegistry;
  createMonitorSourceFactory?: typeof createProductionMonitorSourceFactory;
  createScheduler?: typeof createScheduler;
  createSchedulerClock?: typeof createSystemSchedulerClock;
}

export function createPlatformExtension(
  options: PlatformExtensionOptions = {},
) {
  const suppliedConfiguration =
    options.flags === undefined
      ? undefined
      : {
          ...decodePlatformFlags(options.flags),
          plan: {
            ...defaultPlatformPlanConfiguration,
            ...options.plan,
          },
          languageServers: options.languageServers ?? [],
          mcpServers: options.mcpServers ?? [],
          browser: options.browser ?? defaultPlatformBrowserConfiguration,
          messaging: options.messaging ?? defaultPlatformMessagingConfiguration,
          memory: options.memory ?? defaultPlatformMemoryConfiguration,
          monitors: options.monitors ?? defaultPlatformMonitorConfiguration,
          scheduler: options.scheduler ?? defaultPlatformSchedulerConfiguration,
          hookActions:
            options.hookActions ?? defaultPlatformHookActionConfiguration,
        };
  if (
    suppliedConfiguration &&
    (suppliedConfiguration.flags.monitors ||
      suppliedConfiguration.flags.scheduler) &&
    !suppliedConfiguration.flags.messaging
  ) {
    throw new Error(
      "Phase 7 requires messaging when monitors or scheduler are enabled.",
    );
  }
  const makeLifecycleSupervisor =
    options.createLifecycleSupervisor ?? createLifecycleSupervisor;
  const makeProjectIdentity =
    options.createProjectIdentity ?? createProjectIdentity;
  const agentDir = options.agentDir ?? getAgentDir();

  return (pi: ExtensionAPI) => {
    const role = executionRoleFor(pi.events);
    const policy = createCapabilityPolicy();
    const authorityValue = randomUUID();
    type PlatformRuntime = {
      role: ExecutionRole;
      lifecycle: LifecycleSupervisor;
      acquireDaemon: ReturnType<typeof createDaemonAcquirer>;
      plan?: ReturnType<typeof createPlanCapability>;
      rules?: ReturnType<typeof createRulesCapability>;
      hooks?: ReturnType<typeof createHooksCapability>;
      language?: ReturnType<typeof createLanguageCapability>;
      review?: ReturnType<typeof createReviewCapability>;
      mcp?: ReturnType<typeof createMcpCapability>;
      browser?: ReturnType<typeof createBrowserCapability>;
      memory?: ReturnType<typeof createMemoryCapability>;
      messaging?: ReturnType<typeof createMessagingCapability>;
      messagingDelivery?: PiSessionDeliveryAdapter;
      triggers?: TriggerEngineRuntime;
      monitors?: ReturnType<typeof createMonitorCapability>;
      scheduler?: ReturnType<typeof createSchedulerCapability>;
      hookEventTail?: Promise<void>;
      unbindHookEventSink?: () => void;
      unbindAgentServices?: () => void;
    };
    let runtime: PlatformRuntime | undefined;
    let planCapability: ReturnType<typeof createPlanCapability> | undefined;
    let rulesCapability: ReturnType<typeof createRulesCapability> | undefined;
    let hooksCapability: ReturnType<typeof createHooksCapability> | undefined;
    let languageCapability:
      ReturnType<typeof createLanguageCapability> | undefined;
    let reviewCapability: ReturnType<typeof createReviewCapability> | undefined;
    let mcpCapability: ReturnType<typeof createMcpCapability> | undefined;
    let browserCapability:
      ReturnType<typeof createBrowserCapability> | undefined;
    let memoryCapability: ReturnType<typeof createMemoryCapability> | undefined;
    let messagingCapability:
      ReturnType<typeof createMessagingCapability> | undefined;
    let monitorCapability:
      ReturnType<typeof createMonitorCapability> | undefined;
    let schedulerCapability:
      ReturnType<typeof createSchedulerCapability> | undefined;
    let memoryAuthority:
      | {
          readonly runtime: PlatformRuntime;
          readonly project: ResolvedProjectIdentity;
          readonly sessionId: string;
          readonly workspaceProvider?: CurrentWorkspaceLeaseProvider;
        }
      | undefined;

    const teardown = async (
      current: PlatformRuntime,
      reason: "quit" | "reload" | "new" | "resume" | "fork",
      event: unknown,
    ) => {
      const failures: unknown[] = [];
      memoryAuthority = undefined;
      try {
        await current.scheduler?.stop();
      } catch (error) {
        failures.push(error);
      }
      try {
        await current.monitors?.stop();
      } catch (error) {
        failures.push(error);
      }
      try {
        current.unbindHookEventSink?.();
      } catch (error) {
        failures.push(error);
      }
      try {
        await current.hookEventTail;
      } catch (error) {
        failures.push(error);
      }
      try {
        await current.hooks?.stop(reason, event);
      } catch (error) {
        failures.push(error);
      }
      try {
        current.unbindAgentServices?.();
      } catch (error) {
        failures.push(error);
      }
      try {
        await current.triggers?.close(reason);
      } catch (error) {
        failures.push(error);
      }
      try {
        await current.memory?.stop();
      } catch (error) {
        failures.push(error);
      }
      try {
        await current.browser?.stop();
      } catch (error) {
        failures.push(error);
      }
      try {
        await current.mcp?.stop();
      } catch (error) {
        failures.push(error);
      }
      try {
        await current.language?.stop();
      } catch (error) {
        failures.push(error);
      }
      try {
        await current.review?.stop();
      } catch (error) {
        failures.push(error);
      }
      try {
        current.messagingDelivery?.handleEvent({ type: "session_shutdown" });
      } catch (error) {
        failures.push(error);
      }
      try {
        await current.messaging?.stop(reason);
      } catch (error) {
        failures.push(error);
      }
      try {
        current.rules?.stop();
      } catch (error) {
        failures.push(error);
      }
      try {
        await current.plan?.stop();
      } catch (error) {
        failures.push(error);
      }
      try {
        const report = await current.lifecycle.shutdown(reason);
        if (report.status === "degraded") {
          const lifecycleFailures = report.failures.map(
            (failure) =>
              new Error(
                `Lifecycle resource ${JSON.stringify(failure.resourceId)} ${failure.phase} ${failure.kind}: ${failure.message}`,
              ),
          );
          failures.push(
            ...(lifecycleFailures.length > 0
              ? lifecycleFailures
              : [new Error("Lifecycle shutdown reported degraded status.")]),
          );
        }
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Platform session teardown failed.");
      }
    };

    pi.on("session_start", async (event, ctx) => {
      if (runtime) {
        const previous = runtime;
        runtime = undefined;
        await teardown(previous, "reload", {
          type: "session_shutdown",
          reason: "reload",
        });
      }
      const lifecycle = makeLifecycleSupervisor();
      const current = {
        role,
        lifecycle,
        acquireDaemon: createDaemonAcquirer(role, lifecycle),
      } as PlatformRuntime;
      runtime = current;
      const projectTrusted = ctx.isProjectTrusted();
      const configuration =
        suppliedConfiguration ??
        loadPlatformFlags({
          cwd: ctx.cwd,
          agentDir,
          projectTrusted,
        });
      if (ctx.hasUI) {
        for (const diagnostic of configuration.diagnostics) {
          ctx.ui.notify(
            `Platform config ${diagnostic.path}: ${diagnostic.message}`,
            "warning",
          );
        }
      }

      const platformEnabled =
        configuration.flags.planMode ||
        configuration.flags.rules ||
        configuration.flags.hooks ||
        configuration.flags.profiles ||
        configuration.flags.workspaces ||
        configuration.flags.languageIntelligence ||
        configuration.flags.review ||
        configuration.flags.mcp ||
        configuration.flags.browser ||
        configuration.flags.messaging ||
        configuration.flags.memory ||
        configuration.flags.monitors ||
        configuration.flags.scheduler;
      if (!platformEnabled || role !== "parent") return;

      const projectIdentity = makeProjectIdentity();
      const resolved = await projectIdentity.resolve(ctx.cwd);
      if (!resolved.ok) {
        if (ctx.hasUI) {
          ctx.ui.notify(resolved.error.message, "error");
        }
        return;
      }
      const project = resolved.value;
      const memoryEnabled = configuration.flags.memory && projectTrusted;
      const messagingEnabled = configuration.flags.messaging && projectTrusted;
      const makeStateStore = options.createStateStore ?? createSqliteStateStore;
      const makeArtifactStore =
        options.createArtifactStore ?? createFileSystemArtifactStore;
      let sharedState: ReturnType<typeof createSqliteStateStore> | undefined;
      let sharedArtifacts:
        ReturnType<typeof createFileSystemArtifactStore> | undefined;
      const stateStore = () =>
        (sharedState ??= makeStateStore({
          path: path.join(agentDir, "state", "platform.sqlite"),
        }));
      const artifactStore = () =>
        (sharedArtifacts ??= makeArtifactStore({
          root: platformArtifactRoot(agentDir),
        }));
      const platformMode = () => {
        const state = runtime?.plan?.mode()?.status().state;
        return state === "planning" || state === "approval-pending"
          ? ("plan" as const)
          : ("normal" as const);
      };
      const hookAuthorities = new Map<
        string,
        { readonly scope: string; readonly deadlineMs: number }
      >();
      const externalControls = createExternalIntegrationControls({
        policy,
        authority: {
          verify(token) {
            if (token.value === authorityValue) return true;
            const grant = hookAuthorities.get(token.value);
            if (!grant) return false;
            hookAuthorities.delete(token.value);
            return (
              token.scope === grant.scope && Date.now() <= grant.deadlineMs
            );
          },
        },
      });
      const credentialVault =
        options.credentialVault ?? createLazyCredentialVault();
      const queuedPlatformEvents: PlatformHookEventEnvelope[] = [];
      let publishPlatformEvent:
        ((envelope: PlatformHookEventEnvelope) => Promise<void>) | undefined;
      if (configuration.flags.hooks) {
        current.unbindHookEventSink = bindPlatformHookEventSink(pi.events, {
          publish(envelope) {
            if (runtime !== current) return;
            if (publishPlatformEvent) {
              void publishPlatformEvent(envelope);
              return;
            }
            if (queuedPlatformEvents.length >= 128) {
              queuedPlatformEvents.shift();
            }
            queuedPlatformEvents.push(envelope);
          },
        });
      }
      const workspaceHookEvents = configuration.flags.hooks
        ? platformHookEventProducerFor(pi.events, "workspaces")
        : undefined;
      let workspaces: ReturnType<typeof createWorkspaceManager> | undefined;
      if (
        configuration.flags.workspaces &&
        projectTrusted &&
        project.kind === "git" &&
        !project.bare
      ) {
        const state = stateStore();
        if (state.ok) {
          const workspaceBase =
            process.platform === "win32"
              ? path.join(
                  process.env.LOCALAPPDATA ?? agentDir,
                  "pi-agent",
                  "workspaces",
                )
              : path.join(agentDir, "workspaces");
          workspaces = createWorkspaceManager({
            project,
            projectTrusted,
            workspaceRoot: path.join(
              workspaceBase,
              project.projectId
                .slice(project.projectId.indexOf(":") + 1)
                .slice(0, 16),
            ),
            stateStore: state.value,
            ...(workspaceHookEvents ? { hookEvents: workspaceHookEvents } : {}),
          });
          const recovery = await workspaces.recover();
          if (ctx.hasUI) {
            if (!recovery.ok) {
              ctx.ui.notify(recovery.error.message, "error");
            } else {
              for (const blocked of recovery.value.blocked) {
                ctx.ui.notify(
                  `Workspace ${blocked.workspaceId} recovery blocked: ${blocked.reason}`,
                  "warning",
                );
              }
            }
          }
        } else if (ctx.hasUI) {
          ctx.ui.notify(state.error.message, "error");
        }
      }
      const workspaceProvider =
        options.currentWorkspaceLeaseProvider ??
        (workspaces && project.kind === "git" && !project.bare
          ? createCurrentWorkspaceLeaseProvider({
              manager: workspaces,
              projectIdentity,
              project,
              sessionId: ctx.sessionManager.getSessionId(),
            })
          : undefined);

      if (memoryEnabled) {
        const bindings = createHostMemoryBindingFactory({
          async revalidate(assertion) {
            const authority = memoryAuthority;
            if (
              !authority ||
              runtime !== authority.runtime ||
              assertion.executionRole !== role ||
              assertion.project?.projectId !== authority.project.projectId ||
              assertion.project.canonicalCwd !==
                authority.project.canonicalCwd ||
              (assertion.sessionId !== undefined &&
                assertion.sessionId !== authority.sessionId)
            ) {
              return undefined;
            }
            if (!assertion.workspace) return assertion;
            const workspace = await authority.workspaceProvider?.current();
            return workspace ? { ...assertion, workspace } : undefined;
          },
        });
        memoryCapability ??= createMemoryCapability(pi, {
          role,
          policy,
          mode: () => ({ kind: platformMode() }),
          bindings,
        });
        current.memory = memoryCapability;
        memoryAuthority = {
          runtime: current,
          project,
          sessionId: ctx.sessionManager.getSessionId(),
          ...(workspaceProvider ? { workspaceProvider } : {}),
        };
      }

      if (messagingEnabled) {
        messagingCapability ??= createMessagingCapability({
          pi,
          policy,
          mode: platformMode,
        });
        current.messaging = messagingCapability;
      }

      let toolFederation: ToolFederation | undefined;
      if (configuration.flags.mcp) {
        const oauthServers = configuration.mcpServers.flatMap((server) =>
          "oauth" in server && server.oauth ? [server.oauth] : [],
        );
        let authorization:
          import("./mcp/oauth.ts").McpAuthorization | undefined;
        if (oauthServers.length > 0 && credentialVault) {
          const state = stateStore();
          if (state.ok) {
            const [
              { createMcpCredentialReferences },
              oauthModule,
              protocolModule,
            ] = await Promise.all([
              import("./mcp/references.ts"),
              import("./mcp/oauth.ts"),
              import("./mcp/official-oauth.ts"),
            ]);
            const references = createMcpCredentialReferences({
              store: state.value,
              scope: project.projectId,
            });
            const protocols = new Map<
              string,
              import("./mcp/oauth.ts").McpOAuthProtocol
            >();
            const protocolFor = (
              server: import("./mcp/oauth.ts").McpOAuthServer,
            ) => {
              let current = protocols.get(server.id);
              if (current) return current;
              const allowedOrigin = new URL(server.authorizationServer).origin;
              current = protocolModule.createOfficialMcpOAuthProtocol({
                authorizeUrl: async (url) => {
                  const decision = await externalControls.assess({
                    integration: "mcp",
                    operation: "oauth",
                    effect: "network-read",
                    actor: role,
                    mode: platformMode(),
                    destination: {
                      url,
                      allowedOrigins: [allowedOrigin],
                      allowLoopback: false,
                    },
                  });
                  return decision.kind === "allow"
                    ? {
                        allowed: true,
                        canonicalUrl: decision.canonicalUrl,
                        resolvedAddresses: decision.resolvedAddresses,
                      }
                    : { allowed: false };
                },
              });
              protocols.set(server.id, current);
              return current;
            };
            const protocol: import("./mcp/oauth.ts").McpOAuthProtocol = {
              authorizationUrl: (request) =>
                protocolFor(request.server).authorizationUrl(request),
              exchange: (request) =>
                protocolFor(request.server).exchange(request),
              refresh: (request) =>
                protocolFor(request.server).refresh(request),
              revoke: (request) => protocolFor(request.server).revoke(request),
            };
            authorization = oauthModule.createMcpAuthorization({
              vault: credentialVault,
              references,
              protocol,
            });
          } else if (ctx.hasUI) {
            ctx.ui.notify(state.error.message, "error");
          }
        }
        mcpCapability ??= createMcpCapability(pi, {
          issueAuthority: () => ({
            kind: "external-user-authority",
            value: authorityValue,
          }),
        });
        current.mcp = mcpCapability;
        const officialAdapterOptions = {
          authorizeUrl: async (server: McpServerDefinition, url: string) => {
            if (server.transport.kind !== "http") return { allowed: false };
            const decision = await externalControls.assess({
              integration: "mcp",
              operation: "http-request",
              effect: "network-read",
              actor: role,
              mode: platformMode(),
              destination: {
                url,
                allowedOrigins: server.transport.allowedOrigins,
                allowLoopback: server.transport.allowLoopback ?? false,
              },
            });
            return decision.kind === "allow"
              ? {
                  allowed: true,
                  canonicalUrl: decision.canonicalUrl,
                  resolvedAddresses: decision.resolvedAddresses,
                }
              : { allowed: false };
          },
          tokenFor: async (server: McpServerDefinition) => {
            if (server.oauth && authorization)
              return authorization.token(server.oauth);
            const reference = server.credentialReference;
            if (typeof reference !== "string") return undefined;
            return credentialVault.resolve(reference, {
              integration: "mcp",
              resourceId: server.id,
              ...(server.transport.kind === "http"
                ? { origin: new URL(server.transport.url).origin }
                : {}),
            });
          },
          refreshTokenFor: async (server: McpServerDefinition) => {
            if (!server.oauth || !authorization)
              throw new Error("MCP OAuth refresh is unavailable.");
            const refreshed = await authorization.refresh(server.oauth);
            if (!refreshed.ok) throw new Error(refreshed.error.message);
          },
        };
        let actualMcpAdapter: Promise<McpTransportAdapter> | undefined;
        const adapter: McpTransportAdapter = options.mcpAdapter ?? {
          async connect(server, signal) {
            actualMcpAdapter ??= import("./mcp/official-adapter.ts").then(
              ({ createOfficialMcpAdapter }) =>
                createOfficialMcpAdapter(officialAdapterOptions),
            );
            return (await actualMcpAdapter).connect(server, signal);
          },
        };
        const { createToolFederation } = await import("./mcp/index.ts");
        toolFederation = createToolFederation({
          servers: configuration.mcpServers,
          adapter,
          controls: externalControls,
          artifacts: artifactStore(),
          projectId: project.projectId,
          context: { actor: role, mode: platformMode },
        });
        mcpCapability.start(toolFederation, {
          authorization,
          oauthServers,
          ...(ctx.hasUI ? { ui: ctx.ui } : {}),
        });
      }

      if (configuration.flags.browser) {
        browserCapability ??= createBrowserCapability(pi, {
          issueAuthority: (scope) => ({
            kind: "external-user-authority",
            value: authorityValue,
            scope,
          }),
        });
        current.browser = browserCapability;
        const executablePath = installedBrowserExecutable(
          configuration.browser.executablePath,
        );
        if (!executablePath) {
          if (ctx.hasUI)
            ctx.ui.notify(
              "Browser capability is enabled but no configured Chrome/Edge executable exists.",
              "warning",
            );
        } else {
          let actualBrowserAdapter: Promise<BrowserAdapter> | undefined;
          const adapter: BrowserAdapter = options.browserAdapter ?? {
            async start(browserOptions, signal) {
              actualBrowserAdapter ??= import("./browser/playwright.ts").then(
                ({ createPlaywrightBrowserAdapter }) =>
                  createPlaywrightBrowserAdapter(),
              );
              return (await actualBrowserAdapter).start(browserOptions, signal);
            },
          };
          const { createBrowserControl } = await import("./browser/index.ts");
          browserCapability.start(
            createBrowserControl({
              projectId: project.projectId,
              credentialScope: browserProfileScope(agentDir, project.projectId),
              profileDirectory: path.join(
                platformBrowserProfileRoot(agentDir),
                browserProfileScope(agentDir, project.projectId),
                configuration.browser.profileName,
              ),
              executablePath,
              allowedOrigins: configuration.browser.allowedOrigins,
              allowLoopback: configuration.browser.allowLoopback,
              controls: externalControls,
              ...(credentialVault ? { credentials: credentialVault } : {}),
              artifacts: artifactStore(),
              adapter,
              context: { actor: role, mode: platformMode },
            }),
            {
              ...(ctx.hasUI ? { ui: ctx.ui } : {}),
              credentials: credentialVault,
              credentialScope: browserProfileScope(agentDir, project.projectId),
            },
          );
        }
      }

      const namedProfileExecution = configuration.flags.hooks
        ? namedProfileExecutionPortFor(pi.events)
        : undefined;
      const scheduledAgentExecutor =
        configuration.flags.scheduler && projectTrusted
          ? scheduledAgentExecutorFor(pi.events)
          : undefined;
      const profilesNeeded =
        configuration.flags.profiles ||
        (configuration.flags.hooks && namedProfileExecution !== undefined);
      let profiles: ProfileCatalog | undefined;
      const loadProfiles = async () => {
        if (profiles) return profiles;
        const candidate = (
          options.createProfileCatalog ?? createProfileCatalog
        )({
          agentDir,
        });
        const projectRoot =
          project.kind === "git" && !project.bare
            ? project.repositoryRoot
            : project.canonicalCwd;
        const snapshot = await candidate.reload({
          projectRoot,
          projectTrusted,
        });
        if (ctx.hasUI) {
          for (const diagnostic of snapshot.diagnostics) {
            if (diagnostic.severity === "error") {
              ctx.ui.notify(
                `Agent profile ${diagnostic.path}: ${diagnostic.message}`,
                "warning",
              );
            }
          }
        }
        profiles = candidate;
        return profiles;
      };
      if (profilesNeeded) await loadProfiles();
      if (configuration.flags.profiles || configuration.flags.workspaces) {
        current.unbindAgentServices = bindPlatformAgentServices(pi.events, {
          ...(configuration.flags.profiles && profiles ? { profiles } : {}),
          ...(workspaces ? { workspaces } : {}),
        });
      }

      let languageIntelligence: LanguageIntelligence | undefined;
      if (configuration.flags.languageIntelligence) {
        let actualLanguage: Promise<LanguageIntelligence> | undefined;
        const getLanguage = () =>
          (actualLanguage ??= import("./language/intelligence.ts").then(
            ({ createLanguageIntelligence }) =>
              createLanguageIntelligence({
                lifecycle,
                project,
                servers:
                  configuration.languageServers.length > 0
                    ? configuration.languageServers
                    : builtInLanguageServers(),
                adapter: {
                  async connect(request, signal) {
                    const { createStdioLanguageServerAdapter } =
                      await import("./language/stdio.ts");
                    return createStdioLanguageServerAdapter().connect(
                      request,
                      signal,
                    );
                  },
                } satisfies LanguageServerAdapter,
                artifacts: artifactStore(),
              }),
          ));
        languageIntelligence = {
          async discover() {
            return (await getLanguage()).discover();
          },
          async synchronize(updates, signal) {
            return (await getLanguage()).synchronize(updates, signal);
          },
          async query(request, signal) {
            return (await getLanguage()).query(request, signal);
          },
        };
        languageCapability ??= createLanguageCapability(pi);
        languageCapability.start(languageIntelligence);
        current.language = languageCapability;
      }

      if (configuration.flags.review) {
        reviewCapability ??= createReviewCapability(pi, {});
        current.review = reviewCapability;
      }

      if (
        configuration.flags.review &&
        projectTrusted &&
        project.kind === "git" &&
        !project.bare
      ) {
        const reviewer = {
          review: (request: ReviewRequest) =>
            localReviewerFor(pi.events).review(request),
        };
        let localReviewPromise: Promise<LocalReview> | undefined;
        const localReview: LocalReview = {
          async run(target, reviewOptions) {
            localReviewPromise ??= Promise.all([
              import("./review/index.ts"),
              import("./review/git.ts"),
              import("./review/language-evidence.ts"),
              import("./review/test-evidence.ts"),
            ]).then(
              ([reviewModule, gitModule, languageEvidence, testEvidence]) =>
                reviewModule.createLocalReview({
                  projectId: project.projectId,
                  artifacts: artifactStore(),
                  git: gitModule.createReviewGitAdapter({
                    root: project.repositoryRoot,
                    projectId: project.projectId,
                  }),
                  reviewer,
                  secondReviewer: reviewer,
                  evidence: [
                    ...(languageIntelligence
                      ? [
                          languageEvidence.createLanguageReviewEvidence(
                            languageIntelligence,
                          ),
                        ]
                      : []),
                    testEvidence.createDisposableTestEvidence(
                      project.repositoryRoot,
                    ),
                  ],
                }),
            );
            return (await localReviewPromise).run(target, reviewOptions);
          },
        };
        reviewCapability!.start(localReview);
      }

      if (configuration.flags.planMode) {
        planCapability ??= createPlanCapability({
          pi,
          agentDir,
          actor: role,
          policy,
          configuration: configuration.plan,
        });
        current.plan = planCapability;
        await current.plan.start({ project, projectTrusted, ctx });
      }
      if (configuration.flags.rules) {
        rulesCapability ??= createRulesCapability({
          pi,
          agentDir,
          actor: role,
          policy,
        });
        current.rules = rulesCapability;
        await current.rules.start({ project, projectTrusted, ctx });
      }
      const triggerEngine = () => {
        if (current.triggers) return current.triggers;
        const state = stateStore();
        if (!state.ok) {
          if (ctx.hasUI) ctx.ui.notify(state.error.message, "error");
          return undefined;
        }
        current.triggers = (options.createTriggerEngine ?? createTriggerEngine)(
          {
            hostId: `platform-${createHash("sha256")
              .update(ctx.sessionManager.getSessionId())
              .digest("hex")
              .slice(0, 24)}`,
            persistence: createStateStoreTriggerPersistence(state.value, {
              authenticator: createKeyringTriggerRecordAuthenticator({
                account: `durable-record-${createHash("sha256")
                  .update(path.resolve(agentDir).toLowerCase())
                  .digest("hex")
                  .slice(0, 32)}`,
                lockDirectory: path.join(
                  agentDir,
                  "state",
                  "trigger-authentication.lock",
                ),
              }),
            }),
          },
        );
        return current.triggers;
      };
      if (configuration.flags.hooks) {
        const triggers = triggerEngine();
        if (triggers) {
          hooksCapability ??= createHooksCapability({
            pi,
            agentDir,
            actor: role,
            policy,
            mode: platformMode,
            adapters: {
              ...(configuration.hookActions.http.length > 0
                ? {
                    http: (
                      options.createNamedHookHttpAdapter ??
                      createNamedHookHttpAdapter
                    )({
                      definitions: configuration.hookActions.http,
                      controls: externalControls,
                      credentials: credentialVault,
                      actor: () => role,
                      mode: platformMode,
                      issueAuthority(grant) {
                        const now = Date.now();
                        for (const [value, existing] of hookAuthorities) {
                          if (existing.deadlineMs < now)
                            hookAuthorities.delete(value);
                        }
                        if (hookAuthorities.size >= 256) {
                          const oldest = hookAuthorities.keys().next().value;
                          if (oldest) hookAuthorities.delete(oldest);
                        }
                        const value = randomUUID();
                        hookAuthorities.set(value, grant);
                        return {
                          kind: "external-user-authority",
                          value,
                          scope: grant.scope,
                        };
                      },
                    }),
                  }
                : {}),
              ...(configuration.hookActions.mcp.length > 0 && toolFederation
                ? {
                    mcp: (
                      options.createNamedHookMcpAdapter ??
                      createNamedHookMcpAdapter
                    )({
                      definitions: configuration.hookActions.mcp,
                      federation: toolFederation,
                      controls: externalControls,
                    }),
                  }
                : {}),
              ...(profiles && namedProfileExecution
                ? {
                    agent: (
                      options.createNamedHookAgentAdapter ??
                      createNamedHookAgentAdapter
                    )({
                      profiles,
                      execution: namedProfileExecution,
                      controls: externalControls,
                    }),
                  }
                : {}),
            },
          });
          const hooks = hooksCapability;
          current.hooks = hooks;
          await hooks.start({ project, projectTrusted, ctx, triggers }, event);
          publishPlatformEvent = (envelope) => {
            current.hookEventTail = (current.hookEventTail ?? Promise.resolve())
              .then(async () => {
                if (runtime !== current || current.hooks !== hooks) return;
                await hooks.handlePlatformEvent(envelope.event, {
                  ...envelope.payload,
                  producerSource: envelope.source,
                });
              })
              .catch(() => undefined);
            return current.hookEventTail;
          };
          for (const envelope of queuedPlatformEvents.splice(0)) {
            await publishPlatformEvent(envelope);
          }
        }
      }
      if (memoryEnabled) {
        if (ctx.hasUI && !(await workspaceProvider?.current())) {
          ctx.ui.notify(
            "Workspace Memory is unavailable without a verified current workspace lease. Choose user or project scope explicitly.",
            "warning",
          );
        }
        const createPersistence =
          options.createMemoryPersistenceAdapter ??
          createSqliteMemoryPersistenceAdapter;
        current.memory!.start({
          module: createMemoryStoreModule({
            persistence: createLazyMemoryPersistenceAdapter(() =>
              createPersistence({
                path: path.join(agentDir, "state", "memory.sqlite"),
              }),
            ),
            artifacts: artifactStore(),
          }),
          project,
          defaultScope: configuration.memory.defaultScope,
          ...(workspaceProvider ? { workspaceProvider } : {}),
        });
      }
      if (messagingEnabled) {
        const state = stateStore();
        if (!state.ok) {
          if (ctx.hasUI) ctx.ui.notify(state.error.message, "error");
        } else {
          try {
            const delivery = (
              options.createSessionDeliveryAdapter ??
              createPiSessionDeliveryAdapter
            )(pi, ctx);
            current.messagingDelivery = delivery;
            await current.messaging!.start({
              brokerModule: (
                options.createSessionBrokerModule ?? createSessionBrokerModule
              )({
                state: state.value,
                artifacts: artifactStore(),
                lifecycle,
              }),
              binding: {
                piSessionId: ctx.sessionManager.getSessionId(),
                proof: issueHostSessionProof(),
                executionRole: role,
                project,
                cwd: ctx.cwd,
                exposure: configuration.messaging,
              },
              delivery,
            });
          } catch (error) {
            current.messagingDelivery?.handleEvent({
              type: "session_shutdown",
            });
            current.messagingDelivery = undefined;
            if (ctx.hasUI) {
              ctx.ui.notify(
                error instanceof Error ? error.message : String(error),
                "error",
              );
            }
          }
        }
      }

      const broker: SessionBroker | undefined =
        current.messaging?.sessionBroker();
      const monitorRequested = configuration.flags.monitors && projectTrusted;
      const schedulerRequested =
        configuration.flags.scheduler && projectTrusted;
      if ((monitorRequested || schedulerRequested) && !broker) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Phase 7 automation requires an active Session Broker; Monitor and Scheduler activation was denied.",
            "error",
          );
        }
      } else if (broker) {
        let automationCoreStarted = false;
        const projectScope = createHash("sha256")
          .update(project.projectId)
          .digest("hex");
        const credentialFor = async (
          reference: string,
          destination: string,
        ) => {
          const inspected = await credentialVault.inspect(reference);
          const binding = inspected.binding;
          if (
            !inspected.exists ||
            !binding ||
            binding.integration !== "monitor" ||
            binding.origin !== destination ||
            (binding.scope !== undefined && binding.scope !== projectScope)
          ) {
            return undefined;
          }
          return credentialVault.resolve(reference, binding);
        };
        const monitorCredentialAllowed = async (
          definition: Parameters<
            MonitorAuthority["authorize"]
          >[0]["definition"],
          origin: string,
        ) => {
          const reference =
            "credentialReference" in definition.source
              ? definition.source.credentialReference
              : undefined;
          if (!reference) return true;
          const inspected = await credentialVault.inspect(reference);
          const binding = inspected.binding;
          if (
            !inspected.exists ||
            !binding ||
            binding.integration !== "monitor" ||
            binding.resourceId !== definition.id ||
            binding.origin !== origin ||
            (binding.scope !== undefined && binding.scope !== projectScope)
          ) {
            return false;
          }
          return true;
        };
        const monitorAuthority: MonitorAuthority = {
          async authorize(request) {
            const denied = () => ({
              ok: false as const,
              error: {
                code: "authority_denied" as const,
                message: "Reactive Monitor authority revalidation failed.",
                retryable: false,
              },
            });
            if (
              runtime !== current ||
              !ctx.isProjectTrusted() ||
              request.projectId !== project.projectId ||
              request.cwd !== project.canonicalCwd
            ) {
              return denied();
            }
            const currentProject = await projectIdentity.resolve(request.cwd);
            if (
              !currentProject.ok ||
              currentProject.value.projectId !== project.projectId ||
              currentProject.value.canonicalCwd !== project.canonicalCwd
            ) {
              return denied();
            }
            const source = request.definition.source;
            if (source.kind === "terminal") {
              return request.definition.scope === "session"
                ? { ok: true as const, value: { allowed: true as const } }
                : denied();
            }
            if (source.kind === "file") {
              const sourceProject = await projectIdentity.resolve(source.root);
              const projectRoot =
                project.kind === "git" && !project.bare
                  ? project.currentWorktree
                  : project.canonicalCwd;
              if (!sourceProject.ok) return denied();
              const relative = path.relative(
                projectRoot,
                sourceProject.value.canonicalCwd,
              );
              if (
                sourceProject.value.projectId !== project.projectId ||
                relative === ".." ||
                relative.startsWith(`..${path.sep}`) ||
                path.isAbsolute(relative)
              ) {
                return denied();
              }
              return { ok: true, value: { allowed: true } };
            }
            if (source.kind === "poll") {
              const target = configuration.monitors.pollTargets.find(
                ({ id }) => id === source.adapter,
              );
              if (
                !target ||
                target.credentialReference !== source.credentialReference ||
                !(await monitorCredentialAllowed(
                  request.definition,
                  new URL(target.endpoint).origin,
                ))
              ) {
                return denied();
              }
              const decision = await externalControls.assess({
                integration: "monitor",
                operation: target.id,
                effect: "network-read",
                actor: role,
                mode: platformMode(),
                destination: {
                  url: target.endpoint,
                  allowedOrigins: target.allowedOrigins,
                  allowLoopback: target.allowLoopback,
                },
              });
              return decision.kind === "allow"
                ? { ok: true, value: { allowed: true } }
                : denied();
            }
            const socket = new URL(source.url);
            if (
              socket.search ||
              !configuration.monitors.allowedWebSocketOrigins.includes(
                socket.origin,
              ) ||
              !(await monitorCredentialAllowed(
                request.definition,
                socket.origin,
              ))
            ) {
              return denied();
            }
            const httpUrl = new URL(socket.href);
            httpUrl.protocol = socket.protocol === "wss:" ? "https:" : "http:";
            const allowedOrigins =
              configuration.monitors.allowedWebSocketOrigins.map((origin) => {
                const value = new URL(origin);
                value.protocol = value.protocol === "wss:" ? "https:" : "http:";
                return value.origin;
              });
            const decision = await externalControls.assess({
              integration: "monitor",
              operation: request.definition.id,
              effect: "network-read",
              actor: role,
              mode: platformMode(),
              destination: {
                url: httpUrl.href,
                allowedOrigins,
                allowLoopback: configuration.monitors.allowLoopback,
              },
            });
            return decision.kind === "allow"
              ? { ok: true, value: { allowed: true } }
              : denied();
          },
        };

        if (monitorRequested && isReleasableLifecycleSupervisor(lifecycle)) {
          const triggers = triggerEngine();
          const state = stateStore();
          if (triggers && state.ok) {
            try {
              const pollAdapters = Object.fromEntries(
                configuration.monitors.pollTargets.map((target) => {
                  const authorize = async (request: {
                    readonly url: string;
                    readonly credentialReference?: string;
                  }) => {
                    if (
                      request.url !== target.endpoint ||
                      request.credentialReference !== target.credentialReference
                    ) {
                      return {
                        ok: false as const,
                        error: {
                          code: "policy_denied" as const,
                          message: "Named Monitor poll target changed.",
                          retryable: false,
                        },
                      };
                    }
                    const decision = await externalControls.assess({
                      integration: "monitor",
                      operation: target.id,
                      effect: "network-read",
                      actor: role,
                      mode: platformMode(),
                      destination: {
                        url: target.endpoint,
                        allowedOrigins: target.allowedOrigins,
                        allowLoopback: target.allowLoopback,
                      },
                    });
                    const addresses = decision.resolvedAddresses
                      ?.map((address) => ({ address, family: isIP(address) }))
                      .filter(
                        (
                          entry,
                        ): entry is {
                          address: string;
                          family: 4 | 6;
                        } => entry.family === 4 || entry.family === 6,
                      );
                    return decision.kind === "allow" &&
                      decision.canonicalUrl === target.endpoint &&
                      addresses?.length
                      ? {
                          ok: true as const,
                          value: {
                            canonicalUrl: target.endpoint,
                            addresses,
                          },
                        }
                      : {
                          ok: false as const,
                          error: {
                            code: "policy_denied" as const,
                            message: "Named Monitor poll target was denied.",
                            retryable: false,
                          },
                        };
                  };
                  return [
                    target.id,
                    createJsonPollAdapter({
                      endpoint: target.endpoint,
                      authorize,
                      resolveCredential: credentialFor,
                      maxResponseBytes: target.maxResponseBytes,
                      pinnedFetch: async (request) => {
                        const fetch = createPinnedFetch({
                          authorize: async (url) => ({
                            allowed: url === request.canonicalUrl,
                            canonicalUrl: request.canonicalUrl,
                            resolvedAddresses: request.addresses.map(
                              ({ address }) => address,
                            ),
                          }),
                        });
                        return fetch(request.canonicalUrl, {
                          method: request.method,
                          redirect: request.redirect,
                          signal: request.signal,
                          headers: request.headers,
                        });
                      },
                    }),
                  ] as const;
                }),
              );
              const webSocketControl = {
                async authorize(request: {
                  readonly url: string;
                  readonly credentialReference?: string;
                }) {
                  const socket = new URL(request.url);
                  if (socket.search) {
                    return {
                      ok: false as const,
                      error: {
                        code: "policy_denied" as const,
                        message: "Monitor WebSocket query strings are denied.",
                        retryable: false,
                      },
                    };
                  }
                  const httpUrl = new URL(socket.href);
                  httpUrl.protocol =
                    socket.protocol === "wss:" ? "https:" : "http:";
                  const decision = await externalControls.assess({
                    integration: "monitor",
                    operation: "websocket",
                    effect: "network-read",
                    actor: role,
                    mode: platformMode(),
                    destination: {
                      url: httpUrl.href,
                      allowedOrigins:
                        configuration.monitors.allowedWebSocketOrigins.map(
                          (origin) => {
                            const value = new URL(origin);
                            value.protocol =
                              value.protocol === "wss:" ? "https:" : "http:";
                            return value.origin;
                          },
                        ),
                      allowLoopback: configuration.monitors.allowLoopback,
                    },
                  });
                  const addresses = decision.resolvedAddresses
                    ?.map((address) => ({ address, family: isIP(address) }))
                    .filter(
                      (entry): entry is { address: string; family: 4 | 6 } =>
                        entry.family === 4 || entry.family === 6,
                    );
                  return decision.kind === "allow" && addresses?.length
                    ? {
                        ok: true as const,
                        value: { canonicalUrl: request.url, addresses },
                      }
                    : {
                        ok: false as const,
                        error: {
                          code: "policy_denied" as const,
                          message: "Monitor WebSocket target was denied.",
                          retryable: false,
                        },
                      };
                },
              };
              const terminal = terminalObservationSourceFor(pi.events);
              const sources = (
                options.createMonitorSourceFactory ??
                createProductionMonitorSourceFactory
              )({
                ...(terminal ? { terminal } : {}),
                filesystem: {},
                ...(Object.keys(pollAdapters).length > 0
                  ? {
                      poll: {
                        adapters: pollAdapters,
                        minimumIntervalMs: configuration.monitors.pollMinimumMs,
                      },
                    }
                  : {}),
                ...(configuration.monitors.allowedWebSocketOrigins.length > 0
                  ? {
                      websocket: {
                        allowedOrigins:
                          configuration.monitors.allowedWebSocketOrigins,
                        control: webSocketControl,
                        resolveCredential: credentialFor,
                      },
                    }
                  : {}),
              });
              const opened = await (
                options.createMonitorRegistry ?? createMonitorRegistry
              )({
                ownerId: `monitors-${projectScope.slice(0, 24)}`,
                binding: {
                  projectId: project.projectId,
                  cwd: project.canonicalCwd,
                  sessionId: ctx.sessionManager.getSessionId(),
                },
                triggers,
                lifecycle,
                artifacts: artifactStore(),
                sources,
                delivery: createSessionBrokerMonitorDelivery(broker),
                authority: monitorAuthority,
                credentialCanaries: async (definition) => {
                  const source = definition.source;
                  const reference =
                    "credentialReference" in source
                      ? source.credentialReference
                      : undefined;
                  if (!reference) return [];
                  const destination =
                    source.kind === "poll"
                      ? configuration.monitors.pollTargets.find(
                          ({ id }) => id === source.adapter,
                        )?.endpoint
                      : source.kind === "websocket"
                        ? source.url
                        : undefined;
                  if (!destination) return [];
                  const canary = await credentialFor(
                    reference,
                    new URL(destination).origin,
                  );
                  return canary === undefined ? [] : [canary];
                },
                hookEvents: platformHookEventProducerFor(pi.events, "monitors"),
                state: state.value,
                configuration: configuration.monitors,
              });
              if (opened.ok) {
                monitorCapability ??= createMonitorCapability({
                  pi,
                  actor: role,
                  policy,
                  mode: platformMode,
                  sessionId: () => ctx.sessionManager.getSessionId(),
                });
                current.monitors = monitorCapability;
                await current.monitors.start(opened.value);
                automationCoreStarted = true;
              } else if (ctx.hasUI) {
                ctx.ui.notify(opened.error.message, "error");
              }
            } catch (error) {
              if (ctx.hasUI) {
                ctx.ui.notify(
                  error instanceof Error ? error.message : String(error),
                  "error",
                );
              }
            }
          }
        } else if (monitorRequested && ctx.hasUI) {
          ctx.ui.notify(
            "Reactive Monitors require a releasable LifecycleSupervisor.",
            "error",
          );
        }

        if (schedulerRequested && scheduledAgentExecutor) {
          const triggers = triggerEngine();
          const state = stateStore();
          const schedulerProfiles = await loadProfiles();
          if (triggers && state.ok && schedulerProfiles) {
            try {
              const opened = await (options.createScheduler ?? createScheduler)(
                {
                  state: state.value,
                  artifacts: artifactStore(),
                  clock: (
                    options.createSchedulerClock ?? createSystemSchedulerClock
                  )(),
                  authority: createSchedulerHostAuthority({
                    projects: projectIdentity,
                    profiles: schedulerProfiles,
                    projectTrusted: (candidate) =>
                      runtime === current &&
                      ctx.isProjectTrusted() &&
                      candidate.projectId === project.projectId &&
                      candidate.canonicalCwd === project.canonicalCwd,
                    credentialsAvailable: async (references) => {
                      const statuses = await Promise.all(
                        references.map((reference) =>
                          credentialVault.inspect(reference),
                        ),
                      );
                      return statuses.every(({ exists }) => exists);
                    },
                  }),
                  executor: scheduledAgentExecutor,
                  delivery: createSessionBrokerScheduleDelivery(broker),
                  hookEvents: platformHookEventProducerFor(
                    pi.events,
                    "scheduler",
                  ),
                  ownerId: `scheduler-${projectScope.slice(0, 24)}`,
                  binding: {
                    project,
                    cwd: project.canonicalCwd,
                    creatorSessionId: ctx.sessionManager.getSessionId(),
                    resultRoute: {
                      kind: "session",
                      sessionId: ctx.sessionManager.getSessionId(),
                    },
                  },
                  configuration: configuration.scheduler,
                },
              );
              if (opened.ok) {
                schedulerCapability ??= createSchedulerCapability({
                  pi,
                  actor: role,
                  policy,
                  mode: platformMode,
                });
                current.scheduler = schedulerCapability;
                await current.scheduler.start(opened.value);
                automationCoreStarted = true;
              } else if (ctx.hasUI) {
                ctx.ui.notify(opened.error.message, "error");
              }
            } catch (error) {
              if (ctx.hasUI) {
                ctx.ui.notify(
                  error instanceof Error ? error.message : String(error),
                  "error",
                );
              }
            }
          }
        } else if (schedulerRequested && ctx.hasUI) {
          ctx.ui.notify(
            "Scheduler requires the host Scheduled Agent execution service.",
            "error",
          );
        }

        if (!automationCoreStarted && !configuration.flags.hooks) {
          await current.triggers?.close("inactive");
          current.triggers = undefined;
        }
      }
    });
    pi.on("session_shutdown", async (event) => {
      const current = runtime;
      runtime = undefined;
      if (!current) return;
      await teardown(current, event.reason, event);
    });
  };
}
