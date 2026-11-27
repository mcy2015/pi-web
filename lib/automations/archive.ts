// What a run's session becomes once the run ends, when the automation asks
// for it: archived through the sidebar's own state (the same write as its
// Archive action), so it leaves the main list for Archived. The sidebar lists
// a family as archived only while nothing of it runs and its archive time is
// not older than its last activity, so this is called once the turn has
// settled — pi writes each entry to the file before prompt_done — never while
// the run is going.

import { updateSessionUiState } from "../session-ui-state";

/** Archives the session `sessionId` and says whether the state was written. A
 *  refusal (the state file unreadable, its lock held) is reported, not thrown:
 *  the run itself already ended well or badly, and archiving is cosmetic. */
export async function archiveAutomationSession(sessionId: string, path?: string): Promise<boolean> {
  if (sessionId === "") return false;
  try {
    await updateSessionUiState({ action: "set", ids: [sessionId], archived: true }, path);
    return true;
  } catch (error) {
    console.warn(`[pi-web] automations: archiving the run's session failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
