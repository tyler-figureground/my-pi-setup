import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  canOwnPlatformDaemons,
  createPlatformExtension,
} from "./src/composition.ts";
import { decodePlatformFlags, defaultPlatformFlags } from "./src/flags.ts";

export {
  canOwnPlatformDaemons,
  createPlatformExtension,
  decodePlatformFlags,
  defaultPlatformFlags,
};
export type { PlatformExtensionOptions } from "./src/composition.ts";
export type { PlatformFlags } from "./src/flags.ts";

export default function platform(pi: ExtensionAPI) {
  createPlatformExtension()(pi);
}
