import { useId, type ReactNode } from "react";
import "./settings-toggle.css";

/** Visual only: reusable inside menu switches without nesting interactive controls. */
export function ToggleMark({ checked }: { checked: boolean }) {
  return <span className="settings-toggle-track" data-checked={checked ? "" : undefined} aria-hidden="true"><span className="settings-toggle-thumb" /></span>;
}

/** One native activation target for the label and switch, with no label forwarding. */
export function SettingsToggle({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  description,
  title,
  className = "",
  id,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  description?: ReactNode;
  title?: string;
  className?: string;
  id?: string;
}) {
  const labelId = useId();
  const descriptionId = useId();
  return <button
    id={id}
    type="button"
    role="switch"
    aria-checked={checked}
    aria-labelledby={labelId}
    aria-describedby={description ? descriptionId : undefined}
    className={`settings-toggle ${className}`.trim()}
    disabled={disabled}
    title={title}
    onClick={() => onCheckedChange(!checked)}
  >
    <span className="settings-toggle-copy"><span id={labelId}>{label}</span>{description && <span id={descriptionId} className="settings-toggle-description">{description}</span>}</span>
    <ToggleMark checked={checked} />
  </button>;
}
