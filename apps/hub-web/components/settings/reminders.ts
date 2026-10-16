import { desktopShell } from "@/lib/desktop-param";

let nativeState: NotificationState = "default";

export type NotificationState = NotificationPermission | "unsupported";

export function readNotificationState(): NotificationState {
  return desktopShell() ? nativeState : typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** What Settings › Notifications says about this browser's permission, and how to change it. */
export function notificationNote(state: NotificationState): string {
  if (desktopShell()) {
    if (state === "unsupported") return "This app cannot show native notifications. Update Ensemble; reminders still appear in the bell.";
    if (state === "granted") return "Allowed for the Ensemble app. Your system's notification settings apply.";
    if (state === "denied") return "Notifications are blocked for Ensemble. Allow them in your system's notification settings, then check again.";
    return "Your system asks for permission when you switch this on.";
  }
  switch (state) {
    case "granted":
      return "Allowed in this browser.";
    case "default":
      return "Your browser asks for permission when you switch this on.";
    case "denied":
      return "Your browser is blocking notifications from Ensemble, so reminders can't pop up here. To allow them, click the icon at the left of the address bar, set Notifications to Allow, then reload this page.";
    case "unsupported":
      return "This browser can't show notifications. Reminders still appear in the bell.";
  }
}

/**
 * Switching desktop reminders on asks the browser first. Resolves to the permission after
 * asking; the setting should only turn on when it is "granted".
 */
export async function askNotificationPermission(): Promise<NotificationState> {
  const state = await refreshNotificationPermission();
  if (state !== "default") return state;
  if (desktopShell()) {
    try { nativeState = await (await import("@tauri-apps/plugin-notification")).requestPermission(); } catch { nativeState = "denied"; }
    return nativeState;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return readNotificationState();
  }
}

export async function refreshNotificationPermission(): Promise<NotificationState> {
  if (!desktopShell()) return readNotificationState();
  try { nativeState = await (await import("@tauri-apps/plugin-notification")).isPermissionGranted() ? "granted" : "default"; }
  catch { nativeState = "unsupported"; }
  return nativeState;
}

export async function showNotification(title: string, body: string, options: NotificationOptions = {}): Promise<boolean> {
  if (await refreshNotificationPermission() !== "granted") return false;
  if (desktopShell()) {
    try { (await import("@tauri-apps/plugin-notification")).sendNotification({ title, body }); return true; } catch { return false; }
  }
  const notification = new Notification(title, { body, ...options });
  return Boolean(notification);
}
