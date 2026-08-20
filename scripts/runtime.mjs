import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
const publicHostCache = new Map();

class FetchFailure extends Error {
  constructor(message, status, retryAfter = 0) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function secureUrl(rawUrl, isAllowedHost, kind) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Refusing invalid ${kind} URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !isAllowedHost(url.hostname)) {
    throw new Error(`Refusing unapproved ${kind} URL: ${url.origin}`);
  }
  return url;
}

function publicIpv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second, third] = octets;
  return !(first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0 && third === 0)
    || (first === 192 && second === 0 && third === 2)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
    || first >= 224);
}

function publicIpv6(address) {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized.startsWith("::ffff:")) return publicIpv4(normalized.slice(7));
  return /^(?:2|3)[0-9a-f]{3}:/.test(normalized)
    && !normalized.startsWith("2001:db8:");
}

export function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4 ? publicIpv4(address) : family === 6 ? publicIpv6(address) : false;
}

export async function assertPublicHostname(hostname) {
  const normalized = String(hostname).toLowerCase().replace(/\.$/, "");
  if (!normalized || isIP(normalized)
    || normalized === "localhost"
    || /\.(?:home|internal|invalid|lan|local|localhost|onion|test)$/.test(normalized)) {
    throw new Error(`Refusing non-public host: ${hostname}`);
  }
  if (!publicHostCache.has(normalized)) {
    publicHostCache.set(normalized, (async () => {
      let timer;
      try {
        const addresses = await Promise.race([
          lookup(normalized, { all: true, verbatim: true }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`DNS lookup timed out for ${normalized}`)), 3000);
          }),
        ]);
        if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
          throw new Error(`Refusing non-public host: ${hostname}`);
        }
      } finally {
        clearTimeout(timer);
      }
    })());
  }
  try {
    await publicHostCache.get(normalized);
  } catch (error) {
    publicHostCache.delete(normalized);
    throw error;
  }
}

function retryAfter(response) {
  const value = response.headers.get("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, Math.min(milliseconds, 5000)) : 0;
}

async function readLimited(response, maxBytes, kind) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${kind} response exceeds ${maxBytes} bytes`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${kind} response had no body`);
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`${kind} response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function fetchOnce(rawUrl, options) {
  let url = secureUrl(rawUrl, options.isAllowedHost, options.kind);
  let method = options.method.toUpperCase();
  let body = options.body;
  const headers = new Headers(options.headers);
  const signal = AbortSignal.timeout(options.timeoutMs);

  for (let redirects = 0; redirects <= options.maxRedirects; redirects += 1) {
    if (options.validateHost) await options.validateHost(url.hostname);
    const response = await fetch(url, {
      method,
      body,
      headers,
      redirect: "manual",
      signal,
    });
    if (!redirectStatuses.has(response.status)) {
      if (!response.ok) {
        const delay = retryAfter(response);
        await response.body?.cancel().catch(() => {});
        throw new FetchFailure(`${response.status} from ${url.hostname}`, response.status, delay);
      }
      return {
        buffer: await readLimited(response, options.maxBytes, options.kind),
        contentType: response.headers.get("content-type") ?? "",
        finalUrl: url.href,
      };
    }
    if (redirects === options.maxRedirects) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`${options.kind} exceeded ${options.maxRedirects} redirects`);
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => {});
    if (!location) throw new Error(`${options.kind} redirect had no location`);
    const nextUrl = secureUrl(new URL(location, url), options.isAllowedHost, options.kind);
    if (nextUrl.origin !== url.origin) {
      headers.delete("authorization");
      headers.delete("cookie");
    }
    url = nextUrl;
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers.delete("content-type");
    }
  }
  throw new Error(`${options.kind} request failed`);
}

function isRetryable(error) {
  return (error instanceof FetchFailure && retryableStatuses.has(error.status))
    || error instanceof TypeError
    || error?.name === "AbortError"
    || error?.name === "TimeoutError";
}

export async function fetchBytes(rawUrl, options) {
  const settings = {
    method: "GET",
    body: undefined,
    headers: {},
    attempts: 3,
    maxRedirects: 4,
    ...options,
  };
  if (typeof settings.isAllowedHost !== "function"
    || (settings.validateHost !== undefined && typeof settings.validateHost !== "function")
    || !Number.isInteger(settings.maxBytes) || settings.maxBytes < 1
    || !Number.isInteger(settings.timeoutMs) || settings.timeoutMs < 1
    || !Number.isInteger(settings.attempts) || settings.attempts < 1 || settings.attempts > 5
    || !Number.isInteger(settings.maxRedirects) || settings.maxRedirects < 0 || settings.maxRedirects > 8
    || !["GET", "POST"].includes(String(settings.method).toUpperCase())) {
    throw new Error("Invalid bounded-fetch settings");
  }
  let lastError;
  for (let attempt = 0; attempt < settings.attempts; attempt += 1) {
    try {
      return await fetchOnce(rawUrl, settings);
    } catch (error) {
      lastError = error;
      if (attempt + 1 === settings.attempts || !isRetryable(error)) throw error;
      const delay = error instanceof FetchFailure && error.retryAfter
        ? error.retryAfter
        : 300 * (2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export async function mapConcurrent(values, limit, work) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Concurrency limit must be a positive integer");
  const output = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await work(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

export function createRateLimiter(intervalMs) {
  if (!Number.isInteger(intervalMs) || intervalMs < 0) throw new Error("Rate-limit interval must be a non-negative integer");
  let nextAvailable = 0;
  let queue = Promise.resolve();
  return async function schedule(work) {
    if (typeof work !== "function") throw new Error("Rate-limited work must be a function");
    const run = queue.then(async () => {
      const delay = Math.max(0, nextAvailable - Date.now());
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      nextAvailable = Date.now() + intervalMs;
      return work();
    });
    queue = run.catch(() => {});
    return run;
  };
}
