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
export type { PlatformFlags } from "./src/flags.ts";

export default function platform(pi: ExtensionAPI) {
  createPlatformExtension()(pi);
}
