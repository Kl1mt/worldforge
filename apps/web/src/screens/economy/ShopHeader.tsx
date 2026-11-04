import type { ReactNode } from 'react';
import { asset } from '../../content/assets';
import { HUB_HOTSPOTS, type BuildingId } from '../../content/world';
import { useMediaQuery } from '../../components/useMediaQuery';
import { PHONE_QUERY } from '../../lib/pixel';
import { formatNumber } from '../../lib/format';

const HUB = asset('hub.graumark');

/**
 * Header of a working hub building (ticket 2.6): the building cut from the town picture in its
 * niche (as on the placeholder screens), the name and a line of flavour. The purse is in the top bar.
 */
export function ShopHeader({
  building,
  title,
  children,
}: {
  building: BuildingId;
  title: string;
  children: ReactNode;
}) {
  const phone = useMediaQuery(PHONE_QUERY);
  const spot = HUB_HOTSPOTS.find((h) => h.id === building)!;
  const scale = phone ? 2 : 3;
  return (
    <header className="shop__head">
      <figure className="building__niche shop__niche">
        <span
          className="building__art"
          role="img"
          aria-label={`${title}, seen from the street`}
          style={{
            width: spot.width * scale,
            height: spot.height * scale,
            backgroundImage: `url(${HUB.path})`,
            backgroundSize: `${HUB.width * scale}px ${HUB.height * scale}px`,
            backgroundPosition: `${-spot.x * scale}px ${-spot.y * scale}px`,
          }}
        />
        <figcaption className="building__plaque">{spot.label}</figcaption>
      </figure>
      <div className="shop__intro">
        <p className="caps shop__eyebrow">Graumark</p>
        <h1 className="display shop__title">{title}</h1>
        <p className="shop__text">{children}</p>
      </div>
    </header>
  );
}

/** A gold amount with a coin, e.g. on a price tag. */
export function Gold({ amount, sign = '' }: { amount: number; sign?: string }) {
  return (
    <span className="gold" aria-label={`${sign}${formatNumber(amount)} gold`}>
      <span className="coin" aria-hidden="true" />
      <span aria-hidden="true">
        {sign}
        {formatNumber(amount)}
      </span>
    </span>
  );
}

export type Notice = { kind: 'ok' | 'error'; text: string };

export function NoticeLine({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <p
      className={`shop__notice shop__notice--${notice.kind}`}
      role={notice.kind === 'error' ? 'alert' : 'status'}
    >
      {notice.text}
    </p>
  );
}
