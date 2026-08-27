import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
