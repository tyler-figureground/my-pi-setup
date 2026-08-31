import { randomBytes } from "node:crypto";
import type {
  ArtifactPublicationAdapter,
  PublicationAdapterError,
} from "./model.ts";
import {
  createLocalViewerServer,
  type LocalPublication,
  viewerHash,
} from "./local-viewer-server.ts";

function adapterError(
  code: PublicationAdapterError["code"],
  message: string,
  retryable = false,
) {
  return { ok: false as const, error: { code, message, retryable } };
}

export interface LocalArtifactViewerOptions {
  readonly clock?: () => number;
  readonly maxBytes?: number;
  /** Test fixture override. Production composition always uses port 0. */
  readonly port?: number;
  readonly maxPublications?: number;
}

export function createLocalArtifactPublicationAdapter(
  options: LocalArtifactViewerOptions = {},
) {
  const clock = options.clock ?? Date.now;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const maxPublications = options.maxPublications ?? 128;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(maxPublications) ||
    maxPublications < 1 ||
    maxPublications > 1_024
  )
    throw new TypeError("Local Artifact viewer limits are invalid.");
  const publications = new Map<string, LocalPublication>();
  const capabilities = new Map<string, string>();
  const sessions = new Map<string, string>();
  const server = createLocalViewerServer(
    publications,
    capabilities,
    sessions,
    clock,
    options.port,
  );
  let origin = "";

  const adapter: ArtifactPublicationAdapter = {
    id: "local-loopback",
    target: "local",
    maxBytes,
    async publish(input, signal) {
      if (signal?.aborted)
        return adapterError(
          "cancelled",
          "Local Artifact publication cancelled.",
        );
      if (input.body.byteLength > maxBytes)
        return adapterError(
          "provider_rejected",
          "Local Artifact is too large.",
        );
      if (publications.size >= maxPublications) {
        for (const [handle, publication] of publications) {
          if (
            publication.state === "revoked" ||
            publication.expiresAt <= clock()
          ) {
            publications.delete(handle);
            capabilities.delete(publication.capabilityHash);
            for (const [session, sessionHandle] of sessions) {
              if (sessionHandle === handle) sessions.delete(session);
            }
          }
        }
      }
      const activePublications = [...publications.values()].filter(
        (publication) =>
          publication.state === "active" && publication.expiresAt > clock(),
      ).length;
      if (
        !publications.has(input.handle) &&
        activePublications >= maxPublications
      )
        return adapterError(
          "provider_rejected",
          "Local Artifact publication limit is reached.",
        );
      if (publications.has(input.handle))
        return adapterError(
          "provider_rejected",
          "Local Artifact publication handle already exists.",
        );
      try {
        origin ||= await server.start();
      } catch {
        return adapterError(
          "provider_unavailable",
          "Local Artifact viewer could not start.",
          true,
        );
      }
      const token = randomBytes(32).toString("base64url");
      const capabilityHash = viewerHash(token);
      publications.set(input.handle, {
        handle: input.handle,
        body: Buffer.from(input.body),
        mediaType: input.mediaType,
        interactive: input.interactive,
        live: input.live,
        revision: 1,
        expiresAt: input.expiresAt,
        capabilityHash,
        state: "active",
      });
      capabilities.set(capabilityHash, input.handle);
      return {
        ok: true,
        value: {
          providerReference: input.handle,
          shareUrl: `${origin}/open#${token}`,
        },
      };
    },
    async status(reference) {
      const publication = publications.get(reference);
      if (!publication)
        return adapterError(
          "provider_rejected",
          "Local Artifact publication was not found.",
        );
      return {
        ok: true,
        value: {
          state:
            publication.state === "revoked"
              ? "revoked"
              : publication.expiresAt <= clock()
                ? "expired"
                : "active",
        },
      };
    },
    async revoke(reference) {
      const publication = publications.get(reference);
      if (!publication)
        return adapterError(
          "provider_rejected",
          "Local Artifact publication was not found.",
        );
      publication.state = "revoked";
      capabilities.delete(publication.capabilityHash);
      for (const [session, handle] of sessions) {
        if (handle === reference) sessions.delete(session);
      }
      return { ok: true, value: { state: "revoked" } };
    },
  };

  return {
    adapter,
    async update(
      reference: string,
      input: {
        readonly body: Uint8Array;
        readonly mediaType: string;
        readonly interactive: boolean;
      },
    ) {
      const publication = publications.get(reference);
      if (
        !publication ||
        !publication.live ||
        publication.state !== "active" ||
        publication.expiresAt <= clock() ||
        input.body.byteLength > maxBytes
      )
        return false;
      publication.body = Buffer.from(input.body);
      publication.mediaType = input.mediaType;
      publication.interactive = input.interactive;
      publication.revision += 1;
      return true;
    },
    async close() {
      capabilities.clear();
      sessions.clear();
      publications.clear();
      await server.close();
    },
  };
}
