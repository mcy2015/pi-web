"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";

function StarIcon({ filled, size }: { filled: boolean; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <polygon points="12 2.5 14.9 8.6 21.5 9.4 16.6 13.9 17.9 20.5 12 17.2 6.1 20.5 7.4 13.9 2.5 9.4 9.1 8.6" />
    </svg>
  );
}

/** One entry of the star's save-as-default menu. */
export interface SelectorRowStarChoice {
  key: string;
  label: string;
  disabled?: boolean;
  /** Shown under a disabled entry, and read for it: touch screens have no hover. */
  disabledNote?: string;
  onPick: () => void;
}

export interface SelectorRowStar {
  /** This row is the default new sessions start with. */
  isDefault: boolean;
  /** Title and accessible name of the save button on the other rows. */
  saveLabel: string;
  /** Title and accessible name of the default row's marker. */
  defaultLabel: string;
  onSave: () => void;
  /** Empty star: with entries, the star opens this menu instead of saving directly. */
  choices?: SelectorRowStarChoice[];
  /** Filled star: with entries, the marker becomes a button opening this menu. */
  defaultChoices?: SelectorRowStarChoice[];
}

/**
 * The star's scope menu: fixed-position, because neither the composer's
 * `overflow: hidden` nor a scrolling selector panel may clip it (the same
 * pattern as ModelSelector's panel). Purely presentational — opening,
 * closing, and positioning are SelectorRow's. Exported for tests.
 */
export function SelectorRowStarMenu({
  anchorRect,
  label,
  choices,
  onPick,
}: {
  /** The star button's rect, read when the menu opened. */
  anchorRect: { top: number; right: number; bottom: number };
  label: string;
  choices: SelectorRowStarChoice[];
  onPick: (choice: SelectorRowStarChoice) => void;
}) {
  const openAbove = anchorRect.bottom + 96 > (typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerHeight);
  const rightOffset = typeof window === "undefined" ? 8 : Math.max(8, window.innerWidth - anchorRect.right);
  return (
    <div
      role="menu"
      aria-label={label}
      style={{
        position: "fixed",
        ...(openAbove
          ? { top: anchorRect.top - 4, transform: "translateY(-100%)" }
          : { top: anchorRect.bottom + 4 }),
        right: rightOffset,
        zIndex: 600,
        display: "flex",
        flexDirection: "column",
        minWidth: 200,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg)",
        boxShadow: openAbove ? "0 -4px 16px rgba(0,0,0,0.10)" : "0 4px 16px rgba(0,0,0,0.10)",
      }}
    >
      {choices.map((choice) => (
        <StarMenuEntry key={choice.key} choice={choice} onPick={onPick} />
      ))}
    </div>
  );
}

function StarMenuEntry({ choice, onPick }: { choice: SelectorRowStarChoice; onPick: (choice: SelectorRowStarChoice) => void }) {
  const noteId = useId();
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={choice.disabled ? "true" : undefined}
      aria-describedby={choice.disabled && choice.disabledNote ? noteId : undefined}
      onClick={(event) => {
        event.stopPropagation();
        if (choice.disabled) return;
        onPick(choice);
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 2,
        padding: "7px 12px",
        border: "none",
        background: "none",
        color: choice.disabled ? "var(--text-dim)" : "var(--text-muted)",
        cursor: choice.disabled ? "default" : "pointer",
        fontSize: 12,
        textAlign: "left",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(event) => {
        if (choice.disabled) return;
        event.currentTarget.style.background = "var(--bg-hover)";
        event.currentTarget.style.color = "var(--text)";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = "none";
        event.currentTarget.style.color = choice.disabled ? "var(--text-dim)" : "var(--text-muted)";
      }}
    >
      {choice.label}
      {choice.disabled && choice.disabledNote && (
        <span id={noteId} style={{ color: "var(--text-dim)", fontSize: 10, maxWidth: 260, whiteSpace: "normal" }}>
          {choice.disabledNote}
        </span>
      )}
    </button>
  );
}

/**
 * A selector menu row styled like a session-list row: the whole row selects
 * and highlights on hover. With `star`, the right gutter holds the default
 * marker: a small static star on the default row, and on every other row a
 * "save as default" button that floats in on hover or keyboard focus. Touch
 * screens have no hover, so there the button stays visible.
 */
export function SelectorRow({
  active,
  onSelect,
  star,
  gutter = Boolean(star),
  children,
}: {
  active: boolean;
  onSelect: () => void;
  star?: SelectorRowStar;
  /** Keep room for the star so it never covers the row's text; pass it to every row of a menu that has stars so they line up. */
  gutter?: boolean;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [starMenuRect, setStarMenuRect] = useState<{ top: number; right: number; bottom: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const canSave = Boolean(star && !star.isDefault);
  const hasChoices = canSave && Boolean(star?.choices?.length);
  const hasDefaultChoices = Boolean(star?.isDefault && star.defaultChoices?.length);
  const starMenuOpen = starMenuRect !== null;
  const showSave = canSave && (hovered || focused || isMobile || starMenuOpen);

  // The star menu closes on any press outside its row (the menu itself is a
  // DOM child of it), like the selectors' own panels.
  useEffect(() => {
    if (!starMenuOpen) return;
    const handleOutsidePress = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setStarMenuRect(null);
    };
    document.addEventListener("mousedown", handleOutsidePress);
    return () => document.removeEventListener("mousedown", handleOutsidePress);
  }, [starMenuOpen]);

  const toggleStarMenu = (anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    setStarMenuRect((current) => (current ? null : { top: rect.top, right: rect.right, bottom: rect.bottom }));
  };
  const pickStarChoice = (choice: SelectorRowStarChoice) => {
    setStarMenuRect(null);
    choice.onPick();
  };

  return (
    <div
      ref={rootRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      // The star menu's Escape stops here, so the menu it closes is its own —
      // not the selector panel the row sits in.
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !starMenuOpen) return;
        event.preventDefault();
        event.stopPropagation();
        setStarMenuRect(null);
      }}
      style={{
        position: "relative",
        background: active ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        transition: "background 0.1s",
      }}
    >
      <button
        type="button"
        role="option"
        aria-selected={active}
        onClick={onSelect}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          width: "100%", minWidth: 0, padding: gutter ? "7px 36px 7px 12px" : "7px 12px",
          border: "none", background: "none",
          color: active ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer", fontSize: 12, fontWeight: active ? 600 : 400,
          textAlign: "left", whiteSpace: "nowrap",
        }}
      >
        {active
          ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
          : <span style={{ width: 10, flexShrink: 0 }} />}
        {children}
      </button>
      {star?.isDefault && (hasDefaultChoices ? (
        <button
          type="button"
          title={star.defaultLabel}
          aria-label={star.defaultLabel}
          aria-haspopup="menu"
          aria-expanded={starMenuOpen}
          onClick={(event) => {
            event.stopPropagation();
            toggleStarMenu(event.currentTarget);
          }}
          style={{
            position: "absolute", top: "50%", right: 6, transform: "translateY(-50%)",
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 24, height: 24, padding: 0,
            background: starMenuOpen ? "var(--bg-hover)" : "transparent",
            border: "1px solid transparent", borderRadius: 6,
            color: "var(--text-dim)",
            cursor: "pointer",
            transition: "background 0.12s, border-color 0.12s",
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.background = "var(--bg-hover)";
            event.currentTarget.style.borderColor = "var(--border)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = starMenuOpen ? "var(--bg-hover)" : "transparent";
            event.currentTarget.style.borderColor = "transparent";
          }}
        >
          <StarIcon filled size={10} />
        </button>
      ) : (
        <span
          role="img"
          aria-label={star.defaultLabel}
          title={star.defaultLabel}
          style={{
            position: "absolute", top: "50%", right: 6, transform: "translateY(-50%)",
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 24, height: 24,
            color: "var(--text-dim)",
          }}
        >
          <StarIcon filled size={10} />
        </span>
      ))}
      {star && canSave && (
        <button
          type="button"
          title={star.saveLabel}
          aria-label={star.saveLabel}
          aria-haspopup={hasChoices ? "menu" : undefined}
          aria-expanded={hasChoices ? starMenuOpen : undefined}
          tabIndex={showSave ? 0 : -1}
          onClick={(event) => {
            event.stopPropagation();
            if (hasChoices) toggleStarMenu(event.currentTarget);
            else star.onSave();
          }}
          style={{
            position: "absolute", top: "50%", right: 6, transform: "translateY(-50%)",
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 24, height: 24, padding: 0,
            background: "var(--bg-hover)", border: "1px solid var(--border)",
            borderRadius: 6, color: "var(--text-muted)",
            cursor: "pointer",
            opacity: showSave ? 1 : 0,
            pointerEvents: showSave ? "auto" : "none",
            transition: "opacity 0.1s, background 0.12s, color 0.12s, border-color 0.12s",
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.background = "var(--bg-selected)";
            event.currentTarget.style.color = "var(--accent)";
            event.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = "var(--bg-hover)";
            event.currentTarget.style.color = "var(--text-muted)";
            event.currentTarget.style.borderColor = "var(--border)";
          }}
        >
          <StarIcon filled={false} size={12} />
        </button>
      )}
      {starMenuOpen && star?.choices && starMenuRect && (
        <SelectorRowStarMenu anchorRect={starMenuRect} label={star.saveLabel} choices={star.choices} onPick={pickStarChoice} />
      )}
      {starMenuOpen && star?.defaultChoices && starMenuRect && (
        <SelectorRowStarMenu anchorRect={starMenuRect} label={star.defaultLabel} choices={star.defaultChoices} onPick={pickStarChoice} />
      )}
    </div>
  );
}
