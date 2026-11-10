import type { CSSProperties, ReactNode, Ref } from 'react';
import './scene-anim.css';

/** Idle breath lengths for foes, so a line of them never moves in lockstep. */
const FOE_BOB_MS = [2300, 2700, 2500, 2900];

/**
 * Ticket A.14 / A.14b: wraps one sprite of a fight scene in its motion layers, one element per
 * concern so no two animations ever share an element:
 *
 *   .scene-anim__actor (root, `actorRef`) — the idle breath (CSS only, never touched by JS)
 *     .scene-anim__fade — defeat and respawn (opacity)
 *       .scene-anim__act — the actor's own attack (the hero's strike or frames, a foe's lunge)
 *         .scene-anim__hit — being struck (flash and knock-back), the level-up glow
 *           the sprite
 *
 * The scene driver finds the layers under the root and sets one beat class per layer. Every
 * className here is constant, so a React re-render never wipes a class the driver set. Motion
 * only plays under an ancestor with `.scene-anim`.
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
  /** The actor attacks with a frame sheet instead of a lunge. */
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
  const rootClass = `scene-anim__actor scene-anim__actor--${role}${framed ? ' scene-anim__actor--framed' : ''}`;
  return (
    <span className={rootClass} style={bob} ref={actorRef}>
      <span className="scene-anim__fade">
        <span className="scene-anim__act">
          <span className="scene-anim__hit">{children}</span>
        </span>
      </span>
    </span>
  );
}
