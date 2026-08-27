import { chromium, type BrowserContext, type Page } from "playwright-core";
import type {
  BrowserAdapter,
  BrowserAdapterConnection,
  BrowserAdapterPage,
} from "./index.ts";

const START_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;

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

export function createPlaywrightBrowserAdapter(): BrowserAdapter {
  return {
    async start(options, signal) {
      signal?.throwIfAborted();
      const launching = chromium.launchPersistentContext(
        options.profileDirectory,
        {
          executablePath: options.executablePath,
          headless: true,
          serviceWorkers: options.serviceWorkers,
          acceptDownloads: true,
          args: ["--disable-background-networking", "--no-first-run"],
        },
      );
      void launching.then((context) => {
        if (signal?.aborted) void context.close();
      });
      const context = await withDeadline(
        Promise.race([launching, abortPromise(signal)]),
        START_TIMEOUT_MS,
      );
      context.setDefaultTimeout(ACTION_TIMEOUT_MS);
      context.setDefaultNavigationTimeout(ACTION_TIMEOUT_MS);
      if (options.authorizeUrl) {
        await context.route("**/*", async (route) => {
          let allowed = false;
          try {
            allowed = await options.authorizeUrl!(route.request().url());
          } catch {
            allowed = false;
          }
          if (allowed) await route.continue();
          else await route.abort("blockedbyclient");
        });
        await context.routeWebSocket(/.*/, (route) => route.close());
      }
      return createConnection(context);
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

function boundedPush<T>(target: T[], value: T) {
  target.push(value);
  if (target.length > 512) target.splice(0, target.length - 512);
}

function createConnection(context: BrowserContext): BrowserAdapterConnection {
  const pages = new Map<string, TrackedPage>();
  let nextPage = 1;
  let closed = false;

  const pageFor = (id: string) => {
    const tracked = pages.get(id);
    if (!tracked || tracked.page.isClosed())
      throw new Error(`Browser page ${id} is unavailable.`);
    return tracked;
  };
  const track = (id: string, page: Page) => {
    const tracked: TrackedPage = { page, console: [], errors: [], network: [] };
    page.on("console", (message) =>
      boundedPush(tracked.console, {
        type: message.type(),
        text: message.text(),
        timestamp: Date.now(),
      }),
    );
    page.on("pageerror", (error) =>
      boundedPush(tracked.errors, {
        message: error.message,
        timestamp: Date.now(),
      }),
    );
    page.on("response", (response) => {
      const request = response.request();
      boundedPush(tracked.network, {
        method: request.method(),
        url: response.url(),
        resourceType: request.resourceType(),
        status: response.status(),
        timestamp: Date.now(),
      });
    });
    page.on("requestfailed", (request) =>
      boundedPush(tracked.network, {
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        failure: request.failure()?.errorText ?? "request failed",
        timestamp: Date.now(),
      }),
    );
    pages.set(id, tracked);
    return tracked;
  };
  const describe = async (
    id: string,
    page: Page,
  ): Promise<BrowserAdapterPage> => ({
    id,
    url: page.url(),
    title: await page.title(),
  });

  return {
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
      const id = `playwright-${nextPage++}`;
      track(id, page);
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
        return { kind: "snapshot", text };
      }
      if (request.kind === "screenshot") {
        const body = await tracked.page.screenshot({
          type: "png",
          animations: "disabled",
          caret: "hide",
          fullPage: false,
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
        }),
        { signal },
      );
      if (request.kind === "fill")
        return target.type === "password"
          ? {
              effect: "credential-use",
              reason: "Password fields require a credential reference.",
            }
          : {
              effect: "local-write",
              reason:
                "Form fill changes only page-local state until submission.",
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
      const locator = page.locator(`aria-ref=${request.input.ref}`);
      if ((await locator.count()) !== 1)
        throw new Error("Browser reference is stale or ambiguous.");
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
        await locator.setInputFiles(
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
          locator.click({ timeout: ACTION_TIMEOUT_MS, signal }),
        ]);
        const stream = await download.createReadStream();
        const chunks: Buffer[] = [];
        let bytes = 0;
        try {
          for await (const chunk of stream) {
            signal?.throwIfAborted();
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
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
        await locator.fill(request.input.value, {
          timeout: ACTION_TIMEOUT_MS,
          signal,
        });
      } else if (request.kind === "select") {
        if (typeof request.input.value !== "string")
          throw new Error("Browser select value is invalid.");
        await locator.selectOption(request.input.value, {
          timeout: ACTION_TIMEOUT_MS,
          signal,
        });
      } else if (request.kind === "key") {
        if (typeof request.input.key !== "string")
          throw new Error("Browser key is invalid.");
        await locator.press(request.input.key, {
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
        await locator.click({ timeout: ACTION_TIMEOUT_MS, signal });
      }
      return { changed: true };
    },
    async close() {
      if (closed) return;
      closed = true;
      pages.clear();
      await withDeadline(
        context.close({ reason: "Pi browser shutdown" }),
        15_000,
      );
    },
  };
}
