"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { VerificationBanner } from "@/components/verification-banner";
import { Suspense, useEffect, useRef, useState } from "react";
import { AssistantDock } from "@/components/assistant/assistant-dock";
import { EnsembleHotkey } from "@/components/ensemble/hotkey";
import { LiveProvider } from "@/components/live";
import { PresenceHost } from "@/components/sharing/presence-host";
import { FollowHost } from "@/components/sharing/people";
import { CommandPalette, ShortcutSheet } from "@/components/shell/command-palette";
import { QuickCapture } from "@/components/shell/quick-capture";
import { ShortcutsHost } from "@/components/shell/shortcuts-host";
import { Notifier } from "@/components/shell/notifier";
import { PeekProvider, usePeek, useResizablePeek } from "@/components/shell/peek";
import { toggleSidebarRail } from "@/lib/sidebar-rail";
import { SeasonBanner } from "@/components/shell/season-banner";
import { Sidebar } from "@/components/shell/sidebar";
import { TopBar } from "@/components/shell/topbar";
import { FeatureGate } from "@/components/features/gate";
import { FeatureTour } from "@/components/features/tour";
import { CelebrateHost } from "@/components/motion/celebrate";
import { PageProgress } from "@/components/motion/page-progress";
import { Splash } from "@/components/motion/skeletons";
import { Skeleton, cx } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { clearBrowserTabSession } from "@/lib/tab-session";
import { switchSpace } from "@/lib/spaces";
import { ShellLabelsProvider } from "@/lib/shell-labels";
import { peekPanel, warmPeek } from "@/lib/warm";

function Frame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  const [Peek, setPeek] = useState<typeof peekPanel>(() => peekPanel);
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [capture, setCapture] = useState(false);
  const { peekId, kind, fullscreen } = usePeek();
  const area = useRef<HTMLDivElement>(null);
  const { width, dragging, onPointerDown, onKeyDown, reset, min, max } = useResizablePeek(area);
  const peeking = Boolean(peekId);

  useEffect(() => {
    setDrawer(false);
  }, [pathname]);

  useEffect(() => {
    if (!peekId || Peek) return;
    let live = true;
    void warmPeek().then(() => {
      if (live && peekPanel) setPeek(() => peekPanel);
    });
    return () => {
      live = false;
    };
  }, [peekId, Peek]);

  useEffect(() => {
    const openPalette = () => setPalette(true);
    const openCapture = () => setCapture(true);
    const openHelp = () => setShortcuts(true);
    window.addEventListener("ensemble:palette", openPalette);
    window.addEventListener("ensemble:capture", openCapture);
    window.addEventListener("ensemble:help", openHelp);
    return () => {
      window.removeEventListener("ensemble:palette", openPalette);
      window.removeEventListener("ensemble:capture", openCapture);
      window.removeEventListener("ensemble:help", openHelp);
    };
  }, []);

  // Signup and a new space are full-screen: no sidebar, top bar, or assistant.
  if (pathname === "/start" || pathname === "/spaces/new") {
    return (
      <div className="h-screen overflow-y-auto bg-bg" data-focused-frame>
        <PageProgress />
        <FeatureGate>{children}</FeatureGate>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      <PageProgress />
      <div className="h-full shrink-0 max-md:hidden">
        <Sidebar />
      </div>
      {drawer ? (
        <div className="md:hidden">
          <button type="button" className="fixed inset-0 z-30 bg-black/45" aria-label="Close menu" onClick={() => setDrawer(false)} />
          <div className="fixed inset-y-0 left-0 z-40 shadow-pop">
            <Sidebar />
          </div>
        </div>
      ) : null}
      <div ref={area} className="relative flex min-w-0 flex-1">
        <div className={cx("relative flex min-w-0 flex-1 flex-col", peeking && fullscreen && "hidden")}>
          <TopBar
            onToggleSidebar={() => {
              if (window.matchMedia("(max-width: 767px)").matches) setDrawer((open) => !open);
              else toggleSidebarRail();
            }}
          />
          <SeasonBanner />
          <VerificationBanner />
          <main className="relative min-h-0 flex-1 overflow-y-auto">
            <FeatureGate>{children}</FeatureGate>
          </main>
          <AssistantDock />
        </div>
        {peeking ? (
          <div
            className={cx("task-peek absolute inset-y-0 right-0 z-30 flex border-l border-line bg-bg shadow-pop max-md:!w-full", fullscreen && "is-full")}
          >
            {fullscreen ? null : (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Page width"
                aria-valuemin={min}
                aria-valuemax={max}
                aria-valuenow={width}
                data-page-width={width}
                tabIndex={0}
                title="Drag to resize. Arrow keys nudge. Double-click resets."
                onPointerDown={onPointerDown}
                onKeyDown={onKeyDown}
                onDoubleClick={reset}
                className="page-resize group relative z-40 w-2.5 shrink-0 cursor-col-resize touch-none"
              >
                <div
                  data-resize-line=""
                  className={cx(
                    "pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2",
                    dragging ? "bg-accent" : "bg-transparent group-hover:bg-line-strong group-focus-visible:bg-accent/80",
                  )}
                />
              </div>
            )}
            <div className="min-w-0 flex-1">
              {Peek ? (
                <Peek id={peekId!} kind={kind} />
              ) : (
                <div className="p-4">
                  <Skeleton className="h-8 w-48" />
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
      <EnsembleHotkey />
      <ShortcutsHost
        onPalette={() => setPalette((value) => !value)}
        onHelp={() => setShortcuts((value) => !value)}
        onCapture={() => setCapture(true)}
        onAsk={() => window.dispatchEvent(new CustomEvent("ensemble:ask"))}
      />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <ShortcutSheet open={shortcuts} onClose={() => setShortcuts(false)} />
      <QuickCapture open={capture} onClose={() => setCapture(false)} />
      <FeatureTour />
    </div>
  );
}

/** The owner's own surfaces: never shown in a space someone shared with you. */
const OWNER_ONLY_PAGES = ["/today", "/metrics", "/connect", "/marketplace", "/trash", "/start", "/welcome"];

/** Renders immediately. A 401 on the shell query sends the browser to /login. */
function AuthGate({ children }: { children: React.ReactNode }) {
  const client = useQueryClient();
  const shell = useQuery({
    queryKey: ["shell"],
    queryFn: api.shell,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (!shell.data) return;
    // The shell's user has no profile: keep the one /api/auth/me already loaded.
    const known = client.getQueryData<{ user?: { profile?: unknown } }>(["me"]);
    client.setQueryData(["me"], {
      user: { ...shell.data.user, ...(known?.user?.profile ? { profile: known.user.profile } : {}) },
      via: shell.data.via,
      modules: shell.data.modules,
      verificationRequired: shell.data.verificationRequired,
    });
  }, [client, shell.data]);
  const pathname = usePathname();
  const unauthorized = shell.error instanceof ApiError && shell.error.status === 401;
  useEffect(() => {
    if (unauthorized) {
      clearBrowserTabSession();
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    }
  }, [unauthorized]);
  // A link that names a space (a notification from a shared space): open that space first.
  const spaceId = shell.data?.space?.id;
  useEffect(() => {
    if (!spaceId) return;
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get("openSpace");
    if (!wanted) return;
    params.delete("openSpace");
    if (wanted === spaceId) {
      window.history.replaceState(null, "", `${pathname}${params.toString() ? `?${params.toString()}` : ""}`);
      return;
    }
    const rest = params.toString();
    void switchSpace(wanted, `${pathname}${rest ? `?${rest}` : ""}`).catch(() => undefined);
  }, [spaceId, pathname]);
  // In a space shared with you, the owner's private pages are not there: the board is home.
  const guest = Boolean(shell.data?.space?.shared);
  useEffect(() => {
    if (guest && OWNER_ONLY_PAGES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
      window.location.replace("/board");
    }
  }, [guest, pathname]);
  useEffect(() => {
    if (shell.data && shell.data.onboardingComplete === false && pathname !== "/start") {
      window.location.href = "/start";
    }
  }, [shell.data, pathname]);
  if (unauthorized) return null;
  const offline = shell.isError || shell.failureCount > 0;
  return (
    <>
      <Splash active={shell.isLoading && !shell.data && !offline} />
      {offline ? (
        <div className="fixed left-1/2 top-3 z-[80] -translate-x-1/2 rounded-full border border-line bg-panel px-3 py-1.5 text-[13px] text-ink shadow-pop" data-motion-slot="net.connection" data-state="reconnecting">
          Reconnecting to Ensemble…
        </div>
      ) : null}
      <ShellLabelsProvider labels={shell.data?.labels}>{children}</ShellLabelsProvider>
      {shell.data ? <CelebrateHost /> : null}
    </>
  );
}

export default function HubLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={null}>
      <AuthGate>
        <LiveProvider>
          <Notifier />
          <PresenceHost />
          <FollowHost />
          <PeekProvider>
            <Frame>{children}</Frame>
          </PeekProvider>
        </LiveProvider>
      </AuthGate>
    </Suspense>
  );
}
