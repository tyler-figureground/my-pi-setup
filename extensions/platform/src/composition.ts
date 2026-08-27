import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  createLifecycleSupervisor,
  type LifecycleResource,
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
import type { BrowserAdapter } from "./browser/index.ts";
import type { CredentialVault } from "./external/credentials.ts";
import { createExternalIntegrationControls } from "./external/index.ts";
import type { McpServerDefinition, McpTransportAdapter } from "./mcp/index.ts";
import { bindPlatformAgentServices } from "./agents/services.ts";
import { createFileSystemArtifactStore } from "./core/artifacts/index.ts";
import { createCapabilityPolicy } from "./core/policy/index.ts";
import { createSqliteStateStore } from "./core/persistence/index.ts";
import {
  createProjectIdentity,
  type ProjectIdentity,
} from "./core/projects/index.ts";
import { decodePlatformFlags } from "./flags.ts";
import { createHooksCapability } from "./wiring/hooks.ts";
import { createPlanCapability } from "./wiring/plan.ts";
import { createRulesCapability } from "./wiring/rules.ts";
import type {
  LanguageIntelligence,
  LanguageServerAdapter,
  LanguageServerDefinition,
} from "./language/model.ts";
import { createProfileCatalog } from "./profiles/index.ts";
import type { LocalReview, ReviewRequest } from "./review/index.ts";
import { localReviewerFor } from "./review/reviewer-service.ts";
import { createLanguageCapability } from "./wiring/language.ts";
import { createReviewCapability } from "./wiring/review.ts";
import { createBrowserCapability } from "./wiring/browser.ts";
import { createMcpCapability } from "./wiring/mcp.ts";
import { createWorkspaceManager } from "./workspaces/index.ts";

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

export interface PlatformExtensionOptions {
  flags?: unknown;
  plan?: Partial<PlatformPlanConfiguration>;
  languageServers?: readonly LanguageServerDefinition[];
  mcpServers?: readonly McpServerDefinition[];
  browser?: PlatformBrowserConfiguration;
  mcpAdapter?: McpTransportAdapter;
  browserAdapter?: BrowserAdapter;
  credentialVault?: CredentialVault;
  agentDir?: string;
  createLifecycleSupervisor?: () => LifecycleSupervisor;
  createProjectIdentity?: () => ProjectIdentity;
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
        };
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

    const teardown = async (
      current: PlatformRuntime,
      reason: "quit" | "reload" | "new" | "resume" | "fork",
      event: unknown,
    ) => {
      const failures: unknown[] = [];
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
        current.unbindAgentServices?.();
      } catch (error) {
        failures.push(error);
      }
      try {
        await current.hooks?.stop(reason, event);
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
        await current.lifecycle.shutdown(reason);
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
        configuration.flags.browser;
      if (!platformEnabled || role !== "parent") return;

      const resolved = await makeProjectIdentity().resolve(ctx.cwd);
      if (!resolved.ok) {
        if (ctx.hasUI) {
          ctx.ui.notify(resolved.error.message, "error");
        }
        return;
      }
      const project = resolved.value;
      const artifacts =
        configuration.flags.languageIntelligence ||
        configuration.flags.review ||
        configuration.flags.mcp ||
        configuration.flags.browser
          ? createFileSystemArtifactStore({
              root: platformArtifactRoot(agentDir),
            })
          : undefined;
      const platformMode = () => {
        const state = runtime?.plan?.mode()?.status().state;
        return state === "planning" || state === "approval-pending"
          ? ("plan" as const)
          : ("normal" as const);
      };
      const externalControls = createExternalIntegrationControls({
        policy,
        authority: {
          verify: (token) => token.value === authorityValue,
        },
      });
      const credentialVault =
        options.credentialVault ?? createLazyCredentialVault();

      if (configuration.flags.mcp) {
        const oauthServers = configuration.mcpServers.flatMap((server) =>
          "oauth" in server && server.oauth ? [server.oauth] : [],
        );
        let authorization:
          import("./mcp/oauth.ts").McpAuthorization | undefined;
        if (oauthServers.length > 0 && credentialVault) {
          const state = createSqliteStateStore({
            path: path.join(agentDir, "state", "platform.sqlite"),
          });
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
        mcpCapability.start(
          createToolFederation({
            servers: configuration.mcpServers,
            adapter,
            controls: externalControls,
            ...(artifacts ? { artifacts } : {}),
            projectId: project.projectId,
            context: { actor: role, mode: platformMode },
          }),
          {
            authorization,
            oauthServers,
            ...(ctx.hasUI ? { ui: ctx.ui } : {}),
          },
        );
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
              artifacts: artifacts!,
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

      if (configuration.flags.profiles || configuration.flags.workspaces) {
        const profiles = configuration.flags.profiles
          ? createProfileCatalog({ agentDir })
          : undefined;
        if (profiles) {
          const projectRoot =
            project.kind === "git" && !project.bare
              ? project.repositoryRoot
              : project.canonicalCwd;
          const snapshot = await profiles.reload({
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
        }
        let workspaces;
        if (
          configuration.flags.workspaces &&
          projectTrusted &&
          project.kind === "git" &&
          !project.bare
        ) {
          const state = createSqliteStateStore({
            path: path.join(agentDir, "state", "platform.sqlite"),
          });
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
        current.unbindAgentServices = bindPlatformAgentServices(pi.events, {
          ...(profiles ? { profiles } : {}),
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
                ...(artifacts ? { artifacts } : {}),
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
                  artifacts: artifacts!,
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
      if (configuration.flags.hooks) {
        hooksCapability ??= createHooksCapability({
          pi,
          agentDir,
          actor: role,
          policy,
          mode: () => {
            const state = runtime?.plan?.mode()?.status().state;
            return state === "planning" || state === "approval-pending"
              ? "plan"
              : "normal";
          },
        });
        current.hooks = hooksCapability;
        await current.hooks.start({ project, projectTrusted, ctx }, event);
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
