// Browser-only runtime replacements for native OS APIs that remain imported
// by shared components. Native-only features are hidden in the web shell;
// these no-ops keep shared boot and notification code browser-safe.

export function isTauri(): boolean {
  return false;
}

export async function invoke<T>(): Promise<T> {
  throw new Error("native operation is unavailable in EcomBrain Teams");
}

export async function listen(): Promise<() => void> {
  return () => undefined;
}

export class Channel<T = unknown> {
  onmessage?: (value: T) => void;
}

const browserWindow = {
  show: async () => undefined,
  startDragging: async () => undefined,
  setBadgeCount: async () => undefined,
  setBadgeLabel: async () => undefined,
  requestUserAttention: async () => undefined,
  isFullscreen: async () => false,
  onResized: listen,
  listen,
};

export function getCurrentWindow() {
  return browserWindow;
}

export function getCurrentWebview() {
  return { setZoom: async () => undefined };
}

export const UserAttentionType = {
  Critical: 1,
  Informational: 2,
} as const;

export async function openUrl(url: string): Promise<void> {
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function revealItemInDir(): Promise<void> {
  throw new Error("filesystem reveal is unavailable in EcomBrain Teams");
}

export async function relaunch(): Promise<void> {
  window.location.reload();
}

export async function check(): Promise<null> {
  return null;
}

export async function getVersion(): Promise<string> {
  return "web";
}

export async function homeDir(): Promise<string> {
  return "";
}

export async function isPermissionGranted(): Promise<boolean> {
  return Notification.permission === "granted";
}

export async function requestPermission(): Promise<NotificationPermission> {
  return Notification.requestPermission();
}

export async function onAction(): Promise<{ unregister: () => Promise<void> }> {
  return { unregister: async () => undefined };
}
