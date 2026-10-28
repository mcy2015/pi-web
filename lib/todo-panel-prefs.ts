/**
 * Per-browser preference for the todo panel above the composer: whether the
 * user folded it to its one-line summary. Collapsed is the default; only an
 * explicit save opens it again. Best-effort localStorage, like the sidebar
 * memories (lib/sidebar-prefs.ts): privacy mode or quota errors fall back to
 * the default.
 */

const TODO_PANEL_COLLAPSED_STORAGE_KEY = "pi-web:todo-panel-collapsed";

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem?(key: string): void;
}

function getBrowserStorage(): StorageLike | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

/** The todo panel starts folded; a browser that saved it expanded opens it. */
export function getTodoPanelCollapsed(storage: StorageLike | null = getBrowserStorage()): boolean {
	if (!storage) return true;
	try {
		return storage.getItem(TODO_PANEL_COLLAPSED_STORAGE_KEY) !== "false";
	} catch {
		return true;
	}
}

export function setTodoPanelCollapsed(
	collapsed: boolean,
	storage: StorageLike | null = getBrowserStorage(),
): void {
	if (!storage) return;
	try {
		storage.setItem(TODO_PANEL_COLLAPSED_STORAGE_KEY, String(collapsed));
	} catch {
		// Persistence is best-effort.
	}
}
