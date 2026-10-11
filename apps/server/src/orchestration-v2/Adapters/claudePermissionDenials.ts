import type { PermissionMode, SDKPermissionDenial } from "@anthropic-ai/claude-agent-sdk";

const MAX_REASON_LENGTH = 300;

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > MAX_REASON_LENGTH
    ? `${collapsed.slice(0, MAX_REASON_LENGTH - 1)}…`
    : collapsed;
}

/**
 * The notice for tool calls Claude Code denied on its own, such as Auto
 * mode's classifier, which decides before T3's permission callback runs.
 * T3's own denials (a captured ExitPlanMode plan, a declined approval, a
 * cancelled question) are already visible to the user and are left out.
 * The SDK's denial entries carry no reason, so it comes from the tool_result
 * error text Claude received for that call. Null when nothing is left.
 */
export function claudePermissionDenialNotice(input: {
  readonly denials: ReadonlyArray<SDKPermissionDenial>;
  readonly deniedByT3: ReadonlySet<string>;
  readonly toolErrorTexts: ReadonlyMap<string, string>;
  readonly permissionMode: PermissionMode;
}): string | null {
  const denials = input.denials.filter((denial) => !input.deniedByT3.has(denial.tool_use_id));
  if (denials.length === 0) return null;
  const count = `${denials.length} action${denials.length === 1 ? "" : "s"}`;
  const title = `${input.permissionMode === "auto" ? "Auto mode" : "Claude"} denied ${count}`;
  const tools = [...new Set(denials.map((denial) => denial.tool_name))].join(", ");
  const reasons = [
    ...new Set(
      denials.flatMap((denial) => {
        const text = input.toolErrorTexts.get(denial.tool_use_id);
        return text === undefined || text.trim().length === 0 ? [] : [oneLine(text)];
      }),
    ),
  ];
  return reasons.length === 0
    ? `${title} (${tools}).`
    : `${title} (${tools}): ${reasons.join(" ")}`;
}
