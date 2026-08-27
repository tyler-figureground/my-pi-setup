import { randomUUID } from "node:crypto";
import type { ModuleError, Outcome } from "../core/result.ts";
import type { ExternalIntegration } from "./index.ts";

export interface CredentialBinding {
  readonly integration: ExternalIntegration;
  readonly resourceId: string;
  readonly origin?: string;
}

export interface CredentialReference {
  readonly reference: string;
}

export interface CredentialStatus extends CredentialReference {
  readonly exists: boolean;
  readonly binding?: CredentialBinding;
}

export type CredentialVaultErrorCode =
  "invalid_input" | "reference_collision" | "store_unavailable";
export type CredentialVaultError = ModuleError<CredentialVaultErrorCode>;
export type CredentialVaultOutcome<T> = Outcome<T, CredentialVaultError>;

export interface CredentialVault {
  store(input: {
    readonly binding: CredentialBinding;
    readonly secret: string;
  }): Promise<CredentialVaultOutcome<CredentialReference>>;
  resolve(
    reference: string,
    binding: CredentialBinding,
  ): Promise<string | undefined>;
  inspect(reference: string): Promise<CredentialStatus>;
  replace(
    reference: string,
    binding: CredentialBinding,
    secret: string,
  ): Promise<boolean>;
  remove(reference: string, binding: CredentialBinding): Promise<boolean>;
}

export interface InMemoryCredentialVaultOptions {
  readonly createReference?: () => string;
}

export function normalizeCredentialBinding(
  binding: CredentialBinding,
): CredentialBinding {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(binding.resourceId) ||
    (binding.integration !== "mcp" && binding.integration !== "browser")
  )
    throw new TypeError("Credential binding is invalid.");
  if (binding.origin === undefined) return { ...binding };
  const url = new URL(binding.origin);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== binding.origin ||
    url.username ||
    url.password
  )
    throw new TypeError("Credential origin must be one canonical HTTP origin.");
  return { ...binding, origin: url.origin };
}

export function isCredentialReference(reference: string) {
  return /^credential:[A-Za-z0-9][A-Za-z0-9._-]{0,223}$/.test(reference);
}

export function credentialBindingKey(binding: CredentialBinding) {
  return `${binding.integration}\0${binding.resourceId}\0${binding.origin ?? ""}`;
}

function invalid(message: string): CredentialVaultOutcome<never> {
  return {
    ok: false,
    error: {
      code: "invalid_input",
      message,
      retryable: false,
    },
  };
}

export function createInMemoryCredentialVault(
  options: InMemoryCredentialVaultOptions = {},
): CredentialVault {
  const entries = new Map<
    string,
    { readonly binding: CredentialBinding; readonly secret: string }
  >();
  const createReference =
    options.createReference ?? (() => `credential:${randomUUID()}`);
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
        Buffer.byteLength(input.secret) > 64 * 1024 ||
        input.secret.includes("\0")
      )
        return invalid("Credential secret is invalid.");
      const reference = createReference();
      if (!isCredentialReference(reference))
        return invalid(
          "Credential reference generator returned an invalid value.",
        );
      if (entries.has(reference))
        return {
          ok: false,
          error: {
            code: "reference_collision",
            message: "Credential reference already exists.",
            retryable: true,
          },
        };
      entries.set(reference, { binding, secret: input.secret });
      return { ok: true, value: { reference } };
    },
    async resolve(reference, requestedBinding) {
      if (!isCredentialReference(reference)) return undefined;
      let binding: CredentialBinding;
      try {
        binding = normalizeCredentialBinding(requestedBinding);
      } catch {
        return undefined;
      }
      const entry = entries.get(reference);
      return entry &&
        credentialBindingKey(entry.binding) === credentialBindingKey(binding)
        ? entry.secret
        : undefined;
    },
    async inspect(reference) {
      if (!isCredentialReference(reference))
        return { exists: false, reference };
      const entry = entries.get(reference);
      return entry
        ? {
            exists: true,
            reference,
            binding: structuredClone(entry.binding),
          }
        : { exists: false, reference };
    },
    async replace(reference, requestedBinding, secret) {
      if (
        !isCredentialReference(reference) ||
        typeof secret !== "string" ||
        secret.length === 0 ||
        Buffer.byteLength(secret) > 64 * 1024 ||
        secret.includes("\0")
      )
        return false;
      let binding: CredentialBinding;
      try {
        binding = normalizeCredentialBinding(requestedBinding);
      } catch {
        return false;
      }
      const entry = entries.get(reference);
      if (
        !entry ||
        credentialBindingKey(entry.binding) !== credentialBindingKey(binding)
      )
        return false;
      entries.set(reference, { binding, secret });
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
      const entry = entries.get(reference);
      if (
        !entry ||
        credentialBindingKey(entry.binding) !== credentialBindingKey(binding)
      )
        return false;
      entries.delete(reference);
      return true;
    },
  };
}
