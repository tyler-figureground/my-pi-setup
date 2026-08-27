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
}

export interface BrowserAdapterConnection {
  listPages(signal?: AbortSignal): Promise<readonly BrowserAdapterPage[]>;
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
        signal?: AbortSignal,
      ) => Promise<boolean>;
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
): BrowserControlOutcome<never> {
  return { ok: false, error: { code, message, retryable } };
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
  let state: "idle" | "starting" | "ready" | "failed" | "closed" = "idle";
  let connection: BrowserAdapterConnection | undefined;
  let starting: Promise<BrowserAdapterConnection> | undefined;
  let nextPage = 1;
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
    starting = options.adapter
      .start(
        {
          profileDirectory: options.profileDirectory,
          executablePath: options.executablePath,
          serviceWorkers: "block",
          authorizeUrl: async (url, requestSignal) => {
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
      )
      .then((value) => {
        connection = value;
        state = "ready";
        return value;
      })
      .catch((error) => {
        state = "failed";
        throw error;
      })
      .finally(() => {
        starting = undefined;
      });
    return starting;
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
      const safeUrl = options.controls.sanitize(page.url).value;
      owned.page = {
        id,
        url: typeof safeUrl === "string" ? safeUrl : page.url,
        title: page.title,
      };
      pages.push(owned.page);
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
            filename: `browser-${request.pageId}-screenshot.png`,
            mediaType: "image/png",
            metadata: {
              source: "browser",
              pageId: request.pageId,
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
                ? line.replace(/(:|\bvalue=).*/i, "$1 [REDACTED]")
                : line,
            )
            .join("\n");
          extension = "txt";
          mediaType = "text/plain";
        } else {
          if (!Array.isArray(value.records))
            return browserError(
              "operation_failed",
              "Browser adapter returned invalid diagnostic records.",
            );
          complete = JSON.stringify(options.controls.sanitize(raw).value);
          extension = "json";
          mediaType = "application/json";
        }
        const stored = await options.artifacts.put({
          body: complete,
          filename: `browser-${request.pageId}-${request.kind}.${extension}`,
          mediaType,
          metadata: {
            source: "browser",
            pageId: request.pageId,
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
        return browserError(
          "operation_failed",
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    },
    async act(request, signal) {
      if (request.kind === "open") {
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
          const opened = await current.openPage(decision.canonicalUrl!, signal);
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
          const page = { id, url: opened.url, title: opened.title };
          ownedPages.set(id, { adapterId: opened.id, page });
          return { ok: true, value: { page } };
        } catch (error) {
          return browserError(
            "browser_unavailable",
            error instanceof Error ? error.message : String(error),
            true,
          );
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
                  : { ref: request.ref };
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
        const decision = await options.controls.assess(
          {
            integration: "browser",
            operation: request.kind,
            effect:
              request.kind === "download"
                ? "remote-write"
                : usesCredential
                  ? "credential-use"
                  : classification.effect,
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
          "authority" in request ? request.authority : undefined,
        );
        if (decision.kind !== "allow")
          return browserError(
            decision.kind === "require-user-confirmation"
              ? "approval_required"
              : "policy_denied",
            decision.reason,
          );
        let adapterInput: JsonObject = classificationInput;
        if (request.kind === "upload") {
          const upload = await options.artifacts.get(request.artifactId);
          if (!upload.ok)
            return browserError("artifact_unavailable", upload.error.message);
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
                resourceId: request.pageId,
                origin: new URL(owned.page.url).origin,
              },
            );
            if (value === undefined)
              return browserError(
                "credential_unavailable",
                "Bound browser credential could not be resolved.",
              );
          }
          adapterInput = { ref: request.ref, value: value! };
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
            filename: download.filename,
            mediaType: download.mediaType,
            metadata: {
              source: "browser",
              pageId: request.pageId,
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
        return browserError(
          "operation_failed",
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    },
    async close() {
      if (state === "closed") return;
      state = "closed";
      const current = connection ?? (await starting?.catch(() => undefined));
      connection = undefined;
      ownedPages.clear();
      await current?.close();
    },
  };
}
