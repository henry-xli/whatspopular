type RuntimeEnvironment = Record<string, unknown>;

async function runtimeEnvironment(): Promise<RuntimeEnvironment> {
  try {
    const runtime = await import("cloudflare:workers");
    return (runtime.env ?? {}) as RuntimeEnvironment;
  } catch {
    return {};
  }
}
function configuredString(environment: RuntimeEnvironment, key: string) {
  const value = environment[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export class VerificationEmailError extends Error {
  readonly code: "not_configured" | "delivery_failed";

  constructor(code: "not_configured" | "delivery_failed") {
    super(code);
    this.code = code;
  }
}

export async function sendVerificationEmail(to: string, code: string, displayName: string) {
  const environment = await runtimeEnvironment();
  const apiKey = configuredString(environment, "AUTH_EMAIL_API_KEY") || configuredString(environment, "RESEND_API_KEY");
  const from = configuredString(environment, "AUTH_EMAIL_FROM") || configuredString(environment, "RESEND_FROM");
  const endpoint = configuredString(environment, "AUTH_EMAIL_API_URL") || (apiKey && from ? "https://api.resend.com/emails" : "");
  if (!apiKey || !from || !endpoint) throw new VerificationEmailError("not_configured");

  const safeName = displayName.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) || "there";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: "Your what’s popular? verification code",
      text: `Hi ${safeName},\n\nYour what’s popular? verification code is ${code}. It expires in 10 minutes. If you did not request an account, you can ignore this email.\n\nThis code is single-use.`,
      html: `<p>Hi ${escapeHtml(safeName)},</p><p>Your what’s popular? verification code is <strong>${code}</strong>. It expires in 10 minutes.</p><p>If you did not request an account, you can ignore this email.</p>`,
    }),
  });
  if (!response.ok) throw new VerificationEmailError("delivery_failed");
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
