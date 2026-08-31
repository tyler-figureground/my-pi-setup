import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import type { ArtifactMetadata } from "../core/artifacts/index.ts";
import type { ArtifactKind } from "./model.ts";

export interface MaterializedArtifact {
  readonly body: Uint8Array;
  readonly mediaType: string;
  readonly kind: ArtifactKind;
  readonly interactive: boolean;
  readonly live: boolean;
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });

function text(body: Uint8Array) {
  const value = textDecoder.decode(body);
  if (value.includes("\0"))
    throw new Error("Artifact text contains NUL bytes.");
  return value;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function document(body: string) {
  return Buffer.from(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif}body{max-width:76ch;margin:0 auto;padding:2rem}pre{overflow:auto;padding:1rem;background:#7772;border-radius:.5rem}code{font-family:ui-monospace,monospace}img{max-width:100%;height:auto}table{border-collapse:collapse}th,td{border:1px solid #8886;padding:.4rem}</style></head><body>${body}</body></html>`,
    "utf8",
  );
}

function sanitize(value: string) {
  return sanitizeHtml(value, {
    allowedTags: [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "br",
      "hr",
      "blockquote",
      "pre",
      "code",
      "strong",
      "em",
      "del",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "a",
    ],
    allowedAttributes: {},
    disallowedTagsMode: "discard",
    allowProtocolRelative: false,
    enforceHtmlBoundary: true,
    parseStyleAttributes: false,
  });
}

function validImage(body: Uint8Array, mediaType: string) {
  const bytes = Buffer.from(body);
  if (mediaType === "image/png")
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mediaType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8;
  if (mediaType === "image/gif")
    return ["GIF87a", "GIF89a"].includes(
      bytes.subarray(0, 6).toString("ascii"),
    );
  if (mediaType === "image/webp")
    return (
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    );
  return false;
}

export function materializeArtifact(
  metadata: ArtifactMetadata,
  body: Uint8Array,
): MaterializedArtifact {
  const mediaType = metadata.mediaType?.toLowerCase().split(";", 1)[0]?.trim();
  const live = metadata.metadata?.live === true;
  if (mediaType === "text/markdown" || mediaType === "text/plain") {
    const rendered = marked.parse(text(body), { async: false });
    return {
      body: document(sanitize(rendered)),
      mediaType: "text/html",
      kind: "markdown",
      interactive: false,
      live,
    };
  }
  if (mediaType === "text/html") {
    const source = text(body);
    const interactive = metadata.metadata?.interactive === true;
    return {
      body: interactive
        ? Buffer.from(source, "utf8")
        : document(sanitize(source)),
      mediaType,
      kind: "html",
      interactive,
      live,
    };
  }
  if (mediaType === "application/json") {
    const parsed = JSON.parse(text(body));
    return {
      body: document(
        `<pre><code>${escapeHtml(JSON.stringify(parsed, null, 2))}</code></pre>`,
      ),
      mediaType: "text/html",
      kind: "json",
      interactive: false,
      live,
    };
  }
  if (mediaType === "application/vnd.pi.artifact-bundle+json") {
    JSON.parse(text(body));
    return {
      body: Buffer.from(body),
      mediaType,
      kind: "bundle",
      interactive: false,
      live,
    };
  }
  if (mediaType?.startsWith("image/") && validImage(body, mediaType)) {
    return {
      body: Buffer.from(body),
      mediaType,
      kind: "image",
      interactive: false,
      live,
    };
  }
  throw new Error("Artifact MIME type or body signature is unsupported.");
}
