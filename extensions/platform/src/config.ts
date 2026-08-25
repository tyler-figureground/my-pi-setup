import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  decodePlatformFlags,
  defaultPlatformFlags,
  type PlatformDiagnostic,
  type PlatformFlags,
} from "./flags.ts";

export interface PlatformConfigLocation {
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly agentDir?: string;
}

export function loadPlatformFlags(location: PlatformConfigLocation): {
  readonly flags: PlatformFlags;
  readonly diagnostics: PlatformDiagnostic[];
} {
  const sources = [join(location.agentDir ?? getAgentDir(), "platform.json")];
  if (location.projectTrusted) {
    sources.push(join(location.cwd, CONFIG_DIR_NAME, "platform.json"));
  }
  const diagnostics: PlatformDiagnostic[] = [];
  for (const source of sources) {
    if (!existsSync(source)) continue;
    try {
      const decoded = decodePlatformFlags(
        JSON.parse(readFileSync(source, "utf8")) as unknown,
      );
      diagnostics.push(
        ...decoded.diagnostics.map((diagnostic) => ({
          path: `${source}:${diagnostic.path}`,
          message: diagnostic.message,
        })),
      );
    } catch (error) {
      diagnostics.push({
        path: source,
        message: `Could not parse platform config: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return { flags: defaultPlatformFlags, diagnostics };
}
