/**
 * FR-A5 in-line error rows, one per taxonomy entry in design §11.1. Codes
 * without bespoke copy still render (falls back to the raw code string).
 */
const CODE_LABELS: Record<string, string> = {
  CONFIG_INVALID: "Configuration error",
  LLM_AUTH: "Authentication error",
  LLM_RATE_LIMIT: "Rate limited",
  LLM_ERROR: "LLM error",
  LLM_STREAM_ABORTED: "Generation stopped",
  SERVER_UNREACHABLE: "Server unreachable",
  TOOL_TIMEOUT: "Tool timed out",
  TOOL_ERROR: "Tool error",
  TOOL_UNKNOWN_ALIAS: "Tool unavailable",
  TOOL_DENIED: "Tool call denied",
  RATE_LIMITED: "Rate limited",
  SESSION_NOT_FOUND: "Session not found",
  CLIENT_ERROR: "Error",
};

export interface ErrorMessageProps {
  code: string;
  message: string;
}

export function ErrorMessage({ code, message }: ErrorMessageProps) {
  return (
    <div className="assistant-error-row" role="alert">
      <span className="assistant-error-code">{CODE_LABELS[code] ?? code}</span>
      <span className="assistant-error-message">{message}</span>
    </div>
  );
}
