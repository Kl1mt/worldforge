import type { CSSProperties, ReactNode, Ref } from 'react';
import './scene-anim.css';

/** Idle breath lengths for foes, so a line of them never moves in lockstep. */
const FOE_BOB_MS = [2300, 2700, 2500, 2900];

/**
 * Ticket A.14: wraps one sprite of a fight scene in the two motion layers: the idle breath
 * (`scene-anim__bob`, CSS only) and the beat layer (`scene-anim__actor`, classes set by the scene
 * driver through `actorRef`). Both classNames are constant, so a React re-render never wipes a
 * class the driver set. Motion only plays under an ancestor with `.scene-anim`.
 */
export function SceneActor({
  role,
  index = 0,
  framed = false,
  actorRef,
  children,
}: {
  role: 'hero' | 'foe';
  /** A foe's place in the line: picks its breath length and offset. */
  index?: number;
  /** The hero swings with a frame sheet instead of a lunge. */
  framed?: boolean;
  actorRef?: Ref<HTMLSpanElement>;
  children: ReactNode;
}) {
  const bob: CSSProperties =
    role === 'hero'
      ? { ['--bob-ms' as string]: '2400ms' }
      : {
          ['--bob-ms' as string]: `${FOE_BOB_MS[index % FOE_BOB_MS.length]}ms`,
          ['--bob-delay' as string]: `${-(index * 700 + 350)}ms`,
        };
  const actorClass = `scene-anim__actor scene-anim__actor--${role}${framed ? ' scene-anim__actor--framed' : ''}`;
  return (
    <span className="scene-anim__bob" style={bob}>
      <span className={actorClass} ref={actorRef}>
        {children}
      </span>
    </span>
  );
}
