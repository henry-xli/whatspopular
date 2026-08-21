import type { Metadata } from "next";
import { getChatGPTUser } from "../chatgpt-auth";
import { MobileLinkExperience } from "../components/mobile-link";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Link mobile app",
  description: "Securely link the what’s popular? mobile app to this account.",
  robots: { index: false, follow: false },
};

type PageProps = {
  searchParams: Promise<{ request_id?: string; code?: string }>;
};

export default async function MobileLinkPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const requestId = typeof params.request_id === "string" ? params.request_id : "";
  const code = typeof params.code === "string" ? params.code.toUpperCase() : "";
  const user = await getChatGPTUser();
  return (
    <MobileLinkExperience
      requestId={requestId}
      code={code}
      signedIn={Boolean(user)}
      displayName={user?.displayName}
    />
  );
}
