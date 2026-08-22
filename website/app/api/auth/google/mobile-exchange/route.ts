import { exchangeGoogleMobile, readJsonBody } from "../../../../auth-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const payload = await readJsonBody<Record<string, unknown>>(request);
  const code = typeof payload?.code === "string" ? payload.code.trim() : "";
  return exchangeGoogleMobile(request, code);
}
