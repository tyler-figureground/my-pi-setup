import { createHash, randomUUID } from "node:crypto";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type BrowserContext,
  type ElementHandle,
  type Page,
} from "playwright-core";
import {
  findWindowsProcessIdentitiesByCommandLine,
  isWindowsProcessIdentityAlive,
  snapshotWindowsProcessTree,
  terminateWindowsProcessTreeSnapshot,
  type WindowsProcessIdentity,
} from "../core/processes/windows-tree.ts";
import type {
  BrowserAdapter,
  BrowserAdapterConnection,
  BrowserAdapterPage,
} from "./index.ts";

const START_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;
const MAX_ADAPTER_PAGES = 16;

function abortPromise(signal?: AbortSignal) {
  return new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
      { once: true },
    );
  });
}

async function waitForProfileRelease(profileDirectory: string) {
  if (process.platform !== "win32") return;
  const candidates = ["lockfile", "SingletonLock", "SingletonSocket"];
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const present = await Promise.all(
      candidates.map((name) =>
        access(path.join(profileDirectory, name)).then(
          () => true,
          () => false,
        ),
      ),
    );
    if (!present.some(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Browser profile remained locked after context close.");
}

async function closeBrowserContext(context: BrowserContext) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await context.close({ reason: "Pi browser shutdown" });
      return;
    } catch (error) {
      lastError = error;
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      if (code !== "EBUSY" || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw lastError;
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`Browser operation timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function acquireProfileLease(profileDirectory: string) {
  const requested = path.resolve(profileDirectory);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const status = await lstat(requested);
  if (!status.isDirectory() || status.isSymbolicLink())
    throw new Error("Browser profile directory must be a real directory.");
  const canonical = await realpath(requested);
  if (
    (process.platform === "win32" ? canonical.toLowerCase() : canonical) !==
    (process.platform === "win32" ? requested.toLowerCase() : requested)
  )
    throw new Error(
      "Browser profile directory cannot be an alias or junction.",
    );
  const leasePath = path.join(canonical, ".pi-browser-profile-lease.json");
  const nonce = randomUUID();
  const currentIdentity =
    process.platform === "win32"
      ? (await snapshotWindowsProcessTree(process.pid)).root
      : { pid: process.pid, startedAt: "0" };
  if (!currentIdentity)
    throw new Error("Could not resolve browser profile lease owner identity.");
  let acquired = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pendingPath = `${leasePath}.pending-${nonce}`;
    try {
      const descriptor = await open(pendingPath, "wx", 0o600);
      try {
        await descriptor.writeFile(
          JSON.stringify({
            version: 1,
            pid: currentIdentity.pid,
            startedAt: currentIdentity.startedAt,
            nonce,
          }),
          "utf8",
        );
        await descriptor.sync();
      } finally {
        await descriptor.close();
      }
      try {
        await link(pendingPath, leasePath);
        acquired = true;
        break;
      } finally {
        await unlink(pendingPath).catch(() => undefined);
      }
    } catch (error) {
      await unlink(pendingPath).catch(() => undefined);
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
      let owner: WindowsProcessIdentity | undefined;
      try {
        const value = JSON.parse(await readFile(leasePath, "utf8")) as {
          pid?: unknown;
          startedAt?: unknown;
        };
        if (
          Number.isSafeInteger(value.pid) &&
          typeof value.startedAt === "string" &&
          /^\d+$/.test(value.startedAt)
        )
          owner = { pid: value.pid as number, startedAt: value.startedAt };
      } catch {
        owner = undefined;
      }
      if (owner && (await isWindowsProcessIdentityAlive(owner)))
        throw new Error(
          "Browser profile is already leased by another Pi or Impeccable session.",
        );
      const stalePath = `${leasePath}.stale-${randomUUID()}`;
      await rename(leasePath, stalePath);
      await unlink(stalePath);
    }
  }
  if (!acquired) throw new Error("Could not acquire browser profile lease.");
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      const value = JSON.parse(await readFile(leasePath, "utf8")) as {
        nonce?: unknown;
      };
      if (value.nonce !== nonce)
        throw new Error(
          "Browser profile lease identity changed before release.",
        );
      await unlink(leasePath);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return;
      throw error;
    }
  };
}

export function createPlaywrightBrowserAdapter(): BrowserAdapter {
  return {
    async start(options, signal) {
      signal?.throwIfAborted();
      const releaseProfile = await acquireProfileLease(
        options.profileDirectory,
      );
      const launching = chromium.launchPersistentContext(
        options.profileDirectory,
        {
          executablePath: options.executablePath,
          headless: true,
          timeout: START_TIMEOUT_MS,
          serviceWorkers: options.serviceWorkers,
          acceptDownloads: true,
          args: [
            "--disable-background-networking",
            "--no-first-run",
            "--no-proxy-server",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            ...(options.hostResolverRules?.length
              ? [
                  `--host-resolver-rules=${options.hostResolverRules
                    .map(
                      ({ hostname, address }) =>
                        `MAP ${hostname} ${address.includes(":") ? `[${address}]` : address}`,
                    )
                    .join(",")}`,
                ]
              : []),
          ],
        },
      );
      let context: BrowserContext;
      try {
        context = await withDeadline(
          Promise.race([launching, abortPromise(signal)]),
          START_TIMEOUT_MS,
        );
      } catch (error) {
        const cleanup = launching.then(
          async (lateContext) => {
            try {
              await closeBrowserContext(lateContext);
              return true;
            } catch {
              return false;
            }
          },
          () => true,
        );
        const outcome = await Promise.race([
          cleanup.then((safe) => ({ settled: true as const, safe })),
          new Promise<{ settled: false; safe: false }>((resolve) => {
            const timer = setTimeout(
              () => resolve({ settled: false, safe: false }),
              1_000,
            );
            timer.unref();
          }),
        ]);
        if (outcome.settled) {
          if (outcome.safe) await releaseProfile();
        } else {
          void cleanup.then(async (safe) => {
            if (safe) await releaseProfile();
          });
        }
        throw error;
      }
      const approvalState: {
        mutation?: { page: Page; expiresAt: number; remaining: number };
        download?: { page: Page; expiresAt: number; remaining: number };
      } = {};
      try {
        context.setDefaultTimeout(ACTION_TIMEOUT_MS);
        context.setDefaultNavigationTimeout(ACTION_TIMEOUT_MS);
        await context.addInitScript(() => {
          let eventGeneration = 0;
          const eventTarget = EventTarget.prototype;
          const originalAdd = eventTarget.addEventListener;
          const originalRemove = eventTarget.removeEventListener;
          Object.defineProperty(eventTarget, "addEventListener", {
            configurable: false,
            writable: false,
            value: function (
              ...args: Parameters<EventTarget["addEventListener"]>
            ) {
              eventGeneration += 1;
              return originalAdd.apply(this, args);
            },
          });
          Object.defineProperty(eventTarget, "removeEventListener", {
            configurable: false,
            writable: false,
            value: function (
              ...args: Parameters<EventTarget["removeEventListener"]>
            ) {
              eventGeneration += 1;
              return originalRemove.apply(this, args);
            },
          });
          Object.defineProperty(globalThis, "__piBrowserEventGeneration", {
            configurable: false,
            enumerable: false,
            get: () => eventGeneration,
          });
          Object.defineProperty(globalThis, "RTCPeerConnection", {
            value: undefined,
            configurable: false,
            writable: false,
          });
          Object.defineProperty(globalThis, "webkitRTCPeerConnection", {
            value: undefined,
            configurable: false,
            writable: false,
          });
        });
        if (options.authorizeUrl) {
          await context.route("**/*", async (route) => {
            let allowed = false;
            const request = route.request();
            const method = request.method().toUpperCase();
            const mutating = method !== "GET";
            try {
              const page = request.frame().page();
              const permit = approvalState.mutation;
              const mutationApproved =
                !mutating ||
                (!!permit &&
                  permit.page === page &&
                  permit.remaining > 0 &&
                  Date.now() <= permit.expiresAt);
              // Reserve the one-shot permit before awaiting policy/DNS work so
              // concurrent requests cannot all observe the same authority.
              if (mutating && mutationApproved && permit) {
                permit.remaining -= 1;
                approvalState.mutation = undefined;
              }
              allowed = await options.authorizeUrl!(request.url(), {
                method,
                mutationApproved,
              });
            } catch {
              allowed = false;
            }
            if (allowed) await route.continue();
            else await route.abort("blockedbyclient");
          });
          await context.routeWebSocket(/.*/, (route) => route.close());
        }
        await Promise.all(
          context.pages().map((page) => page.close().catch(() => undefined)),
        );
        const processIdentities =
          process.platform === "win32"
            ? await findWindowsProcessIdentitiesByCommandLine(
                `--user-data-dir=${path.resolve(options.profileDirectory)}`,
              )
            : [];
        return createConnection(
          context,
          releaseProfile,
          options.profileDirectory,
          processIdentities,
          approvalState,
        );
      } catch (error) {
        try {
          await withDeadline(closeBrowserContext(context), 30_000);
        } catch (cleanupError) {
          // Retain the profile lease when browser cleanup is degraded. Another
          // process must not reuse a profile that may still have a live owner.
          throw new AggregateError(
            [error, cleanupError],
            "Browser startup and cleanup failed; profile lease retained.",
          );
        }
        await releaseProfile();
        throw error;
      }
    },
  };
}

interface TrackedPage {
  readonly page: Page;
  readonly console: Array<{ type: string; text: string; timestamp: number }>;
  readonly errors: Array<{ message: string; timestamp: number }>;
  readonly network: Array<{
    method: string;
    url: string;
    resourceType: string;
    status?: number;
    failure?: string;
    timestamp: number;
  }>;
}

function boundedText(value: string, maximum = 8 * 1024) {
  const body = Buffer.from(value);
  return body.length <= maximum
    ? value
    : `${body.subarray(0, maximum).toString("utf8")}[TRUNCATED]`;
}

function boundedPush<T>(target: T[], value: T) {
  target.push(value);
  if (target.length > 512) target.splice(0, target.length - 512);
}

function createConnection(
  context: BrowserContext,
  releaseProfile: () => Promise<void>,
  profileDirectory: string,
  processIdentities: readonly WindowsProcessIdentity[],
  approvalState: {
    mutation?: { page: Page; expiresAt: number; remaining: number };
    download?: { page: Page; expiresAt: number; remaining: number };
  },
): BrowserAdapterConnection {
  const pages = new Map<string, TrackedPage>();
  const pageIds = new WeakMap<Page, string>();
  let nextPage = 1;
  let closed = false;

  const preparedTargets = new Map<string, ElementHandle>();
  const pageFor = (id: string) => {
    const tracked = pages.get(id);
    if (!tracked || tracked.page.isClosed())
      throw new Error(`Browser page ${id} is unavailable.`);
    return tracked;
  };
  const track = (page: Page) => {
    const existing = pageIds.get(page);
    if (existing) return { id: existing, tracked: pages.get(existing)! };
    if (pages.size >= MAX_ADAPTER_PAGES) {
      void page.close().catch(() => undefined);
      throw new Error("Browser adapter page limit is reached.");
    }
    const id = `playwright-${nextPage++}`;
    const tracked: TrackedPage = { page, console: [], errors: [], network: [] };
    page.on("download", (download) => {
      const permit = approvalState.download;
      if (
        !permit ||
        permit.page !== page ||
        permit.remaining <= 0 ||
        Date.now() > permit.expiresAt
      ) {
        void download.cancel().catch(() => undefined);
        return;
      }
      permit.remaining -= 1;
      approvalState.download = undefined;
    });
    page.on("console", (message) =>
      boundedPush(tracked.console, {
        type: message.type(),
        text: boundedText(message.text()),
        timestamp: Date.now(),
      }),
    );
    page.on("pageerror", (error) =>
      boundedPush(tracked.errors, {
        message: boundedText(error.message),
        timestamp: Date.now(),
      }),
    );
    page.on("response", (response) => {
      const request = response.request();
      boundedPush(tracked.network, {
        method: request.method(),
        url: boundedText(response.url(), 4 * 1024),
        resourceType: request.resourceType(),
        status: response.status(),
        timestamp: Date.now(),
      });
    });
    page.on("requestfailed", (request) =>
      boundedPush(tracked.network, {
        method: request.method(),
        url: boundedText(request.url(), 4 * 1024),
        resourceType: request.resourceType(),
        failure: request.failure()?.errorText ?? "request failed",
        timestamp: Date.now(),
      }),
    );
    pages.set(id, tracked);
    pageIds.set(page, id);
    return { id, tracked };
  };
  context.on("page", (page) => {
    try {
      track(page);
    } catch {
      void page.close().catch(() => undefined);
    }
  });
  const describe = async (
    id: string,
    page: Page,
  ): Promise<BrowserAdapterPage> => {
    const opener = await page.opener();
    return {
      id,
      url: page.url(),
      title: await page.title(),
      ...(opener && pageIds.get(opener)
        ? { openerId: pageIds.get(opener)! }
        : {}),
    };
  };

  return {
    async targetIdentity(pageId, signal, reference) {
      signal?.throwIfAborted();
      const tracked = pageFor(pageId);
      let targetIdentity: unknown;
      if (reference) {
        const targetKey = `${pageId}:${reference}`;
        let handle = preparedTargets.get(targetKey);
        if (handle) {
          const connected = await handle
            .evaluate((element) => element.isConnected)
            .catch(() => false);
          if (!connected) {
            preparedTargets.delete(targetKey);
            throw new Error("Browser approved target was replaced.");
          }
        } else {
          // Resolve the ref before any other accessibility operation can
          // invalidate Playwright's snapshot-scoped ARIA references.
          const locator = tracked.page.locator(`aria-ref=${reference}`);
          if ((await locator.count()) !== 1)
            throw new Error("Browser reference is stale or ambiguous.");
          handle = await locator.elementHandle();
          if (!handle) throw new Error("Browser reference became stale.");
          if (preparedTargets.size >= 64)
            preparedTargets.delete(preparedTargets.keys().next().value!);
          preparedTargets.set(targetKey, handle);
        }
        targetIdentity = await handle.evaluate((element) => {
          const record = element as HTMLElement & Record<string, unknown>;
          const form =
            "form" in record && record.form instanceof HTMLFormElement
              ? record.form
              : element instanceof Element
                ? element.closest("form")
                : null;
          const formRecord = form as
            (HTMLFormElement & Record<string, unknown>) | null;
          const functionValue = (value: unknown) =>
            typeof value === "function" ? String(value) : String(value ?? "");
          return {
            connected: element.isConnected,
            outerHTML: (element as Element).outerHTML,
            onclick: functionValue(record.onclick),
            onchange: functionValue(record.onchange),
            oninput: functionValue(record.oninput),
            onsubmit: functionValue(record.onsubmit),
            form: form
              ? {
                  outerHTML: form.outerHTML,
                  action: form.action,
                  method: form.method,
                  onsubmit: functionValue(formRecord?.onsubmit),
                  onchange: functionValue(formRecord?.onchange),
                  oninput: functionValue(formRecord?.oninput),
                }
              : null,
          };
        });
      }
      const pageIdentity = await tracked.page.evaluate(() => ({
        eventGeneration: Number(
          (
            globalThis as typeof globalThis & {
              __piBrowserEventGeneration?: unknown;
            }
          ).__piBrowserEventGeneration ?? -1,
        ),
        timeOrigin: performance.timeOrigin,
        body: document.body?.outerHTML ?? "",
      }));
      return createHash("sha256")
        .update(
          JSON.stringify({
            url: tracked.page.url(),
            pageIdentity: {
              ...pageIdentity,
              body: boundedText(pageIdentity.body, 1024 * 1024),
            },
            targetIdentity,
          }),
        )
        .digest("hex");
    },
    async listPages() {
      const result: BrowserAdapterPage[] = [];
      for (const [id, tracked] of pages) {
        if (tracked.page.isClosed()) {
          pages.delete(id);
          continue;
        }
        result.push(await describe(id, tracked.page));
      }
      return result;
    },
    async openPage(url, signal) {
      signal?.throwIfAborted();
      const page = await context.newPage();
      const { id } = track(page);
      try {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: ACTION_TIMEOUT_MS,
          signal,
        });
        return await describe(id, page);
      } catch (error) {
        pages.delete(id);
        await page.close().catch(() => undefined);
        throw error;
      }
    },
    async closePage(id) {
      const tracked = pages.get(id);
      pages.delete(id);
      await tracked?.page.close();
    },
    async observe(request, signal) {
      const tracked = pageFor(request.pageId);
      if (request.kind === "snapshot") {
        const text = await tracked.page.ariaSnapshot({
          mode: "ai",
          depth: 32,
          timeout: ACTION_TIMEOUT_MS,
          signal,
        });
        if (Buffer.byteLength(text) > 16 * 1024 * 1024)
          throw new Error("Browser snapshot exceeds 16777216 bytes.");
        return { kind: "snapshot", text };
      }
      if (request.kind === "screenshot") {
        const body = await tracked.page.screenshot({
          type: "png",
          animations: "disabled",
          caret: "hide",
          fullPage: false,
          mask: [
            tracked.page.locator(
              "input, textarea, select, [contenteditable='true']",
            ),
          ],
          maskColor: "#000000",
          timeout: ACTION_TIMEOUT_MS,
          signal,
        });
        if (body.length > 16 * 1024 * 1024)
          throw new Error("Browser screenshot exceeds 16777216 bytes.");
        return {
          kind: "screenshot",
          mediaType: "image/png",
          base64: body.toString("base64"),
        };
      }
      if (request.kind === "console")
        return { kind: "console", records: structuredClone(tracked.console) };
      if (request.kind === "page-errors")
        return {
          kind: "page-errors",
          records: structuredClone(tracked.errors),
        };
      if (request.kind === "network")
        return { kind: "network", records: structuredClone(tracked.network) };
      throw new Error(`Unsupported browser observation ${request.kind}.`);
    },
    async classifyAction(request, signal) {
      if (request.kind === "scroll")
        return {
          effect: "local-write",
          reason: "Scroll changes only page-local viewport state.",
        };
      if (request.kind === "key")
        return {
          effect: "remote-write",
          reason:
            "Keyboard input can submit a form or trigger a remote action.",
        };
      if (request.kind === "wait")
        return { effect: "read", reason: "Wait observes page-local state." };
      if (request.kind === "upload")
        return {
          effect: "credential-use",
          reason:
            "File upload reads artifact data and can affect a remote system.",
        };
      if (request.kind === "download")
        return {
          effect: "remote-write",
          reason: "Download requires direct user approval.",
        };
      if (
        !["click", "fill", "select", "upload", "download"].includes(
          request.kind,
        ) ||
        typeof request.input.ref !== "string"
      )
        return {
          effect: "remote-write",
          reason: "Unrecognized browser action is protected.",
        };
      const page = pageFor(request.pageId).page;
      const locator = page.locator(`aria-ref=${request.input.ref}`);
      if ((await locator.count()) !== 1)
        throw new Error("Browser reference is stale or ambiguous.");
      const target = await locator.evaluate(
        (element) => ({
          tag: element.tagName.toLowerCase(),
          type:
            element instanceof HTMLButtonElement ||
            element instanceof HTMLInputElement
              ? element.type.toLowerCase()
              : "",
          href: element instanceof HTMLAnchorElement ? element.href : "",
          origin: element.ownerDocument.location.origin,
        }),
        { signal },
      );
      if (request.kind === "fill")
        return target.type === "password"
          ? {
              effect: "credential-use",
              reason: "Password fields require a credential reference.",
              destination: target.origin,
            }
          : {
              effect: "local-write",
              reason:
                "Form fill changes only page-local state until submission.",
              destination: target.origin,
            };
      if (request.kind === "upload")
        return {
          effect: "credential-use",
          reason:
            "File upload reads artifact data and can affect a remote system.",
        };
      if (request.kind === "download")
        return {
          effect: "remote-write",
          reason: "Download requires direct user approval.",
        };
      if (request.kind === "select")
        return {
          effect: "local-write",
          reason:
            "Selection changes only page-local form state until submission.",
        };
      if (target.tag === "a" && target.href)
        return {
          effect: "network-read",
          reason: "Link click performs navigation.",
          destination: target.href,
        };
      return {
        effect: "remote-write",
        reason:
          target.type === "submit"
            ? "Submit control can write to a remote system."
            : "Page click can trigger a remote side effect.",
      };
    },
    async act(request, signal) {
      const page = pageFor(request.pageId).page;
      if (request.kind === "navigate") {
        if (typeof request.input.url !== "string")
          throw new Error("Browser navigation URL is invalid.");
        await page.goto(request.input.url, {
          waitUntil: "domcontentloaded",
          timeout: ACTION_TIMEOUT_MS,
          signal,
        });
        return { changed: true };
      }
      if (request.kind === "scroll") {
        if (typeof request.input.deltaY !== "number")
          throw new Error("Browser scroll delta is invalid.");
        await page.mouse.wheel(0, request.input.deltaY);
        return { changed: true };
      }
      if (
        ![
          "click",
          "fill",
          "select",
          "key",
          "wait",
          "upload",
          "download",
        ].includes(request.kind) ||
        typeof request.input.ref !== "string"
      )
        throw new Error(`Unsupported browser action ${request.kind}.`);
      const targetKey = `${request.pageId}:${request.input.ref}`;
      const locator = page.locator(`aria-ref=${request.input.ref}`);
      let handle = preparedTargets.get(targetKey);
      preparedTargets.delete(targetKey);
      if (handle) {
        const connected = await handle
          .evaluate((element) => element.isConnected)
          .catch(() => false);
        if (!connected)
          throw new Error("Browser approved target was replaced.");
      } else {
        if ((await locator.count()) !== 1)
          throw new Error("Browser reference is stale or ambiguous.");
        handle = await locator.elementHandle();
        if (!handle) throw new Error("Browser reference became stale.");
      }
      if (request.kind !== "wait")
        approvalState.mutation = {
          page,
          expiresAt: Date.now() + 5_000,
          remaining: 1,
        };
      if (request.kind === "download")
        approvalState.download = {
          page,
          expiresAt: Date.now() + 5_000,
          remaining: 1,
        };
      try {
        if (request.kind === "upload") {
          if (
            typeof request.input.filename !== "string" ||
            typeof request.input.mediaType !== "string" ||
            typeof request.input.base64 !== "string"
          )
            throw new Error("Browser upload artifact is invalid.");
          const body = Buffer.from(request.input.base64, "base64");
          if (
            body.length === 0 ||
            body.length > 16 * 1024 * 1024 ||
            body.toString("base64") !== request.input.base64
          )
            throw new Error("Browser upload encoding or size is invalid.");
          await handle.setInputFiles(
            {
              name: request.input.filename,
              mimeType: request.input.mediaType,
              buffer: body,
            },
            { timeout: ACTION_TIMEOUT_MS, signal },
          );
        } else if (request.kind === "download") {
          const [download] = await Promise.all([
            page.waitForEvent("download", {
              timeout: ACTION_TIMEOUT_MS,
              signal,
            }),
            handle.click({ timeout: ACTION_TIMEOUT_MS, signal }),
          ]);
          const stream = await download.createReadStream();
          const chunks: Buffer[] = [];
          let bytes = 0;
          try {
            for await (const chunk of stream) {
              signal?.throwIfAborted();
              const buffer = Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk);
              bytes += buffer.length;
              if (bytes > 16 * 1024 * 1024)
                throw new Error("Browser download exceeds 16777216 bytes.");
              chunks.push(buffer);
            }
          } catch (error) {
            await download.cancel().catch(() => undefined);
            throw error;
          }
          return {
            kind: "download",
            filename: download.suggestedFilename(),
            mediaType: "application/octet-stream",
            base64: Buffer.concat(chunks).toString("base64"),
          };
        } else if (request.kind === "fill") {
          if (typeof request.input.value !== "string")
            throw new Error("Browser fill value is invalid.");
          await handle.fill(request.input.value, {
            timeout: ACTION_TIMEOUT_MS,
            signal,
          });
        } else if (request.kind === "select") {
          if (typeof request.input.value !== "string")
            throw new Error("Browser select value is invalid.");
          await handle.selectOption(request.input.value, {
            timeout: ACTION_TIMEOUT_MS,
            signal,
          });
        } else if (request.kind === "key") {
          if (typeof request.input.key !== "string")
            throw new Error("Browser key is invalid.");
          await handle.press(request.input.key, {
            timeout: ACTION_TIMEOUT_MS,
            signal,
          });
        } else if (request.kind === "wait") {
          if (
            request.input.state !== "visible" &&
            request.input.state !== "hidden"
          )
            throw new Error("Browser wait state is invalid.");
          await locator.waitFor({
            state: request.input.state,
            timeout: ACTION_TIMEOUT_MS,
            signal,
          });
        } else {
          await handle.click({ timeout: ACTION_TIMEOUT_MS, signal });
        }
        return { changed: true };
      } finally {
        approvalState.mutation = undefined;
        approvalState.download = undefined;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      pages.clear();
      const failures: unknown[] = [];
      const snapshots = [];
      for (const processIdentity of processIdentities) {
        try {
          const snapshot = await snapshotWindowsProcessTree(
            processIdentity.pid,
          );
          if (
            snapshot.root &&
            snapshot.root.startedAt !== processIdentity.startedAt
          )
            throw new Error(
              "Browser root process identity changed before shutdown.",
            );
          snapshots.push(snapshot);
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await withDeadline(closeBrowserContext(context), 30_000);
      } catch (error) {
        failures.push(error);
      }
      if (snapshots.length > 0)
        await new Promise((resolve) => setTimeout(resolve, 500));
      for (const snapshot of snapshots) {
        try {
          await terminateWindowsProcessTreeSnapshot(snapshot);
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await waitForProfileRelease(profileDirectory);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0)
        throw new AggregateError(failures, "Browser shutdown failed.");
      await releaseProfile();
    },
  };
}
