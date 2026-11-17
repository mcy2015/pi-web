/**
 * Grouping of consecutive tool calls for the assistant message view: a run of
 * successful calls to the same tool collapses into one summary card
 * ("read × 4, all succeeded") that expands to the individual cards.
 *
 * Pure logic only — no React, no state — so it is unit-testable on its own and
 * its one caller (MessageView) just maps the segments it returns.
 */

import { applyPatchResultHasFailures } from "./apply-patch";
import { isApplyPatchToolName } from "./tool-names";
import type { AssistantContentBlock, ToolCallContent, ToolResultMessage } from "./types";

/** A run shorter than this renders as individual cards. */
export const TOOL_CALL_GROUP_MIN = 3;

/** A tool-call card's error test, shared with the grouping's eligibility. */
export function toolCallHasError(block: ToolCallContent, result?: ToolResultMessage): boolean {
  return (result?.isError ?? false)
    || (isApplyPatchToolName(block.toolName) && applyPatchResultHasFailures(result?.details));
}

export interface BlockItem {
  block: AssistantContentBlock;
  originalIndex: number;
}

export type AssistantRenderSegment =
  | { kind: "block"; block: AssistantContentBlock; originalIndex: number }
  | { kind: "toolCallGroup"; toolName: string; firstOriginalIndex: number; items: { block: ToolCallContent; originalIndex: number }[] };

function blockSegment({ block, originalIndex }: BlockItem): AssistantRenderSegment {
  return { kind: "block", block, originalIndex };
}

/**
 * Split a message's blocks into render segments. A run of at least
 * `minGroupSize` calls to the same tool, adjacent in `originalIndex` (a
 * filtered empty thinking block leaves a gap and breaks the run) and each with
 * a result that is safe to hide behind the fold — no error, no image — becomes
 * one `toolCallGroup`; everything else passes through block by block.
 *
 * Streaming never groups, and neither does a message with any call whose result
 * has yet to arrive: folding a message whose results land one by one would
 * unfold and refold it as they come.
 */
export function groupConsecutiveToolCalls(
  blockItems: BlockItem[],
  toolResults?: Map<string, ToolResultMessage>,
  options?: { isStreaming?: boolean; minGroupSize?: number },
): AssistantRenderSegment[] {
  if (options?.isStreaming) return blockItems.map(blockSegment);
  for (const { block } of blockItems) {
    if (block.type === "toolCall" && !toolResults?.get(block.toolCallId)) return blockItems.map(blockSegment);
  }
  const minGroupSize = options?.minGroupSize ?? TOOL_CALL_GROUP_MIN;
  const segments: AssistantRenderSegment[] = [];
  let run: { block: ToolCallContent; originalIndex: number }[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length >= minGroupSize) {
      segments.push({ kind: "toolCallGroup", toolName: run[0].block.toolName, firstOriginalIndex: run[0].originalIndex, items: run });
    } else {
      for (const { block, originalIndex } of run) segments.push(blockSegment({ block, originalIndex }));
    }
    run = [];
  };
  for (const { block, originalIndex } of blockItems) {
    if (block.type !== "toolCall") {
      flush();
      segments.push({ kind: "block", block, originalIndex });
      continue;
    }
    const result = toolResults?.get(block.toolCallId);
    const groupable = result !== undefined
      && !toolCallHasError(block, result)
      && !result.content.some((part) => part.type === "image");
    const continues = run.length > 0
      && originalIndex === run[run.length - 1].originalIndex + 1
      && block.toolName === run[run.length - 1].block.toolName;
    if (groupable && (run.length === 0 || continues)) {
      run.push({ block, originalIndex });
    } else {
      flush();
      if (groupable) run.push({ block, originalIndex });
      else segments.push(blockSegment({ block, originalIndex }));
    }
  }
  flush();
  return segments;
}
