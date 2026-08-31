import { randomUUID } from "node:crypto";
import { publisherFailure, validPublicationHandle } from "./errors.ts";
import { approvalScope, publishArtifact } from "./publish-operation.ts";
import { refreshArtifact } from "./refresh-operation.ts";
import type {
  ArtifactPublicationAdapter,
  ArtifactPublisher,
  CreateArtifactPublisherOptions,
  PublicationApproval,
  PublicationTarget,
} from "./model.ts";

export function createArtifactPublisher(
  options: CreateArtifactPublisherOptions,
) {
  const clock = options.clock ?? Date.now;
  const createHandle = options.createHandle ?? randomUUID;
  const adapters = new Map<PublicationTarget, ArtifactPublicationAdapter>();
  for (const adapter of options.adapters) {
    if (adapters.has(adapter.target))
      throw new TypeError(
        `Duplicate Artifact publication target: ${adapter.target}`,
      );
    if (!Number.isSafeInteger(adapter.maxBytes) || adapter.maxBytes < 1)
      throw new TypeError(`Invalid Artifact adapter byte limit: ${adapter.id}`);
    adapters.set(adapter.target, adapter);
  }

  const implementation: Omit<ArtifactPublisher, "close"> = {
    publish: (input, signal) =>
      publishArtifact(options, adapters, clock, createHandle, input, signal),

    async status(handle, signal) {
      if (!validPublicationHandle(handle))
        return publisherFailure(
          "invalid_request",
          "Artifact publication handle is invalid.",
        );
      const stored = await options.publications.get(handle);
      if (!stored.ok)
        return publisherFailure(
          stored.error.code === "publication_not_found"
            ? "publication_not_found"
            : "persistence_error",
          stored.error.message,
          { retryable: stored.error.retryable },
        );
      const current = stored.value.publication;
      if (
        current.state === "revoked" ||
        current.state === "expired" ||
        current.state === "refreshing" ||
        current.state === "revoking"
      )
        return { ok: true as const, value: current };
      if (current.expiresAt <= clock()) {
        const saved = await options.publications.update({
          ...stored.value,
          publication: {
            ...current,
            state: "expired",
            observedAt: clock(),
          },
        });
        return saved.ok
          ? { ok: true as const, value: saved.value.publication }
          : publisherFailure("persistence_error", saved.error.message);
      }
      const adapter = options.adapters.find(
        ({ id }) => id === stored.value.adapterId,
      );
      if (!adapter || !stored.value.providerReference)
        return { ok: true as const, value: current };
      let observed;
      try {
        observed = await adapter.status(stored.value.providerReference, signal);
      } catch {
        return publisherFailure(
          "provider_unavailable",
          "Artifact publication status provider is unavailable.",
          { retryable: true },
        );
      }
      if (!observed.ok)
        return publisherFailure(
          observed.error.code,
          observed.error.message,
          observed.error,
        );
      const saved = await options.publications.update({
        ...stored.value,
        publication: {
          ...current,
          state: observed.value.state,
          observedAt: clock(),
        },
      });
      return saved.ok
        ? { ok: true as const, value: saved.value.publication }
        : publisherFailure("persistence_error", saved.error.message);
    },

    refresh: (input, signal) => refreshArtifact(options, clock, input, signal),

    async revoke(input, signal) {
      const policy = options.policy.decide(
        { kind: "operation", name: "publish" },
        options.actor,
        { kind: options.mode() },
      );
      if (policy.kind === "deny")
        return publisherFailure("policy_denied", policy.reason);
      if (!validPublicationHandle(input.handle))
        return publisherFailure(
          "invalid_request",
          "Artifact publication handle is invalid.",
        );
      const stored = await options.publications.get(input.handle);
      if (!stored.ok)
        return publisherFailure(
          stored.error.code === "publication_not_found"
            ? "publication_not_found"
            : "persistence_error",
          stored.error.message,
          { retryable: stored.error.retryable },
        );
      const current = stored.value.publication;
      if (current.state === "revoked" || current.state === "expired")
        return { ok: true as const, value: current };
      const exact = {
        operation: "revoke" as const,
        artifactId: current.sourceArtifactId,
        target: current.target,
        providerId: stored.value.adapterId,
        interactive: current.interactive,
        live: current.live,
        publicationState: current.state,
        access: current.access,
        expiresAt: current.expiresAt,
        sensitivity: current.sensitivity,
      };
      const approval: PublicationApproval = {
        ...exact,
        scope: approvalScope(exact),
      };
      if (
        !input.authority ||
        !options.authority.verify(input.authority, approval.scope)
      )
        return publisherFailure(
          "approval_required",
          "Artifact revocation requires direct user approval.",
          { approval },
        );
      const adapter = options.adapters.find(
        ({ id }) => id === stored.value.adapterId,
      );
      if (!adapter || !stored.value.providerReference)
        return publisherFailure(
          "provider_unavailable",
          "Artifact publication adapter is unavailable.",
        );
      const revoking = await options.publications.update({
        ...stored.value,
        publication: {
          ...current,
          state: "revoking",
          observedAt: clock(),
        },
      });
      if (!revoking.ok)
        return publisherFailure("persistence_error", revoking.error.message, {
          retryable: revoking.error.retryable,
        });
      let result;
      try {
        result = await adapter.revoke(stored.value.providerReference, signal);
      } catch {
        await options.publications.update({
          ...revoking.value,
          publication: {
            ...current,
            state: "unknown",
            observedAt: clock(),
          },
        });
        return publisherFailure(
          "ambiguous_outcome",
          "Artifact revocation outcome is unknown.",
        );
      }
      if (!result.ok) {
        if (result.error.code === "ambiguous_outcome")
          await options.publications.update({
            ...revoking.value,
            publication: {
              ...current,
              state: "unknown",
              observedAt: clock(),
            },
          });
        return publisherFailure(
          result.error.code,
          result.error.message,
          result.error,
        );
      }
      const saved = await options.publications.update({
        ...revoking.value,
        publication: {
          ...current,
          state: result.value.state,
          observedAt: clock(),
        },
      });
      return saved.ok
        ? { ok: true as const, value: saved.value.publication }
        : publisherFailure("persistence_error", saved.error.message);
    },
  };
  let closing = false;
  const active = new Set<Promise<unknown>>();
  const track = <T>(operation: () => Promise<T>) => {
    const running = operation();
    active.add(running);
    void running.then(
      () => active.delete(running),
      () => active.delete(running),
    );
    return running;
  };
  const closed = () =>
    publisherFailure(
      "provider_unavailable",
      "Artifact Publisher is shutting down.",
    );
  const publisher: ArtifactPublisher = {
    publish: (input, signal) =>
      closing
        ? Promise.resolve(closed())
        : track(() => implementation.publish(input, signal)),
    status: (handle, signal) =>
      closing
        ? Promise.resolve(closed())
        : track(() => implementation.status(handle, signal)),
    refresh: (input, signal) =>
      closing
        ? Promise.resolve(closed())
        : track(() => implementation.refresh(input, signal)),
    revoke: (input, signal) =>
      closing
        ? Promise.resolve(closed())
        : track(() => implementation.revoke(input, signal)),
    async close() {
      closing = true;
      await Promise.allSettled([...active]);
    },
  };
  return publisher;
}
