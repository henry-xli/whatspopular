import { authClient, readJsonBody, startEmailSignup } from "../../../../auth-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const payload = await readJsonBody<Record<string, unknown>>(request);
  return startEmailSignup(request, { ...(payload ?? {}), client: authClient(payload?.client) });
}
