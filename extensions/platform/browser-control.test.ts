import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
import { createInMemoryCredentialVault } from "./src/external/credentials.ts";
import { createExternalIntegrationControls } from "./src/external/index.ts";
import {
  createBrowserControl,
  type BrowserAdapterConnection,
} from "./src/browser/index.ts";

test("BrowserControl starts lazily with its dedicated profile and exposes only owned pages", async () => {
  const starts: unknown[] = [];
  const closes: string[] = [];
  const control = createBrowserControl({
    profileDirectory: "C:/phase5/browser-profile",
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    allowedOrigins: ["http://127.0.0.1:4173"],
    allowLoopback: true,
    controls: createExternalIntegrationControls(),
    artifacts: createInMemoryArtifactStore(),
    adapter: {
      async start(options): Promise<BrowserAdapterConnection> {
        starts.push(options);
        const pages = new Map<
          string,
          { id: string; url: string; title: string }
        >();
        return {
          async listPages() {
            return [...pages.values()];
          },
          async openPage(url) {
            const page = {
              id: `adapter-${pages.size + 1}`,
              url,
              title: "Fixture",
            };
            pages.set(page.id, page);
            return page;
          },
          async closePage(id) {
            pages.delete(id);
          },
          async observe() {
            throw new Error("not used");
          },
          async act() {
            throw new Error("not used");
          },
          async close() {
            closes.push("connection");
          },
        };
      },
    },
  });

  assert.deepEqual(control.status(), {
    state: "idle",
    profileDirectory: "C:/phase5/browser-profile",
    pageCount: 0,
  });
  assert.deepEqual(starts, []);

  const opened = await control.act({
    kind: "open",
    url: "http://127.0.0.1:4173/fixture",
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(opened.value.page.id, "page-1");
  assert.equal(starts.length, 1);
  assert.deepEqual(
    {
      ...(starts[0] as Record<string, unknown>),
      authorizeUrl: typeof (starts[0] as { authorizeUrl?: unknown })
        .authorizeUrl,
    },
    {
      profileDirectory: "C:/phase5/browser-profile",
      executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
      serviceWorkers: "block",
      authorizeUrl: "function",
    },
  );
  assert.deepEqual(await control.pages(), [
    { id: "page-1", url: "http://127.0.0.1:4173/fixture", title: "Fixture" },
  ]);

  await control.close();
  assert.deepEqual(closes, ["connection"]);
});

test("BrowserControl bounds observations and persists complete evidence outside model output", async () => {
  const artifacts = createInMemoryArtifactStore();
  const fullSnapshot = `button "Submit" [ref=e1]\n${"x".repeat(70_000)}`;
  const control = createBrowserControl({
    profileDirectory: "C:/phase5/browser-profile",
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    allowedOrigins: ["http://127.0.0.1:4173"],
    allowLoopback: true,
    controls: createExternalIntegrationControls(),
    artifacts,
    adapter: {
      async start(): Promise<BrowserAdapterConnection> {
        return {
          async listPages() {
            return [
              {
                id: "adapter-1",
                url: "http://127.0.0.1:4173/",
                title: "Fixture",
              },
            ];
          },
          async openPage() {
            return {
              id: "adapter-1",
              url: "http://127.0.0.1:4173/",
              title: "Fixture",
            };
          },
          async closePage() {},
          async observe(request) {
            assert.equal(request.pageId, "adapter-1");
            return { kind: "snapshot", text: fullSnapshot };
          },
          async act() {
            throw new Error("not used");
          },
          async close() {},
        };
      },
    },
  });
  const opened = await control.act({
    kind: "open",
    url: "http://127.0.0.1:4173/",
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const observed = await control.observe({
    kind: "snapshot",
    pageId: opened.value.page.id,
  });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(Buffer.byteLength(observed.value.preview) <= 50 * 1024, true);
  assert.equal(observed.value.truncated, true);
  assert.equal(typeof observed.value.artifactId, "string");
  const stored = await artifacts.get(observed.value.artifactId!);
  assert.equal(stored.ok, true);
  if (stored.ok)
    assert.equal(Buffer.from(stored.value.body).toString("utf8"), fullSnapshot);
});

test("BrowserControl rejects an allowed navigation that redirects to a denied target", async () => {
  const closed: string[] = [];
  const control = createBrowserControl({
    profileDirectory: "C:/phase5/browser-profile",
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    allowedOrigins: ["http://127.0.0.1:4173"],
    allowLoopback: true,
    controls: createExternalIntegrationControls(),
    artifacts: createInMemoryArtifactStore(),
    adapter: {
      async start(): Promise<BrowserAdapterConnection> {
        return {
          async listPages() {
            return [];
          },
          async openPage() {
            return {
              id: "redirected",
              url: "http://169.254.169.254/latest/meta-data",
              title: "metadata",
            };
          },
          async closePage(id) {
            closed.push(id);
          },
          async observe() {
            throw new Error("not used");
          },
          async act() {
            throw new Error("not used");
          },
          async close() {},
        };
      },
    },
  });

  const result = await control.act({
    kind: "open",
    url: "http://127.0.0.1:4173/redirect",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "policy_denied");
  assert.deepEqual(closed, ["redirected"]);
  assert.equal(control.status().pageCount, 0);
});

test("BrowserControl requires direct authority before a protected page action", async () => {
  let actions = 0;
  const control = createBrowserControl({
    profileDirectory: "C:/phase5/browser-profile",
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    allowedOrigins: ["http://127.0.0.1:4173"],
    allowLoopback: true,
    controls: createExternalIntegrationControls({
      authority: { verify: (token) => token.value === "direct-user" },
    }),
    artifacts: createInMemoryArtifactStore(),
    adapter: {
      async start(): Promise<BrowserAdapterConnection> {
        return {
          async listPages() {
            return [
              {
                id: "adapter-1",
                url: "http://127.0.0.1:4173/",
                title: "Fixture",
              },
            ];
          },
          async openPage() {
            return {
              id: "adapter-1",
              url: "http://127.0.0.1:4173/",
              title: "Fixture",
            };
          },
          async closePage() {},
          async observe() {
            throw new Error("not used");
          },
          async classifyAction() {
            return { effect: "remote-write", reason: "submit control" };
          },
          async act() {
            actions += 1;
            return { changed: true };
          },
          async close() {},
        };
      },
    },
  });
  const opened = await control.act({
    kind: "open",
    url: "http://127.0.0.1:4173/",
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const pending = await control.act({
    kind: "click",
    pageId: opened.value.page.id,
    ref: "e4",
  });
  assert.equal(pending.ok, false);
  if (!pending.ok) assert.equal(pending.error.code, "approval_required");
  assert.equal(actions, 0);

  const approved = await control.act({
    kind: "click",
    pageId: opened.value.page.id,
    ref: "e4",
    authority: { kind: "external-user-authority", value: "direct-user" },
  });
  assert.equal(approved.ok, true);
  assert.equal(actions, 1);
});

test("BrowserControl sanitizes console and network observations before artifact persistence", async () => {
  const artifacts = createInMemoryArtifactStore();
  const control = createBrowserControl({
    profileDirectory: "C:/phase5/browser-profile",
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    allowedOrigins: ["http://127.0.0.1:4173"],
    allowLoopback: true,
    controls: createExternalIntegrationControls(),
    artifacts,
    adapter: {
      async start(): Promise<BrowserAdapterConnection> {
        return {
          async listPages() {
            return [
              {
                id: "adapter-1",
                url: "http://127.0.0.1:4173/",
                title: "Fixture",
              },
            ];
          },
          async openPage() {
            return {
              id: "adapter-1",
              url: "http://127.0.0.1:4173/",
              title: "Fixture",
            };
          },
          async closePage() {},
          async observe() {
            return {
              kind: "network",
              records: [
                {
                  url: "http://127.0.0.1:4173/callback?code=oauth-secret&state=ok",
                  authorization: "Bearer secret-token",
                  status: 200,
                },
              ],
            };
          },
          async act() {
            throw new Error("not used");
          },
          async close() {},
        };
      },
    },
  });
  const opened = await control.act({
    kind: "open",
    url: "http://127.0.0.1:4173/",
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const result = await control.observe({
    kind: "network",
    pageId: opened.value.page.id,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.preview.includes("oauth-secret"), false);
  assert.equal(result.value.preview.includes("secret-token"), false);
  const stored = await artifacts.get(result.value.artifactId);
  assert.equal(stored.ok, true);
  if (stored.ok) {
    const body = Buffer.from(stored.value.body).toString("utf8");
    assert.equal(body.includes("oauth-secret"), false);
    assert.equal(body.includes("secret-token"), false);
  }
});

test("BrowserControl persists screenshots without returning pixels in model preview", async () => {
  const artifacts = createInMemoryArtifactStore();
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const control = createBrowserControl({
    profileDirectory: "C:/phase5/browser-profile",
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    allowedOrigins: ["http://127.0.0.1:4173"],
    allowLoopback: true,
    controls: createExternalIntegrationControls(),
    artifacts,
    adapter: {
      async start(): Promise<BrowserAdapterConnection> {
        return {
          async listPages() {
            return [
              {
                id: "adapter-1",
                url: "http://127.0.0.1:4173/",
                title: "Fixture",
              },
            ];
          },
          async openPage() {
            return {
              id: "adapter-1",
              url: "http://127.0.0.1:4173/",
              title: "Fixture",
            };
          },
          async closePage() {},
          async observe() {
            return {
              kind: "screenshot",
              mediaType: "image/png",
              base64: png.toString("base64"),
            };
          },
          async act() {
            throw new Error("not used");
          },
          async close() {},
        };
      },
    },
  });
  const opened = await control.act({
    kind: "open",
    url: "http://127.0.0.1:4173/",
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const result = await control.observe({
    kind: "screenshot",
    pageId: opened.value.page.id,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.preview.includes(png.toString("base64")), false);
  const stored = await artifacts.get(result.value.artifactId);
  assert.equal(stored.ok, true);
  if (stored.ok) assert.deepEqual(Buffer.from(stored.value.body), png);
});

test("BrowserControl allows bounded form interaction normally but plan mode blocks it", async () => {
  let mode: "normal" | "plan" = "normal";
  const actions: unknown[] = [];
  const control = createBrowserControl({
    profileDirectory: "C:/phase5/browser-profile",
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    allowedOrigins: ["http://127.0.0.1:4173"],
    allowLoopback: true,
    controls: createExternalIntegrationControls(),
    artifacts: createInMemoryArtifactStore(),
    context: { actor: "parent", mode: () => mode },
    adapter: {
      async start(): Promise<BrowserAdapterConnection> {
        return {
          async listPages() {
            return [
              {
                id: "adapter-1",
                url: "http://127.0.0.1:4173/",
                title: "Fixture",
              },
            ];
          },
          async openPage() {
            return {
              id: "adapter-1",
              url: "http://127.0.0.1:4173/",
              title: "Fixture",
            };
          },
          async closePage() {},
          async observe() {
            throw new Error("not used");
          },
          async classifyAction() {
            return { effect: "local-write", reason: "form interaction" };
          },
          async act(request) {
            actions.push(request);
            return { changed: true };
          },
          async close() {},
        };
      },
    },
  });
  const opened = await control.act({
    kind: "open",
    url: "http://127.0.0.1:4173/",
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const filled = await control.act({
    kind: "fill",
    pageId: opened.value.page.id,
    ref: "e3",
    value: "hello",
  });
  assert.equal(filled.ok, true);
  assert.equal(actions.length, 1);

  mode = "plan";
  const blocked = await control.act({
    kind: "fill",
    pageId: opened.value.page.id,
    ref: "e3",
    value: "blocked",
  });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.error.code, "policy_denied");
  assert.equal(actions.length, 1);
});

test("BrowserControl injects password fields from a bound credential reference without exposing the secret", async () => {
  const credentials = createInMemoryCredentialVault({
    createReference: () => "credential:browser-password",
  });
  const stored = await credentials.store({
    binding: {
      integration: "browser",
      resourceId: "page-1",
      origin: "http://127.0.0.1:4173",
    },
    secret: "secret-password",
  });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  const actions: unknown[] = [];
  const control = createBrowserControl({
    profileDirectory: "C:/phase5/browser-profile",
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    allowedOrigins: ["http://127.0.0.1:4173"],
    allowLoopback: true,
    controls: createExternalIntegrationControls({
      authority: { verify: (token) => token.value === "direct-user" },
    }),
    credentials,
    artifacts: createInMemoryArtifactStore(),
    adapter: {
      async start(): Promise<BrowserAdapterConnection> {
        return {
          async listPages() {
            return [
              {
                id: "adapter-1",
                url: "http://127.0.0.1:4173/login",
                title: "Login",
              },
            ];
          },
          async openPage() {
            return {
              id: "adapter-1",
              url: "http://127.0.0.1:4173/login",
              title: "Login",
            };
          },
          async closePage() {},
          async observe() {
            throw new Error("not used");
          },
          async classifyAction() {
            return { effect: "credential-use", reason: "password field" };
          },
          async act(request) {
            actions.push(request);
            return { changed: true };
          },
          async close() {},
        };
      },
    },
  });
  const opened = await control.act({
    kind: "open",
    url: "http://127.0.0.1:4173/login",
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const result = await control.act({
    kind: "fill",
    pageId: opened.value.page.id,
    ref: "e2",
    credentialReference: stored.value.reference,
    authority: { kind: "external-user-authority", value: "direct-user" },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(JSON.stringify(result).includes("secret-password"), false);
  assert.equal(
    (actions[0] as { input?: { value?: string } }).input?.value,
    "secret-password",
  );
});

test("BrowserControl revalidates an owned-page navigation before the adapter acts", async () => {
  const actions: unknown[] = [];
  let url = "http://127.0.0.1:4173/start";
  const control = createBrowserControl({
    profileDirectory: "C:/phase5/browser-profile",
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    allowedOrigins: ["http://127.0.0.1:4173"],
    allowLoopback: true,
    controls: createExternalIntegrationControls(),
    artifacts: createInMemoryArtifactStore(),
    adapter: {
      async start(): Promise<BrowserAdapterConnection> {
        return {
          async listPages() {
            return [{ id: "adapter-1", url, title: "Fixture" }];
          },
          async openPage() {
            return { id: "adapter-1", url, title: "Fixture" };
          },
          async closePage() {},
          async observe() {
            throw new Error("not used");
          },
          async classifyAction(request) {
            return {
              effect: "network-read",
              reason: "navigation",
              destination: String(request.input.url),
            };
          },
          async act(request) {
            actions.push(request);
            url = String(request.input.url);
            return { changed: true };
          },
          async close() {},
        };
      },
    },
  });
  const opened = await control.act({ kind: "open", url });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const navigated = await control.act({
    kind: "navigate",
    pageId: opened.value.page.id,
    url: "http://127.0.0.1:4173/next",
  });
  assert.equal(navigated.ok, true, JSON.stringify(navigated));
  if (navigated.ok)
    assert.equal(navigated.value.page.url, "http://127.0.0.1:4173/next");
  assert.equal(actions.length, 1);

  const blocked = await control.act({
    kind: "navigate",
    pageId: opened.value.page.id,
    url: "http://169.254.169.254/latest/meta-data",
  });
  assert.equal(blocked.ok, false);
  assert.equal(actions.length, 1);
});

test("BrowserControl supports select, key, scroll, and wait with conservative action policy", async () => {
  const actions: Array<{ kind?: unknown }> = [];
  const control = createBrowserControl({
    profileDirectory: "C:/phase5/browser-profile",
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    allowedOrigins: ["http://127.0.0.1:4173"],
    allowLoopback: true,
    controls: createExternalIntegrationControls({
      authority: { verify: (token) => token.value === "direct-user" },
    }),
    artifacts: createInMemoryArtifactStore(),
    adapter: {
      async start(): Promise<BrowserAdapterConnection> {
        return {
          async listPages() {
            return [
              {
                id: "adapter-1",
                url: "http://127.0.0.1:4173/",
                title: "Fixture",
              },
            ];
          },
          async openPage() {
            return {
              id: "adapter-1",
              url: "http://127.0.0.1:4173/",
              title: "Fixture",
            };
          },
          async closePage() {},
          async observe() {
            throw new Error("not used");
          },
          async classifyAction(request) {
            return {
              effect:
                request.kind === "key"
                  ? "remote-write"
                  : request.kind === "wait"
                    ? "read"
                    : "local-write",
              reason: request.kind,
            };
          },
          async act(request) {
            actions.push(request);
            return { changed: true };
          },
          async close() {},
        };
      },
    },
  });
  const opened = await control.act({
    kind: "open",
    url: "http://127.0.0.1:4173/",
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const pageId = opened.value.page.id;
  assert.equal(
    (await control.act({ kind: "select", pageId, ref: "e3", value: "one" })).ok,
    true,
  );
  assert.equal(
    (await control.act({ kind: "scroll", pageId, deltaY: 400 })).ok,
    true,
  );
  assert.equal(
    (await control.act({ kind: "wait", pageId, ref: "e4", state: "visible" }))
      .ok,
    true,
  );
  const pending = await control.act({
    kind: "key",
    pageId,
    ref: "e4",
    key: "Enter",
  });
  assert.equal(pending.ok, false);
  assert.equal(
    (
      await control.act({
        kind: "key",
        pageId,
        ref: "e4",
        key: "Enter",
        authority: { kind: "external-user-authority", value: "direct-user" },
      })
    ).ok,
    true,
  );
  assert.deepEqual(
    actions.map(({ kind }) => kind),
    ["select", "scroll", "wait", "key"],
  );
});

test("BrowserControl gates upload/download and exchanges only bounded artifacts with the adapter", async () => {
  const artifacts = createInMemoryArtifactStore();
  const upload = await artifacts.put({
    body: "fixture upload",
    filename: "fixture.txt",
    mediaType: "text/plain",
  });
  assert.equal(upload.ok, true);
  if (!upload.ok) return;
  const actions: any[] = [];
  const downloaded = Buffer.from("fixture download");
  const control = createBrowserControl({
    profileDirectory: "C:/phase5/browser-profile",
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    allowedOrigins: ["http://127.0.0.1:4173"],
    allowLoopback: true,
    controls: createExternalIntegrationControls({
      authority: { verify: (token) => token.value === "direct-user" },
    }),
    artifacts,
    adapter: {
      async start(): Promise<BrowserAdapterConnection> {
        return {
          async listPages() {
            return [
              {
                id: "adapter-1",
                url: "http://127.0.0.1:4173/",
                title: "Fixture",
              },
            ];
          },
          async openPage() {
            return {
              id: "adapter-1",
              url: "http://127.0.0.1:4173/",
              title: "Fixture",
            };
          },
          async closePage() {},
          async observe() {
            throw new Error("not used");
          },
          async classifyAction(request) {
            return {
              effect:
                request.kind === "upload" ? "credential-use" : "local-write",
              reason: request.kind,
            };
          },
          async act(request) {
            actions.push(request);
            return request.kind === "download"
              ? {
                  kind: "download",
                  filename: "download.txt",
                  mediaType: "application/octet-stream",
                  base64: downloaded.toString("base64"),
                }
              : { changed: true };
          },
          async close() {},
        };
      },
    },
  });
  const opened = await control.act({
    kind: "open",
    url: "http://127.0.0.1:4173/",
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const pageId = opened.value.page.id;
  const pending = await control.act({
    kind: "upload",
    pageId,
    ref: "e5",
    artifactId: upload.value.id,
  });
  assert.equal(pending.ok, false);
  const approvedUpload = await control.act({
    kind: "upload",
    pageId,
    ref: "e5",
    artifactId: upload.value.id,
    authority: { kind: "external-user-authority", value: "direct-user" },
  });
  assert.equal(approvedUpload.ok, true, JSON.stringify(approvedUpload));
  assert.equal(
    actions[0].input.base64,
    Buffer.from("fixture upload").toString("base64"),
  );

  const approvedDownload = await control.act({
    kind: "download",
    pageId,
    ref: "e6",
    authority: { kind: "external-user-authority", value: "direct-user" },
  });
  assert.equal(approvedDownload.ok, true, JSON.stringify(approvedDownload));
  if (!approvedDownload.ok) return;
  assert.equal(typeof approvedDownload.value.artifactId, "string");
  const stored = await artifacts.get(approvedDownload.value.artifactId!);
  assert.equal(stored.ok, true);
  if (stored.ok) assert.deepEqual(Buffer.from(stored.value.body), downloaded);
});
