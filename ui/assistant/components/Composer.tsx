/**
 * Prompt textarea (design §3.2's `Composer.tsx`): Enter submits, Shift+Enter
 * inserts a newline; disabled while a turn is active; a Stop button calls
 * `api.cancelChat` (wired by the parent).
 */
import { useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";

export interface ComposerProps {
  disabled: boolean;
  turnActive: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

export function Composer({ disabled, turnActive, onSubmit, onCancel }: ComposerProps) {
  const [value, setValue] = useState("");

  function submit() {
    const text = value.trim();
    if (text === "" || disabled) return;
    onSubmit(text);
    setValue("");
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function handleFormSubmit(e: FormEvent) {
    e.preventDefault();
    submit();
  }

  return (
    <form className="assistant-composer" onSubmit={handleFormSubmit}>
      <div className="assistant-composer-inner">
        <textarea
          className="assistant-composer-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about sales…"
          rows={1}
          disabled={disabled}
          aria-label="Message"
        />
        <div className="assistant-composer-actions">
          {turnActive ? (
            <button type="button" className="assistant-stop-button" onClick={onCancel}>
              Stop
            </button>
          ) : (
            <button type="submit" className="assistant-send-button" disabled={disabled || value.trim() === ""}>
              Send
            </button>
          )}
        </div>
      </div>
      <div className="assistant-composer-hint">Enter to send · Shift+Enter for a new line</div>
    </form>
  );
}
