import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createRunningWidget } from "./src/ui/running-widget.ts";

const theme = {
  fg: (_color: string, text: string) => `\u001b[33m${text}\u001b[39m`,
};

for (const count of [1, 2, 8]) {
  test(`running widget fits every width and resize with ${count} terminals`, () => {
    const widget = createRunningWidget(count, theme);
    const full = widget.render(120);
    assert.equal(full.length, 1);
    assert.equal(visibleWidth(full[0]!), count === 1 ? 45 : 46);
    // Reuse the same component: resizing does not change the running count.
    for (const width of [
      29,
      ...Array.from({ length: 81 }, (_, i) => i),
      120,
      29,
    ]) {
      const lines = widget.render(width);
      assert.equal(lines.length, 1);
      assert.ok(
        visibleWidth(lines[0]!) <= width,
        `overflow at width ${width}: ${visibleWidth(lines[0]!)}`,
      );
    }
    widget.invalidate();
    assert.deepEqual(widget.render(120), full);
  });
}
