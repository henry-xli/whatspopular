import type { Metadata } from "next";
import { safeReturnPath } from "../account-server";
import { SignInExperience } from "../components/sign-in-experience";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to sync your what’s popular? interests across the website and mobile app.",
  robots: { index: false, follow: false },
};

type PageProps = {
  searchParams: Promise<{ return_to?: string; error?: string }>;
};

export default async function SignInPage({ searchParams }: PageProps) {
  const params = await searchParams;
  return (
    <SignInExperience
      returnTo={safeReturnPath(params.return_to)}
      initialError={typeof params.error === "string" ? params.error.slice(0, 160) : ""}
    />
  );
}
