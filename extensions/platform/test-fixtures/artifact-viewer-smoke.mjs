import { createLocalArtifactPublicationAdapter } from "../src/artifacts/local-viewer.ts";

const viewer = createLocalArtifactPublicationAdapter({ port: 4173 });
const published = await viewer.adapter.publish({
  handle: "visual-smoke",
  body: Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>Artifact smoke</title><style>body{font:16px/1.6 system-ui;margin:0;padding:2rem;color:#172033;background:#f5f3ec}button{font:inherit;padding:.6rem 1rem;border:1px solid #172033;background:#fff;color:#172033;border-radius:.35rem}button:focus-visible{outline:3px solid #2563eb;outline-offset:3px}</style></head><body><main><h1>Interactive Artifact</h1><p id="isolation">Checking isolation…</p><button id="increment">Count: 0</button></main><script>let isolated=false;try{void parent.document}catch{isolated=true}fetch("https://example.com/artifact-network-canary").then(()=>document.querySelector("#isolation").textContent="NETWORK ESCAPED").catch(()=>document.querySelector("#isolation").textContent=isolated?"Opaque origin and network blocked":"Isolation failed");let count=0;document.querySelector("#increment").addEventListener("click",event=>{count++;event.currentTarget.textContent="Count: "+count})</script></body></html>`),
  mediaType: "text/html",
  kind: "html",
  interactive: true,
  live: false,
  access: "private",
  expiresAt: Date.now() + 10 * 60_000,
});
if (!published.ok) throw new Error(published.error.message);
console.log(`ARTIFACT_VIEWER_URL=${published.value.shareUrl}`);

const close = async () => {
  await viewer.close();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
await new Promise(() => {});
