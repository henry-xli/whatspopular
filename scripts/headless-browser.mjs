import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const chromeCandidates = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const privateNetworkPatterns = [
  "file://*", "ftp://*",
  "http://localhost/*", "https://localhost/*", "ws://localhost/*", "wss://localhost/*",
  "http://127.*", "https://127.*", "ws://127.*", "wss://127.*",
  "http://0.*", "https://0.*", "http://10.*", "https://10.*",
  "http://169.254.*", "https://169.254.*", "http://192.168.*", "https://192.168.*",
  "http://[::1]/*", "https://[::1]/*",
  ...Array.from({ length: 16 }, (_, index) => `http://172.${index + 16}.*`),
  ...Array.from({ length: 16 }, (_, index) => `https://172.${index + 16}.*`),
];

async function chromePath() {
  for (const candidate of chromeCandidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("No compatible Chrome or Chromium executable was found");
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

class CdpSession {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
  }

  async connect() {
    await withTimeout(new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("Chrome debugging connection failed")), { once: true });
    }), 8_000, "Chrome debugging connection");
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      const listeners = this.events.get(message.method) ?? [];
      this.events.delete(message.method);
      for (const listener of listeners) listener(message.params);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return withTimeout(new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    }), 20_000, method);
  }

  waitFor(method, timeoutMs = 20_000) {
    return withTimeout(new Promise((resolve) => {
      this.events.set(method, [...(this.events.get(method) ?? []), resolve]);
    }), timeoutMs, method);
  }

  close() {
    this.socket.close();
  }
}

function waitForDebugUrl(child) {
  return withTimeout(new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-12_000);
      const url = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
      if (url) resolve(url);
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Chrome exited before startup (${code ?? "unknown"})`)));
  }), 15_000, "Chrome startup");
}

export async function withHeadlessPage({ allowedHosts, work }) {
  const executable = await chromePath();
  const profile = await mkdtemp(path.join(os.tmpdir(), "whatspopular-chrome-"));
  const child = spawn(executable, [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-gpu",
    "--disable-blink-features=AutomationControlled",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let session;
  try {
    const browserUrl = new URL(await waitForDebugUrl(child));
    if (browserUrl.protocol !== "ws:" || browserUrl.hostname !== "127.0.0.1") {
      throw new Error("Chrome exposed an invalid debugging address");
    }
    const target = await (await fetch(`http://${browserUrl.host}/json/new?about:blank`, { method: "PUT" })).json();
    if (!target.webSocketDebuggerUrl) throw new Error("Chrome did not create a page target");
    session = new CdpSession(target.webSocketDebuggerUrl);
    await session.connect();
    await Promise.all([
      session.send("Page.enable"),
      session.send("Runtime.enable"),
      session.send("Network.enable"),
    ]);
    await session.send("Network.setBlockedURLs", { urls: privateNetworkPatterns });

    const page = {
      async navigate(rawUrl, waitMs = 1_500) {
        const url = new URL(rawUrl);
        if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) {
          throw new Error(`Refusing browser navigation to ${url.hostname}`);
        }
        const loaded = session.waitFor("Page.loadEventFired");
        await session.send("Page.navigate", { url: url.href });
        await loaded;
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
        const finalUrl = new URL(await this.evaluate("location.href"));
        if (finalUrl.protocol !== "https:" || !allowedHosts.has(finalUrl.hostname)) {
          throw new Error(`Refusing browser redirect to ${finalUrl.hostname}`);
        }
      },
      async evaluate(expression) {
        const result = await session.send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails) throw new Error("Browser page evaluation failed");
        return result.result?.value;
      },
      wait(milliseconds) {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
      },
    };
    return await work(page);
  } finally {
    session?.close();
    child.kill("SIGTERM");
    await withTimeout(new Promise((resolve) => child.once("exit", resolve)), 3_000, "Chrome shutdown")
      .catch(() => child.kill("SIGKILL"));
    await rm(profile, { recursive: true, force: true });
  }
}
