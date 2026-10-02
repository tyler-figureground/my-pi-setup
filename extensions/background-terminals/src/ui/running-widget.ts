import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

/** Single-row status above the editor. */
export function createRunningWidget(
  running: number,
  theme: Pick<Theme, "fg">,
): Component {
  const line =
    theme.fg("warning", "■ ") +
    theme.fg(
      "text",
      `${running} background terminal${running === 1 ? "" : "s"} running`,
    ) +
    theme.fg("dim", " • ") +
    theme.fg("accent", "/ps") +
    theme.fg("dim", " to view");
  return {
    render: (width) => [truncateToWidth(line, width)],
    invalidate: () => {},
  };
}
