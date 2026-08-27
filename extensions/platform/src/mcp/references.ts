import { randomUUID } from "node:crypto";
import type {
  StateRecord,
  StateStore,
} from "../core/persistence/state-store.ts";
import type { McpCredentialReferences } from "./oauth.ts";

const COLLECTION = "mcp-credential-references";

export interface McpCredentialReferenceOptions {
  readonly store: StateStore;
  readonly scope: string;
}

function validPart(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

export function createMcpCredentialReferences(
  options: McpCredentialReferenceOptions,
): McpCredentialReferences {
  if (!validPart(options.scope))
    throw new TypeError("MCP credential reference scope is invalid.");
  const key = (serverId: string) => {
    if (!validPart(serverId))
      throw new TypeError("MCP credential server id is invalid.");
    return `${options.scope}:${serverId}`;
  };
  const record = async (serverId: string): Promise<StateRecord | null> => {
    const result = await options.store.query({
      type: "record",
      collection: COLLECTION,
      key: key(serverId),
    });
    if (!result.ok) throw new Error(result.error.message);
    if (result.value.type !== "record")
      throw new Error("State store returned an unexpected reference query.");
    return result.value.record;
  };
  return {
    async get(serverId) {
      const current = await record(serverId);
      const reference = current?.metadata.reference;
      return typeof reference === "string" &&
        /^credential:[A-Za-z0-9][A-Za-z0-9._-]{0,223}$/.test(reference)
        ? reference
        : undefined;
    },
    async set(serverId, reference) {
      if (!/^credential:[A-Za-z0-9][A-Za-z0-9._-]{0,223}$/.test(reference))
        throw new TypeError("MCP credential reference is invalid.");
      const current = await record(serverId);
      const result = await options.store.transact({
        transactionId: `mcp-credential-set:${randomUUID()}`,
        operations: [
          {
            type: "put-record",
            collection: COLLECTION,
            key: key(serverId),
            metadata: { reference },
            expectedVersion: current?.version ?? null,
          },
        ],
      });
      if (!result.ok) throw new Error(result.error.message);
    },
    async remove(serverId) {
      const current = await record(serverId);
      if (!current) return;
      const result = await options.store.transact({
        transactionId: `mcp-credential-remove:${randomUUID()}`,
        operations: [
          {
            type: "delete-record",
            collection: COLLECTION,
            key: key(serverId),
            expectedVersion: current.version,
          },
        ],
      });
      if (!result.ok) throw new Error(result.error.message);
    },
  };
}
