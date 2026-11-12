import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { COSMETICS, GUILD_HALL_UPGRADES } from '@worldforge/game-core';
import { ART_TINTS, bannerStyleSprite, crestStyleSprite } from '../content/appearance';
import { howToEarn, sourceLabel } from '../cosmetics/text';
import {
  HALL_ART,
  HallBanner,
  HallCrest,
  HallStage,
  backdropClass,
  guildNameClass,
} from '../social/HallLook';
import { describeHallFailure } from '../social/guildHall';
import { boardLocation, parseRoute } from '../lib/route';

/** Ticket 8.4: the guild hall's looks, the guild honours' art, the words and the routes. */

const css = (rel: string) => readFileSync(join(import.meta.dirname, rel), 'utf8');

describe('guild hall looks', () => {
  it('every hall upgrade is drawn: banners and frames from existing art, the rest in CSS', () => {
    const hall = css('../social/hall-look.css');
    for (const u of GUILD_HALL_UPGRADES) {
      const name = u.id.slice(u.id.indexOf('.') + 1);
      if (u.kind === 'hallBanner' || u.kind === 'crestFrame') {
        expect(HALL_ART[u.id], u.id).toBeDefined();
      } else if (u.kind === 'backdrop') {
        expect(hall, u.id).toContain(`.gh-backdrop--${name}`);
        expect(backdropClass(u.id)).toBe(`gh-backdrop gh-backdrop--${name}`);
      } else {
        expect(hall, u.id).toContain(`.gh-name--${name}`);
        expect(guildNameClass(u.id)).toBe(`gh-name gh-name--${name}`);
      }
    }
    expect(guildNameClass('backdrop.hearth-glow')).toBe('');
    expect(backdropClass(null)).toContain('plain');
  });

  it('draws the stage with the hung look, and plain without one', () => {
    const look = {
      hallBanner: 'hall-banner.ember-hangings',
      crestFrame: 'crest-frame.gilt-wreath',
      backdrop: 'backdrop.hearth-glow',
      titleColour: 'guild-colour.forge-gold',
    };
    const html = renderToStaticMarkup(
      <HallStage look={look} emblem="anvil" name="The Ashen Wardens" tag="ASH" />,
    );
    expect(html).toContain('data-upgrade="hall-banner.ember-hangings"');
    expect(html).toContain('data-upgrade="crest-frame.gilt-wreath"');
    expect(html).toContain('gh-backdrop--hearth-glow');
    expect(html).toContain('gh-name--forge-gold');
    const plain = renderToStaticMarkup(
      <HallStage
        look={{ hallBanner: null, crestFrame: null, backdrop: null, titleColour: null }}
        emblem="anvil"
        name="Plain"
        tag="PLN"
      />,
    );
    expect(plain).not.toContain('data-upgrade');
    expect(plain).toContain('gh-backdrop--plain');
    // An unknown or wrong-kind id draws nothing rather than failing.
    expect(renderToStaticMarkup(<HallBanner id="crest-frame.iron-rim" />)).toBe('');
    expect(renderToStaticMarkup(<HallCrest frame="nope.x" emblem="anvil" />)).toContain('crest');
  });
});

describe('guild honours (cosmetics)', () => {
  it('draw the laurel banner and the gilt crest, tinted per tier, with words', () => {
    const cosm = css('../cosmetics/cosmetics.css');
    for (const c of COSMETICS.filter((x) => x.source.kind === 'guildSeason')) {
      const name = c.id.slice(c.id.indexOf('.') + 1);
      expect(ART_TINTS[c.id], c.id).toBeDefined();
      if (c.kind === 'banner') {
        expect(bannerStyleSprite(c.id), c.id).not.toBeNull();
        expect(cosm).toContain(`.cosm-banner--${name}`);
      } else {
        expect(crestStyleSprite(c.id), c.id).not.toBeNull();
        expect(cosm).toContain(`.cosm-crest--${name}`);
      }
      expect(howToEarn(c.source)).toMatch(/guild/i);
      expect(sourceLabel(c.source)).toBe('Guild');
    }
  });
});

describe('words and routes', () => {
  it('says each refusal in plain words', () => {
    for (const code of ['treasury_capped', 'treasury_short', 'guild_forbidden', 'test_account']) {
      const words = describeHallFailure({ status: 409, code, message: '' } as never);
      expect(words.length, code).toBeGreaterThan(15);
      expect(words).not.toContain('_');
    }
  });
  it('has the treasury route and the guild roll tab', () => {
    expect(parseRoute('#/treasury')).toBe('treasury');
    expect(boardLocation('#/boards/guilds?season=2')).toMatchObject({
      metric: 'guilds',
      season: 2,
    });
  });
});
