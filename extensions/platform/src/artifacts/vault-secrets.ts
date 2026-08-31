import { createHash, randomUUID } from "node:crypto";
import type { StateStore } from "../core/persistence/index.ts";
import type { CredentialVault } from "../external/credentials.ts";
import type { PublicationSecretStore } from "./vercel.ts";

export function createVaultPublicationSecretStore(options: {
  readonly state: StateStore;
  readonly vault: CredentialVault;
  readonly projectId: string;
}): PublicationSecretStore {
  const scope = createHash("sha256").update(options.projectId).digest("hex");
  const collection = `artifact-share-secrets:${scope.slice(0, 32)}`;
  const binding = (id: string) => ({
    integration: "artifact" as const,
    resourceId: `vercel-share.${id}`,
    origin: "https://api.vercel.com",
    scope,
  });
  const reference = async (id: string) => {
    const result = await options.state.query({
      type: "record",
      collection,
      key: id,
    });
    if (!result.ok || result.value.type !== "record") return undefined;
    const value = result.value.record?.metadata.credentialReference;
    return typeof value === "string" ? value : undefined;
  };
  return {
    async put(id, secret) {
      if (!/^dpl_[A-Za-z0-9]+$/u.test(id)) return false;
      const stored = await options.vault.store({
        binding: binding(id),
        secret,
      });
      if (!stored.ok) return false;
      const committed = await options.state.transact({
        transactionId: `artifact-share-secret.put:${id}:${randomUUID()}`,
        operations: [
          {
            type: "put-record",
            collection,
            key: id,
            metadata: { credentialReference: stored.value.reference },
            expectedVersion: null,
          },
        ],
      });
      if (committed.ok) return true;
      await options.vault.remove(stored.value.reference, binding(id));
      return false;
    },
    async get(id) {
      const found = await reference(id);
      return found ? options.vault.resolve(found, binding(id)) : undefined;
    },
    async remove(id) {
      const found = await reference(id);
      if (!found) return false;
      const queried = await options.state.query({
        type: "record",
        collection,
        key: id,
      });
      if (
        !queried.ok ||
        queried.value.type !== "record" ||
        !queried.value.record
      )
        return false;
      const stillStored = await options.vault.resolve(found, binding(id));
      if (
        stillStored !== undefined &&
        !(await options.vault.remove(found, binding(id)))
      )
        return false;
      const removed = await options.state.transact({
        transactionId: `artifact-share-secret.remove:${id}:${randomUUID()}`,
        operations: [
          {
            type: "delete-record",
            collection,
            key: id,
            expectedVersion: queried.value.record.version,
          },
        ],
      });
      return removed.ok;
    },
  };
}
