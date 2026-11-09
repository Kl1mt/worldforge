import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REDUCED_MOTION_QUERY, sceneMotionMode } from './motion';
import {
  BEAT_CLASS,
  DOWN_CLASS,
  applyBeat,
  startSceneDriver,
  type ActorElement,
  type DriverClock,
} from './sceneDriver';
import { SceneLoop, planFor, seededRandom } from './sceneLoop';

/** A fake element: a real class set, nothing else. */
function actor(): ActorElement & { classes: Set<string> } {
  const classes = new Set<string>();
  return {
    classes,
    offsetWidth: 0,
    classList: {
      add: (...c: string[]) => c.forEach((x) => classes.add(x)),
      remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
      contains: (c: string) => classes.has(c),
    },
  };
}

/** An injected clock with one-shot timers, advanced by hand. Counts live timers. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: DriverClock = {
    now: () => now,
    setTimer: (fn, ms) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimer: (h) => void timers.delete(h as number),
  };
  return {
    clock,
    timers,
    /** Moves time forward, firing due timers in order. */
    tick(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}

function setup(foes = 3, seed = 11) {
  const time = fakeClock();
  const hero = actor();
  const line = Array.from({ length: foes }, actor);
  const loop = new SceneLoop(planFor({ attackSpeed: 1, foes }), seededRandom(seed));
  const driver = startSceneDriver({ loop, clock: time.clock, actors: () => ({ hero, foes: line }) });
  return { time, hero, line, driver };
}

describe('scene driver (A.14)', () => {
  it('keeps at most one timer alive at any time', () => {
    const { time } = setup();
    for (let i = 0; i < 400; i++) {
      time.tick(97);
      expect(time.timers.size).toBeLessThanOrEqual(1);
    }
  });

  it('marks the hero striking and the foes hit, felled and risen as time passes', () => {
    const { time, hero, line } = setup();
    const seen = new Set<string>();
    for (let i = 0; i < 600; i++) {
      time.tick(50);
      for (const c of hero.classes) seen.add(`hero:${c}`);
      for (const foe of line) for (const c of foe.classes) seen.add(`foe:${c}`);
    }
    expect(seen).toContain(`hero:${BEAT_CLASS.heroStrike}`);
    expect(seen).toContain(`foe:${BEAT_CLASS.foeHit}`);
    expect(seen).toContain(`foe:${DOWN_CLASS}`);
    expect(seen).toContain(`foe:${BEAT_CLASS.foeRise}`);
  });

  it('stops scheduling while the tab is hidden and brings fallen foes back on return', () => {
    const { time, line, driver } = setup(1);
    // Run until the only foe is down, then hide the tab.
    for (let i = 0; i < 400 && !line[0]!.classes.has(DOWN_CLASS); i++) time.tick(50);
    expect(line[0]!.classes.has(DOWN_CLASS)).toBe(true);
    driver.pause();
    expect(time.timers.size).toBe(0);
    time.tick(60_000);
    expect(line[0]!.classes.has(DOWN_CLASS)).toBe(true); // nothing ran while hidden
    driver.resume();
    expect(line[0]!.classes.has(DOWN_CLASS)).toBe(false); // the respawn due meanwhile applied
    expect(time.timers.size).toBe(1);
  });

  it('cleans every class it set when stopped, and schedules nothing more', () => {
    const { time, hero, line, driver } = setup();
    time.tick(10_000);
    driver.stop();
    expect(time.timers.size).toBe(0);
    expect(hero.classes.size).toBe(0);
    for (const foe of line) expect(foe.classes.size).toBe(0);
    time.tick(10_000);
    expect(hero.classes.size).toBe(0);
  });

  it('copes with a missing element (a foe without art, an unmounted hero)', () => {
    expect(() =>
      applyBeat({ kind: 'foeHit', foe: 2, heavy: true }, { hero: null, foes: [actor()] }),
    ).not.toThrow();
    expect(() => applyBeat({ kind: 'heroStrike', foe: 0 }, { hero: null, foes: [] })).not.toThrow();
  });

  it('restarts a beat that is still marked, so the animation plays again', () => {
    const hero = actor();
    let flushes = 0;
    Object.defineProperty(hero, 'offsetWidth', { get: () => ++flushes });
    applyBeat({ kind: 'heroStrike', foe: 0 }, { hero, foes: [] });
    applyBeat({ kind: 'heroStrike', foe: 0 }, { hero, foes: [] });
    expect(hero.classes.has(BEAT_CLASS.heroStrike)).toBe(true);
    expect(flushes).toBe(1);
  });
});

describe('scene motion mode (A.14)', () => {
  it('is static for players who ask for reduced motion, whatever else is set', () => {
    for (const automated of [false, true]) {
      for (const override of [null, 'on', 'off']) {
        expect(sceneMotionMode({ reducedMotion: true, automated, override })).toBe('reduced');
      }
    }
    expect(REDUCED_MOTION_QUERY).toBe('(prefers-reduced-motion: reduce)');
  });

  it('is off under automation (e2e, screenshots) unless the local override turns it on', () => {
    expect(sceneMotionMode({ reducedMotion: false, automated: true, override: null })).toBe('off');
    expect(sceneMotionMode({ reducedMotion: false, automated: true, override: 'on' })).toBe('full');
    expect(sceneMotionMode({ reducedMotion: false, automated: false, override: null })).toBe(
      'full',
    );
    expect(sceneMotionMode({ reducedMotion: false, automated: false, override: 'off' })).toBe(
      'off',
    );
  });

  it('only animates under the .scene-anim root, which the scene sets for full motion only', () => {
    const css = readFileSync(new URL('./scene-anim.css', import.meta.url), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const animated = css
      .split('}')
      .filter((rule) => /\banimation:/.test(rule) && !/animation:\s*none/.test(rule))
      .map((rule) => rule.slice(0, rule.indexOf('{')).trim());
    expect(animated.length).toBeGreaterThan(5);
    for (const selector of animated) {
      if (/^(@keyframes|\d|from|to)/.test(selector)) continue;
      // Every selector of the rule (comma lists, or one inside a media block) is scoped.
      const last = selector.slice(selector.lastIndexOf('{') + 1);
      for (const part of last.split(',')) expect(part.trim(), selector).toMatch(/^\.scene-anim /);
    }
  });
});

describe('the scene animation sends nothing (A.14)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('makes no request while running for ten minutes of fake time', () => {
    const fetch = vi.fn();
    const beacon = vi.fn();
    const xhr = vi.fn();
    const ws = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('XMLHttpRequest', xhr);
    vi.stubGlobal('WebSocket', ws);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const { time, driver } = setup();
    driver.cue('kill');
    driver.cue('level');
    time.tick(600_000);
    driver.pause();
    driver.resume();
    driver.stop();
    for (const spy of [fetch, beacon, xhr, ws]) expect(spy).not.toHaveBeenCalled();
  });

  it('imports nothing that can reach the server', () => {
    const dir = new URL('./', import.meta.url);
    const sources = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'));
    expect(sources.length).toBeGreaterThanOrEqual(5);
    for (const file of sources) {
      const text = readFileSync(new URL(file, dir), 'utf8');
      expect(text, file).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
      expect(text, file).not.toMatch(/from '\.\.\/game\/(api|GameProvider)'/);
    }
  });
});
