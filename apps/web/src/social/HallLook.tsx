import { useState, type ReactNode } from 'react';
import { findGuildHallUpgrade } from '@worldforge/game-core';
import { bannerStyleAsset, crestStyleAsset, CREST_STYLE_WINDOW } from '../content/assets';
import { Crest } from './Crest';
import type { HallLook } from './guildHall';
import './hall-look.css';

/**
 * Ticket 8.4: how a guild hall's cosmetic upgrades are drawn. No new art: hall banners and crest
 * frames reuse A.13's banner and crest sprites with code treatments (`gh-art--<name>` CSS filters);
 * backdrops and name colours are CSS only. Missing or failing art falls back to a plain cloth or a
 * plain rim in the upgrade's metal.
 */

/** Which existing sprite each hall upgrade draws (recoloured in hall-look.css). */
export const HALL_ART: Readonly<Record<string, string>> = {
  'hall-banner.iron-drapes': 'banner.crypt-seal',
  'hall-banner.ember-hangings': 'banner.ember-standard',
  'hall-banner.pale-silks': 'banner.forgeward',
  'crest-frame.iron-rim': 'crest.iron',
  'crest-frame.bone-ring': 'crest.bone',
  'crest-frame.gilt-wreath': 'crest.gilt',
};

const suffix = (id: string) => id.slice(id.indexOf('.') + 1);

/** The class that colours a guild's name, or ''. */
export function guildNameClass(id: string | null | undefined): string {
  if (!id || findGuildHallUpgrade(id)?.kind !== 'titleColour') return '';
  return `gh-name gh-name--${suffix(id)}`;
}

/** The class that tints a hall backdrop, or the plain one. */
export function backdropClass(id: string | null | undefined): string {
  if (!id || findGuildHallUpgrade(id)?.kind !== 'backdrop') return 'gh-backdrop gh-backdrop--plain';
  return `gh-backdrop gh-backdrop--${suffix(id)}`;
}

/** A hung hall banner (32×40 at `scale`); plain cloth without art. */
export function HallBanner({ id, scale = 2 }: { id: string | null; scale?: 1 | 2 | 3 }) {
  const u = id ? findGuildHallUpgrade(id) : undefined;
  const sprite = u?.kind === 'hallBanner' ? bannerStyleAsset(HALL_ART[u.id] ?? '') : null;
  const [failed, setFailed] = useState<string | null>(null);
  const show = sprite && failed !== sprite.path ? sprite : null;
  if (!u || u.kind !== 'hallBanner') return null;
  return (
    <span
      className={`gh-banner gh-art--${suffix(u.id)}${show ? '' : ' gh-banner--plain'}`}
      style={{ width: 32 * scale, height: 40 * scale }}
      role="img"
      aria-label={u.name}
      data-upgrade={u.id}
    >
      <span className="gh-banner__cloth" aria-hidden="true" />
      {show ? (
        <img
          className="gh-banner__device pixel"
          src={show.path}
          alt=""
          width={32 * scale}
          height={32 * scale}
          draggable={false}
          onError={() => setFailed(show.path)}
        />
      ) : null}
    </span>
  );
}

/** The guild's emblem in its crest frame (48×56 at `scale`); the bare shield without a frame. */
export function HallCrest({
  frame,
  emblem,
  scale = 2,
}: {
  frame: string | null;
  emblem: string;
  scale?: 1 | 2 | 3;
}): ReactNode {
  const u = frame ? findGuildHallUpgrade(frame) : undefined;
  const sprite = u?.kind === 'crestFrame' ? crestStyleAsset(HALL_ART[u.id] ?? '') : null;
  const [failed, setFailed] = useState<string | null>(null);
  if (!u || u.kind !== 'crestFrame') return <Crest emblem={emblem} size="lg" />;
  const show = sprite && failed !== sprite.path ? sprite : null;
  const w = CREST_STYLE_WINDOW;
  return (
    <span
      className={`gh-crest gh-art--${suffix(u.id)}${show ? '' : ' gh-crest--plain'}`}
      style={{ width: 48 * scale, height: 56 * scale }}
      role="img"
      aria-label={`${u.name} around the guild's crest`}
      data-upgrade={u.id}
    >
      <span
        className="gh-crest__well"
        style={{
          left: w.x * scale,
          top: w.y * scale,
          width: w.width * scale,
          height: w.height * scale,
        }}
      >
        <Crest emblem={emblem} size="md" />
      </span>
      {show ? (
        <img
          className="gh-crest__frame pixel"
          src={show.path}
          alt=""
          width={show.width * scale}
          height={show.height * scale}
          draggable={false}
          onError={() => setFailed(show.path)}
        />
      ) : null}
    </span>
  );
}

/** The hall as a little stage: backdrop, banners either side, the framed crest, the name. */
export function HallStage({
  look,
  emblem,
  name,
  tag,
  children,
}: {
  look: HallLook;
  emblem: string;
  name: string;
  tag: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`gh-stage ${backdropClass(look.backdrop)}`}
      data-backdrop={look.backdrop ?? 'plain'}
    >
      <div className="gh-stage__wall">
        <HallBanner id={look.hallBanner} />
        <HallCrest frame={look.crestFrame} emblem={emblem} />
        <HallBanner id={look.hallBanner} />
      </div>
      <p className="gh-stage__name display">
        <span className={guildNameClass(look.titleColour)}>{name}</span>{' '}
        <span className="gh-stage__tag">[{tag}]</span>
      </p>
      {children}
    </div>
  );
}
