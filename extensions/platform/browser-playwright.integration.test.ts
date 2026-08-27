import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPlaywrightBrowserAdapter } from "./src/browser/playwright.ts";

const chromePath = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chromeTest = existsSync(chromePath) ? test : test.skip;

chromeTest(
  "real Playwright adapter uses an isolated profile and returns AI accessibility refs",
  async () => {
    const profile = await mkdtemp(path.join(tmpdir(), "pi-browser-profile-"));
    const server = createServer((request, response) => {
      if (request.url === "/missing") {
        response.statusCode = 500;
        response.end("failed");
        return;
      }
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        `<!doctype html><title>Fixture</title><label>Name <input aria-label="Name"></label><input type="file" aria-label="Upload"><a download="fixture.txt" href="data:text/plain,fixture-download">Download</a><button onclick="document.title='Clicked'">Submit</button><script>console.error('fixture-console');fetch('/missing');setTimeout(()=>{throw new Error('fixture-page-error')},0)</script>`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address && typeof address === "object" ? address.port : 0}`;
    const adapter = createPlaywrightBrowserAdapter();
    let connection;
    try {
      connection = await adapter.start({
        profileDirectory: profile,
        executablePath: chromePath,
        serviceWorkers: "block",
        authorizeUrl: async (url) => url.startsWith(origin),
      });
      const page = await connection.openPage(`${origin}/fixture`);
      assert.equal(page.title, "Fixture");
      const snapshot = await connection.observe({
        pageId: page.id,
        kind: "snapshot",
      });
      assert.equal(typeof snapshot, "object");
      const text = (snapshot as { text?: unknown }).text;
      assert.equal(typeof text, "string");
      assert.match(text as string, /button "Submit"/);
      const buttonRef = /button "Submit" \[ref=(e\d+)\]/.exec(
        text as string,
      )?.[1];
      const uploadRef = /button "Upload" \[ref=(e\d+)\]/.exec(
        text as string,
      )?.[1];
      const downloadRef = /link "Download" \[ref=(e\d+)\]/.exec(
        text as string,
      )?.[1];
      assert.equal(typeof buttonRef, "string");
      assert.equal(typeof uploadRef, "string", text as string);
      assert.equal(typeof downloadRef, "string", text as string);
      const classification = await connection.classifyAction?.({
        pageId: page.id,
        kind: "click",
        input: { ref: buttonRef! },
      });
      assert.equal(classification?.effect, "remote-write");
      await connection.act({
        pageId: page.id,
        kind: "click",
        input: { ref: buttonRef! },
      });
      assert.equal((await connection.listPages())[0]?.title, "Clicked");
      await connection.act({
        pageId: page.id,
        kind: "upload",
        input: {
          ref: uploadRef!,
          filename: "upload.txt",
          mediaType: "text/plain",
          base64: Buffer.from("fixture-upload").toString("base64"),
        },
      });
      const download = await connection.act({
        pageId: page.id,
        kind: "download",
        input: { ref: downloadRef! },
      });
      assert.equal(
        Buffer.from(
          (download as { base64: string }).base64,
          "base64",
        ).toString(),
        "fixture-download",
      );
      const consoleRecords = await connection.observe({
        pageId: page.id,
        kind: "console",
      });
      assert.match(JSON.stringify(consoleRecords), /fixture-console/);
      const pageErrors = await connection.observe({
        pageId: page.id,
        kind: "page-errors",
      });
      assert.match(JSON.stringify(pageErrors), /fixture-page-error/);
      const network = await connection.observe({
        pageId: page.id,
        kind: "network",
      });
      assert.match(JSON.stringify(network), /missing/);
      assert.match(JSON.stringify(network), /500/);
      const screenshot = await connection.observe({
        pageId: page.id,
        kind: "screenshot",
      });
      const base64 = (screenshot as { base64?: unknown }).base64;
      assert.equal(typeof base64, "string");
      assert.deepEqual(
        Buffer.from(base64 as string, "base64").subarray(0, 8),
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
    } finally {
      await connection?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
  },
);

chromeTest(
  "Playwright network authority is one-shot, page-bound, and treats HEAD as protected",
  async () => {
    const profile = await mkdtemp(path.join(tmpdir(), "pi-browser-network-"));
    const received: string[] = [];
    const server = createServer((request, response) => {
      if (request.method !== "GET")
        received.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (request.url === "/background")
        response.end(
          `<!doctype html><title>Background</title><script>setInterval(()=>fetch('/background-write',{method:'POST'}).catch(()=>{}),20)</script>`,
        );
      else if (request.url === "/actor")
        response.end(
          `<!doctype html><title>Actor</title><button onclick="fetch('/first',{method:'POST'});fetch('/second',{method:'POST'})">Mutate</button><script>fetch('/head',{method:'HEAD'}).catch(()=>{})</script>`,
        );
      else response.end("ok");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address && typeof address === "object" ? address.port : 0}`;
    let connection;
    try {
      connection = await createPlaywrightBrowserAdapter().start({
        profileDirectory: profile,
        executablePath: chromePath,
        serviceWorkers: "block",
        authorizeUrl: async (url, request) =>
          url.startsWith(origin) &&
          (request?.method === "GET" || request?.mutationApproved === true),
      });
      await connection.openPage(`${origin}/background`);
      const actor = await connection.openPage(`${origin}/actor`);
      const snapshot = await connection.observe({
        pageId: actor.id,
        kind: "snapshot",
      });
      const ref = /button "Mutate" \[ref=(e\d+)\]/.exec(
        (snapshot as { text: string }).text,
      )?.[1];
      assert.equal(typeof ref, "string");
      await connection.act({
        pageId: actor.id,
        kind: "click",
        input: { ref: ref! },
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(received.length, 1, JSON.stringify(received));
      assert.match(received[0]!, /^POST \/(?:first|second)$/);
    } finally {
      await Promise.resolve(connection?.close()).catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
  },
);

chromeTest(
  "Playwright adapter refuses profile collision while a separate Impeccable profile coexists",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-browser-coexist-"));
    const platformProfile = path.join(root, "platform");
    const impeccableProfile = path.join(root, "impeccable");
    const adapter = createPlaywrightBrowserAdapter();
    const first = await adapter.start({
      profileDirectory: platformProfile,
      executablePath: chromePath,
      serviceWorkers: "block",
      authorizeUrl: async () => false,
    });
    let impeccable;
    try {
      await assert.rejects(() =>
        adapter.start({
          profileDirectory: platformProfile,
          executablePath: chromePath,
          serviceWorkers: "block",
          authorizeUrl: async () => false,
        }),
      );
      impeccable = await adapter.start({
        profileDirectory: impeccableProfile,
        executablePath: chromePath,
        serviceWorkers: "block",
        authorizeUrl: async () => false,
      });
      assert.equal((await first.listPages()).length, 0);
      assert.equal((await impeccable.listPages()).length, 0);
    } finally {
      await impeccable?.close();
      await first.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

chromeTest(
  "Playwright recovers malformed leases and releases failed launches",
  async () => {
    const staleProfile = await mkdtemp(
      path.join(tmpdir(), "pi-browser-stale-"),
    );
    const failedProfile = await mkdtemp(
      path.join(tmpdir(), "pi-browser-failed-"),
    );
    const leaseName = ".pi-browser-profile-lease.json";
    let connection;
    try {
      await writeFile(path.join(staleProfile, leaseName), "", "utf8");
      connection = await createPlaywrightBrowserAdapter().start({
        profileDirectory: staleProfile,
        executablePath: chromePath,
        serviceWorkers: "block",
      });
      await connection.close();
      connection = undefined;
      assert.equal(existsSync(path.join(staleProfile, leaseName)), false);
      await assert.rejects(() =>
        createPlaywrightBrowserAdapter().start({
          profileDirectory: failedProfile,
          executablePath: path.join(failedProfile, "missing-browser.exe"),
          serviceWorkers: "block",
        }),
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(existsSync(path.join(failedProfile, leaseName)), false);
    } finally {
      await Promise.resolve(connection?.close()).catch(() => undefined);
      await rm(staleProfile, { recursive: true, force: true });
      await rm(failedProfile, { recursive: true, force: true });
    }
  },
);

chromeTest(
  "browser host resolver connects only to the address pinned before launch",
  async () => {
    const profile = await mkdtemp(path.join(tmpdir(), "pi-browser-pinned-"));
    const server = createServer((_request, response) =>
      response.end("<title>Pinned Host</title>"),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    const origin = `http://rebind.example.test:${port}`;
    let connection;
    try {
      connection = await createPlaywrightBrowserAdapter().start({
        profileDirectory: profile,
        executablePath: chromePath,
        serviceWorkers: "block",
        hostResolverRules: [
          { hostname: "rebind.example.test", address: "127.0.0.1" },
        ],
        authorizeUrl: async (url) => url.startsWith(origin),
      });
      assert.equal(
        (await connection.openPage(`${origin}/fixture`)).title,
        "Pinned Host",
      );
    } finally {
      await connection?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  },
);

chromeTest(
  "dedicated browser profiles persist their own cookies without crossing identities",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-browser-cookies-"));
    const profileA = path.join(root, "profile-a");
    const profileB = path.join(root, "profile-b");
    const server = createServer((request, response) => {
      if (request.url === "/set")
        response.setHeader(
          "set-cookie",
          "phase5=yes; Path=/; HttpOnly; Max-Age=3600",
        );
      response.setHeader("content-type", "text/html");
      response.end(
        `<title>${request.headers.cookie?.includes("phase5=yes") ? "cookie-present" : "cookie-absent"}</title>`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    const origin = `http://127.0.0.1:${address && typeof address === "object" ? address.port : 0}`;
    const adapter = createPlaywrightBrowserAdapter();
    const start = (profileDirectory: string) =>
      adapter.start({
        profileDirectory,
        executablePath: chromePath,
        serviceWorkers: "block",
        authorizeUrl: async (url) => url.startsWith(origin),
      });
    try {
      const first = await start(profileA);
      assert.equal(
        (await first.openPage(`${origin}/set`)).title,
        "cookie-absent",
      );
      assert.equal(
        (await first.openPage(`${origin}/check`)).title,
        "cookie-present",
      );
      await first.close();

      const restored = await start(profileA);
      assert.equal(
        (await restored.openPage(`${origin}/check`)).title,
        "cookie-present",
      );
      await restored.close();

      const isolated = await start(profileB);
      assert.equal(
        (await isolated.openPage(`${origin}/check`)).title,
        "cookie-absent",
      );
      await isolated.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true }).catch((error) => {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "EBUSY"
        )
          return;
        throw error;
      });
    }
  },
);
