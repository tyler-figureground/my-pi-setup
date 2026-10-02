import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type BrowserContext } from "playwright-core";
import {
  createBrowserControl,
  type BrowserAdapterConnection,
  type BrowserControlOutcome,
} from "./src/browser/index.ts";
import { createPlaywrightBrowserAdapter } from "./src/browser/playwright.ts";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
import { createExternalIntegrationControls } from "./src/external/index.ts";

const chromePath = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chromeTest = existsSync(chromePath) ? test : test.skip;

function authorityFrom(result: BrowserControlOutcome<unknown>) {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("Expected approval request.");
  assert.equal(result.error.code, "approval_required");
  const scope = result.error.details?.approvalScope;
  assert.equal(typeof scope, "string");
  return {
    kind: "external-user-authority" as const,
    value: "direct-user",
    scope: scope as string,
  };
}

chromeTest(
  "event instrumentation accepts site wrappers without losing approval freshness",
  async (t) => {
    const profile = await mkdtemp(path.join(tmpdir(), "pi-browser-events-"));
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><title>Before wrappers</title>
      <button onclick="window.fixtureClicks = (window.fixtureClicks || 0) + 1">Act</button>
      <script>
        "use strict";
        for (const name of ["addEventListener", "removeEventListener"]) {
          const previous = EventTarget.prototype[name];
          EventTarget.prototype[name] = function (...args) {
            return previous.apply(this, args);
          };
        }
        document.title = "Wrappers installed";
      </script>`);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const launch = chromium.launchPersistentContext.bind(chromium);
    let context: BrowserContext | undefined;
    let connection: BrowserAdapterConnection | undefined;
    const spy = t.mock.method(
      chromium,
      "launchPersistentContext",
      async (...args: Parameters<typeof launch>) => {
        context = await launch(...args);
        return context;
      },
    );
    const adapter = createPlaywrightBrowserAdapter();
    const control = createBrowserControl({
      profileDirectory: profile,
      executablePath: chromePath,
      allowedOrigins: [origin],
      allowLoopback: true,
      controls: createExternalIntegrationControls({
        authority: { verify: (token) => token.value === "direct-user" },
      }),
      artifacts: createInMemoryArtifactStore(),
      adapter: {
        async start(...args) {
          connection = await adapter.start(...args);
          return connection;
        },
      },
    });
    try {
      const opened = await control.act({ kind: "open", url: origin });
      assert.ok(opened.ok, JSON.stringify(opened));
      assert.equal(opened.value.page.title, "Wrappers installed");
      assert.ok(context);
      assert.ok(connection);
      const page = context.pages()[0]!;
      assert.deepEqual(
        await connection.observe({
          pageId: "playwright-1",
          kind: "page-errors",
        }),
        {
          kind: "page-errors",
          records: [],
        },
      );

      await t.test(
        "successive wrappers, saved functions, and native listener semantics",
        async () => {
          const result = await page.evaluate(() => {
            const generation = () =>
              (
                globalThis as typeof globalThis & {
                  __piBrowserEventGeneration: number;
                }
              ).__piBrowserEventGeneration;
            const proto = EventTarget.prototype;
            const checkpoints = [generation()];
            const savedAdd = proto.addEventListener;
            const savedRemove = proto.removeEventListener;
            // A second wrapping layer must capture the previous function, not a mutable delegate.
            proto.addEventListener = function (...args) {
              return savedAdd.apply(this, args);
            };
            checkpoints.push(generation());
            proto.removeEventListener = function (...args) {
              return savedRemove.apply(this, args);
            };
            checkpoints.push(generation());
            const target = new EventTarget();
            let calls = 0;
            let receiverCorrect = true;
            function listener(this: EventTarget) {
              calls += 1;
              receiverCorrect &&= this === target;
            }
            target.addEventListener("fixture", listener, true);
            checkpoints.push(generation());
            target.dispatchEvent(new Event("fixture"));
            target.removeEventListener("fixture", listener, true);
            checkpoints.push(generation());
            target.dispatchEvent(new Event("fixture"));
            savedAdd.call(target, "fixture", listener, { once: true });
            checkpoints.push(generation());
            target.dispatchEvent(new Event("fixture"));
            target.dispatchEvent(new Event("fixture"));
            savedRemove.call(target, "fixture", listener);
            checkpoints.push(generation());
            const abort = new AbortController();
            target.addEventListener("fixture", listener, {
              signal: abort.signal,
            });
            abort.abort();
            target.dispatchEvent(new Event("fixture"));
            const objectListener = {
              handleEvent() {
                calls += 1;
              },
            };
            target.addEventListener("fixture", objectListener);
            target.dispatchEvent(new Event("fixture"));
            target.removeEventListener("fixture", objectListener);
            target.dispatchEvent(new Event("fixture"));
            return { checkpoints, calls, receiverCorrect };
          });
          assert.equal(result.calls, 3);
          assert.equal(result.receiverCorrect, true);
          for (let i = 1; i < result.checkpoints.length; i += 1)
            assert.ok(result.checkpoints[i]! > result.checkpoints[i - 1]!);
        },
      );

      await t.test(
        "nondelegating replacements and receiver-local overrides stay tracked",
        async () => {
          const result = await page.evaluate(() => {
            const generation = () =>
              (
                globalThis as typeof globalThis & {
                  __piBrowserEventGeneration: number;
                }
              ).__piBrowserEventGeneration;
            const proto = EventTarget.prototype;
            const saved = proto.addEventListener;
            const target = new EventTarget();
            const checkpoints = [generation()];
            target.addEventListener = function () {};
            checkpoints.push(generation());
            const prototypeUnchanged = proto.addEventListener === saved;
            target.addEventListener("fixture", () => {});
            checkpoints.push(generation());
            proto.addEventListener = function () {};
            checkpoints.push(generation());
            proto.addEventListener.call(target, "fixture", () => {});
            checkpoints.push(generation());
            proto.addEventListener = saved;
            checkpoints.push(generation());
            let redefineBlocked = false;
            try {
              Object.defineProperty(proto, "addEventListener", {
                value: () => {},
              });
            } catch {
              redefineBlocked = true;
            }
            const beforeTamper = generation();
            const tamperRejected = !Reflect.set(
              globalThis,
              "__piBrowserEventGeneration",
              0,
            );
            return {
              checkpoints,
              prototypeUnchanged,
              redefineBlocked,
              tamperRejected,
              generationUnchanged: generation() === beforeTamper,
              deletionBlocked: !Reflect.deleteProperty(
                proto,
                "removeEventListener",
              ),
              rtcDisabled: typeof RTCPeerConnection === "undefined",
            };
          });
          for (let i = 1; i < result.checkpoints.length; i += 1)
            assert.ok(result.checkpoints[i]! > result.checkpoints[i - 1]!);
          for (const [key, value] of Object.entries(result))
            if (key !== "checkpoints") assert.equal(value, true, key);
        },
      );

      await t.test(
        "listener and method changes reject stale approvals without DOM changes",
        async () => {
          const observed = await control.observe({
            kind: "snapshot",
            pageId: opened.value.page.id,
          });
          assert.ok(observed.ok, JSON.stringify(observed));
          const ref = /button "Act" \[ref=(e\d+)\]/.exec(
            observed.value.preview,
          )?.[1];
          assert.ok(ref);
          const request = {
            kind: "click" as const,
            pageId: opened.value.page.id,
            ref,
          };
          for (const change of [
            "add",
            "remove",
            "replace-add",
            "replace-remove",
          ] as const) {
            const pending = await control.act(request);
            const authority = authorityFrom(pending);
            const body = await page.evaluate(() => document.body.outerHTML);
            await page.evaluate((change) => {
              const fixture = globalThis as typeof globalThis & {
                fixtureListener?: EventListener;
              };
              fixture.fixtureListener ??= () => {};
              if (change === "add")
                document.addEventListener("fixture", fixture.fixtureListener);
              else if (change === "remove")
                document.removeEventListener(
                  "fixture",
                  fixture.fixtureListener,
                );
              else {
                const name =
                  change === "replace-add"
                    ? "addEventListener"
                    : "removeEventListener";
                const previous = EventTarget.prototype[name];
                EventTarget.prototype[name] = function (...args) {
                  return previous.apply(this, args);
                };
              }
            }, change);
            assert.equal(
              await page.evaluate(() => document.body.outerHTML),
              body,
            );
            const rejected = await control.act({ ...request, authority });
            const fresh = authorityFrom(rejected);
            assert.notEqual(fresh.scope, authority.scope, change);
            assert.equal(
              await page.evaluate(
                () =>
                  (globalThis as typeof globalThis & { fixtureClicks?: number })
                    .fixtureClicks ?? 0,
              ),
              0,
            );
          }
          // Drift after initial identity capture must also fail the final
          // revalidation, even when the supplied approval initially matched.
          const beforeDelay = await control.act(request);
          const classify = connection!.classifyAction!;
          let drifted = false;
          connection!.classifyAction = async (...args) => {
            const result = await classify(...args);
            if (!drifted) {
              drifted = true;
              await page.evaluate(() => {
                document.addEventListener("fixture-delayed", () => {});
              });
            }
            return result;
          };
          try {
            const rejected = await control.act({
              ...request,
              authority: authorityFrom(beforeDelay),
            });
            assert.notEqual(
              authorityFrom(rejected).scope,
              authorityFrom(beforeDelay).scope,
            );
            assert.ok(!rejected.ok);
            assert.match(rejected.error.message, /target changed/);
          } finally {
            connection!.classifyAction = classify;
          }
          const pending = await control.act(request);
          const approved = await control.act({
            ...request,
            authority: authorityFrom(pending),
          });
          assert.ok(approved.ok, JSON.stringify(approved));
          assert.equal(
            await page.evaluate(
              () =>
                (globalThis as typeof globalThis & { fixtureClicks?: number })
                  .fixtureClicks,
            ),
            1,
          );
        },
      );
    } finally {
      await control.close();
      spy.mock.restore();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(profile, { recursive: true, force: true });
    }
  },
);
