import assert from "node:assert/strict";
import test from "node:test";

import { formatSessionTime } from "../shared/session-time.js";

const day = 86_400_000;
const now = Date.UTC(2026, 7, 18, 12);

test("session time uses the compact DSH relative-time buckets", () => {
  assert.equal(formatSessionTime(new Date(now).toISOString(), now), "刚刚");
  assert.equal(formatSessionTime(new Date(now - 5 * 60_000).toISOString(), now), "5分钟");
  assert.equal(formatSessionTime(new Date(now - 22 * 3_600_000).toISOString(), now), "22小时");
  assert.equal(formatSessionTime(new Date(now - 4 * day).toISOString(), now), "4天");
  assert.equal(formatSessionTime(new Date(now - 60 * day).toISOString(), now), "2个月");
  assert.equal(formatSessionTime(new Date(now - 400 * day).toISOString(), now), "1年");
});

test("session time clamps future activity and preserves the invalid fallback", () => {
  assert.equal(formatSessionTime(new Date(now + day).toISOString(), now), "刚刚");
  assert.equal(formatSessionTime("not-a-date", now), "时间未知");
});
