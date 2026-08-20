import handler from "vinext/server/app-router-entry";

declare const __BUILD_ID__: string;

interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  ASSETS: AssetFetcher;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

const securityHeaders = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    // Spotify's official iFrame controller currently evaluates its bundled
    // runtime. Keep the source allowlist narrow while permitting that runtime
    // so the playlist handoff can receive playback events.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.buymeacoffee.com https://open.spotify.com https://embed-cdn.spotifycdn.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://cdn.buymeacoffee.com",
    "font-src 'self' data: https://cdn.buymeacoffee.com",
    "connect-src 'self' https://open.spotify.com",
    "frame-src https://open.spotify.com https://www.buymeacoffee.com https://buymeacoffee.com",
    "upgrade-insecure-requests",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Origin-Agent-Cluster": "?1",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Permitted-Cross-Domain-Policies": "none",
};

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isHtmlNavigation = request.method === "GET"
      && (url.pathname === "/" || url.pathname === "/about" || url.pathname === "/explore")
      && !request.headers.has("rsc")
      && !request.headers.has("next-router-state-tree")
      && ((request.headers.get("accept") ?? "").includes("text/html")
        || request.headers.get("sec-fetch-mode") === "navigate");
    const edgeCache = (globalThis as unknown as { caches?: { default?: EdgeCache } }).caches?.default;
    let cacheKey: Request | undefined;
    if (isHtmlNavigation && edgeCache) {
      const cacheUrl = new URL(url.pathname, url.origin);
      cacheUrl.searchParams.set("__wpv", __BUILD_ID__);
      cacheKey = new Request(cacheUrl, { headers: { accept: "text/html" } });
      try {
        const cached = await edgeCache.match(cacheKey);
        if (cached) return cached;
      } catch {}
    }

    const response = await handler.fetch(request, env, ctx);
    const headers = new Headers(response.headers);
    const cacheable = (request.method === "GET" || request.method === "HEAD")
      && ((response.status >= 200 && response.status < 300) || response.status === 304);

    if (!cacheable) {
      headers.set("Cache-Control", "no-store");
    } else if (url.pathname.startsWith("/_next/static/")) {
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
    } else if (url.pathname === "/site.css") {
      headers.set("Cache-Control", "public, max-age=0, must-revalidate, s-maxage=86400, stale-while-revalidate=604800");
    } else if (url.pathname.startsWith("/culture/") || ["/icon.png", "/og.jpg"].includes(url.pathname)) {
      headers.set("Cache-Control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800");
    } else if ((headers.get("content-type") ?? "").includes("text/html")) {
      headers.set("Cache-Control", "public, no-cache, s-maxage=86400, stale-while-revalidate=604800");
    }

    if (process.env.NODE_ENV === "production") {
      for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
    }

    const finalResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    if (cacheKey && edgeCache && response.status === 200
      && (headers.get("content-type") ?? "").includes("text/html")) {
      ctx.waitUntil(edgeCache.put(cacheKey, finalResponse.clone()).catch(() => {}));
    }
    return finalResponse;
  },
};

export default worker;
