interface SegmentedProps<T extends string | number> {
  value: T;
  options: { label: string; value: T }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}

export function Segmented<T extends string | number>({ value, options, onChange, disabled }: SegmentedProps<T>) {
  return (
    <div className="viz-segmented">
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          type="button"
          data-active={opt.value === value}
          disabled={disabled}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  active,
  label,
  onClick,
  disabled,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" className="viz-toggle" data-active={active} onClick={onClick} disabled={disabled}>
      {label}
    </button>
  );
}
