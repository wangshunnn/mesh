export function formatSessionTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间未知";
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${String(Math.floor(elapsed / 60_000))} 分钟前`;
  if (elapsed < 86_400_000) return `${String(Math.floor(elapsed / 3_600_000))} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(timestamp);
}

export function displaySessionTitle(session: { readonly title: string; readonly messageCount: number }): string {
  return session.messageCount === 0 ? "新会话" : session.title;
}
