import type { Metadata } from "next";
import { getServerAuthenticatedUser } from "../account-server";
import { ForYouExperience } from "../components/for-you";
import { nicheBrief } from "../niche";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "For You",
  description: "Build a weekly digest from the niche interests you actually want to follow.",
  alternates: { canonical: "/for-you" },
  openGraph: {
    title: "For You — what’s popular?",
    description: "Build a weekly digest from the niche interests you actually want to follow.",
    url: "/for-you",
    images: [{ url: "/og.jpg", width: 1200, height: 630, alt: "what’s popular? For You weekly digest" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "For You — what’s popular?",
    description: "Build a weekly digest from the niche interests you actually want to follow.",
    images: ["/og.jpg"],
  },
};

export default async function ForYouPage() {
  const user = await getServerAuthenticatedUser();
  return (
    <ForYouExperience
      categories={nicheBrief.categories}
      generatedAt={nicheBrief.generatedAt}
      edition={nicheBrief.edition}
      windowLabel={nicheBrief.window}
      summary={nicheBrief.summary}
      signedIn={Boolean(user)}
      displayName={user?.displayName}
    />
  );
}
