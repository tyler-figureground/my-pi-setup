import { createHash, randomUUID } from "node:crypto";
import type { AsyncEntry as AsyncEntryType } from "@napi-rs/keyring";
import {
  credentialBindingKey,
  isCredentialReference,
  normalizeCredentialBinding,
  type CredentialBinding,
  type CredentialStatus,
  type CredentialVault,
  type CredentialVaultOutcome,
} from "./credentials.ts";

const CHUNK_CHARACTERS = 1_000;
const MAX_SECRET_BYTES = 64 * 1024;
const MAX_CHUNKS = 64;

interface KeyringIndex {
  readonly version: 1;
  readonly binding: CredentialBinding;
  readonly generation: string;
  readonly chunks: number;
  readonly sha256: string;
}

export interface KeyringCredentialVaultOptions {
  readonly serviceName?: string;
  readonly createReference?: () => string;
}

function invalid(message: string): CredentialVaultOutcome<never> {
  return {
    ok: false,
    error: { code: "invalid_input", message, retryable: false },
  };
}

function storeUnavailable(message: string): CredentialVaultOutcome<never> {
  return {
    ok: false,
    error: { code: "store_unavailable", message, retryable: true },
  };
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function splitSecret(secret: string) {
  const chunks: string[] = [];
  for (let offset = 0; offset < secret.length; offset += CHUNK_CHARACTERS)
    chunks.push(secret.slice(offset, offset + CHUNK_CHARACTERS));
  return chunks;
}

function decodeIndex(value: string | undefined): KeyringIndex | undefined {
  if (!value || Buffer.byteLength(value) > 8 * 1024) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<KeyringIndex>;
    if (
      parsed.version !== 1 ||
      !parsed.binding ||
      !/^[a-f0-9]{32}$/.test(parsed.generation ?? "") ||
      !Number.isSafeInteger(parsed.chunks) ||
      parsed.chunks! < 1 ||
      parsed.chunks! > MAX_CHUNKS ||
      !/^[a-f0-9]{64}$/.test(parsed.sha256 ?? "")
    )
      return undefined;
    return {
      version: 1,
      binding: normalizeCredentialBinding(parsed.binding),
      generation: parsed.generation!,
      chunks: parsed.chunks!,
      sha256: parsed.sha256!,
    };
  } catch {
    return undefined;
  }
}

export function createKeyringCredentialVault(
  options: KeyringCredentialVaultOptions = {},
): CredentialVault {
  const serviceName =
    options.serviceName ?? "pi-agent-platform-external-credentials-v1";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(serviceName))
    throw new TypeError("Credential service name is invalid.");
  const createReference =
    options.createReference ?? (() => `credential:${randomUUID()}`);
  let keyringPromise: Promise<typeof import("@napi-rs/keyring")> | undefined;
  const keyring = () => (keyringPromise ??= import("@napi-rs/keyring"));
  const entry = async (account: string): Promise<AsyncEntryType> => {
    const { AsyncEntry } = await keyring();
    return new AsyncEntry(serviceName, account);
  };
  const indexEntry = (reference: string) => entry(`${reference}:index`);
  const chunkEntry = (reference: string, generation: string, index: number) =>
    entry(`${reference}:${generation}:${String(index).padStart(2, "0")}`);

  const inspect = async (reference: string): Promise<CredentialStatus> => {
    if (!isCredentialReference(reference)) return { exists: false, reference };
    const encoded = await (await indexEntry(reference)).getPassword();
    const index = decodeIndex(encoded);
    return index
      ? { exists: true, reference, binding: index.binding }
      : { exists: false, reference };
  };
  const deleteVersion = async (reference: string, index: KeyringIndex) =>
    Promise.allSettled(
      Array.from({ length: index.chunks }, async (_unused, position) =>
        (
          await chunkEntry(reference, index.generation, position)
        ).deleteCredential(),
      ),
    );
  const writeVersion = async (
    reference: string,
    binding: CredentialBinding,
    secret: string,
    commit = true,
  ) => {
    const chunks = splitSecret(secret);
    if (chunks.length === 0 || chunks.length > MAX_CHUNKS)
      throw new Error("Credential secret requires too many secure chunks.");
    const generation = randomUUID().replaceAll("-", "");
    const written: AsyncEntryType[] = [];
    try {
      for (let position = 0; position < chunks.length; position += 1) {
        const target = await chunkEntry(reference, generation, position);
        await target.setPassword(chunks[position]!);
        written.push(target);
      }
      const metadata: KeyringIndex = {
        version: 1,
        binding,
        generation,
        chunks: chunks.length,
        sha256: digest(secret),
      };
      if (commit)
        await (
          await indexEntry(reference)
        ).setPassword(JSON.stringify(metadata));
      return metadata;
    } catch (error) {
      await Promise.allSettled(
        written.map((target) => target.deleteCredential()),
      );
      throw error;
    }
  };

  return {
    async store(input) {
      let binding: CredentialBinding;
      try {
        binding = normalizeCredentialBinding(input.binding);
      } catch (error) {
        return invalid(error instanceof Error ? error.message : String(error));
      }
      if (
        typeof input.secret !== "string" ||
        input.secret.length === 0 ||
        Buffer.byteLength(input.secret) > MAX_SECRET_BYTES ||
        input.secret.includes("\0")
      )
        return invalid("Credential secret is invalid.");
      const reference = createReference();
      if (!isCredentialReference(reference))
        return invalid(
          "Credential reference generator returned an invalid value.",
        );
      try {
        if ((await inspect(reference)).exists)
          return {
            ok: false,
            error: {
              code: "reference_collision",
              message: "Credential reference already exists.",
              retryable: true,
            },
          };
        await writeVersion(reference, binding, input.secret);
        return { ok: true, value: { reference } };
      } catch (error) {
        return storeUnavailable(
          `Operating-system credential store failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    async resolve(reference, requestedBinding) {
      if (!isCredentialReference(reference)) return undefined;
      let binding: CredentialBinding;
      try {
        binding = normalizeCredentialBinding(requestedBinding);
      } catch {
        return undefined;
      }
      const index = decodeIndex(
        await (await indexEntry(reference)).getPassword(),
      );
      if (
        !index ||
        credentialBindingKey(index.binding) !== credentialBindingKey(binding)
      )
        return undefined;
      const chunks = await Promise.all(
        Array.from({ length: index.chunks }, async (_unused, position) =>
          (
            await chunkEntry(reference, index.generation, position)
          ).getPassword(),
        ),
      );
      if (chunks.some((chunk) => chunk === undefined)) return undefined;
      const secret = chunks.join("");
      return digest(secret) === index.sha256 ? secret : undefined;
    },
    inspect,
    async replace(reference, requestedBinding, secret) {
      if (
        !isCredentialReference(reference) ||
        typeof secret !== "string" ||
        secret.length === 0 ||
        Buffer.byteLength(secret) > MAX_SECRET_BYTES ||
        secret.includes("\0")
      )
        return false;
      let binding: CredentialBinding;
      try {
        binding = normalizeCredentialBinding(requestedBinding);
      } catch {
        return false;
      }
      const prior = decodeIndex(
        await (await indexEntry(reference)).getPassword(),
      );
      if (
        !prior ||
        credentialBindingKey(prior.binding) !== credentialBindingKey(binding)
      )
        return false;
      const staged = await writeVersion(reference, binding, secret, false);
      try {
        await (await indexEntry(reference)).setPassword(JSON.stringify(staged));
      } catch {
        await deleteVersion(reference, staged);
        return false;
      }
      // The active index is durable before old chunks become unreachable. A
      // cleanup failure cannot roll the credential back to a partial version.
      await deleteVersion(reference, prior);
      return true;
    },
    async remove(reference, requestedBinding) {
      if (!isCredentialReference(reference)) return false;
      let binding: CredentialBinding;
      try {
        binding = normalizeCredentialBinding(requestedBinding);
      } catch {
        return false;
      }
      const index = decodeIndex(
        await (await indexEntry(reference)).getPassword(),
      );
      if (
        !index ||
        credentialBindingKey(index.binding) !== credentialBindingKey(binding)
      )
        return false;
      const removedIndex = await (
        await indexEntry(reference)
      ).deleteCredential();
      if (!removedIndex) return false;
      const removals = await deleteVersion(reference, index);
      return removals.every(
        (result) => result.status === "fulfilled" && result.value !== false,
      );
    },
  };
}
