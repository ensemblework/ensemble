"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery } from "@tanstack/react-query";
import { Keyboard, LayoutTemplate, LogOut, Moon, Plug, Settings, Sparkles, Sun, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AppearanceSettings } from "@ensemble/shared-types";
import { api } from "@/lib/api";
import { personInitials } from "@/lib/initials";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, publishAppearance, usePersistentState } from "@/lib/prefs";
import { SHELL_USER_KEY, clearBrowserTabSession } from "@/lib/tab-session";
import { Popover } from "../ui";

type RememberedUser = { name: string; email: string; via: string };

/** The last shell user for this tab, so the initials paint before the shell request returns. */
function readRememberedUser(): RememberedUser | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SHELL_USER_KEY) ?? "null") as RememberedUser | null;
    return parsed && typeof parsed.email === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function Row({ icon: Icon, children, onSelect, hint, danger }: { icon: typeof Settings; children: React.ReactNode; onSelect: () => void; hint?: string; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={`row-tile flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] ${danger ? "text-danger" : "text-ink"}`}
    >
      <Icon size={14} className={danger ? "" : "text-muted"} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className="text-[11px] text-faint">{hint}</span> : null}
    </button>
  );
}

/** Initials in the top right. A menu, not a link: settings, shortcuts, theme, and sign out. */
export function AccountMenu() {
  const router = useRouter();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const [appearance] = usePersistentState<AppearanceSettings>(APPEARANCE_KEY, DEFAULT_APPEARANCE);
  const dark = appearance.theme !== "light";
  const [remembered, setRemembered] = useState<RememberedUser | null>(null);
  useEffect(() => {
    const me = shell.data;
    if (!me?.user) {
      setRemembered(readRememberedUser());
      return;
    }
    const next = { name: me.user.name, email: me.user.email, via: me.via };
    try {
      sessionStorage.setItem(SHELL_USER_KEY, JSON.stringify(next));
    } catch {
      // private mode
    }
    setRemembered(next);
  }, [shell.data]);
  const user = shell.data?.user ?? remembered ?? undefined;
  const via = shell.data?.via ?? remembered?.via;
  const local = via === "bypass" || via === "desktop";
  const name = user?.name?.trim() || (local ? "Local account" : "");
  const initials = personInitials(user?.name, user?.email);
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      clearBrowserTabSession();
      window.location.href = "/login";
    },
  });
  const go = (close: () => void, href: string) => {
    close();
    router.push(href);
  };
  return (
    <Popover
      align="right"
      width={260}
      trigger={(open, toggle) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={name ? `Account menu for ${name}` : "Account menu"}
          title={user?.email ?? "Account"}
          className="account-avatar"
          data-account-avatar
        >
          {initials || <UserRound size={14} aria-hidden />}
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label="Account" className="p-1">
          <div className="flex items-center gap-2.5 px-2 pb-2 pt-1.5">
            <span className="account-avatar account-avatar-lg" aria-hidden>
              {initials || <UserRound size={16} />}
            </span>
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-semibold">{name || "Your account"}</div>
              <div className="truncate text-[12px] text-muted">{local ? "No-login mode" : user?.email ?? ""}</div>
            </div>
          </div>
          <div className="my-1 h-px bg-line" />
          <Row icon={UserRound} onSelect={() => go(close, "/settings?tab=account")}>Account settings</Row>
          <Row icon={Sparkles} onSelect={() => go(close, "/settings?tab=assistant")}>Assistant and models</Row>
          <Row icon={Plug} onSelect={() => go(close, "/settings?tab=connections")}>Connected apps</Row>
          <Row icon={Keyboard} onSelect={() => go(close, "/settings?tab=shortcuts")} hint="?">Keyboard shortcuts</Row>
          {shell.data?.devTools ? <Row icon={LayoutTemplate} onSelect={() => go(close, "/marketplace")}>Templates</Row> : null}
          <Row
            icon={dark ? Sun : Moon}
            onSelect={() => {
              publishAppearance({ ...appearance, theme: dark ? "light" : "dark" });
              close();
            }}
          >
            {dark ? "Light theme" : "Dark theme"}
          </Row>
          <div className="my-1 h-px bg-line" />
          {local ? (
            <Row icon={UserRound} onSelect={() => go(close, "/signup")}>Create an account</Row>
          ) : (
            <Row icon={LogOut} danger onSelect={() => logout.mutate()}>
              {logout.isPending ? "Signing out…" : "Sign out"}
            </Row>
          )}
        </div>
      )}
    </Popover>
  );
}
