import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const url = process.env.PI_ARTIFACT_VIEWER_URL;
if (!url) throw new Error("PI_ARTIFACT_VIEWER_URL is required.");
const executables = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
];
const executablePath = executables.find(existsSync);
if (!executablePath) throw new Error("Chrome or Edge executable was not found.");
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleEntries = [];
const pageErrors = [];
const failedRequests = [];
page.on("console", (message) => consoleEntries.push(message.text()));
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("requestfailed", (request) => failedRequests.push(new URL(request.url()).origin));
try {
  await page.goto(url, { waitUntil: "load" });
  const frame = page.frameLocator('iframe[title="Artifact"]');
  await frame.getByText("Opaque origin and network blocked").waitFor();
  await frame.getByRole("button", { name: "Count: 0" }).click();
  await frame.getByRole("button", { name: "Count: 1" }).waitFor();
  if (pageErrors.length > 0)
    throw new Error(`Artifact viewer page errors: ${pageErrors.join("; ")}`);
  if (failedRequests.length > 0)
    throw new Error(
      `Artifact viewer emitted network requests: ${failedRequests.join("; ")}`,
    );
  if (
    consoleEntries.some((entry) =>
      /NETWORK ESCAPED|Isolation failed/iu.test(entry),
    )
  )
    throw new Error("Artifact viewer isolation assertion failed.");
  const output = path.resolve("../../docs/verification/phase-9-artifact-viewer.png");
  await mkdir(path.dirname(output), { recursive: true });
  await page.screenshot({ path: output, fullPage: true });
  console.log(
    JSON.stringify({
      origin: new URL(url).origin,
      semantic: "opaque parent access blocked; network blocked; interaction count advanced",
      screenshot: output,
      pageErrors,
      failedRequestOrigins: [...new Set(failedRequests)],
      consoleCount: consoleEntries.length,
    }),
  );
} finally {
  await browser.close();
}
