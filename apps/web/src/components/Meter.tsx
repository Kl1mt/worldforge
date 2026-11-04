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

interface LabeledMeterProps extends MeterProps {
  /** Visible value, e.g. "842 / 1,046". */
  value: string;
}

/** A meter with its name and value written above the bar, e.g. "Health 842 / 1,046". */
export function LabeledMeter({ value, className, ...meter }: LabeledMeterProps) {
  return (
    <div className={['meter-field', className].filter(Boolean).join(' ')}>
      <div className="meter-field__text" aria-hidden="true">
        <span className="meter-field__name">{meter.label}</span>
        <span className="meter-field__value">{value}</span>
      </div>
      <Meter {...meter} />
    </div>
  );
}
