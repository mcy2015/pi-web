"use client";

import { useState } from "react";
import { getTodoPanelCollapsed, setTodoPanelCollapsed } from "@/lib/todo-panel-prefs";
import type { TodoItem, TodoSnapshot } from "@/lib/todo-state";

// The model's todo list, rendered read-only above the composer. The snapshot
// is derived from the conversation (lib/todo-state.ts): the list belongs to
// the agent, so the panel offers no editing. Copy stays inline English —
// status glyphs carry the states, and the strings are single words.

const EXPAND_TODOS = "Expand todos";
const COLLAPSE_TODOS = "Collapse todos";
const ALL_DONE = "All done";
const REMAINING = (count: number) => `${count} remaining`;
const HIGH_PRIORITY_BADGE = "high";
const HIGH_PRIORITY_LABEL = "High priority";

function statusGlyph(status: TodoItem["status"]): string {
	if (status === "completed") return "✓";
	if (status === "in_progress") return "◐";
	return "○";
}

function GlyphSpan({ status, color }: { status: TodoItem["status"]; color: string }) {
	return (
		<span
			aria-hidden="true"
			// In-progress breathes only through the glyph's opacity: no spinner.
			className={status === "in_progress" ? "animate-[pulse_1.5s_infinite] motion-reduce:animate-none" : undefined}
			style={{ flexShrink: 0, width: 14, textAlign: "center", fontFamily: "var(--font-mono)", lineHeight: "inherit", color }}
		>
			{statusGlyph(status)}
		</span>
	);
}

/**
 * The todo summary bar with the list under it. Hidden entirely while there is
 * no snapshot or nothing in it. Collapsed (the default) it is one thin line —
 * done/total and what is under way; the chevron expands the read-only list.
 */
export function TodoPanel({ snapshot }: { snapshot: TodoSnapshot | null }) {
	const [collapsed, setCollapsed] = useState(() => getTodoPanelCollapsed());
	if (!snapshot || snapshot.todos.length === 0) return null;

	const { todos, counts } = snapshot;
	const inProgress = todos.find((item) => item.status === "in_progress") ?? null;
	const summaryText = inProgress ? inProgress.content : (counts.pending > 0 ? REMAINING(counts.pending) : ALL_DONE);
	const summaryStatus = inProgress ? "in_progress" : (counts.pending > 0 ? "pending" : "completed");
	const progress = `${counts.completed}/${counts.total}`;

	const toggle = () => {
		const next = !collapsed;
		setCollapsed(next);
		setTodoPanelCollapsed(next);
	};

	return (
		<div style={{ padding: "0 16px", marginBottom: 8 }}>
			<div style={{ maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto" }}>
				<button
					type="button"
					aria-expanded={!collapsed}
					aria-label={`Todos ${progress} · ${summaryText}`}
					title={collapsed ? EXPAND_TODOS : COLLAPSE_TODOS}
					onClick={toggle}
					style={{
						display: "flex",
						alignItems: "center",
						gap: 7,
						width: "100%",
						minWidth: 0,
						minHeight: 24,
						padding: "2px 0",
						border: "none",
						background: "transparent",
						color: "var(--text-muted)",
						cursor: "pointer",
						fontSize: 12,
						textAlign: "left",
					}}
				>
					<GlyphSpan status={summaryStatus} color="var(--text-muted)" />
					<span aria-hidden="true" style={{ flexShrink: 0, fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}>{progress}</span>
					<span aria-hidden="true" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summaryText}</span>
					<svg
						width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
						aria-hidden="true" style={{ flexShrink: 0, transform: collapsed ? "none" : "rotate(90deg)", transition: "transform 0.15s" }}
					>
						<polyline points="4 2.5 7.5 6 4 9.5" />
					</svg>
				</button>
				{!collapsed && (
					<ul
						style={{
							listStyle: "none",
							margin: "4px 0 0",
							padding: "6px 10px",
							border: "1px solid var(--border)",
							borderRadius: 7,
							background: "var(--bg-panel)",
							maxHeight: "min(240px, 30dvh)",
							overflowY: "auto",
							overscrollBehavior: "contain",
							display: "flex",
							flexDirection: "column",
							gap: 4,
							minWidth: 0,
						}}
					>
						{todos.map((item, index) => (
							<li key={index} style={{ display: "flex", alignItems: "flex-start", gap: 7, minWidth: 0, fontSize: 12, lineHeight: 1.5, color: "var(--text)" }}>
								<GlyphSpan status={item.status} color={item.status === "completed" ? "var(--text-dim)" : "var(--text-muted)"} />
								<span
									style={{
										flex: 1,
										minWidth: 0,
										overflowWrap: "anywhere",
										color: item.status === "completed" ? "var(--text-muted)" : "var(--text)",
										textDecoration: item.status === "completed" ? "line-through" : undefined,
									}}
								>
									{item.content}
								</span>
								{item.priority === "high" && (
									<span
										title={HIGH_PRIORITY_LABEL}
										style={{ flexShrink: 0, marginTop: 1, padding: "0 5px", border: "1px solid var(--accent)", borderRadius: 999, color: "var(--accent)", fontSize: 10, lineHeight: "16px", whiteSpace: "nowrap" }}
									>
										{HIGH_PRIORITY_BADGE}
									</span>
								)}
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
