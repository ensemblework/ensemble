export type NotificationState = NotificationPermission | "unsupported";

export function readNotificationState(): NotificationState {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** What Settings › Notifications says about this browser's permission, and how to change it. */
export function notificationNote(state: NotificationState): string {
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
  const state = readNotificationState();
  if (state !== "default") return state;
  try {
    return await Notification.requestPermission();
  } catch {
    return readNotificationState();
  }
}
