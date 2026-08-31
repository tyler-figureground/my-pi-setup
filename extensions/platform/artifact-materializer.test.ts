import assert from "node:assert/strict";
import test from "node:test";
import { materializeArtifact } from "./src/artifacts/materializer.ts";
import { scanArtifactSensitivity } from "./src/artifacts/scanner.ts";
import type { ArtifactMetadata } from "./src/core/artifacts/index.ts";

function metadata(
  mediaType: string,
  custom?: Record<string, boolean>,
): ArtifactMetadata {
  return {
    id: "a".repeat(64),
    sha256: "a".repeat(64),
    size: 1,
    createdAt: 1,
    mediaType,
    ...(custom ? { metadata: custom } : {}),
  };
}

test("Markdown and static HTML are rendered then sanitized at the final materialization seam", () => {
  const markdown = materializeArtifact(
    metadata("text/markdown"),
    Buffer.from(
      "# Report\n\n<script>alert(1)</script>\n[escape](https://attacker.example)",
    ),
  );
  const markdownText = Buffer.from(markdown.body).toString("utf8");
  assert.match(markdownText, /<h1>Report<\/h1>/);
  assert.equal(markdownText.includes("<script"), false);
  assert.equal(markdownText.includes("attacker.example"), false);
  assert.equal(markdown.interactive, false);

  const html = materializeArtifact(
    metadata("text/html"),
    Buffer.from(
      '<img src="https://attacker.example/leak" onerror="alert(1)"><p style="color:red">Safe</p>',
    ),
  );
  const htmlText = Buffer.from(html.body).toString("utf8");
  assert.equal(htmlText.includes("attacker.example"), false);
  assert.equal(htmlText.includes("onerror"), false);
  assert.equal(htmlText.includes("color:red"), false);
  assert.match(htmlText, /<p>Safe<\/p>/);
});

test("explicit interactive HTML preserves script only for sandboxed adapter containment", () => {
  const source =
    "<!doctype html><script>document.body.textContent='interactive'</script>";
  const result = materializeArtifact(
    metadata("text/html", { interactive: true }),
    Buffer.from(source),
  );
  assert.equal(result.interactive, true);
  assert.equal(Buffer.from(result.body).toString("utf8"), source);
});

test("sensitivity scanner catches common token families and local path forms", () => {
  for (const value of [
    "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    "github_pat_1234567890abcdefghijklmnopqrstuv",
    "postgres://user:password@example.test/db",
  ]) {
    assert.equal(
      scanArtifactSensitivity(Buffer.from(value)).verdict,
      "blocked",
      value,
    );
  }
  for (const value of [
    "C:/Users/Tyler/private/file.ts",
    "C:/work/private.txt",
    "/etc/private.conf",
    "Evidence:/home/tyler/private",
    "<code>/home/用户/private</code>",
    "/c/Users/Tyler/private/file.ts",
    "/Users/tyler/private/file.ts",
  ]) {
    assert.equal(
      scanArtifactSensitivity(Buffer.from(value)).verdict,
      "review",
      value,
    );
  }
});

test("JSON renders as escaped formatted text and malformed MIME/signatures fail", () => {
  const json = materializeArtifact(
    metadata("application/json"),
    Buffer.from(JSON.stringify({ html: "</script><script>alert(1)</script>" })),
  );
  const text = Buffer.from(json.body).toString("utf8");
  assert.equal(text.includes("</script><script>"), false);
  assert.match(text, /&lt;\/script&gt;/);
  assert.throws(() =>
    materializeArtifact(metadata("image/png"), Buffer.from("not-png")),
  );
  assert.throws(() =>
    materializeArtifact(metadata("application/octet-stream"), Buffer.from("x")),
  );
});
