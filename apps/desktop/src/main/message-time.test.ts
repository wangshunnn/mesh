import assert from "node:assert/strict";
import test from "node:test";

import { formatMessageTime } from "../shared/message-time.js";

test("message time includes the local date in the DSH format", () => {
  const timestamp = new Date(2026, 7, 14, 10, 57).getTime();

  assert.equal(formatMessageTime(timestamp), "8月14日 10:57");
});

test("message time preserves the invalid fallback", () => {
  assert.equal(formatMessageTime(Number.NaN), "时间未知");
});
