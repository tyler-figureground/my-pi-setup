import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createPinnedFetch } from "./src/external/pinned-fetch.ts";

test("pinned fetch connects only to the address approved for the hostname", async () => {
  const server = createServer((request, response) => {
    assert.match(request.headers.host ?? "", /^rebind\.example\.test:/);
    response.end("pinned");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  const url = `http://rebind.example.test:${port}/fixture`;
  try {
    const response = await createPinnedFetch({
      authorize: async (requested) => ({
        allowed: requested === url,
        canonicalUrl: requested,
        resolvedAddresses: ["127.0.0.1"],
      }),
    })(url);
    assert.equal(await response.text(), "pinned");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
