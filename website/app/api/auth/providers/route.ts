import { authProviderStatus } from "../../../auth-server";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await authProviderStatus(), {
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
