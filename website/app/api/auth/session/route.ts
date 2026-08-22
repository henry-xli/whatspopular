import { authSession } from "../../../auth-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return authSession(request);
}
