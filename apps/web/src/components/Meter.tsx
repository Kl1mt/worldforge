interface MeterProps {
  current: number;
  max: number;
  label: string;
  variant?: 'health' | 'rage' | 'xp';
  className?: string;
}

export function Meter({ current, max, label, variant = 'health', className }: MeterProps) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (current / max) * 100)) : 0;
  const classes = ['meter', variant !== 'health' ? `meter--${variant}` : '', className];
  return (
    <div
      className={classes.filter(Boolean).join(' ')}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={current}
    >
      <span style={{ ['--value' as string]: `${pct}%` }} />
    </div>
  );
}
