import type { SubagentToolDetails } from "./subagent-extension";

/** True when a tool call's `details` describe a pi-web subagent run.
 *  Client-safe: the marker is checked structurally, so this module never
 *  pulls the server-side extension module into a client bundle. */
export function isSubagentToolDetails(value: unknown): value is SubagentToolDetails {
  if (!value || typeof value !== "object") return false;
  const details = value as Partial<SubagentToolDetails>;
  return details.kind === "pi-web-subagent" && typeof details.sessionId === "string";
}
