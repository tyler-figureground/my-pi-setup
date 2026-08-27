import { createHash } from "node:crypto";
import type { ArtifactStore } from "../core/artifacts/model.ts";
import type { CredentialVault } from "../external/credentials.ts";
import type { JsonObject, ModuleError, Outcome } from "../core/result.ts";
import type {
  ExternalIntegrationControls,
  ExternalUserAuthorityToken,
} from "../external/index.ts";
import type { ActorRole } from "../core/policy/index.ts";

export interface BrowserPage {
  readonly id: string;
  readonly url: string;
  readonly title: string;
}

export interface BrowserAdapterPage {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly openerId?: string;
}

export interface BrowserAdapterConnection {
  listPages(signal?: AbortSignal): Promise<readonly BrowserAdapterPage[]>;
  targetIdentity?(
    pageId: string,
    signal?: AbortSignal,
    reference?: string,
  ): Promise<string>;
  openPage(url: string, signal?: AbortSignal): Promise<BrowserAdapterPage>;
  closePage(id: string, signal?: AbortSignal): Promise<void>;
  observe(
    request: { readonly pageId: string; readonly kind: string },
    signal?: AbortSignal,
  ): Promise<unknown>;
  classifyAction?(
    request: {
      readonly pageId: string;
      readonly kind: string;
      readonly input: JsonObject;
    },
    signal?: AbortSignal,
  ): Promise<{
    readonly effect:
      | "read"
      | "local-write"
      | "network-read"
      | "remote-write"
      | "credential-use";
    readonly reason: string;
    readonly destination?: string;
  }>;
  act(
    request: {
      readonly pageId: string;
      readonly kind: string;
      readonly input: JsonObject;
    },
    signal?: AbortSignal,
  ): Promise<unknown>;
  close(): void | Promise<void>;
}

export interface BrowserAdapter {
  start(
    options: {
      readonly profileDirectory: string;
      readonly executablePath: string;
      readonly serviceWorkers: "block";
      readonly authorizeUrl?: (
        url: string,
        request?: {
          readonly method: string;
          readonly mutationApproved: boolean;
        },
        signal?: AbortSignal,
      ) => Promise<boolean>;
      readonly hostResolverRules?: readonly {
        readonly hostname: string;
        readonly address: string;
      }[];
    },
    signal?: AbortSignal,
  ): Promise<BrowserAdapterConnection>;
}

export type BrowserControlErrorCode =
  | "invalid_request"
  | "policy_denied"
  | "approval_required"
  | "browser_unavailable"
  | "page_not_found"
  | "operation_failed"
  | "artifact_unavailable"
  | "credential_unavailable";
export type BrowserControlError = ModuleError<BrowserControlErrorCode>;
export type BrowserControlOutcome<T> = Outcome<T, BrowserControlError>;

export type BrowserActionRequest =
  | {
      readonly kind: "open";
      readonly url: string;
      readonly authority?: ExternalUserAuthorityToken;
    }
  | {
      readonly kind: "close";
      readonly pageId: string;
    }
  | {
      readonly kind: "navigate";
      readonly pageId: string;
      readonly url: string;
    }
  | {
      readonly kind: "click";
      readonly pageId: string;
      readonly ref: string;
      readonly authority?: ExternalUserAuthorityToken;
    }
  | {
      readonly kind: "fill";
      readonly pageId: string;
      readonly ref: string;
      readonly value?: string;
      readonly credentialReference?: string;
      readonly authority?: ExternalUserAuthorityToken;
    }
  | {
      readonly kind: "select";
      readonly pageId: string;
      readonly ref: string;
      readonly value: string;
      readonly authority?: ExternalUserAuthorityToken;
    }
  | {
      readonly kind: "key";
      readonly pageId: string;
      readonly ref: string;
      readonly key: string;
      readonly authority?: ExternalUserAuthorityToken;
    }
  | {
      readonly kind: "scroll";
      readonly pageId: string;
      readonly deltaY: number;
      readonly authority?: ExternalUserAuthorityToken;
    }
  | {
      readonly kind: "wait";
      readonly pageId: string;
      readonly ref: string;
      readonly state: "visible" | "hidden";
    }
  | {
      readonly kind: "upload";
      readonly pageId: string;
      readonly ref: string;
      readonly artifactId: string;
      readonly authority?: ExternalUserAuthorityToken;
    }
  | {
      readonly kind: "download";
      readonly pageId: string;
      readonly ref: string;
      readonly authority?: ExternalUserAuthorityToken;
    };

export type BrowserObservationKind =
  "snapshot" | "screenshot" | "console" | "page-errors" | "network";

export interface BrowserControl {
  status(): {
    readonly state: "idle" | "starting" | "ready" | "failed" | "closed";
    readonly profileDirectory: string;
    readonly pageCount: number;
  };
  pages(signal?: AbortSignal): Promise<readonly BrowserPage[]>;
  observe(
    request: {
      readonly kind: BrowserObservationKind;
      readonly pageId: string;
    },
    signal?: AbortSignal,
  ): Promise<
    BrowserControlOutcome<{
      readonly kind: BrowserObservationKind;
      readonly preview: string;
      readonly truncated: boolean;
      readonly artifactId: string;
    }>
  >;
  act(
    request: BrowserActionRequest,
    signal?: AbortSignal,
  ): Promise<
    BrowserControlOutcome<{
      readonly page: BrowserPage;
      readonly artifactId?: string;
    }>
  >;
  close(): Promise<void>;
}

export interface BrowserControlOptions {
  readonly projectId?: string;
  readonly credentialScope?: string;
  readonly profileDirectory: string;
  readonly executablePath: string;
  readonly allowedOrigins: readonly string[];
  readonly allowLoopback: boolean;
  readonly controls: ExternalIntegrationControls;
  readonly credentials?: CredentialVault;
  readonly artifacts: ArtifactStore;
  readonly adapter: BrowserAdapter;
  readonly context?: {
    readonly actor: ActorRole;
    readonly mode: () => "normal" | "plan";
  };
}

function browserError(
  code: BrowserControlErrorCode,
  message: string,
  retryable = false,
  details?: JsonObject,
): BrowserControlOutcome<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
      ...(details ? { details } : {}),
    },
  };
}

function actionApprovalScope(input: JsonObject) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function createBrowserControl(
  options: BrowserControlOptions,
): BrowserControl {
  if (!options.profileDirectory || !options.executablePath)
    throw new TypeError("Browser profile and executable paths are required.");
  const context = options.context ?? {
    actor: "parent" as const,
    mode: () => "normal" as const,
  };
  const exactRedactions = new Set<string>();
  const sanitize = (
    value: unknown,
    limits: {
      readonly maxStringBytes?: number;
      readonly maxNodes?: number;
      readonly maxDepth?: number;
    } = {},
  ) =>
    options.controls.sanitize(value, {
      ...limits,
      exactRedactions: [...exactRedactions],
    });
  const safeError = (error: unknown) => {
    const value = sanitize(
      error instanceof Error ? error.message : String(error),
      { maxStringBytes: 4_096, maxNodes: 8, maxDepth: 2 },
    ).value;
    return typeof value === "string" ? value : "External browser error.";
  };
  let state: "idle" | "starting" | "ready" | "failed" | "closed" = "idle";
  let connection: BrowserAdapterConnection | undefined;
  let starting: Promise<BrowserAdapterConnection> | undefined;
  let nextPage = 1;
  let generation = 0;
  let openTail: Promise<void> = Promise.resolve();
  const maxOwnedPages = 16;
  const ownedPages = new Map<
    string,
    { readonly adapterId: string; page: BrowserPage }
  >();

  const start = (signal?: AbortSignal) => {
    if (state === "closed")
      return Promise.reject(new Error("Browser control is closed."));
    if (connection) return Promise.resolve(connection);
    if (starting) return starting;
    state = "starting";
    const startGeneration = ++generation;
    starting = (async () => {
      const hostResolverRules: Array<{
        hostname: string;
        address: string;
      }> = [];
      for (const origin of options.allowedOrigins) {
        const url = new URL(origin);
        const decision = await options.controls.assess({
          integration: "browser",
          operation: "pin-origin",
          effect: "network-read",
          actor: context.actor,
          mode: context.mode(),
          destination: {
            url: origin,
            allowedOrigins: options.allowedOrigins,
            allowLoopback: options.allowLoopback,
          },
        });
        if (decision.kind !== "allow" || !decision.resolvedAddresses?.[0])
          throw new Error(`Browser origin cannot be pinned safely: ${origin}`);
        hostResolverRules.push({
          hostname: url.hostname,
          address: decision.resolvedAddresses[0],
        });
      }
      return options.adapter.start(
        {
          profileDirectory: options.profileDirectory,
          executablePath: options.executablePath,
          serviceWorkers: "block",
          hostResolverRules,
          authorizeUrl: async (url, networkRequest, requestSignal) => {
            const method = networkRequest?.method.toUpperCase() ?? "GET";
            if (method !== "GET" && !networkRequest?.mutationApproved)
              return false;
            const decision = await options.controls.assess({
              integration: "browser",
              operation: "network-request",
              effect: "network-read",
              actor: context.actor,
              mode: context.mode(),
              destination: {
                url,
                allowedOrigins: options.allowedOrigins,
                allowLoopback: options.allowLoopback,
              },
            });
            requestSignal?.throwIfAborted();
            return decision.kind === "allow";
          },
        },
        signal,
      );
    })()
      .then(async (value) => {
        if (state === "closed" || generation !== startGeneration) {
          await value.close();
          throw new Error("Browser startup settled after shutdown.");
        }
        connection = value;
        state = "ready";
        return value;
      })
      .catch((error) => {
        if (state !== "closed" && generation === startGeneration)
          state = "failed";
        throw error;
      })
      .finally(() => {
        starting = undefined;
      });
    return starting;
  };

  const targetEvidence = async (
    current: BrowserAdapterConnection,
    pageId: string,
    signal?: AbortSignal,
    reference?: string,
  ) => {
    const live = (await current.listPages(signal)).find(
      (page) => page.id === pageId,
    );
    if (!live) throw new Error("Browser target page is unavailable.");
    const identity = current.targetIdentity
      ? await current.targetIdentity(pageId, signal, reference)
      : live.url;
    return {
      url: live.url,
      digest: createHash("sha256")
        .update(JSON.stringify({ url: live.url, identity }), "utf8")
        .digest("hex"),
    };
  };

  const currentPages = async (signal?: AbortSignal) => {
    if (!connection) return [];
    const actual = new Map(
      (await connection.listPages(signal)).map((page) => [page.id, page]),
    );
    const pages: BrowserPage[] = [];
    for (const [id, owned] of ownedPages) {
      const page = actual.get(owned.adapterId);
      if (!page) {
        ownedPages.delete(id);
        continue;
      }
      const decision = await options.controls.assess({
        integration: "browser",
        operation: "page-status",
        effect: "network-read",
        actor: context.actor,
        mode: context.mode(),
        destination: {
          url: page.url,
          allowedOrigins: options.allowedOrigins,
          allowLoopback: options.allowLoopback,
        },
      });
      if (decision.kind !== "allow") {
        await connection.closePage(page.id, signal).catch(() => undefined);
        ownedPages.delete(id);
        continue;
      }
      const safeUrl = sanitize(page.url).value;
      const safeTitle = sanitize(page.title, {
        maxStringBytes: 4_096,
        maxNodes: 8,
        maxDepth: 2,
      }).value;
      owned.page = {
        id,
        url: typeof safeUrl === "string" ? safeUrl : page.url,
        title: typeof safeTitle === "string" ? safeTitle : "",
      };
      pages.push(owned.page);
    }
    const claimed = new Set(
      [...ownedPages.values()].map(({ adapterId }) => adapterId),
    );
    for (const page of actual.values()) {
      if (claimed.has(page.id)) continue;
      if (
        !page.openerId ||
        !claimed.has(page.openerId) ||
        ownedPages.size >= maxOwnedPages
      ) {
        await connection.closePage(page.id, signal).catch(() => undefined);
        continue;
      }
      const decision = await options.controls.assess({
        integration: "browser",
        operation: "popup-status",
        effect: "network-read",
        actor: context.actor,
        mode: context.mode(),
        destination: {
          url: page.url,
          allowedOrigins: options.allowedOrigins,
          allowLoopback: options.allowLoopback,
        },
      });
      if (decision.kind !== "allow") {
        await connection.closePage(page.id, signal).catch(() => undefined);
        continue;
      }
      const id = `page-${nextPage++}`;
      const safeUrl = sanitize(page.url).value;
      const safeTitle = sanitize(page.title, {
        maxStringBytes: 4_096,
        maxNodes: 8,
        maxDepth: 2,
      }).value;
      const browserPage = {
        id,
        url: typeof safeUrl === "string" ? safeUrl : page.url,
        title: typeof safeTitle === "string" ? safeTitle : "",
      };
      ownedPages.set(id, { adapterId: page.id, page: browserPage });
      pages.push(browserPage);
    }
    return pages.sort((left, right) => left.id.localeCompare(right.id));
  };

  return {
    status: () => ({
      state,
      profileDirectory: options.profileDirectory,
      pageCount: ownedPages.size,
    }),
    pages: currentPages,
    async observe(request, signal) {
      await currentPages(signal);
      const owned = ownedPages.get(request.pageId);
      if (!owned)
        return browserError(
          "page_not_found",
          `Browser page ${JSON.stringify(request.pageId)} is not owned by this session.`,
        );
      try {
        const current = await start(signal);
        if (request.kind === "screenshot" && exactRedactions.size > 0)
          return browserError(
            "policy_denied",
            "Screenshots are disabled after a credential was used in this browser session.",
          );
        const raw = await current.observe(
          { pageId: owned.adapterId, kind: request.kind },
          signal,
        );
        const value = raw as {
          readonly kind?: unknown;
          readonly text?: unknown;
          readonly records?: unknown;
          readonly mediaType?: unknown;
          readonly base64?: unknown;
        };
        if (value.kind !== request.kind)
          return browserError(
            "operation_failed",
            "Browser adapter returned a mismatched observation.",
          );
        if (request.kind === "screenshot") {
          if (
            value.mediaType !== "image/png" ||
            typeof value.base64 !== "string" ||
            value.base64.length > 24 * 1024 * 1024 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64)
          )
            return browserError(
              "operation_failed",
              "Browser adapter returned an invalid screenshot.",
            );
          const screenshot = Buffer.from(value.base64, "base64");
          if (
            screenshot.length === 0 ||
            screenshot.length > 16 * 1024 * 1024 ||
            screenshot.toString("base64") !== value.base64
          )
            return browserError(
              "operation_failed",
              "Browser screenshot encoding or size is invalid.",
            );
          const stored = await options.artifacts.put({
            body: screenshot,
            filename: "browser-screenshot.png",
            mediaType: "image/png",
            metadata: {
              source: "browser",
              ...(options.projectId ? { projectId: options.projectId } : {}),
              kind: "screenshot",
            },
          });
          if (!stored.ok)
            return browserError("artifact_unavailable", stored.error.message);
          return {
            ok: true,
            value: {
              kind: request.kind,
              preview: `Screenshot stored as artifact ${stored.value.id} (${screenshot.length} bytes).`,
              truncated: false,
              artifactId: stored.value.id,
            },
          };
        }
        let complete: string;
        let extension: "txt" | "json";
        let mediaType: "text/plain" | "application/json";
        if (request.kind === "snapshot") {
          if (typeof value.text !== "string")
            return browserError(
              "operation_failed",
              "Browser adapter returned an invalid snapshot.",
            );
          complete = value.text
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
            .split("\n")
            .map((line) =>
              /\b(?:password|secret|access[_ -]?token|refresh[_ -]?token|authorization|cookie)\b/i.test(
                line,
              )
                ? /(:|\bvalue=)/i.test(line)
                  ? line.replace(/(:|\bvalue=).*/i, "$1 [REDACTED]")
                  : "[REDACTED SENSITIVE CONTROL]"
                : line,
            )
            .join("\n");
          const sanitizedSnapshot = sanitize(complete, {
            maxStringBytes: 16 * 1024 * 1024,
            maxNodes: 8,
            maxDepth: 2,
          }).value;
          complete =
            typeof sanitizedSnapshot === "string"
              ? sanitizedSnapshot
              : "[REDACTED]";
          extension = "txt";
          mediaType = "text/plain";
        } else {
          if (!Array.isArray(value.records))
            return browserError(
              "operation_failed",
              "Browser adapter returned invalid diagnostic records.",
            );
          complete = JSON.stringify(sanitize(raw).value);
          extension = "json";
          mediaType = "application/json";
        }
        const stored = await options.artifacts.put({
          body: complete,
          filename: `browser-${request.kind}.${extension}`,
          mediaType,
          metadata: {
            source: "browser",
            ...(options.projectId ? { projectId: options.projectId } : {}),
            kind: request.kind,
          },
        });
        if (!stored.ok)
          return browserError("artifact_unavailable", stored.error.message);
        const body = Buffer.from(complete);
        const truncated = body.length > 50 * 1024;
        const preview = truncated
          ? `${body.subarray(0, 50 * 1024 - 32).toString("utf8")}\n[TRUNCATED]`
          : complete;
        return {
          ok: true,
          value: {
            kind: request.kind,
            preview,
            truncated,
            artifactId: stored.value.id,
          },
        };
      } catch (error) {
        return browserError("operation_failed", safeError(error), true);
      }
    },
    async act(request, signal) {
      if (request.kind === "open") {
        const predecessor = openTail;
        let releaseOpen!: () => void;
        openTail = new Promise<void>((resolve) => {
          releaseOpen = resolve;
        });
        await predecessor;
        try {
          if (ownedPages.size >= maxOwnedPages)
            return browserError(
              "policy_denied",
              "Browser owned-page limit is reached.",
            );
          const decision = await options.controls.assess(
            {
              integration: "browser",
              operation: "open",
              effect: "network-read",
              actor: context.actor,
              mode: context.mode(),
              destination: {
                url: request.url,
                allowedOrigins: options.allowedOrigins,
                allowLoopback: options.allowLoopback,
              },
            },
            request.authority,
          );
          if (decision.kind !== "allow")
            return browserError(
              decision.kind === "require-user-confirmation"
                ? "approval_required"
                : "policy_denied",
              decision.reason,
            );
          let current: BrowserAdapterConnection;
          try {
            current = await start(signal);
            const opened = await current.openPage(
              decision.canonicalUrl!,
              signal,
            );
            const redirected = await options.controls.assess({
              integration: "browser",
              operation: "open-redirect",
              effect: "network-read",
              actor: context.actor,
              mode: context.mode(),
              destination: {
                url: opened.url,
                allowedOrigins: options.allowedOrigins,
                allowLoopback: options.allowLoopback,
              },
            });
            if (redirected.kind !== "allow") {
              await current.closePage(opened.id, signal);
              return browserError("policy_denied", redirected.reason);
            }
            const id = `page-${nextPage++}`;
            const safeUrl = sanitize(opened.url).value;
            const safeTitle = sanitize(opened.title, {
              maxStringBytes: 4_096,
              maxNodes: 8,
              maxDepth: 2,
            }).value;
            const page = {
              id,
              url: typeof safeUrl === "string" ? safeUrl : opened.url,
              title: typeof safeTitle === "string" ? safeTitle : "",
            };
            ownedPages.set(id, { adapterId: opened.id, page });
            return { ok: true, value: { page } };
          } catch (error) {
            return browserError("browser_unavailable", safeError(error), true);
          }
        } finally {
          releaseOpen();
        }
      }
      await currentPages(signal);
      const owned = ownedPages.get(request.pageId);
      if (!owned)
        return browserError(
          "page_not_found",
          `Browser page ${JSON.stringify(request.pageId)} is not owned by this session.`,
        );
      try {
        const current = await start(signal);
        if (request.kind === "close") {
          await current.closePage(owned.adapterId, signal);
          ownedPages.delete(request.pageId);
          return { ok: true, value: { page: owned.page } };
        }
        if (request.kind === "navigate") {
          const allowed = await options.controls.assess({
            integration: "browser",
            operation: "navigate",
            effect: "network-read",
            actor: context.actor,
            mode: context.mode(),
            destination: {
              url: request.url,
              allowedOrigins: options.allowedOrigins,
              allowLoopback: options.allowLoopback,
            },
          });
          if (allowed.kind !== "allow")
            return browserError("policy_denied", allowed.reason);
          await current.act(
            {
              pageId: owned.adapterId,
              kind: "navigate",
              input: { url: allowed.canonicalUrl! },
            },
            signal,
          );
          const refreshed = await currentPages(signal);
          const page =
            refreshed.find((candidate) => candidate.id === request.pageId) ??
            owned.page;
          const redirected = await options.controls.assess({
            integration: "browser",
            operation: "navigate-redirect",
            effect: "network-read",
            actor: context.actor,
            mode: context.mode(),
            destination: {
              url: page.url,
              allowedOrigins: options.allowedOrigins,
              allowLoopback: options.allowLoopback,
            },
          });
          if (redirected.kind !== "allow") {
            await current.closePage(owned.adapterId, signal);
            ownedPages.delete(request.pageId);
            return browserError("policy_denied", redirected.reason);
          }
          return { ok: true, value: { page } };
        }
        if (request.kind !== "scroll" && !/^e\d{1,8}$/.test(request.ref))
          return browserError(
            "invalid_request",
            "Browser reference is invalid.",
          );
        if (request.kind === "fill") {
          const hasValue = typeof request.value === "string";
          const hasCredential = typeof request.credentialReference === "string";
          if (
            hasValue === hasCredential ||
            (hasValue &&
              (Buffer.byteLength(request.value!) > 64 * 1024 ||
                request.value!.includes("\0")))
          )
            return browserError(
              "invalid_request",
              "Browser fill requires exactly one bounded value or credential reference.",
            );
        }
        if (
          request.kind === "select" &&
          (!request.value ||
            Buffer.byteLength(request.value) > 4_096 ||
            request.value.includes("\0"))
        )
          return browserError(
            "invalid_request",
            "Browser select value is invalid.",
          );
        if (
          request.kind === "key" &&
          (!request.key ||
            Buffer.byteLength(request.key) > 128 ||
            /[\u0000-\u001f\u007f]/.test(request.key))
        )
          return browserError("invalid_request", "Browser key is invalid.");
        if (
          request.kind === "scroll" &&
          (!Number.isSafeInteger(request.deltaY) ||
            request.deltaY === 0 ||
            Math.abs(request.deltaY) > 10_000)
        )
          return browserError(
            "invalid_request",
            "Browser scroll delta is invalid.",
          );
        if (request.kind === "download" && exactRedactions.size > 0)
          return browserError(
            "policy_denied",
            "Downloads are disabled after a credential was used in this browser session.",
          );
        if (
          request.kind === "upload" &&
          !/^[a-f0-9]{64}$/.test(request.artifactId)
        )
          return browserError(
            "invalid_request",
            "Browser upload artifact id is invalid.",
          );
        const classificationInput: JsonObject =
          request.kind === "scroll"
            ? { deltaY: request.deltaY }
            : request.kind === "select"
              ? { ref: request.ref, value: request.value }
              : request.kind === "key"
                ? { ref: request.ref, key: request.key }
                : request.kind === "wait"
                  ? { ref: request.ref, state: request.state }
                  : request.kind === "fill"
                    ? {
                        ref: request.ref,
                        ...(request.credentialReference
                          ? {
                              credentialReference: request.credentialReference,
                            }
                          : {
                              valueDigest: createHash("sha256")
                                .update(request.value ?? "", "utf8")
                                .digest("hex"),
                            }),
                      }
                    : request.kind === "upload"
                      ? {
                          ref: request.ref,
                          artifactId: request.artifactId,
                        }
                      : { ref: request.ref };
        const reference =
          "ref" in request && typeof request.ref === "string"
            ? request.ref
            : undefined;
        const initialTarget = await targetEvidence(
          current,
          owned.adapterId,
          signal,
          reference,
        );
        const scopeInput: JsonObject = {
          ...classificationInput,
          targetUrl: initialTarget.url,
          documentDigest: initialTarget.digest,
        };
        const classificationRequest = {
          pageId: owned.adapterId,
          kind: request.kind,
          input: classificationInput,
        };
        const classification = current.classifyAction
          ? await current.classifyAction(classificationRequest, signal)
          : {
              effect: "remote-write" as const,
              reason: "Unclassified browser action is protected.",
            };
        if (
          request.kind === "fill" &&
          classification.effect === "credential-use" &&
          typeof request.value === "string"
        )
          return browserError(
            "invalid_request",
            "Password-like controls require an opaque credential reference.",
          );
        const usesCredential =
          (request.kind === "fill" &&
            typeof request.credentialReference === "string") ||
          request.kind === "upload";
        const approvalScope = actionApprovalScope({
          pageId: request.pageId,
          adapterPageId: owned.adapterId,
          action: request.kind,
          input: scopeInput,
          effect: usesCredential ? "credential-use" : "remote-write",
          destination: classification.destination ?? "",
          reason: classification.reason,
        });
        const suppliedAuthority =
          "authority" in request && request.authority?.scope === approvalScope
            ? request.authority
            : undefined;
        const decision = await options.controls.assess(
          {
            integration: "browser",
            operation: request.kind,
            effect: usesCredential
              ? "credential-use"
              : request.kind === "wait"
                ? "read"
                : "remote-write",
            actor: context.actor,
            mode: context.mode(),
            ...(classification.destination
              ? {
                  destination: {
                    url: classification.destination,
                    allowedOrigins: options.allowedOrigins,
                    allowLoopback: options.allowLoopback,
                  },
                }
              : {}),
          },
          suppliedAuthority,
        );
        if (decision.kind !== "allow")
          return browserError(
            decision.kind === "require-user-confirmation"
              ? "approval_required"
              : "policy_denied",
            decision.reason,
            false,
            decision.kind === "require-user-confirmation"
              ? {
                  approvalScope,
                  action: request.kind,
                  pageId: request.pageId,
                  reference:
                    "ref" in request && typeof request.ref === "string"
                      ? request.ref
                      : "",
                  origin: new URL(initialTarget.url).origin,
                  reason: classification.reason,
                  ...(request.kind === "upload"
                    ? { artifactId: request.artifactId }
                    : {}),
                }
              : undefined,
          );
        let adapterInput: JsonObject = classificationInput;
        if (request.kind === "upload") {
          const upload = await options.artifacts.get(request.artifactId);
          if (!upload.ok)
            return browserError("artifact_unavailable", upload.error.message);
          if (
            options.projectId &&
            upload.value.metadata.metadata?.projectId !== options.projectId
          )
            return browserError(
              "artifact_unavailable",
              "Browser upload artifact belongs to a different project or capability.",
            );
          adapterInput = {
            ref: request.ref,
            filename: upload.value.metadata.filename ?? "upload.bin",
            mediaType:
              upload.value.metadata.mediaType ?? "application/octet-stream",
            base64: Buffer.from(upload.value.body).toString("base64"),
          };
        } else if (request.kind === "fill") {
          let value = request.value;
          if (request.credentialReference) {
            if (!options.credentials)
              return browserError(
                "credential_unavailable",
                "Browser credential vault is unavailable.",
              );
            value = await options.credentials.resolve(
              request.credentialReference,
              {
                integration: "browser",
                resourceId: options.credentialScope ?? "browser",
                origin: new URL(classification.destination ?? owned.page.url)
                  .origin,
              },
            );
            if (value === undefined)
              return browserError(
                "credential_unavailable",
                "Bound browser credential could not be resolved.",
              );
            if (Buffer.byteLength(value) > 64 * 1024 || value.includes("\0"))
              return browserError(
                "credential_unavailable",
                "Bound browser credential is invalid.",
              );
            if (!exactRedactions.has(value) && exactRedactions.size >= 32)
              return browserError(
                "credential_unavailable",
                "Browser credential redaction capacity is reached.",
              );
            exactRedactions.add(value);
          }
          adapterInput = { ref: request.ref, value: value! };
        }
        if (current.classifyAction) {
          await currentPages(signal);
          const livePage = ownedPages.get(request.pageId);
          if (!livePage)
            return browserError(
              "page_not_found",
              "Browser page changed while approval or credentials were pending.",
            );
          const currentTarget = await targetEvidence(
            current,
            livePage.adapterId,
            signal,
            reference,
          );
          const reclassified = await current.classifyAction(
            classificationRequest,
            signal,
          );
          const reclassifiedScope = actionApprovalScope({
            pageId: request.pageId,
            adapterPageId: livePage.adapterId,
            action: request.kind,
            input: {
              ...classificationInput,
              targetUrl: currentTarget.url,
              documentDigest: currentTarget.digest,
            },
            effect: usesCredential ? "credential-use" : "remote-write",
            destination: reclassified.destination ?? "",
            reason: reclassified.reason,
          });
          if (reclassifiedScope !== approvalScope)
            return browserError(
              "approval_required",
              "Browser target changed while approval or credentials were pending.",
              false,
              {
                approvalScope: reclassifiedScope,
                action: request.kind,
                pageId: request.pageId,
                reference:
                  "ref" in request && typeof request.ref === "string"
                    ? request.ref
                    : "",
                origin: new URL(currentTarget.url).origin,
                reason: reclassified.reason,
                ...(request.kind === "upload"
                  ? { artifactId: request.artifactId }
                  : {}),
              },
            );
        }
        const adapterResult = await current.act(
          {
            pageId: owned.adapterId,
            kind: request.kind,
            input: adapterInput,
          },
          signal,
        );
        let artifactId: string | undefined;
        if (request.kind === "download") {
          const download = adapterResult as {
            readonly kind?: unknown;
            readonly filename?: unknown;
            readonly mediaType?: unknown;
            readonly base64?: unknown;
          };
          if (
            download.kind !== "download" ||
            typeof download.filename !== "string" ||
            typeof download.mediaType !== "string" ||
            typeof download.base64 !== "string" ||
            download.base64.length > 24 * 1024 * 1024 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(download.base64)
          )
            return browserError(
              "operation_failed",
              "Browser adapter returned an invalid download.",
            );
          const body = Buffer.from(download.base64, "base64");
          if (
            body.length === 0 ||
            body.length > 16 * 1024 * 1024 ||
            body.toString("base64") !== download.base64
          )
            return browserError(
              "operation_failed",
              "Browser download encoding or size is invalid.",
            );
          const stored = await options.artifacts.put({
            body,
            filename: "browser-download.bin",
            mediaType: "application/octet-stream",
            metadata: {
              source: "browser",
              ...(options.projectId ? { projectId: options.projectId } : {}),
              kind: "download",
            },
          });
          if (!stored.ok)
            return browserError("artifact_unavailable", stored.error.message);
          artifactId = stored.value.id;
        }
        const refreshed = await currentPages(signal);
        return {
          ok: true,
          value: {
            page:
              refreshed.find((page) => page.id === request.pageId) ??
              owned.page,
            ...(artifactId ? { artifactId } : {}),
          },
        };
      } catch (error) {
        return browserError("operation_failed", safeError(error), true);
      }
    },
    async close() {
      if (state === "closed") return;
      state = "closed";
      generation += 1;
      const current = connection ?? (await starting?.catch(() => undefined));
      connection = undefined;
      ownedPages.clear();
      await current?.close();
    },
  };
}
