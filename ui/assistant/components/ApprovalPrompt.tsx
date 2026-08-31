/**
 * D-9 human-in-the-loop dialog for `tool_approval_request` events: shown
 * inline on the `ToolResultCard` for the tool call awaiting approval.
 */
import { useState } from "react";
import type { ApprovalDecision } from "../state";

export interface ApprovalPromptProps {
  serverName: string;
  toolName: string;
  onDecision: (decision: ApprovalDecision) => void;
}

export function ApprovalPrompt({ serverName, toolName, onDecision }: ApprovalPromptProps) {
  const [decided, setDecided] = useState<ApprovalDecision | null>(null);

  function decide(decision: ApprovalDecision) {
    if (decided) return;
    setDecided(decision);
    onDecision(decision);
  }

  return (
    <div className="assistant-approval" role="alertdialog" aria-label={`Approve tool call: ${toolName}`}>
      <p>
        <strong>{serverName}</strong> (user-added server) wants to call <strong>{toolName}</strong>.
      </p>
      {decided ? (
        <p className="assistant-approval-decided">
          {decided === "deny" ? "Denied." : decided === "session" ? "Allowed for this session." : "Allowed once."}
        </p>
      ) : (
        <div className="assistant-approval-actions">
          <button type="button" onClick={() => decide("once")}>
            Allow once
          </button>
          <button type="button" onClick={() => decide("session")}>
            Allow for this session
          </button>
          <button type="button" className="assistant-approval-deny" onClick={() => decide("deny")}>
            Deny
          </button>
        </div>
      )}
    </div>
  );
}
