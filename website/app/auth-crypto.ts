const PASSWORD_ITERATIONS = 150_000;
const PASSWORD_BYTES = 32;

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations, hash: "SHA-256" },
    key,
    PASSWORD_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await derivePassword(password, salt, PASSWORD_ITERATIONS);
  return {
    hash: base64Url(hash),
    salt: base64Url(salt),
    iterations: PASSWORD_ITERATIONS,
  };
}

export async function verifyPassword(password: string, storedHash: string, storedSalt: string, iterations: number) {
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 500_000) return false;
  let expected: Uint8Array;
  let salt: Uint8Array;
  try {
    expected = fromBase64Url(storedHash);
    salt = fromBase64Url(storedSalt);
  } catch {
    return false;
  }
  if (expected.length !== PASSWORD_BYTES || salt.length < 12 || salt.length > 64) return false;
  const actual = await derivePassword(password, salt, iterations);
  return constantTimeEqual(actual, expected);
}

export function randomDigits(length = 6) {
  const result: string[] = [];
  const limit = Math.floor(256 / 10) * 10;
  while (result.length < length) {
    const bytes = new Uint8Array(length - result.length + 4);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      result.push(String(byte % 10));
      if (result.length === length) break;
    }
  }
  return result.join("");
}

export function randomVerifier(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function sha256Base64Url(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

export async function hashCode(code: string, salt: string) {
  return sha256Base64Url(`${salt}.${code}`);
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
