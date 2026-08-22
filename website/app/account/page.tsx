import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Profile",
  description: "Open the profile menu to manage your what’s popular? account.",
  robots: { index: false, follow: false },
};

export default function AccountPage() {
  redirect("/for-you");
}
