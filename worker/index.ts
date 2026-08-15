import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const securityHeaders = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.buymeacoffee.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src https://open.spotify.com https://www.buymeacoffee.com",
    "upgrade-insecure-requests",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const response = await handler.fetch(request, env, ctx);
    const headers = new Headers(response.headers);
    const url = new URL(request.url);

    if (url.pathname.startsWith("/_next/static/")) {
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
    } else if (url.pathname.startsWith("/culture/") || url.pathname === "/icon.png" || url.pathname === "/og.png") {
      headers.set("Cache-Control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800");
    } else if ((headers.get("content-type") ?? "").includes("text/html")) {
      headers.set("Cache-Control", "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800");
    }

    if (process.env.NODE_ENV === "production") {
      for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

export default worker;
