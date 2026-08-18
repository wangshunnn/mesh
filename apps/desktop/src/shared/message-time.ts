const messageDateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatMessageTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return "时间未知";
  return messageDateTimeFormatter.format(timestamp);
}
