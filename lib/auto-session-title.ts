import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { invalidateSessionListCache } from "./session-reader";
import { generateSessionTitle } from "./session-title";
import { readAutoNameSessionsEnabled } from "./web-settings-file";

// The server-side half of the session title: when a run settles with the task
// finished (`AgentSessionWrapper` fires `onAgentRunComplete` only then — not
// aborted, no subagent still working, never for the suppressed subagent and
// side-chat sessions), a session that still has no name gets one, so the
// sidebar stops showing the first message as its title. The manual button
// (`POST /api/sessions/[id]/auto-name`) stays as-is: it renames named sessions
// too, this only fills the empty slot — a user's (or fork's, or this feature's)
// name is never overwritten.

export interface AutoNameDependencies {
  /** Reads the `autoNameSessions` setting (`pi-web-settings.json`, on unless turned off). */
  readEnabled?: () => boolean;
  /** The title request; injectable so tests need no model runtime. */
  generate?: (session: AgentSession) => Promise<{ title: string }>;
  /** The wrapper's liveness: a session disposed while its title generated (up to 90 s) is left alone. */
  isAlive?: () => boolean;
}

/**
 * Names an unnamed session after a completed answer. Returns the title, or
 * null when nothing was named: the setting is off, the session is named (also
 * when a rename landed while the title was being generated), or the model gave
 * no usable title — a failure of the feature, never of the run it follows.
 */
export async function autoNameSessionAfterRun(
  session: AgentSession,
  { readEnabled = readAutoNameSessionsEnabled, generate = generateSessionTitle, isAlive }: AutoNameDependencies = {},
): Promise<string | null> {
  if (!readEnabled()) return null;
  if (session.sessionManager.getSessionName() !== undefined) return null;

  const { title } = await generate(session);

  // The title can take up to 90 s: the wrapper may have been disposed meanwhile,
  // and a name appended to a closed session's file would sit on a dead branch
  // off the live leaf (#1388).
  if (isAlive && !isAlive()) return null;
  // A rename (PATCH, the fork route, an extension) may land while the title
  // generates; the first name written wins, and it is not this one.
  if (session.sessionManager.getSessionName() !== undefined) return null;
  session.setSessionName(title);
  // The wrapper's session_info_changed invalidates the list as well (#1237);
  // this also covers a wrapper whose subscription is already gone.
  invalidateSessionListCache();
  return title;
}
