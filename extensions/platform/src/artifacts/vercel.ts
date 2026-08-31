import type { Outcome } from "../core/result.ts";
import type {
  ArtifactPublicationAdapter,
  PublicationAdapterError,
  PublicationAdapterState,
} from "./model.ts";
import { artifactCsp } from "./viewer-shell.ts";

export interface VercelFile {
  readonly file: string;
  readonly data: string;
  readonly encoding: "base64";
}

export interface VercelArtifactTransport {
  projectProtection(
    signal?: AbortSignal,
  ): Promise<
    Outcome<{ readonly preview: "all" | "none" }, PublicationAdapterError>
  >;
  deploy(
    input: {
      readonly name: string;
      readonly project: string;
      readonly intentId: string;
      readonly files: readonly VercelFile[];
    },
    signal?: AbortSignal,
  ): Promise<
    Outcome<
      {
        readonly id: string;
        readonly url: string;
        readonly target: "staging" | "production" | null;
        readonly readyState: string;
      },
      PublicationAdapterError
    >
  >;
  findDeployment(
    intentId: string,
    signal?: AbortSignal,
  ): Promise<
    Outcome<{ readonly deploymentId?: string }, PublicationAdapterError>
  >;
  createShareLink(
    deploymentId: string,
    ttlSeconds: number,
    signal?: AbortSignal,
  ): Promise<
    Outcome<
      { readonly url: string; readonly secret: string },
      PublicationAdapterError
    >
  >;
  status(
    deploymentId: string,
    signal?: AbortSignal,
  ): Promise<Outcome<PublicationAdapterState, PublicationAdapterError>>;
  revokeShareLink(
    deploymentId: string,
    secret: string,
    signal?: AbortSignal,
  ): Promise<Outcome<undefined, PublicationAdapterError>>;
  deleteDeployment(
    deploymentId: string,
    signal?: AbortSignal,
  ): Promise<Outcome<undefined, PublicationAdapterError>>;
}

export interface PublicationSecretStore {
  put(publicationId: string, secret: string): Promise<boolean>;
  get(publicationId: string): Promise<string | undefined>;
  remove(publicationId: string): Promise<boolean>;
}

export function createInMemoryPublicationSecretStore(): PublicationSecretStore {
  const values = new Map<string, string>();
  return {
    async put(id, secret) {
      if (values.has(id)) return false;
      values.set(id, secret);
      return true;
    },
    async get(id) {
      return values.get(id);
    },
    async remove(id) {
      return values.delete(id);
    },
  };
}

function rejected(message: string) {
  return {
    ok: false as const,
    error: {
      code: "provider_rejected" as const,
      message,
      retryable: false,
    },
  };
}

function ambiguousWithReference(message: string, providerReference: string) {
  return {
    ok: false as const,
    error: {
      code: "ambiguous_outcome" as const,
      message,
      retryable: false,
      details: { providerReference },
    },
  };
}

function file(name: string, body: Uint8Array): VercelFile {
  return {
    file: name,
    data: Buffer.from(body).toString("base64"),
    encoding: "base64",
  };
}

function deploymentFiles(
  body: Uint8Array,
  mediaType: string,
  interactive: boolean,
) {
  if (mediaType !== "text/html")
    throw new Error("Remote publication currently requires materialized HTML.");
  const headers = [
    { key: "Content-Security-Policy", value: artifactCsp(interactive) },
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Cache-Control", value: "private, no-store" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  ];
  const config = Buffer.from(
    JSON.stringify({
      cleanUrls: false,
      trailingSlash: false,
      headers: [{ source: "/(.*)", headers }],
    }),
    "utf8",
  );
  return [file("index.html", body), file("vercel.json", config)];
}

export interface VercelArtifactPublicationOptions {
  readonly project: string;
  readonly transport: VercelArtifactTransport;
  readonly secrets: PublicationSecretStore;
  readonly clock?: () => number;
  readonly maxBytes?: number;
}

export function createVercelArtifactPublicationAdapter(
  options: VercelArtifactPublicationOptions,
): ArtifactPublicationAdapter {
  const clock = options.clock ?? Date.now;
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/u.test(options.project))
    throw new TypeError("Vercel Artifact project name is invalid.");
  return {
    id: "vercel-preview",
    target: "remote",
    maxBytes,
    recoveryReference: (handle) => `intent:${handle}`,
    async publish(input, signal) {
      if (signal?.aborted)
        return {
          ok: false,
          error: {
            code: "cancelled",
            message: "Vercel Artifact publication cancelled.",
            retryable: false,
          },
        };
      if (input.live)
        return rejected(
          "Live Artifacts are local-only immutable revision streams.",
        );
      if (input.interactive)
        return rejected(
          "Remote interactive HTML is unavailable; open it in the isolated local viewer.",
        );
      if (input.access !== "link")
        return rejected(
          "Vercel Artifact publication requires an expiring link capability.",
        );
      const protection = await options.transport.projectProtection(signal);
      if (!protection.ok) return protection;
      if (protection.value.preview !== "all")
        return rejected(
          "Vercel preview authentication must protect every preview before Artifact publication.",
        );
      if (signal?.aborted || input.expiresAt <= clock())
        return rejected("Artifact publication expired before Vercel dispatch.");
      let files: readonly VercelFile[];
      try {
        files = deploymentFiles(input.body, input.mediaType, input.interactive);
      } catch (error) {
        return rejected(error instanceof Error ? error.message : String(error));
      }
      const intentReference = `intent:${input.handle}`;
      const deployment = await options.transport.deploy(
        {
          name: options.project,
          project: options.project,
          intentId: input.handle,
          files,
        },
        signal,
      );
      if (!deployment.ok)
        return deployment.error.code === "ambiguous_outcome"
          ? {
              ok: false,
              error: {
                ...deployment.error,
                details: {
                  providerReference:
                    deployment.error.details?.providerReference ??
                    intentReference,
                },
              },
            }
          : deployment;
      if (
        deployment.value.target !== null ||
        deployment.value.readyState !== "READY" ||
        !/^dpl_[A-Za-z0-9]+$/u.test(deployment.value.id)
      ) {
        if (/^dpl_[A-Za-z0-9]+$/u.test(deployment.value.id)) {
          const cleaned = await options.transport.deleteDeployment(
            deployment.value.id,
            signal,
          );
          if (cleaned.ok)
            return rejected(
              "Vercel returned a non-preview or unsettled deployment; it was deleted.",
            );
        }
        return ambiguousWithReference(
          "Vercel returned a non-preview or unsettled deployment.",
          deployment.value.id,
        );
      }
      let url: URL;
      try {
        url = new URL(`https://${deployment.value.url}/`);
      } catch {
        return ambiguousWithReference(
          "Vercel returned an invalid deployment URL.",
          deployment.value.id,
        );
      }
      if (
        url.protocol !== "https:" ||
        !url.hostname.endsWith(".vercel.app") ||
        url.username ||
        url.password
      )
        return ambiguousWithReference(
          "Vercel returned an unexpected deployment origin.",
          deployment.value.id,
        );
      let shareUrl = url.href;
      if (input.access === "link") {
        if (signal?.aborted || input.expiresAt <= clock())
          return ambiguousWithReference(
            "Artifact publication expired before share-link creation.",
            deployment.value.id,
          );
        const ttlSeconds = Math.ceil((input.expiresAt - clock()) / 1_000);
        if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1)
          return ambiguousWithReference(
            "Vercel share-link expiry is invalid.",
            deployment.value.id,
          );
        const shared = await options.transport.createShareLink(
          deployment.value.id,
          ttlSeconds,
          signal,
        );
        if (!shared.ok)
          return {
            ok: false,
            error: {
              ...shared.error,
              details: { providerReference: deployment.value.id },
            },
          };
        let sharedUrl: URL;
        try {
          sharedUrl = new URL(shared.value.url);
        } catch {
          return ambiguousWithReference(
            "Vercel returned an invalid share URL.",
            deployment.value.id,
          );
        }
        if (
          sharedUrl.origin !== url.origin ||
          sharedUrl.hash ||
          [...sharedUrl.searchParams.keys()].some(
            (key) => key !== "_vercel_share",
          )
        )
          return ambiguousWithReference(
            "Vercel returned an unexpected share URL.",
            deployment.value.id,
          );
        if (
          !(await options.secrets.put(deployment.value.id, shared.value.secret))
        )
          return {
            ok: false,
            error: {
              code: "ambiguous_outcome",
              message:
                "Vercel share capability could not be stored for revocation.",
              retryable: false,
              details: { providerReference: deployment.value.id },
            },
          };
        shareUrl = sharedUrl.href;
      }
      return {
        ok: true,
        value: {
          providerReference: deployment.value.id,
          shareUrl,
        },
      };
    },
    async status(reference, signal) {
      let deploymentId = reference;
      if (reference.startsWith("intent:")) {
        const found = await options.transport.findDeployment(
          reference.slice("intent:".length),
          signal,
        );
        if (!found.ok) return found;
        if (!found.value.deploymentId)
          return { ok: true, value: { state: "unknown" } };
        deploymentId = found.value.deploymentId;
      }
      return options.transport.status(deploymentId, signal);
    },
    async revoke(reference, signal) {
      let deploymentId = reference;
      if (reference.startsWith("intent:")) {
        const found = await options.transport.findDeployment(
          reference.slice("intent:".length),
          signal,
        );
        if (!found.ok) return found;
        if (!found.value.deploymentId)
          return {
            ok: false,
            error: {
              code: "ambiguous_outcome",
              message: "Vercel deployment intent could not be reconciled.",
              retryable: false,
            },
          };
        deploymentId = found.value.deploymentId;
      }
      const secret = await options.secrets.get(deploymentId);
      if (secret) {
        const revoked = await options.transport.revokeShareLink(
          deploymentId,
          secret,
          signal,
        );
        if (!revoked.ok) return revoked;
      }
      const deleted = await options.transport.deleteDeployment(
        deploymentId,
        signal,
      );
      if (!deleted.ok) return deleted;
      if (secret && !(await options.secrets.remove(deploymentId)))
        return {
          ok: false,
          error: {
            code: "provider_unavailable",
            message:
              "Vercel access was revoked but local credential cleanup is incomplete.",
            retryable: true,
          },
        };
      return { ok: true, value: { state: "revoked" } };
    },
  };
}
