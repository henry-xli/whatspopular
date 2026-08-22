import { revokeSession } from "../../../auth-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return revokeSession(request);
}
