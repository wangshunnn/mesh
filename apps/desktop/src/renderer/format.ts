export { formatSessionTime } from "../shared/session-time.js";
export { formatMessageTime } from "../shared/message-time.js";

export function displaySessionTitle(session: { readonly title: string; readonly messageCount: number }): string {
  return session.messageCount === 0 && session.title === "New Session" ? "新会话" : session.title;
}
