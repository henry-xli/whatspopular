import { spawn } from "node:child_process";
import path from "node:path";

const websiteRoot = path.resolve(import.meta.dirname, "..");
const timeoutMs = Number(process.env.WHATSPOPULAR_VERIFY_TIMEOUT_MS ?? 180_000);
const checks = [
  ["lint", ["run", "lint"]],
  ["typecheck", ["run", "typecheck"]],
  ["tests", ["test"]],
];

function runCheck(name, args) {
  return new Promise((resolve) => {
    const child = spawn("npm", args, {
      cwd: websiteRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    const startedAt = Date.now();
    let timedOut = false;
    let settled = false;
    let forceTimer;
    child.stdout.on("data", (chunk) => output.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    child.stderr.on("data", (chunk) => output.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, timeoutMs);
    const finish = (code, signal, error = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (error) output.push(Buffer.from(`${error}\n`));
      resolve({
        name,
        code: timedOut ? 124 : (code ?? 1),
        signal,
        elapsedMs: Date.now() - startedAt,
        output: Buffer.concat(output).toString("utf8"),
      });
    };
    child.on("close", (code, signal) => {
      finish(code, signal);
    });
    child.on("error", (error) => {
      finish(1, null, error);
    });
  });
}

const results = await Promise.all(checks.map(([name, args]) => runCheck(name, args)));
let failed = false;
for (const result of results) {
  const status = result.code === 0 ? "PASS" : "FAIL";
  console.log(`${status} ${result.name} (${result.elapsedMs}ms)`);
  if (result.code !== 0) {
    failed = true;
    console.error(result.output.trimEnd());
  }
}
if (failed) process.exitCode = 1;
