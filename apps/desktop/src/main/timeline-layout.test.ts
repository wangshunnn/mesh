import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActivityTimelineScale,
  packTimelineLabelCenters,
} from "../shared/timeline-layout.js";

const options = Object.freeze({ width: 500, labelWidth: 34, gap: 8, padding: 12 });

test("crowded Room labels remain ordered, separated, and inside the plot", () => {
  const packed = packTimelineLabelCenters([100, 102, 105, 420], options);

  assert.equal(packed.length, 4);
  assert.equal((packed[1] ?? 0) - (packed[0] ?? 0) >= 42, true);
  assert.equal((packed[2] ?? 0) - (packed[1] ?? 0) >= 42, true);
  assert.equal((packed[3] ?? 0) - (packed[2] ?? 0) >= 42, true);
  assert.equal((packed[0] ?? 0) >= 29, true);
  assert.equal((packed[3] ?? 500) <= 471, true);
});

test("labels near the right edge pack backwards without overlap", () => {
  const packed = packTimelineLabelCenters([450, 470, 490], options);

  assert.deepEqual(packed, [387, 429, 471]);
});

test("a dense 22-message Room rail stays on one collision-free shelf", () => {
  const labelWidth = 46;
  const gap = 8;
  const padding = 18;
  const width = 22 * (labelWidth + gap) + padding * 2;
  const packed = packTimelineLabelCenters(
    Array.from({ length: 22 }, (_value, index) => 300 + index * 3),
    { width, labelWidth, gap, padding },
  );

  assert.equal(packed.length, 22);
  for (let index = 1; index < packed.length; index += 1) {
    assert.equal((packed[index] ?? 0) - (packed[index - 1] ?? 0) >= labelWidth + gap, true);
  }
  assert.equal((packed[0] ?? 0) >= padding + labelWidth / 2, true);
  assert.equal((packed.at(-1) ?? width) <= width - padding - labelWidth / 2, true);
});

test("an empty Room rail has no label positions", () => {
  assert.deepEqual(packTimelineLabelCenters([], options), []);
});

test("long globally idle gaps are capped without erasing short idle time", () => {
  const scale = buildActivityTimelineScale(
    [0, 1_000, 3_000, 3_600_000, 3_601_000],
    [
      { startedAt: 0, endedAt: 1_000 },
      { startedAt: 3_600_000, endedAt: 3_601_000 },
    ],
  );
  const firstTurnWidth = scale.position(1_000) - scale.position(0);
  const shortIdleWidth = scale.position(3_000) - scale.position(1_000);
  const longIdleWidth = scale.position(3_600_000) - scale.position(3_000);

  assert.equal(Math.abs(shortIdleWidth / firstTurnWidth - 2) < 1e-10, true);
  assert.equal(Math.abs(longIdleWidth / firstTurnWidth - 5) < 1e-10, true);
});

test("Agent turn widths preserve real elapsed-time ratios", () => {
  const scale = buildActivityTimelineScale(
    [0, 6_240, 37_500],
    [
      { startedAt: 0, endedAt: 6_240 },
      { startedAt: 0, endedAt: 37_500 },
    ],
  );
  const openCodeWidth = scale.position(6_240) - scale.position(0);
  const codexWidth = scale.position(37_500) - scale.position(0);

  assert.equal(Math.abs(codexWidth / openCodeWidth - 37_500 / 6_240) < 1e-10, true);
  assert.equal(codexWidth > openCodeWidth, true);
});

test("overlapping Agent turns share one wall-clock span", () => {
  const scale = buildActivityTimelineScale(
    [0, 5_000, 10_000, 15_000],
    [
      { startedAt: 0, endedAt: 10_000 },
      { startedAt: 5_000, endedAt: 15_000 },
    ],
  );

  assert.equal(
    Math.abs(
      (scale.position(10_000) - scale.position(0)) -
      (scale.position(15_000) - scale.position(5_000)),
    ) < 1e-10,
    true,
  );
});

test("activity spacing keeps Room labels directly above their anchors", () => {
  const scale = buildActivityTimelineScale([10, 20, 30, 40]);
  const pitch = 54;
  const width = (scale.anchors.length + 1) * pitch;
  const desired = scale.anchors.map((timestamp) => scale.position(timestamp) * width);
  const packed = packTimelineLabelCenters(desired, {
    width,
    labelWidth: 46,
    gap: 8,
    padding: 18,
  });

  assert.deepEqual(packed, desired);
});
