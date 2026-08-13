import type { DesktopApi } from "../shared/api.js";

declare global {
  interface Window {
    readonly mesh: DesktopApi;
  }
}

export {};
