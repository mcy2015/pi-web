import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { SharedSessionView } from "@/components/SharedSessionView";
import { SharedSessionExpiredView } from "@/components/SharedSessionExpiredView";
import { findShareByCode, isShareExpired } from "@/lib/share-store";
import { SHARE_CODE_PATTERN } from "@/lib/share-types";
import { I18nProvider } from "@/hooks/useI18n";

// The public share page. It is outside the proxy's matcher, so it serves
// without the web password, and it never calls an API: the server component
// reads the frozen snapshot directly and hands it to the client view.
export const dynamic = "force-dynamic";

export async function generateMetadata(
  { params }: { params: Promise<{ code: string }> },
): Promise<Metadata> {
  const { code } = await params;
  if (!SHARE_CODE_PATTERN.test(code)) notFound();
  const found = findShareByCode(code);
  // An expired link answers with the plain instance title: its holder should
  // not read any session metadata, same as a missing one.
  const expired = found !== null && isShareExpired(found.share);
  return {
    title: found && !expired ? `${found.share.snapshot.title} · Pi Web` : "Pi Web",
    robots: { index: false, follow: false },
  };
}

export default async function SharePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  // Codes are the only input; anything off-pattern is a 404 before the file
  // is even opened.
  if (!SHARE_CODE_PATTERN.test(code)) notFound();
  const found = findShareByCode(code);
  if (!found) notFound();
  // Expired is not 404: the page says so in the visitor's language and still
  // answers 200, while serving none of the frozen content.
  if (isShareExpired(found.share)) {
    return (
      <I18nProvider>
        <SharedSessionExpiredView expiresAt={found.share.expiresAt ?? null} />
      </I18nProvider>
    );
  }

  return (
    <I18nProvider>
      <SharedSessionView snapshot={found.share.snapshot} />
    </I18nProvider>
  );
}
