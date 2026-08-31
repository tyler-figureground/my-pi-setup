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

export function artifactProducerFor(events: object) {
  return bindings.get(events);
}
