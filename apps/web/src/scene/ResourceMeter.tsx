import { RESOURCES, type ResourceId } from '@worldforge/game-core';
import { useState } from 'react';
import {
  changeSlice,
  clampResource,
  pipStates,
  RESOURCE_LOOK,
  resourceChange,
  resourceText,
  type ResourceChange,
} from './resourceMeter';
import './resource-meter.css';

/**
 * Ticket A.18: a class resource in the fight scene's HUD, drawn so a change can be seen: when it
 * fills, the slice just gained flares in the resource's light colour and the bar steps up to it;
 * when it is spent, the spent slice flashes and burns away in steps. Soul Fragments are pips that
 * light up or go out. Rage, Mana and Focus get ten notches.
 *
 * Driven by props only (ticket 9.2 passes the value from the fight's timeline): every change of
 * `current` plays once. `animate` is false for reduced motion and automation (`useSceneMotion()
 * === 'full'` is the usual value); the meter then just shows the value. No timers, no requests.
 */
export function ResourceMeter({
  resource,
  current,
  max,
  animate,
  className,
}: {
  resource: ResourceId;
  current: number;
  max: number;
  animate: boolean;
  className?: string;
}) {
  // The last value seen and the change into it (React's "state from props" pattern: the change is
  // derived during render, so it lands in the same paint as the new value).
  const [seen, setSeen] = useState<{ value: number; change: ResourceChange | null; n: number }>({
    value: current,
    change: null,
    n: 0,
  });
  if (seen.value !== current) {
    setSeen({ value: current, change: resourceChange(seen.value, current, max), n: seen.n + 1 });
  }
  const change = animate ? seen.change : null;
  const name = RESOURCES.find((r) => r.id === resource)?.name ?? resource;
  const value = clampResource(current, max);
  const look = RESOURCE_LOOK[resource];
  const text = resourceText(name, value, max);
  const classes = [
    'resource-meter',
    `resource-meter--${resource}`,
    animate ? 'resource-meter--anim' : '',
    value >= max ? 'resource-meter--full' : '',
    className,
  ];

  return (
    <div className={classes.filter(Boolean).join(' ')}>
      <div className="meter-field__text" aria-hidden="true">
        <span className="meter-field__name">{name}</span>
        <span className="meter-field__value">
          {Math.floor(value)} / {max}
        </span>
      </div>
      <div
        className={`resource-meter__track resource-meter__track--${look}`}
        role="meter"
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.floor(value)}
        aria-valuetext={text}
      >
        {look === 'pips' ? (
          pipStates(value, max, change).map((pip, i) => (
            <span
              // A pip that moves gets a fresh element, so its animation plays from the start.
              key={pip.moved ? `${i}-${seen.n}` : i}
              className={[
                'resource-meter__pip',
                pip.filled ? 'resource-meter__pip--on' : '',
                pip.moved ? `resource-meter__pip--${pip.moved}` : '',
              ]
                .filter(Boolean)
                .join(' ')}
            />
          ))
        ) : (
          <>
            <span
              className="resource-meter__fill"
              style={{ ['--value' as string]: `${Math.round((value / max) * 1000) / 10}%` }}
            />
            {change ? <Slice key={seen.n} change={change} max={max} /> : null}
          </>
        )}
      </div>
    </div>
  );
}

/** The slice that just moved: a flare over the gained part, or the spent part burning away. */
function Slice({ change, max }: { change: ResourceChange; max: number }) {
  const { left, width } = changeSlice(change, max);
  return (
    <span
      className={`resource-meter__slice resource-meter__slice--${change.kind}`}
      style={{ left: `${left}%`, width: `${width}%` }}
      aria-hidden="true"
    />
  );
}
