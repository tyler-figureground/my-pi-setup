import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPlatformExtension } from "../src/composition.ts";
import { defaultPlatformFlags } from "../src/flags.ts";

export default function phase7MissingMessaging(pi: ExtensionAPI) {
  createPlatformExtension({
    flags: {
      ...defaultPlatformFlags,
      monitors: true,
      messaging: false,
    },
  })(pi);
}
