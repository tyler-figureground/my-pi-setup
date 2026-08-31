import type {
  ArtifactPublisherError,
  ArtifactPublisherOutcome,
} from "./model.ts";

export function publisherFailure(
  code: ArtifactPublisherError["code"],
  message: string,
  extra: Partial<ArtifactPublisherError> = {},
): ArtifactPublisherOutcome<never> {
  return {
    ok: false,
    error: { code, message, retryable: extra.retryable ?? false, ...extra },
  };
}

export function validPublicationHandle(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}
