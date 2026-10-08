import { useRef, useState, type KeyboardEvent } from 'react';

export function Composer({
  disabled,
  autoAccept,
  onAutoAcceptChange,
  onSend,
}: {
  disabled: boolean;
  autoAccept: boolean;
  onAutoAcceptChange: (value: boolean) => void;
  onSend: (message: string) => void;
}) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || disabled) return;
    onSend(trimmed);
    setValue('');
    textareaRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Describe the idea, add a constraint, or ask for alternatives…"
        rows={3}
        disabled={disabled}
        aria-label="Message Ideno"
      />
      <div className="composer__actions">
        <label className="switch" title="Skip the review step and apply proposals immediately">
          <input
            type="checkbox"
            checked={autoAccept}
            onChange={(event) => onAutoAcceptChange(event.target.checked)}
          />
          <span>Auto-apply changes</span>
        </label>
        <span className="composer__hint">Enter to send · Shift+Enter for a new line</span>
        <button
          type="button"
          className="button button--primary"
          onClick={submit}
          disabled={disabled || value.trim().length === 0}
        >
          Send
        </button>
      </div>
    </div>
  );
}
