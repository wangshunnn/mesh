/**
 * Format a session's last activity using the compact DSH sidebar buckets.
 *
 * `now` is injectable so callers can render or test a stable snapshot.
 */
export function formatSessionTime(value: string, now: number = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间未知";

  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  const elapsed = Math.max(0, now - timestamp);

  if (elapsed < minute) return "刚刚";
  if (elapsed < hour) return `${String(Math.floor(elapsed / minute))}分钟`;
  if (elapsed < day) return `${String(Math.floor(elapsed / hour))}小时`;
  if (elapsed < 30 * day) return `${String(Math.floor(elapsed / day))}天`;
  if (elapsed < 365 * day) return `${String(Math.floor(elapsed / (30 * day)))}个月`;
  return `${String(Math.floor(elapsed / (365 * day)))}年`;
}
