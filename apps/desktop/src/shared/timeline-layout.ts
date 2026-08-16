export interface TimelineLabelPackingOptions {
  readonly width: number;
  readonly labelWidth: number;
  readonly gap: number;
  readonly padding: number;
}

export interface ActivityTimelineScale {
  readonly anchors: readonly number[];
  readonly position: (timestamp: number) => number;
}

export interface TimelineActiveInterval {
  readonly startedAt: number;
  readonly endedAt: number;
}

const maximumIdleGapMs = 5_000;

interface TimelineSegment {
  readonly startedAt: number;
  readonly endedAt: number;
  readonly mappedStart: number;
  readonly mappedDuration: number;
}

/**
 * Builds an idle-compressed wall-clock scale. Time covered by at least one
 * Agent turn retains its real duration, including quiet time inside the turn.
 * Only gaps where no Agent is running are capped, so old Room inactivity cannot
 * dominate the chart while concurrent turns remain directly comparable.
 */
export function buildActivityTimelineScale(
  timestamps: readonly number[],
  activeIntervals: readonly TimelineActiveInterval[] = [],
): ActivityTimelineScale {
  const intervals = mergeActiveIntervals(activeIntervals);
  const anchors = Object.freeze(
    [
      ...new Set([
        ...timestamps.filter(Number.isFinite),
        ...intervals.flatMap((interval) => [interval.startedAt, interval.endedAt]),
      ]),
    ].sort((left, right) => left - right),
  );
  const segments: TimelineSegment[] = [];
  let mappedEnd = 0;
  let intervalIndex = 0;
  for (let index = 1; index < anchors.length; index += 1) {
    const startedAt = anchors[index - 1] ?? 0;
    const endedAt = anchors[index] ?? startedAt;
    while ((intervals[intervalIndex]?.endedAt ?? Number.POSITIVE_INFINITY) <= startedAt) {
      intervalIndex += 1;
    }
    const interval = intervals[intervalIndex];
    const agentIsRunning = interval !== undefined &&
      interval.startedAt <= startedAt && interval.endedAt >= endedAt;
    const duration = endedAt - startedAt;
    const mappedDuration = agentIsRunning ? duration : Math.min(duration, maximumIdleGapMs);
    segments.push({ startedAt, endedAt, mappedStart: mappedEnd, mappedDuration });
    mappedEnd += mappedDuration;
  }
  const averageSegment = mappedEnd / Math.max(1, segments.length);
  const padding = Math.max(1, Math.min(maximumIdleGapMs, averageSegment));
  const extent = mappedEnd + padding * 2;
  const position = (timestamp: number): number => {
    if (anchors.length === 0) return .5;
    if (anchors.length === 1) return .5;
    const first = anchors[0] ?? timestamp;
    const last = anchors.at(-1) ?? timestamp;
    if (timestamp <= first) return padding / extent;
    if (timestamp >= last) return (padding + mappedEnd) / extent;

    let low = 0;
    let high = anchors.length - 1;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if ((anchors[middle] ?? timestamp) <= timestamp) low = middle;
      else high = middle;
    }
    const segment = segments[low];
    if (segment === undefined) return .5;
    const duration = segment.endedAt - segment.startedAt;
    const fraction = duration === 0 ? 0 : (timestamp - segment.startedAt) / duration;
    return (padding + segment.mappedStart + segment.mappedDuration * fraction) / extent;
  };
  return Object.freeze({ anchors, position });
}

function mergeActiveIntervals(
  activeIntervals: readonly TimelineActiveInterval[],
): readonly TimelineActiveInterval[] {
  const sorted = activeIntervals
    .filter((interval) =>
      Number.isFinite(interval.startedAt) &&
      Number.isFinite(interval.endedAt) &&
      interval.endedAt > interval.startedAt,
    )
    .map((interval) => ({ startedAt: interval.startedAt, endedAt: interval.endedAt }))
    .sort((left, right) => left.startedAt - right.startedAt || left.endedAt - right.endedAt);
  const merged: TimelineActiveInterval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || interval.startedAt > previous.endedAt) {
      merged.push(interval);
    } else {
      merged[merged.length - 1] = {
        startedAt: previous.startedAt,
        endedAt: Math.max(previous.endedAt, interval.endedAt),
      };
    }
  }
  return Object.freeze(merged);
}

/**
 * Packs chronologically ordered labels onto one horizontal shelf.
 *
 * The caller keeps the original timestamp anchors separately. Labels may move
 * along the x-axis, but they never reorder, overlap, or escape the plot bounds
 * when the supplied width can contain them.
 */
export function packTimelineLabelCenters(
  desiredCenters: readonly number[],
  options: TimelineLabelPackingOptions,
): readonly number[] {
  if (desiredCenters.length === 0) return Object.freeze([]);

  const width = Math.max(1, options.width);
  const labelWidth = Math.max(1, options.labelWidth);
  const half = labelWidth / 2;
  const minimum = Math.min(width / 2, Math.max(0, options.padding) + half);
  const maximum = Math.max(minimum, width - Math.max(0, options.padding) - half);
  const pitch = labelWidth + Math.max(0, options.gap);
  const required = pitch * (desiredCenters.length - 1);

  // The chart chooses a density-aware minimum width, so this is normally true.
  // Keeping an evenly distributed fallback makes the helper safe for transient
  // resize frames where the DOM has not caught up with the target width yet.
  if (required > maximum - minimum) {
    if (desiredCenters.length === 1) {
      return Object.freeze([(minimum + maximum) / 2]);
    }
    const availablePitch = (maximum - minimum) / (desiredCenters.length - 1);
    return Object.freeze(desiredCenters.map((_center, index) => minimum + availablePitch * index));
  }

  const packed: number[] = [];
  for (const desired of desiredCenters) {
    const previous = packed.at(-1);
    packed.push(Math.max(minimum, Math.min(maximum, desired), previous === undefined ? minimum : previous + pitch));
  }

  if ((packed.at(-1) ?? maximum) > maximum) {
    packed[packed.length - 1] = maximum;
    for (let index = packed.length - 2; index >= 0; index -= 1) {
      packed[index] = Math.min(packed[index] ?? minimum, (packed[index + 1] ?? maximum) - pitch);
    }
  }

  return Object.freeze(packed);
}
