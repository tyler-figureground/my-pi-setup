import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import type { AsyncEntry as AsyncEntryType } from "@napi-rs/keyring";
import type { TriggerDurableRecord } from "./persistence.ts";

const AUTHENTICATION_DOMAIN = "pi-trigger-durable-record-v1\0";
const KEY_BYTES = 32;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_ATTEMPTS = 1_600;

export interface TriggerRecordAuthenticator {
  authenticate(record: TriggerDurableRecord): Promise<string>;
  verify(
    record: TriggerDurableRecord,
    authentication: string,
  ): Promise<boolean>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

function authenticatedBytes(record: TriggerDurableRecord) {
  return `${AUTHENTICATION_DOMAIN}${canonicalJson(record)}`;
}

function validKey(value: Uint8Array) {
  return value.byteLength === KEY_BYTES;
}

export function createHmacTriggerRecordAuthenticator(
  loadSigningKey: () => Promise<Uint8Array>,
  loadVerificationKey: () => Promise<Uint8Array> = loadSigningKey,
): TriggerRecordAuthenticator {
  let signingKeyPromise: Promise<Buffer> | undefined;
  let verificationKeyPromise: Promise<Buffer> | undefined;
  const load = async (loader: () => Promise<Uint8Array>) => {
    const value = await loader();
    if (!validKey(value))
      throw new Error("Trigger authentication key is invalid.");
    return Buffer.from(value);
  };
  const signingKey = () => {
    if (!signingKeyPromise) {
      signingKeyPromise = load(loadSigningKey).catch((error) => {
        signingKeyPromise = undefined;
        throw error;
      });
    }
    return signingKeyPromise;
  };
  const verificationKey = () => {
    if (!verificationKeyPromise) {
      verificationKeyPromise = load(loadVerificationKey).catch((error) => {
        verificationKeyPromise = undefined;
        throw error;
      });
    }
    return verificationKeyPromise;
  };
  const authenticate = async (record: TriggerDurableRecord) =>
    createHmac("sha256", await signingKey())
      .update(authenticatedBytes(record))
      .digest("hex");
  return {
    authenticate,
    async verify(record, authentication) {
      if (!/^[a-f0-9]{64}$/.test(authentication)) return false;
      const expected = createHmac("sha256", await verificationKey())
        .update(authenticatedBytes(record))
        .digest("hex");
      return timingSafeEqual(
        Buffer.from(authentication, "hex"),
        Buffer.from(expected, "hex"),
      );
    },
  };
}

export interface KeyringTriggerRecordAuthenticatorOptions {
  readonly lockDirectory: string;
  readonly serviceName?: string;
  readonly account?: string;
}

function decodeStoredKey(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
    return Buffer.from(value, "hex");
  throw new Error("Trigger authentication key is malformed.");
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireInitializationLock(lockDirectory: string) {
  await mkdir(dirname(lockDirectory), { recursive: true, mode: 0o700 });
  const ownerPath = `${lockDirectory}/owner`;
  const token = randomUUID();
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      await writeFile(ownerPath, token, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const heartbeat = setInterval(
        () => {
          const now = new Date();
          void utimes(ownerPath, now, now).catch(() => undefined);
        },
        Math.max(1_000, Math.floor(LOCK_STALE_MS / 3)),
      );
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        const owner = await readFile(ownerPath, "utf8").catch(() => undefined);
        if (owner !== token) return;
        await unlink(ownerPath).catch(() => undefined);
        await rmdir(lockDirectory).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = await stat(ownerPath).catch(() => stat(lockDirectory));
        if (Date.now() - owner.mtimeMs > LOCK_STALE_MS) {
          const stalePath = `${lockDirectory}.stale-${randomUUID()}`;
          await rename(lockDirectory, stalePath);
          await unlink(`${stalePath}/owner`).catch(() => undefined);
          await rmdir(stalePath).catch(() => undefined);
          continue;
        }
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT")
          throw inspectionError;
      }
      await wait(LOCK_RETRY_MS);
    }
  }
  throw new Error("Trigger authentication key initialization timed out.");
}

export function createKeyringTriggerRecordAuthenticator(
  options: KeyringTriggerRecordAuthenticatorOptions,
) {
  const serviceName =
    options.serviceName ?? "pi-agent-platform-trigger-authentication-v1";
  const account = options.account ?? "durable-record-hmac";
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(serviceName) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(account) ||
    !options.lockDirectory
  )
    throw new TypeError("Trigger authentication key options are invalid.");

  let entryPromise: Promise<AsyncEntryType> | undefined;
  const entry = () =>
    (entryPromise ??= import("@napi-rs/keyring").then(
      ({ AsyncEntry }) => new AsyncEntry(serviceName, account),
    ));
  const loadExistingKey = async () => {
    const existing = decodeStoredKey(await (await entry()).getPassword());
    if (!existing)
      throw new Error("Trigger authentication key is unavailable.");
    return existing;
  };
  const loadOrCreateKey = async () => {
    const target = await entry();
    const existing = decodeStoredKey(await target.getPassword());
    if (existing) return existing;

    const release = await acquireInitializationLock(options.lockDirectory);
    try {
      const current = decodeStoredKey(await target.getPassword());
      if (current) return current;
      await target.setPassword(randomBytes(KEY_BYTES).toString("hex"));
      const committed = decodeStoredKey(await target.getPassword());
      if (!committed)
        throw new Error("Trigger authentication key was not committed.");
      return committed;
    } finally {
      await release();
    }
  };
  return createHmacTriggerRecordAuthenticator(loadOrCreateKey, loadExistingKey);
}
