import { BadPathError, normalizePath } from "@ensemble/shared-types/modules";
import { NextResponse, type NextRequest } from "next/server";
import { isAnonymousAsset } from "@/lib/anonymous-asset";
import { isAppRoute } from "@/lib/app-routes";
import { resolveHubApi } from "./lib/hub-origin";
import { sessionCookieDelete } from "./lib/session-cookie";

const PUBLIC = new Set(["/login", "/signup"]);
const API = resolveHubApi({
  NEXT_PUBLIC_HUB_API: process.env.NEXT_PUBLIC_HUB_API,
  NODE_ENV: process.env.NODE_ENV,
});

/** Document loads only. RSC payloads and prefetches must not wait on auth. */
function wantsHtml(request: NextRequest): boolean {
  if (request.headers.get("rsc") === "1") return false;
  if (request.headers.get("next-router-prefetch") === "1") return false;
  if (request.headers.get("purpose") === "prefetch") return false;
  return (request.headers.get("accept") ?? "").includes("text/html");
}

function unavailable(request: NextRequest, commitUrl: boolean) {
  const url = request.nextUrl.clone();
  url.pathname = "/unavailable";
  url.search = "";
  // A document load keeps the 404 on the requested path. A client navigation
  // follows a redirect so the address bar lands on the in-shell 404 page.
  if (commitUrl) return NextResponse.redirect(url);
  return NextResponse.rewrite(url, { status: 404 });
}

const STANDALONE_404 = "/missing";
const SHELL_404 = "/lost";

/** Signed-out unknown URLs stay on the requested path and render the standalone page. */
function standaloneNotFound(request: NextRequest, pathname: string) {
  if (pathname === STANDALONE_404) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = STANDALONE_404;
  url.search = "";
  return NextResponse.rewrite(url, { status: 404 });
}

/** Signed-in unknown URLs stay on the requested path and render inside the hub. */
function shellNotFound(request: NextRequest, carry?: NextResponse) {
  const url = request.nextUrl.clone();
  url.pathname = SHELL_404;
  url.search = "";
  const response = NextResponse.rewrite(url, { status: 404 });
  const accent = carry?.cookies.get("ensemble_accent");
  if (accent) {
    response.cookies.set("ensemble_accent", accent.value, { path: "/", sameSite: "lax", maxAge: 60 * 60 * 24 * 400 });
  }
  return response;
}

function isDataRequest(request: NextRequest): boolean {
  if (request.headers.get("rsc") === "1") return true;
  if (request.headers.get("next-router-prefetch") === "1") return true;
  if (request.headers.get("purpose") === "prefetch") return true;
  return false;
}

function loginRedirect(request: NextRequest, dropCookie: boolean) {
  const url = request.nextUrl.clone();
  const next = url.pathname + url.search;
  url.pathname = "/login";
  url.search = "";
  if (next !== "/") url.searchParams.set("next", next);
  const response = NextResponse.redirect(url);
  if (dropCookie) {
    const cookie = sessionCookieDelete(process.env.ENSEMBLE_COOKIE_DOMAIN);
    response.cookies.delete(cookie);
  }
  return response;
}

/**
 * A missing cookie never receives the hub shell. A present cookie is checked
 * against `/api/auth/me` on HTML document loads so a stale session does not
 * paint chrome before the client redirect. RSC and prefetch skip that hop.
 */
export async function middleware(request: NextRequest) {
  let pathname = request.nextUrl.pathname;
  try {
    pathname = normalizePath(pathname);
  } catch (error) {
    if (error instanceof BadPathError) return unavailable(request, !wantsHtml(request));
  }
  if (
    pathname.startsWith("/api") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/templates/") ||
    pathname.startsWith("/fonts/") ||
    pathname === "/health" ||
    isAnonymousAsset(pathname)
  ) {
    return NextResponse.next();
  }
  if (PUBLIC.has(pathname)) return NextResponse.next();
  const session = request.cookies.get("ensemble_session")?.value;
  const unknown = !isAppRoute(pathname);
  // Unknown URLs are not login walls. No session rewrites to the standalone
  // page. A session rewrites to the in-shell card with status 404. Calling
  // notFound() under the client hub layout does not keep that status.
  if (unknown && !session) return standaloneNotFound(request, pathname);
  if (!session) return loginRedirect(request, false);
  // RSC and prefetch must not wait on /api/auth/me. A slow auth check (the
  // fetch below is capped at 1.2s) aborts the in-flight prefetch when the
  // person clicks, and Next then drops that first click on gated routes
  // such as Metrics. Document loads still check the session. An unknown URL
  // is treated as a document even when Accept is */*, so curl gets a 404.
  if (isDataRequest(request) || (!unknown && !wantsHtml(request))) return NextResponse.next();
  try {
    const me = await fetch(`${API}/api/auth/me`, {
      headers: { cookie: `ensemble_session=${session}` },
      cache: "no-store",
      signal: AbortSignal.timeout(1200),
    });
    // Only an explicit 401 means the session is invalid. A restart, a network
    // blip, or a 5xx must not delete the cookie or bounce the user to login.
    if (me.status === 401) return loginRedirect(request, true);
    if (!me.ok) return unknown ? shellNotFound(request) : NextResponse.next();
    const response = NextResponse.next();
    let devTools = false;
    try {
      const body = (await me.json()) as {
        onboardingComplete?: boolean;
        modules?: string | null;
        devTools?: boolean;
        appearance?: { accent?: string; accentCustom?: string | null; accentAt?: number };
      };
      devTools = body.devTools === true;
      if (body.onboardingComplete === false && pathname !== "/start") {
        const start = request.nextUrl.clone();
        start.pathname = "/start";
        start.search = "";
        return NextResponse.redirect(start);
      }
      // A feature that is off stays on its own URL. The shell shows an enable
      // landing. Data routes stay refused until the feature is turned on.
      const custom = body.appearance?.accentCustom;
      const accent = body.appearance?.accent;
      const stamp = typeof body.appearance?.accentAt === "number" ? body.appearance.accentAt : 0;
      const value =
        typeof custom === "string" && /^#[0-9a-fA-F]{6}$/.test(custom)
          ? `c:${custom}`
          : typeof accent === "string" && /^[a-z]+$/.test(accent)
            ? accent
            : "";
      if (value) {
        response.cookies.set("ensemble_accent", `${value}@${stamp}`, { path: "/", sameSite: "lax", maxAge: 60 * 60 * 24 * 400 });
      }
    } catch {
      return unknown ? shellNotFound(request) : NextResponse.next();
    }
    if (pathname === "/marketplace" || pathname.startsWith("/marketplace/")) {
      response.headers.set("x-robots-tag", "noindex, nofollow");
      if (!devTools) return unavailable(request, !wantsHtml(request));
    }
    if (unknown) return shellNotFound(request, response);
    return response;
  } catch {
    return unknown ? shellNotFound(request) : NextResponse.next();
  }
}

export const config = {
  matcher: [
    "/((?!api/|health$|_next/static|_next/image|templates/|fonts/|icon\\.svg|favicon\\.ico|robots\\.txt|apple-icon(?:\\.png)?|apple-touch-icon\\.png|manifest\\.webmanifest|site\\.webmanifest|icon(?:-maskable)?-\\d+\\.png|brand-icon-\\d+\\.png|og-image\\.png|opengraph-image|twitter-image|offline\\.html|404\\.html|500\\.html).*)",
  ],
};
