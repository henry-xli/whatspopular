import { readJsonBody, verifyEmailChange } from "../../../../auth-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const payload = await readJsonBody<Record<string, unknown>>(request);
  return verifyEmailChange(request, payload ?? {});
}
