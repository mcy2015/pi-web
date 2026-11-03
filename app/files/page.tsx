import { Suspense } from "react";
import type { Metadata } from "next";
import { FilesPage } from "@/components/FilesPage";
import { I18nProvider } from "@/hooks/useI18n";

// The file panel as its own route, under the web password like the main page
// (see proxy.ts's matcher). All data still goes through /api/files.
export const metadata: Metadata = {
  title: "Files · Pi Web",
  robots: { index: false, follow: false },
};

export default function FilesRoutePage() {
  return (
    <Suspense>
      <I18nProvider>
        <FilesPage />
      </I18nProvider>
    </Suspense>
  );
}
