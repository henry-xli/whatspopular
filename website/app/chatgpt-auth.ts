import { headers } from "next/headers";
import { redirect } from "next/navigation";

export type ChatGPTUser = {
  userId: string;
  displayName: string;
  email: string;
  fullName: string | null;
};

const USER_ID_HEADER = "oai-authenticated-user-id";
const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER = "oai-authenticated-user-full-name-encoding";
const SIGN_IN_PATH = "/signin-with-chatgpt";
const SIGN_OUT_PATH = "/signout-with-chatgpt";

export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestHeaders = await headers();
  const userId = boundedIdentityValue(requestHeaders.get(USER_ID_HEADER), 256);
  const email = boundedIdentityValue(requestHeaders.get(USER_EMAIL_HEADER), 320);
  if (!userId || !email) return null;

  const encodedFullName = requestHeaders.get(USER_FULL_NAME_HEADER);
  const decodedFullName = encodedFullName
    && requestHeaders.get(USER_FULL_NAME_ENCODING_HEADER) === "percent-encoded-utf-8"
    ? safeDecodeURIComponent(encodedFullName)
    : null;
  const fullName = boundedIdentityValue(decodedFullName, 160);

  const displayName = boundedIdentityValue(fullName, 160) ?? email;
  return {
    userId,
    displayName,
    email,
    fullName,
  };
}

export async function requireChatGPTUser(returnTo: string): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;
  redirect(chatGPTSignInPath(returnTo));
}

export function chatGPTSignInPath(returnTo: string) {
  return `${SIGN_IN_PATH}?return_to=${encodeURIComponent(safeRelativeReturnPath(returnTo))}`;
}

export function chatGPTSignOutPath(returnTo = "/") {
  return `${SIGN_OUT_PATH}?return_to=${encodeURIComponent(safeRelativeReturnPath(returnTo))}`;
}

function safeRelativeReturnPath(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "https://whatspopular.local");
    if (url.origin !== "https://whatspopular.local"
      || [SIGN_IN_PATH, SIGN_OUT_PATH, "/callback"].includes(url.pathname)) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function boundedIdentityValue(value: string | null, maxLength: number) {
  if (!value) return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}
