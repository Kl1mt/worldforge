import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REDUCED_MOTION_QUERY, sceneMotionMode } from './motion';
import {
  BEAT_CLASS,
  DOWN_CLASS,
  HEAVY_CLASS,
  LAYER_CLASSES,
  LATE_BEAT_MS,
  applyBeat,
  startSceneDriver,
  type ActorElement,
  type ActorLayers,
  type DriverClock,
  type LayerName,
} from './sceneDriver';
import { SceneLoop, planFor, seededRandom, type SceneBeat } from './sceneLoop';

const LAYERS: LayerName[] = ['fade', 'act', 'hit'];

/** A fake element: a real class set, nothing else. */
/** Every class add on every fake element, in order (A.14c: the visible history of a run). */
let history: { el: object; cls: string }[] = [];

/** A fake element: a real class set, nothing else; its adds go to `history`. */
function element(): ActorElement & { classes: Set<string> } {
  const classes = new Set<string>();
  const el = {
    classes,
    offsetWidth: 0,
    classList: {
      add: (...c: string[]) =>
        c.forEach((x) => {
          classes.add(x);
          history.push({ el, cls: x });
        }),
      remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
      contains: (c: string) => classes.has(c),
    },
  };
  return el;
}

type FakeActor = { [K in LayerName]: ReturnType<typeof element> };

function actor(): FakeActor {
  return { fade: element(), act: element(), hit: element() };
}

const classesOf = (a: FakeActor) => LAYERS.flatMap((l) => [...a[l].classes]);

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
    /** Moves time forward, firing due timers in order (each on time). */
    tick(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        now = Math.max(now, next[1].at); // an overdue timer fires late, never in the past
        next[1].fn();
      }
      now = end;
    },
    /** Moves time forward WITHOUT firing timers (a busy or throttled tab), then fires. */
    stall(ms: number) {
      now += ms;
      this.tick(0);
    },
  };
}

function setup(foes = 3, seed = 11, onBeat?: (beats: SceneBeat[]) => void) {
  const time = fakeClock();
  const hero = actor();
  const line = Array.from({ length: foes }, actor);
  const loop = new SceneLoop(planFor({ attackSpeed: 1, foes }), seededRandom(seed));
  if (onBeat) {
    const advance = loop.advance.bind(loop);
    loop.advance = (now) => {
      const due = advance(now);
      onBeat(due.map((d) => d.beat));
      return due;
    };
  }
  const driver = startSceneDriver({
    loop,
    clock: time.clock,
    actors: () => ({ hero, foes: line }),
  });
  return { time, hero, line, driver };
}

/**
 * A.14b: a model of the browser's cascade over `scene-anim.css`. For a layer element (its role,
 * whether the actor is framed, its layer and its classes) the running animation is the one of the
 * LAST rule in the file whose selector matches, as in a browser. The A.14 desync was exactly
 * this: stale classes left on one element made an earlier beat's rule win over the newest one.
 */
interface CssRule {
  role: 'hero' | 'foe' | null;
  framed: boolean | null;
  layer: string;
  states: string[];
  animation: string;
}

function cssRules(): CssRule[] {
  const css = readFileSync(new URL('./scene-anim.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '')
    .replace(/@media[^{]*\{[\s\S]*\}\s*$/, '');
  const rules: CssRule[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const anim = /animation:\s*([a-z-]+)/.exec(m[2]!);
    if (!anim || anim[1] === 'none') continue;
    for (const raw of m[1]!.split(',')) {
      const sel = raw.trim();
      if (sel.endsWith('.pixel-sheet__strip')) continue; // the strip, not a layer
      const last = sel.split(/\s+/).at(-1)!;
      const layer = /scene-anim__(fade|act|hit)\b/.exec(last)?.[1];
      if (!layer) continue; // the breath on the root
      rules.push({
        role: /__actor--hero/.test(sel) ? 'hero' : /__actor--foe/.test(sel) ? 'foe' : null,
        framed: /:not\(\.scene-anim__actor--framed\)/.test(sel)
          ? false
          : /__actor--framed/.test(sel)
            ? true
            : null,
        layer,
        states: [...last.matchAll(/\.(scene-anim--[a-z]+)/g)].map((x) => x[1]!),
        animation: anim[1]!,
      });
    }
  }
  return rules;
}

const RULES = cssRules();

function running(
  role: 'hero' | 'foe',
  framed: boolean,
  layer: LayerName,
  classes: Set<string>,
): string | null {
  let found: string | null = null;
  for (const r of RULES) {
    if (r.layer !== layer) continue;
    if (r.role !== null && r.role !== role) continue;
    if (r.framed !== null && r.framed !== framed) continue;
    if (r.states.every((c) => classes.has(c))) found = r.animation;
  }
  return found;
}

/** The animation each beat must start on its layer. */
function expected(beat: SceneBeat, framed: boolean): { layer: LayerName; animation: string } {
  switch (beat.kind) {
    case 'heroStrike':
      return { layer: 'act', animation: framed ? 'scene-anim-lean' : 'scene-anim-lunge-right' };
    case 'foeStrike':
      return { layer: 'act', animation: framed ? 'scene-anim-lean-left' : 'scene-anim-lunge-left' };
    case 'foeHit':
      return { layer: 'hit', animation: 'scene-anim-hit' };
    case 'heroHit':
      return { layer: 'hit', animation: 'scene-anim-hurt' };
    case 'heroGlow':
      return { layer: 'hit', animation: 'scene-anim-glow' };
    case 'foeFall':
      return { layer: 'fade', animation: 'scene-anim-fall' };
    case 'foeRise':
      return { layer: 'fade', animation: 'scene-anim-rise' };
  }
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
      for (const c of classesOf(hero)) seen.add(`hero:${c}`);
      for (const foe of line) for (const c of classesOf(foe)) seen.add(`foe:${c}`);
    }
    expect(seen).toContain(`hero:${BEAT_CLASS.heroStrike.cls}`);
    expect(seen).toContain(`foe:${BEAT_CLASS.foeHit.cls}`);
    expect(seen).toContain(`foe:${DOWN_CLASS}`);
    expect(seen).toContain(`foe:${BEAT_CLASS.foeRise.cls}`);
    // A strike names its target, but it is the hero who moves.
    for (const foe of line) expect(foe.act.classes.has(BEAT_CLASS.heroStrike.cls)).toBe(false);
  });

  it('stops scheduling while the tab is hidden and brings fallen foes back on return', () => {
    const { time, line, driver } = setup(1);
    // Run until the only foe is down, then hide the tab.
    for (let i = 0; i < 400 && !line[0]!.fade.classes.has(DOWN_CLASS); i++) time.tick(50);
    expect(line[0]!.fade.classes.has(DOWN_CLASS)).toBe(true);
    driver.pause();
    expect(time.timers.size).toBe(0);
    time.tick(60_000);
    expect(line[0]!.fade.classes.has(DOWN_CLASS)).toBe(true); // nothing ran while hidden
    driver.resume();
    expect(line[0]!.fade.classes.has(DOWN_CLASS)).toBe(false); // the respawn due meanwhile applied
    expect(time.timers.size).toBe(1);
  });

  it('cleans every class it set when stopped, and schedules nothing more', () => {
    const { time, hero, line, driver } = setup();
    time.tick(10_000);
    driver.stop();
    expect(time.timers.size).toBe(0);
    expect(classesOf(hero)).toEqual([]);
    for (const foe of line) expect(classesOf(foe)).toEqual([]);
    time.tick(10_000);
    expect(classesOf(hero)).toEqual([]);
  });

  it('copes with a missing element (a foe without art, an unmounted hero)', () => {
    const partial: ActorLayers = { fade: null, act: element(), hit: null };
    expect(() =>
      applyBeat({ kind: 'foeHit', foe: 2, heavy: true }, { hero: null, foes: [partial] }),
    ).not.toThrow();
    expect(() =>
      applyBeat({ kind: 'foeFall', foe: 0 }, { hero: null, foes: [partial] }),
    ).not.toThrow();
    expect(() => applyBeat({ kind: 'heroStrike', foe: 0 }, { hero: null, foes: [] })).not.toThrow();
  });

  it('restarts a beat that is still marked, so the animation plays again', () => {
    const hero = actor();
    let flushes = 0;
    Object.defineProperty(hero.act, 'offsetWidth', { get: () => ++flushes });
    applyBeat({ kind: 'heroStrike', foe: 0 }, { hero, foes: [] });
    applyBeat({ kind: 'heroStrike', foe: 0 }, { hero, foes: [] });
    expect(hero.act.classes.has(BEAT_CLASS.heroStrike.cls)).toBe(true);
    expect(flushes).toBe(1);
  });
});

describe('scene sync over many respawns (A.14b)', () => {
  /**
   * Runs a loop for `ms` with an injected clock and checks, after EVERY beat, that the layer it
   * touched runs that beat's animation under the real stylesheet's cascade, and that no layer
   * carries two beat classes. Over many seeds and two minutes each (dozens of kills per seed), so
   * a foe's tenth life must animate exactly like its first.
   */
  function checkRun(seed: number, foes: number, framed: boolean, stall = false) {
    const lives = new Map<number, number>();
    const time = fakeClock();
    const hero = actor();
    const line = Array.from({ length: foes }, actor);
    const loop = new SceneLoop(planFor({ attackSpeed: 1.1, foes, framed }), seededRandom(seed));
    let checked = 0;
    const pending: SceneBeat[] = [];
    const advance = loop.advance.bind(loop);
    loop.advance = (now) => {
      const due = advance(now);
      pending.push(...due.map((d) => d.beat));
      return due;
    };
    startSceneDriver({ loop, clock: time.clock, actors: () => ({ hero, foes: line }) });

    let seen = history.length;
    /** After a tick: the newest beat on each actor's layer must run its own animation. */
    const verify = () => {
      const newest = new Map<string, SceneBeat>();
      for (const beat of pending.splice(0)) {
        const hero_ = beat.kind.startsWith('hero');
        const index = hero_ ? -1 : (beat as { foe: number }).foe;
        newest.set(`${index}:${expected(beat, framed).layer}`, beat);
        if (beat.kind === 'foeRise') {
          lives.set(beat.foe, (lives.get(beat.foe) ?? 1) + 1);
          // A fresh foe (when the rise played: A.14c drops it with a dropped fall): only the rise
          // is on it, nothing of the last life.
          const foe = line[beat.foe]!;
          const rose = history
            .slice(seen)
            .some((h) => h.el === foe.fade && h.cls === BEAT_CLASS.foeRise.cls);
          if (rose) expect([...foe.act.classes, ...foe.hit.classes], `seed ${seed}`).toEqual([]);
        }
      }
      for (const [key, beat] of newest) {
        const index = Number(key.split(':')[0]);
        const role = index < 0 ? 'hero' : 'foe';
        const want = expected(beat, framed);
        const el = (index < 0 ? hero : line[index]!)[want.layer];
        // A late one-shot beat may have been dropped; an applied beat must run its own animation.
        if (!el.classes.has(BEAT_CLASS[beat.kind].cls)) continue;
        expect(running(role, framed, want.layer, el.classes), `seed ${seed} ${beat.kind}`).toBe(
          want.animation,
        );
        checked++;
      }
      for (const a of [hero, ...line]) {
        for (const layer of LAYERS) {
          const own = LAYER_CLASSES[layer] as readonly string[];
          const beats = [...a[layer].classes].filter((c) => c !== HEAVY_CLASS);
          expect(beats.length, `seed ${seed}: ${layer} = ${beats.join(' ')}`).toBeLessThanOrEqual(
            1,
          );
          for (const c of a[layer].classes) expect(own).toContain(c);
        }
      }
      seen = history.length;
    };

    for (let t = 0; t < 120_000; t += 100) {
      if (stall && t % 5_000 === 0) time.stall(900);
      else time.tick(100);
      verify();
    }
    return { checked, lives };
  }

  it("plays each beat's own animation after any number of respawns", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { checked, lives } = checkRun(seed, 3, seed % 2 === 0);
      expect(checked).toBeGreaterThan(150);
      // Each foe died and came back several times in two minutes.
      for (let foe = 0; foe < 3; foe++)
        expect(lives.get(foe) ?? 1, `seed ${seed}`).toBeGreaterThan(3);
    }
  }, 60_000);

  it('keeps one foe in step through many lives (the crypt)', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { lives } = checkRun(seed, 1, true);
      expect(lives.get(0)).toBeGreaterThan(10);
    }
  }, 60_000);

  it('drops one-shot beats that come too late instead of stacking them in one tick', () => {
    for (let seed = 1; seed <= 20; seed++) checkRun(seed, 3, false, true);
    // And exactly: after a stall, the scene equals one where only the on-time beats and every
    // fall and rise were applied, in order.
    for (let seed = 1; seed <= 50; seed++) {
      const due: { at: number; beat: SceneBeat }[] = [];
      const time = fakeClock();
      const hero = actor();
      const line = Array.from({ length: 3 }, actor);
      const loop = new SceneLoop(planFor({ attackSpeed: 1, foes: 3 }), seededRandom(seed));
      const advance = loop.advance.bind(loop);
      loop.advance = (now) => {
        const out = advance(now);
        due.push(...out);
        return out;
      };
      startSceneDriver({ loop, clock: time.clock, actors: () => ({ hero, foes: line }) });
      time.stall(LATE_BEAT_MS * 20);
      const now = LATE_BEAT_MS * 20;
      const refHero = actor();
      const refLine = Array.from({ length: 3 }, actor);
      // The reference: on-time one-shot beats; a fall only after a visible hit in this life, a
      // rise only after a fall that played (A.14c).
      const hit = [false, false, false];
      const down = [false, false, false];
      for (const { at, beat } of due) {
        const actors = { hero: refHero, foes: refLine };
        if (beat.kind === 'foeFall') {
          if (down[beat.foe] || !hit[beat.foe]) continue;
          down[beat.foe] = true;
          applyBeat(beat, actors);
        } else if (beat.kind === 'foeRise') {
          if (!down[beat.foe]) continue;
          down[beat.foe] = false;
          hit[beat.foe] = false;
          applyBeat(beat, actors);
        } else if (now - at <= LATE_BEAT_MS) {
          if (beat.kind === 'foeHit') hit[beat.foe] = true;
          applyBeat(beat, actors);
        }
      }
      expect(due.length).toBeGreaterThan(3);
      expect(classesOf(hero)).toEqual(classesOf(refHero));
      line.forEach((foe, i) => expect(classesOf(foe)).toEqual(classesOf(refLine[i]!)));
    }
  });

  it('models the cascade: a stale rise beat the newest hit before A.14b, and cannot now', () => {
    // The old layout: one element per actor carried rise, lunge and hit at once and the later
    // rule won. Now each layer has its own rules, so a hit can only meet hit-layer rules.
    const hitRules = RULES.filter((r) => r.layer === 'hit').map((r) => r.animation);
    expect(hitRules).not.toContain('scene-anim-rise');
    expect(hitRules).not.toContain('scene-anim-lunge-left');
    const classes = new Set(['scene-anim--hit']);
    expect(running('foe', false, 'hit', classes)).toBe('scene-anim-hit');
  });
});

describe('no fade without a visible blow (A.14c)', () => {
  /**
   * The owner saw "an enemy just fades out, but there was no attack or took-damage animation
   * before". A main-thread hitch fired the hit (due 200 ms before the fall) more than 250 ms late,
   * so it was dropped while the fall still played. The rule now: a foe fades only after a blow
   * showed in its current life, and rises only after a fade that played.
   */
  function run(seed: number, foes: number, hitchEvery: number) {
    history = [];
    const time = fakeClock();
    const hero = actor();
    const line = Array.from({ length: foes }, actor);
    const loop = new SceneLoop(planFor({ attackSpeed: 1.2, foes }), seededRandom(seed));
    const driver = startSceneDriver({
      loop,
      clock: time.clock,
      actors: () => ({ hero, foes: line }),
    });
    const rnd = seededRandom(seed * 7919);
    for (let t = 0; t < 90_000; t += 100) {
      if (rnd() < hitchEvery)
        time.stall(200 + Math.floor(rnd() * 700)); // a 200–900 ms hitch
      else time.tick(100);
      // A hidden tab now and then.
      if (rnd() < 0.003) {
        driver.pause();
        time.tick(1_000 + Math.floor(rnd() * 8_000));
        driver.resume();
      }
    }
    // Walk each foe's visible history.
    let falls = 0;
    line.forEach((foe, i) => {
      let hitThisLife = false;
      let down = false;
      for (const { el, cls } of history) {
        if (el === foe.hit && cls === BEAT_CLASS.foeHit.cls) hitThisLife = true;
        if (el !== foe.fade) continue;
        if (cls === DOWN_CLASS) {
          expect(hitThisLife, `seed ${seed}: foe ${i} faded with no blow in this life`).toBe(true);
          expect(down, `seed ${seed}: foe ${i} faded twice`).toBe(false);
          down = true;
          falls++;
        }
        if (cls === BEAT_CLASS.foeRise.cls) {
          expect(down, `seed ${seed}: foe ${i} rose without having faded`).toBe(true);
          down = false;
          hitThisLife = false;
        }
      }
    });
    return falls;
  }

  it('holds over many seeds and lives, with hitches and hidden tabs', () => {
    let falls = 0;
    for (let seed = 1; seed <= 60; seed++) falls += run(seed, 3, 0.04);
    // Plenty of foes still fall: the rule drops only the fades that had no blow.
    expect(falls).toBeGreaterThan(60 * 8);
  }, 60_000);

  it('holds for a single foe (the crypt) with heavy hitches', () => {
    for (let seed = 1; seed <= 30; seed++) run(seed, 1, 0.15);
  }, 60_000);

  it('still fells foes on a smooth run (nothing dropped without a hitch)', () => {
    for (let seed = 1; seed <= 20; seed++) {
      history = [];
      const time = fakeClock();
      const line = Array.from({ length: 3 }, actor);
      const loop = new SceneLoop(planFor({ attackSpeed: 1, foes: 3 }), seededRandom(seed));
      const fallsDue: number[] = [];
      const advance = loop.advance.bind(loop);
      loop.advance = (now) => {
        const out = advance(now);
        for (const d of out) if (d.beat.kind === 'foeFall') fallsDue.push(d.at);
        return out;
      };
      startSceneDriver({ loop, clock: time.clock, actors: () => ({ hero: actor(), foes: line }) });
      time.tick(60_000);
      const played = history.filter((h) => h.cls === DOWN_CLASS).length;
      expect(played, `seed ${seed}`).toBe(fallsDue.length);
    }
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
      for (const part of last.split(',')) expect(part.trim(), selector).toMatch(/^\.scene-anim\s/);
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
