"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyImageToClipboard } from "@/lib/image-actions";

// A finished action's outcome (done / failed) shows for 2 s, then the button is
// itself again. Unmounting clears the timer; the mounted ref keeps a timer that
// fires around unmount from setting state on the gone component.
function useTransientOutcome() {
  const [outcome, setOutcome] = useState<"idle" | "done" | "failed">("idle");
  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);
  const settle = (next: "done" | "failed") => {
    setOutcome(next);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (mountedRef.current) setOutcome("idle");
    }, 2000);
  };
  return { outcome, settle };
}

function OutcomeIcon({ failed }: { failed: boolean }) {
  return failed ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/** Copies the shown image to the clipboard as PNG (an animated GIF as one frame). */
export function CopyImageButton({ url, isAnimatedGif }: { url: string; isAnimatedGif: boolean }) {
  const { t } = useI18n();
  const { outcome, settle } = useTransientOutcome();
  const [busy, setBusy] = useState(false);
  const label = outcome === "done"
    ? t("files.copyImageCopied")
    : outcome === "failed"
      ? t("files.copyImageFailed")
      : isAnimatedGif
        ? t("files.copyImageGifTitle")
        : t("files.copyImage");
  return (
    <button
      type="button"
      className="file-viewer-icon-button"
      title={label}
      aria-label={label}
      disabled={busy}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        // The write must leave the click gesture synchronously (Safari's
        // user-activation window closes before any awaited fetch), so the call
        // is made here, un-awaited: its clipboard.write() runs within this
        // handler while the PNG is still loading.
        copyImageToClipboard(url).then(() => {
          setBusy(false);
          settle("done");
        }, () => {
          setBusy(false);
          settle("failed");
        });
      }}
    >
      {outcome === "done" || outcome === "failed" ? (
        <OutcomeIcon failed={outcome === "failed"} />
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

/** Attaches the shown image to the chat input, like a dropped file. */
export function AddToChatButton({ filePath, onAddToChat }: { filePath: string; onAddToChat: ((p: string) => void | Promise<void>) | null }) {
  const { t } = useI18n();
  const { outcome, settle } = useTransientOutcome();
  const [busy, setBusy] = useState(false);
  if (!onAddToChat) return null;
  const label = outcome === "failed" ? t("files.addToChatFailed") : t("files.addToChat");
  return (
    <button
      type="button"
      className="file-viewer-icon-button"
      title={label}
      aria-label={label}
      disabled={busy}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        Promise.resolve(onAddToChat(filePath)).then(() => {
          setBusy(false);
        }, () => {
          setBusy(false);
          settle("failed");
        });
      }}
    >
      {outcome === "failed" ? (
        <OutcomeIcon failed />
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M16 5h6" />
          <path d="M19 2v6" />
          <path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5" />
          <circle cx="9" cy="9" r="2" />
          <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
        </svg>
      )}
    </button>
  );
}
