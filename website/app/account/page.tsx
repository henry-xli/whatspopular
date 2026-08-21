import type { Metadata } from "next";
import { getChatGPTUser } from "../chatgpt-auth";
import { AccountSettingsExperience } from "../components/account-settings";
import { nicheBrief } from "../niche";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Account settings",
  description: "Manage the interests that shape your what’s popular? digest.",
  robots: { index: false, follow: false },
};

export default async function AccountPage() {
  const user = await getChatGPTUser();
  return (
    <AccountSettingsExperience
      categories={nicheBrief.categories}
      signedIn={Boolean(user)}
      displayName={user?.displayName}
      email={user?.email}
    />
  );
}
