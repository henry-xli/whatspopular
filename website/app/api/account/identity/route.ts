import { accountIdentity, readJsonBody, updateAccountIdentity } from "../../../auth-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return accountIdentity(request);
}

export async function PATCH(request: Request) {
  const payload = await readJsonBody<Record<string, unknown>>(request);
  return updateAccountIdentity(request, payload ?? {});
}

export async function PUT(request: Request) {
  return PATCH(request);
}
