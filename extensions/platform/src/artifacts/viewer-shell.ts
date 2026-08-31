export function viewerShell(nonce: string) {
  const script = `(()=>{const denied="This private Artifact link expired or was revoked. Ask its owner for a new link.";const token=location.hash.slice(1);history.replaceState(null,"",location.pathname);if(!token){document.body.textContent="This private Artifact link is incomplete. Ask its owner to open or share it again.";return}fetch("/session",{method:"POST",headers:{"X-Artifact-Capability":token}}).then(async response=>{if(!response.ok)throw new Error(denied);const session=await response.json();const frame=document.createElement("iframe");frame.title="Artifact";frame.setAttribute("sandbox","allow-scripts");frame.referrerPolicy="no-referrer";frame.src=session.contentPath;document.body.replaceChildren(frame);if(session.live){let revision=session.revision;setInterval(()=>fetch(session.contentPath.replace(/content$/,"revision")).then(response=>response.ok?response.json():Promise.reject()).then(next=>{if(next.revision!==revision){revision=next.revision;frame.src=session.contentPath+"?revision="+revision}}).catch(()=>{}),1000)}}).catch(()=>{document.body.textContent=denied})})();`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Private Artifact</title><style nonce="${nonce}">html,body,iframe{box-sizing:border-box;width:100%;height:100%;margin:0;border:0}body{background:#111;color:#eee;font:16px system-ui;display:grid;place-items:center}iframe{background:white}</style></head><body><!-- THESIS: Artifact leads; viewer chrome disappears instead of becoming a dashboard. OWN-WORLD: neutral system surface, full-bleed content, no decorative containers. STORY: verify private access, then place exact Artifact in focus. FIRST VIEWPORT: single edge-to-edge frame with a brief accessible opening state. FORM: Operate surface, security-first local viewer. FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance. -->Opening private Artifact…<script nonce="${nonce}">${script}</script></body></html>`;
}

export function shellCsp(nonce: string) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "frame-src 'self'",
    "img-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "trusted-types artifact-shell",
    "require-trusted-types-for 'script'",
  ].join("; ");
}

export function artifactCsp(interactive: boolean) {
  return [
    "default-src 'none'",
    interactive ? "sandbox allow-scripts" : "sandbox",
    interactive ? "script-src 'unsafe-inline' blob:" : "script-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}
