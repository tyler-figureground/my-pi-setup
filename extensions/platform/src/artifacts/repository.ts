import { failure, success } from "../core/result.ts";
import type { PublicationRepository, StoredPublication } from "./model.ts";

export function createInMemoryPublicationRepository(): PublicationRepository {
  const records = new Map<string, StoredPublication>();
  return {
    async list() {
      return success(
        [...records.values()]
          .map((record) => structuredClone(record))
          .sort((left, right) =>
            left.publication.handle.localeCompare(right.publication.handle),
          ),
      );
    },
    async create(record) {
      if (!records.has(record.publication.handle) && records.size >= 1_000) {
        const terminal = [...records.values()]
          .filter(({ publication }) =>
            ["revoked", "expired", "failed"].includes(publication.state),
          )
          .sort(
            (left, right) =>
              left.publication.observedAt - right.publication.observedAt,
          )[0];
        if (terminal) records.delete(terminal.publication.handle);
        else
          return failure({
            code: "persistence_error",
            message: "Artifact publication registry limit is reached.",
            retryable: false,
          });
      }
      if (records.has(record.publication.handle)) {
        return failure({
          code: "publication_conflict",
          message: `Publication already exists: ${record.publication.handle}`,
          retryable: false,
        });
      }
      const snapshot = structuredClone({ ...record, revision: 1 });
      records.set(record.publication.handle, snapshot);
      return success(structuredClone(snapshot));
    },
    async get(handle) {
      const record = records.get(handle);
      return record
        ? success(structuredClone(record))
        : failure({
            code: "publication_not_found",
            message: `Publication not found: ${handle}`,
            retryable: false,
          });
    },
    async update(record) {
      const current = records.get(record.publication.handle);
      if (!current) {
        return failure({
          code: "publication_not_found",
          message: `Publication not found: ${record.publication.handle}`,
          retryable: false,
        });
      }
      if (record.revision !== current.revision) {
        return failure({
          code: "persistence_error",
          message: "Artifact publication revision changed.",
          retryable: true,
        });
      }
      const snapshot = structuredClone({
        ...record,
        revision: current.revision + 1,
      });
      records.set(record.publication.handle, snapshot);
      return success(structuredClone(snapshot));
    },
  };
}
