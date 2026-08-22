import { readJsonBody, startEmailChange } from "../../../../auth-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const payload = await readJsonBody<Record<string, unknown>>(request);
  return startEmailChange(request, payload ?? {});
}
