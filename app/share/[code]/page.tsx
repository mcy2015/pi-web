import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { SharedSessionView } from "@/components/SharedSessionView";
import { findShareByCode } from "@/lib/share-store";
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
  return {
    title: found ? `${found.share.snapshot.title} · Pi Web` : "Pi Web",
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

  return (
    <I18nProvider>
      <SharedSessionView snapshot={found.share.snapshot} />
    </I18nProvider>
  );
}
