import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTerminalWidget } from "./src/ui/widget.ts";

test("running-terminal widget fits narrow terminals and rerenders after resize", () => {
  const widget = createTerminalWidget(12, { fg: (_color, text) => text });
  for (const width of [80, 12, 1, 0, 40, 120]) {
    const lines = widget.render(width);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0]!) <= width);
  }
  assert.match(widget.render(120)[0]!, /12 background terminals running/);
  widget.invalidate();
});
