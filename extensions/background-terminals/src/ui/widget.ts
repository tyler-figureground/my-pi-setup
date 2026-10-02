import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export function createTerminalWidget(
  running: number,
  theme: Pick<Theme, "fg">,
) {
  return {
    render(width: number) {
      const line =
        theme.fg("warning", "■ ") +
        theme.fg(
          "text",
          `${running} background terminal${running === 1 ? "" : "s"} running`,
        ) +
        theme.fg("dim", " • ") +
        theme.fg("accent", "/ps") +
        theme.fg("dim", " to view");
      // Recompute for every width and theme; a widget overflow crashes Pi.
      return [truncateToWidth(line, Math.max(0, width), "")];
    },
    invalidate() {},
  };
}
