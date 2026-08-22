import { completeGoogle } from "../../../../auth-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (error) return Response.redirect(new URL(`/signin?error=${encodeURIComponent("Google sign-in was cancelled.")}`, url.origin), 302);
  return completeGoogle(request, code, state);
}
