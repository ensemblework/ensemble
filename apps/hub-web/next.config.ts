import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHubApi } from "./lib/hub-origin";

const desktopExport = process.env.ENSEMBLE_DESKTOP_EXPORT === "1";
const productionBuild = process.env.NODE_ENV === "production";
const fixtureStub = path.join(path.dirname(fileURLToPath(import.meta.url)), "lib/graph-fixture.prod.ts");

type ResolveHookData = { request: string };
type WebpackCompiler = {
  hooks: {
    normalModuleFactory: {
      tap: (name: string, fn: (factory: { hooks: { beforeResolve: { tap: (name: string, fn: (data: ResolveHookData | undefined) => void) => void } } }) => void) => void;
    };
  };
};

const API_ORIGIN = resolveHubApi({
  NEXT_PUBLIC_HUB_API: process.env.NEXT_PUBLIC_HUB_API,
  NODE_ENV: process.env.NODE_ENV,
});

const nextConfig: NextConfig = {
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  ...(desktopExport
    ? {
        output: "export" as const,
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {}),
  transpilePackages: ["@ensemble/shared-types", "@ensemble/ide-theme", "@ensemble/block-diagrams"],
  onDemandEntries: {
    maxInactiveAge: 15 * 60 * 1000,
    pagesBufferLength: 12,
  },
  experimental: {
    optimizePackageImports: ["lucide-react", "@ensemble/block-diagrams"],
    proxyTimeout: 310_000,
  },
  // `next build --turbopack` (and a future turbopack production build) must
  // resolve the dev fixture to the empty stub. `next dev` keeps the real module.
  ...(productionBuild
    ? {
        turbopack: {
          resolveAlias: {
            "@/lib/graph-fixture": fixtureStub,
          },
        },
      }
    : {}),
  // The desktop shell rewrites /api in the webview. Export has no Next server, and
  // declaring rewrites() makes `output: "export"` warn and ignore them.
  ...(desktopExport
    ? {}
    : {
        async rewrites() {
          return [
            { source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` },
            { source: "/health", destination: `${API_ORIGIN}/health` },
            // The metadata file route is /opengraph-image.png and, without metadataBase,
            // Next absolutizes it to localhost. Serve the public preview at the path
            // scrapers request, and keep the explicit /og-image.png metadata.
            { source: "/opengraph-image", destination: "/og-image.png" },
            { source: "/opengraph-image.png", destination: "/og-image.png" },
          ];
        },
      }),
  webpack(config, { dev }) {
    // elk.bundled.js is already a browserify bundle. If webpack rewrites it,
    // ELK's inlined worker stops being a constructor and layout collapses.
    const previous = config.module.noParse;
    config.module.noParse = (request: string) => {
      if (/elk\.bundled\.js$/.test(request)) return true;
      if (typeof previous === "function") return previous(request);
      if (previous instanceof RegExp) return previous.test(request);
      return false;
    };
    // shared-types is NodeNext ESM: its imports say ./x.js but the files are ./x.ts.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    if (!dev) {
      // `@/` is a tsconfig path. Next resolves it in the same hook as webpack
      // aliases, so the alias alone does not win. Rewrite the request first.
      const alias = config.resolve.alias;
      const stubAlias = {
        "@/lib/graph-fixture": fixtureStub,
        "@/lib/graph-fixture$": fixtureStub,
      };
      if (Array.isArray(alias)) alias.push(stubAlias);
      else config.resolve.alias = { ...alias, ...stubAlias };
      config.plugins.push({
        apply(compiler: WebpackCompiler) {
          compiler.hooks.normalModuleFactory.tap("GraphFixtureProdStub", (factory) => {
            factory.hooks.beforeResolve.tap("GraphFixtureProdStub", (data) => {
              if (!data) return;
              const request = data.request.split("!").pop() ?? "";
              if (!request || request.includes("graph-fixture.prod")) return;
              if (request === "@/lib/graph-fixture" || /[/\\]graph-fixture(?:\.ts)?$/.test(request)) data.request = fixtureStub;
            });
          });
        },
      });
    }
    return config;
  },
};

export default nextConfig;
