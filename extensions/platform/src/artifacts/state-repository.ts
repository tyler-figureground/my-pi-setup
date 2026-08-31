import { createHash, randomUUID } from "node:crypto";
import type { StateMutation, StateStore } from "../core/persistence/index.ts";
import type { JsonObject } from "../core/result.ts";
import { failure, success } from "../core/result.ts";
import type {
  PublicationRepository,
  PublicationState,
  StoredPublication,
} from "./model.ts";

const states = new Set<PublicationState>([
  "pending",
  "active",
  "revoking",
  "refreshing",
  "revoked",
  "expired",
  "failed",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validStoredPublication(value: unknown): value is StoredPublication {
  if (!isRecord(value) || !isRecord(value.publication)) return false;
  const publication = value.publication;
  const sensitivity = publication.sensitivity;
  return (
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    typeof value.ownerId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.ownerId) &&
    typeof value.adapterId === "string" &&
    value.adapterId.length <= 128 &&
    (value.providerReference === undefined ||
      (typeof value.providerReference === "string" &&
        value.providerReference.length <= 4_096)) &&
    typeof publication.handle === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(publication.handle) &&
    typeof publication.sourceArtifactId === "string" &&
    /^[a-f0-9]{64}$/u.test(publication.sourceArtifactId) &&
    typeof publication.outboundArtifactId === "string" &&
    /^[a-f0-9]{64}$/u.test(publication.outboundArtifactId) &&
    (publication.target === "local" || publication.target === "remote") &&
    (publication.access === "private" || publication.access === "link") &&
    typeof publication.interactive === "boolean" &&
    typeof publication.live === "boolean" &&
    states.has(publication.state as PublicationState) &&
    Number.isSafeInteger(publication.createdAt) &&
    Number.isSafeInteger(publication.expiresAt) &&
    Number.isSafeInteger(publication.observedAt) &&
    isRecord(sensitivity) &&
    ["clear", "review", "blocked"].includes(String(sensitivity.verdict)) &&
    typeof sensitivity.scannerVersion === "string" &&
    sensitivity.scannerVersion.length <= 128 &&
    typeof sensitivity.digest === "string" &&
    /^[a-f0-9]{64}$/u.test(sensitivity.digest) &&
    Array.isArray(sensitivity.findings) &&
    sensitivity.findings.length <= 128 &&
    sensitivity.findings.every(
      (finding) =>
        isRecord(finding) &&
        typeof finding.ruleId === "string" &&
        finding.ruleId.length <= 128 &&
        (finding.severity === "review" || finding.severity === "block") &&
        Number.isSafeInteger(finding.count) &&
        Number(finding.count) > 0,
    )
  );
}

function storageFailure(message: string, retryable = false) {
  return failure({ code: "persistence_error" as const, message, retryable });
}

export function createStateStorePublicationRepository(
  state: StateStore,
  scope: string,
): PublicationRepository {
  const collection = `artifact-publications:${createHash("sha256")
    .update(scope)
    .digest("hex")
    .slice(0, 32)}`;
  const query = async (handle: string) => {
    const result = await state.query({
      type: "record",
      collection,
      key: handle,
    });
    if (!result.ok)
      return storageFailure(result.error.message, result.error.retryable);
    if (result.value.type !== "record")
      return storageFailure(
        "StateStore returned an unexpected publication query.",
      );
    return success(result.value.record);
  };
  const decode = (metadata: JsonObject) => {
    const snapshot: unknown = structuredClone(metadata);
    return validStoredPublication(snapshot)
      ? success(snapshot)
      : storageFailure("Stored Artifact publication metadata is invalid.");
  };

  return {
    async list() {
      const result = await state.query({
        type: "records",
        collection,
        limit: 1_000,
      });
      if (!result.ok)
        return storageFailure(result.error.message, result.error.retryable);
      if (result.value.type !== "records")
        return storageFailure(
          "StateStore returned an unexpected publication list.",
        );
      const records: StoredPublication[] = [];
      for (const item of result.value.records) {
        const decoded = decode(item.metadata);
        if (!decoded.ok) return decoded;
        records.push(decoded.value);
      }
      return success(records);
    },
    async create(record) {
      const existing = await state.query({
        type: "records",
        collection,
        limit: 1_000,
      });
      if (!existing.ok)
        return storageFailure(existing.error.message, existing.error.retryable);
      if (existing.value.type !== "records")
        return storageFailure(
          "StateStore returned an unexpected publication list.",
        );
      const cleanup: StateMutation[] = [];
      if (existing.value.records.length >= 1_000) {
        const terminal = existing.value.records
          .flatMap((item) => {
            const decoded = decode(item.metadata);
            return decoded.ok &&
              ["revoked", "expired", "failed"].includes(
                decoded.value.publication.state,
              )
              ? [{ item, publication: decoded.value.publication }]
              : [];
          })
          .sort(
            (left, right) =>
              left.publication.observedAt - right.publication.observedAt,
          )[0];
        if (!terminal)
          return storageFailure(
            "Artifact publication registry limit is reached.",
          );
        cleanup.push({
          type: "delete-record",
          collection,
          key: terminal.item.key,
          expectedVersion: terminal.item.version,
        });
      }
      if (!validStoredPublication(record))
        return storageFailure("Artifact publication record is invalid.");
      if (record.revision !== 0)
        return storageFailure(
          "New Artifact publication revision must be zero.",
        );
      const created = { ...record, revision: 1 };
      const result = await state.transact({
        transactionId: `artifact-publication.create:${record.publication.handle}:${randomUUID()}`,
        operations: [
          ...cleanup,
          {
            type: "put-record",
            collection,
            key: record.publication.handle,
            metadata: structuredClone(created) as unknown as JsonObject,
            expectedVersion: null,
          },
        ],
      });
      if (!result.ok) {
        return result.error.code === "VERSION_CONFLICT"
          ? failure({
              code: "publication_conflict",
              message: `Publication already exists: ${record.publication.handle}`,
              retryable: false,
            })
          : storageFailure(result.error.message, result.error.retryable);
      }
      return success(structuredClone(created));
    },
    async get(handle) {
      const result = await query(handle);
      if (!result.ok) return result;
      if (!result.value)
        return failure({
          code: "publication_not_found",
          message: `Publication not found: ${handle}`,
          retryable: false,
        });
      return decode(result.value.metadata);
    },
    async update(record) {
      if (!validStoredPublication(record))
        return storageFailure("Artifact publication record is invalid.");
      const current = await query(record.publication.handle);
      if (!current.ok) return current;
      if (!current.value)
        return failure({
          code: "publication_not_found",
          message: `Publication not found: ${record.publication.handle}`,
          retryable: false,
        });
      const decoded = decode(current.value.metadata);
      if (!decoded.ok) return decoded;
      if (decoded.value.revision !== record.revision)
        return storageFailure("Artifact publication revision changed.", true);
      const updated = { ...record, revision: record.revision + 1 };
      const result = await state.transact({
        transactionId: `artifact-publication.update:${record.publication.handle}:${randomUUID()}`,
        operations: [
          {
            type: "put-record",
            collection,
            key: record.publication.handle,
            metadata: structuredClone(updated) as unknown as JsonObject,
            expectedVersion: current.value.version,
          },
        ],
      });
      return result.ok
        ? success(structuredClone(updated))
        : storageFailure(result.error.message, result.error.retryable);
    },
  };
}
