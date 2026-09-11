/**
 * Pi extension entry for the capability platform. Pi loads the default
 * export; the named re-exports let tests build the platform with overrides
 * (`createPlatformExtension(options)`) and inspect flag metadata.
 *
 * All startup, Execution Role gating, and capability wiring lives in
 * `src/composition.ts`. With every flag off (the default) the platform
 * registers no tools or commands.
 *
 * See: docs/adr/0001-platform-composition-root.md,
 * docs/architecture/platform-foundation.md
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  canOwnPlatformDaemons,
  createPlatformExtension,
} from "./src/composition.ts";
import {
  availablePlatformFlags,
  decodePlatformFlags,
  defaultPlatformFlags,
} from "./src/flags.ts";

export {
  availablePlatformFlags,
  canOwnPlatformDaemons,
  createPlatformExtension,
  decodePlatformFlags,
  defaultPlatformFlags,
};
export type { PlatformExtensionOptions } from "./src/composition.ts";
export type { PlatformPlanConfiguration } from "./src/config.ts";
export type { PlatformGoalConfiguration } from "./src/goals/config.ts";
export type { PlatformArtifactConfiguration } from "./src/artifacts/config.ts";
export type { PlatformFlags } from "./src/flags.ts";

export default function platform(pi: ExtensionAPI) {
  createPlatformExtension()(pi);
}
