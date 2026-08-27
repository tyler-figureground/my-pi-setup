import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  BrowserActionRequest,
  BrowserControl,
  BrowserObservationKind,
} from "../browser/index.ts";
import type { CredentialVault } from "../external/credentials.ts";
import type { ExternalUserAuthorityToken } from "../external/index.ts";

const toolNames = ["browser_pages", "browser_action", "browser_observe"];

export interface BrowserCapabilityOptions {
  readonly issueAuthority?: (scope: string) => ExternalUserAuthorityToken;
}

function resultText(value: unknown, details: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details,
  };
}

export function createBrowserCapability(
  pi: ExtensionAPI,
  options: BrowserCapabilityOptions = {},
) {
  let browser: BrowserControl | undefined;
  let statusUi:
    { setStatus(key: string, value: string | undefined): void } | undefined;
  let credentials: CredentialVault | undefined;
  let credentialScope: string | undefined;

  pi.registerTool({
    name: "browser_pages",
    label: "Browser Pages",
    description: "List pages owned by the dedicated Pi browser session.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _parameters, signal) {
      if (!browser) throw new Error("Browser control is unavailable.");
      const pages = await browser.pages(signal);
      return resultText({ pages }, { pages });
    },
  });

  pi.registerTool({
    name: "browser_observe",
    label: "Browser Observe",
    description:
      "Capture bounded accessibility, screenshot, console, page-error, or network evidence from an owned page. Full evidence is stored as an artifact.",
    parameters: Type.Object(
      {
        kind: StringEnum([
          "snapshot",
          "screenshot",
          "console",
          "page-errors",
          "network",
        ] as const),
        pageId: Type.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    ),
    async execute(_id, parameters, signal) {
      if (!browser) throw new Error("Browser control is unavailable.");
      const observed = await browser.observe(
        {
          kind: parameters.kind as BrowserObservationKind,
          pageId: parameters.pageId,
        },
        signal,
      );
      if (!observed.ok) throw new Error(observed.error.message);
      return resultText(observed.value, observed.value);
    },
  });

  pi.registerTool({
    name: "browser_action",
    label: "Browser Action",
    description:
      "Open or close an owned page, click an accessibility ref, or fill a ref. Protected actions require direct user approval. Use credentialReference instead of a raw password.",
    parameters: Type.Object(
      {
        kind: StringEnum([
          "open",
          "close",
          "navigate",
          "click",
          "fill",
          "select",
          "key",
          "scroll",
          "wait",
          "upload",
          "download",
        ] as const),
        url: Type.Optional(Type.String({ maxLength: 8_192 })),
        pageId: Type.Optional(Type.String({ maxLength: 128 })),
        ref: Type.Optional(Type.String({ maxLength: 32 })),
        value: Type.Optional(Type.String({ maxLength: 64 * 1024 })),
        credentialReference: Type.Optional(Type.String({ maxLength: 256 })),
        artifactId: Type.Optional(Type.String({ maxLength: 64 })),
        key: Type.Optional(Type.String({ maxLength: 128 })),
        deltaY: Type.Optional(
          Type.Integer({ minimum: -10_000, maximum: 10_000 }),
        ),
        state: Type.Optional(StringEnum(["visible", "hidden"] as const)),
      },
      { additionalProperties: false },
    ),
    async execute(_id, parameters, signal, _update, ctx) {
      if (!browser) throw new Error("Browser control is unavailable.");
      const request = parameters as BrowserActionRequest;
      let acted = await browser.act(request, signal);
      if (!acted.ok && acted.error.code === "approval_required") {
        if (!ctx.hasUI || !options.issueAuthority)
          throw new Error(acted.error.message);
        const approvalScope = acted.error.details?.approvalScope;
        if (typeof approvalScope !== "string")
          throw new Error("Browser approval scope is unavailable.");
        const confirmed = await ctx.ui.confirm(
          "Approve browser action?",
          [
            `Action: ${String(acted.error.details?.action ?? parameters.kind)}`,
            `Origin: ${String(acted.error.details?.origin ?? "unknown")}`,
            `Page: ${String(acted.error.details?.pageId ?? "unknown")}`,
            `Reference: ${String(acted.error.details?.reference ?? "")}`,
            `Artifact: ${String(acted.error.details?.artifactId ?? "")}`,
            `Risk: ${String(acted.error.details?.reason ?? acted.error.message)}`,
            "Allow once?",
          ].join("\n"),
        );
        if (!confirmed) throw new Error("Browser action denied by user.");
        acted = await browser.act(
          {
            ...request,
            authority: options.issueAuthority(approvalScope),
          } as BrowserActionRequest,
          signal,
        );
      }
      if (!acted.ok) throw new Error(acted.error.message);
      statusUi?.setStatus(
        "platform:browser",
        `Browser ${browser.status().state} (${browser.status().pageCount})`,
      );
      return resultText(
        {
          page: acted.value.page,
          ...(acted.value.artifactId
            ? { artifactId: acted.value.artifactId }
            : {}),
        },
        {
          page: acted.value.page,
          ...(acted.value.artifactId
            ? { artifactId: acted.value.artifactId }
            : {}),
        },
      );
    },
  });

  pi.registerCommand("browser", {
    description:
      "Show browser status or manage credentials: credential-store, credential-remove",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) throw new Error("/browser requires TUI or RPC mode.");
      const [action = "status", first, second] = args
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (action === "credential-store") {
        if (!credentials || !credentialScope)
          throw new Error("Browser credential vault is unavailable.");
        if (!first || !second || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(second))
          throw new Error(
            "Usage: /browser credential-store <origin> <ENV_NAME>",
          );
        const url = new URL(first);
        if (url.origin !== first)
          throw new Error("Browser credential origin must be canonical.");
        const secret = process.env[second];
        if (!secret)
          throw new Error(`Environment variable ${second} is unavailable.`);
        delete process.env[second];
        const stored = await credentials.store({
          binding: {
            integration: "browser",
            resourceId: credentialScope,
            origin: url.origin,
          },
          secret,
        });
        if (!stored.ok) throw new Error(stored.error.message);
        ctx.ui.notify(
          `Stored opaque browser credential reference: ${stored.value.reference}`,
          "info",
        );
        return;
      }
      if (action === "credential-remove") {
        if (!credentials || !credentialScope || !first || !second)
          throw new Error(
            "Usage: /browser credential-remove <reference> <origin>",
          );
        const origin = new URL(second).origin;
        if (origin !== second)
          throw new Error("Browser credential origin must be canonical.");
        const removed = await credentials.remove(first, {
          integration: "browser",
          resourceId: credentialScope,
          origin,
        });
        if (!removed)
          throw new Error("Browser credential could not be removed.");
        ctx.ui.notify("Browser credential removed.", "info");
        return;
      }
      if (action !== "status")
        throw new Error(`Unknown /browser action ${JSON.stringify(action)}.`);
      const status = browser?.status();
      ctx.ui.notify(
        status
          ? `Browser: ${status.state}; owned pages: ${status.pageCount}`
          : "Browser control is unavailable.",
        status?.state === "failed" ? "error" : "info",
      );
    },
  });

  return {
    start(
      next: BrowserControl,
      runtime: {
        readonly ui?: {
          setStatus(key: string, value: string | undefined): void;
        };
        readonly credentials?: CredentialVault;
        readonly credentialScope?: string;
      } = {},
    ) {
      browser = next;
      statusUi = runtime.ui;
      credentials = runtime.credentials;
      credentialScope = runtime.credentialScope;
      statusUi?.setStatus("platform:browser", "Browser idle (0)");
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...toolNames])]);
    },
    async stop() {
      const current = browser;
      browser = undefined;
      statusUi?.setStatus("platform:browser", undefined);
      statusUi = undefined;
      credentials = undefined;
      credentialScope = undefined;
      const removed = new Set(toolNames);
      pi.setActiveTools(
        pi.getActiveTools().filter((name) => !removed.has(name)),
      );
      await current?.close();
    },
  };
}
