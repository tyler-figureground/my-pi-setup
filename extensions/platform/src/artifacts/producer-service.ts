/**
 * Handoff that lets other extensions write Artifacts without importing the
 * platform composition root, keyed (weakly) by the session's `pi.events` bus.
 *
 * `src/composition.ts` binds a producer when Artifacts are enabled in a
 * trusted project; consumers such as `extensions/workflows/` look it up with
 * `artifactProducerFor`. The bound producer stamps the current Project
 * Identity and writes to the core `ArtifactStore`; it can only `put`, never
 * publish. The unbind function removes only its own binding.
 */

import type {
  ArtifactMetadata,
  ArtifactStoreError,
} from "../core/artifacts/index.ts";
import type { Outcome } from "../core/result.ts";

export interface ArtifactProducer {
  put(input: {
    readonly body: string | Uint8Array;
    readonly filename: string;
    readonly mediaType: string;
    readonly title: string;
    readonly creator: string;
    readonly kind: "markdown" | "html" | "json" | "image" | "bundle" | "other";
    readonly sensitivity:
      "unknown" | "public" | "internal" | "confidential" | "restricted";
  }): Promise<Outcome<ArtifactMetadata, ArtifactStoreError>>;
}

const bindings = new WeakMap<object, ArtifactProducer>();

export function bindArtifactProducer(
  events: object,
  producer: ArtifactProducer,
) {
  bindings.set(events, producer);
  return () => {
    if (bindings.get(events) === producer) bindings.delete(events);
  };
}

/**
 * `undefined` when Artifacts are disabled, the project is untrusted, or the
 * producer was unbound at shutdown.
 */
export function artifactProducerFor(events: object) {
  return bindings.get(events);
}
