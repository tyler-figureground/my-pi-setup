import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { createLocalArtifactPublicationAdapter } from "./src/artifacts/local-viewer.ts";

async function getWithHost(url: URL, host: string) {
  return new Promise<number>((resolve, reject) => {
    const call = request(url, { headers: { Host: host } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    call.on("error", reject);
    call.end();
  });
}

async function openSession(shareUrl: string) {
  const url = new URL(shareUrl);
  const token = url.hash.slice(1);
  url.hash = "";
  const shell = await fetch(url);
  const shellText = await shell.text();
  assert.equal(shell.status, 200);
  assert.match(
    shell.headers.get("content-security-policy") ?? "",
    /default-src 'none'/,
  );
  assert.match(
    shell.headers.get("content-security-policy") ?? "",
    /trusted-types/,
  );
  assert.equal(shellText.includes(token), false);
  assert.equal(shellText.includes("PRIVATE ARTIFACT BODY"), false);
  assert.match(shellText, /Ask its owner for a new link/);

  const origin = url.origin;
  const exchange = await fetch(new URL("/session", origin), {
    method: "POST",
    headers: {
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "X-Artifact-Capability": token,
    },
  });
  assert.equal(exchange.status, 200);
  const cookie = exchange.headers.get("set-cookie");
  assert.ok(cookie);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  const session = (await exchange.json()) as {
    contentPath: string;
    live: boolean;
    revision: number;
  };
  return {
    origin,
    cookie: cookie.split(";", 1)[0]!,
    contentPath: session.contentPath,
    live: session.live,
    revision: session.revision,
  };
}

test("loopback viewer exchanges fragment capability and isolates interactive HTML", async () => {
  const viewer = createLocalArtifactPublicationAdapter({ clock: () => 100 });
  try {
    const published = await viewer.adapter.publish({
      handle: "publication-1",
      body: Buffer.from(
        "<!doctype html><script>document.body.textContent='PRIVATE ARTIFACT BODY'</script>",
      ),
      mediaType: "text/html",
      kind: "html",
      interactive: true,
      live: true,
      access: "private",
      expiresAt: 1_000,
    });
    assert.equal(published.ok, true);
    if (!published.ok) return;
    const share = new URL(published.value.shareUrl);
    assert.equal(share.hostname, "127.0.0.1");
    assert.ok(share.hash.length >= 44);

    const session = await openSession(published.value.shareUrl);
    const content = await fetch(new URL(session.contentPath, session.origin), {
      headers: { Cookie: session.cookie },
    });
    assert.equal(content.status, 200);
    assert.match(
      content.headers.get("content-security-policy") ?? "",
      /sandbox allow-scripts/,
    );
    assert.match(
      content.headers.get("content-security-policy") ?? "",
      /connect-src 'none'/,
    );
    assert.equal(content.headers.get("referrer-policy"), "no-referrer");
    assert.equal(content.headers.get("x-content-type-options"), "nosniff");
    assert.match(await content.text(), /PRIVATE ARTIFACT BODY/);
    assert.equal(session.live, true);
    assert.equal(session.revision, 1);
    assert.equal(
      await viewer.update(published.value.providerReference, {
        body: Buffer.from("<!doctype html><h1>REFRESHED BODY</h1>"),
        mediaType: "text/html",
        interactive: false,
      }),
      true,
    );
    const revision = await fetch(
      new URL(
        session.contentPath.replace(/content$/u, "revision"),
        session.origin,
      ),
      { headers: { Cookie: session.cookie } },
    );
    assert.deepEqual(await revision.json(), { revision: 2 });
    const refreshed = await fetch(
      new URL(session.contentPath, session.origin),
      { headers: { Cookie: session.cookie } },
    );
    assert.match(await refreshed.text(), /REFRESHED BODY/);
  } finally {
    await viewer.close();
  }
});

test("loopback viewer rejects cross-site exchange, wrong host, expiry, and revoked access", async () => {
  let now = 100;
  const viewer = createLocalArtifactPublicationAdapter({ clock: () => now });
  try {
    const published = await viewer.adapter.publish({
      handle: "publication-2",
      body: Buffer.from("<!doctype html><p>safe</p>"),
      mediaType: "text/html",
      kind: "html",
      interactive: false,
      live: false,
      access: "private",
      expiresAt: 200,
    });
    assert.equal(published.ok, true);
    if (!published.ok) return;
    const url = new URL(published.value.shareUrl);
    const crossSite = await fetch(new URL("/session", url.origin), {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "cross-site",
        "X-Artifact-Capability": url.hash.slice(1),
      },
    });
    assert.equal(crossSite.status, 403);

    const wrongHost = await getWithHost(
      new URL("/open", url.origin),
      `localhost:${url.port}`,
    );
    assert.equal(wrongHost, 421);

    const session = await openSession(published.value.shareUrl);
    const revoked = await viewer.adapter.revoke(
      published.value.providerReference,
    );
    assert.equal(revoked.ok, true);
    const denied = await fetch(new URL(session.contentPath, session.origin), {
      headers: { Cookie: session.cookie },
    });
    assert.equal(denied.status, 404);

    now = 300;
    const status = await viewer.adapter.status(
      published.value.providerReference,
    );
    assert.equal(status.ok, true);
    if (status.ok) assert.equal(status.value.state, "revoked");
  } finally {
    await viewer.close();
  }
});
