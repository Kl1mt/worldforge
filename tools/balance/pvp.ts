// Ticket 5.4: PvP measurements behind docs/PVP.md. Dev script; guards in balance/pvp-balance.test.ts.
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/pvp.ts report   # or: tune
//   report: class pairs and means, gear steps, the ladder against a typical opponent, the fresh
//           hero, and duel lengths, per bracket
//   tune:   re-fits the per-bracket class damage factors (prints the new `classDamage`)
import {
  DEFAULT_PVP_CONFIG,
  PVP_BRACKETS,
  simulateDuel,
  type ClassId,
} from '../../packages/game-core/src/index.ts';
import {
  CLASS_IDS,
  GEAR_TIERS,
  fighter,
  fresh,
  gear,
  matchupShare,
  sampleBuild,
  shareVsTypical,
  typical,
  winShare,
} from '../../packages/game-core/src/balance/pvp-fixtures.ts';

const pct = (v: number) => (v * 100).toFixed(0);
const mode = process.argv[2] ?? 'report';

if (mode === 'tune') {
  const all: Record<string, Record<ClassId, number>> = JSON.parse(
    JSON.stringify(DEFAULT_PVP_CONFIG.classDamage),
  );
  for (const b of PVP_BRACKETS) {
    const t = all[b.id]!;
    for (let i = 0; i < 5; i++) {
      const cfg = { ...DEFAULT_PVP_CONFIG, classDamage: all };
      const mean: Record<string, number> = Object.fromEntries(CLASS_IDS.map((c) => [c, 0]));
      for (const a of CLASS_IDS)
        for (const d of CLASS_IDS)
          if (a < d) {
            const s = matchupShare(b, a, d, 6, 12, cfg);
            mean[a]! += s / 3;
            mean[d]! += (1 - s) / 3;
          }
      console.log(b.id, i, CLASS_IDS.map((c) => `${c} ${pct(mean[c]!)} (× ${t[c]})`).join(', '));
      for (const c of CLASS_IDS) t[c] = +(t[c] * Math.pow(0.5 / mean[c]!, 0.2)).toFixed(3);
    }
  }
  console.log(JSON.stringify(all));
} else {
  for (const b of PVP_BRACKETS) {
    const L = b.referenceLevel;
    const m: Record<string, number> = {};
    const mean: Record<string, number> = {};
    for (const c of CLASS_IDS) mean[c] = 0;
    for (const a of CLASS_IDS)
      for (const d of CLASS_IDS)
        if (a < d) {
          const s = matchupShare(b, a, d, 6, 12);
          m[`${a}-${d}`] = s;
          mean[a] += s / 3;
          mean[d] += (1 - s) / 3;
        }
    const worst = Object.entries(m).sort((x, y) => Math.abs(y[1] - 0.5) - Math.abs(x[1] - 0.5))[0]!;
    console.log(
      `== ${b.id}: pairs ${Object.entries(m)
        .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}`)
        .join(
          ', ',
        )}; means ${CLASS_IDS.map((c) => `${c} ${(mean[c]! * 100).toFixed(0)}`).join(', ')}; worst ${worst[0]} ${(worst[1] * 100).toFixed(0)}`,
    );
    const steps: string[] = [];
    for (let i = 1; i < GEAR_TIERS.length; i++) {
      let sh = 0;
      for (const c of CLASS_IDS)
        for (let s = 0; s < 3; s++)
          sh += winShare(
            fighter(c, L, gear(c, L, GEAR_TIERS[i]!, s)),
            fighter(c, L, gear(c, L, GEAR_TIERS[i - 1]!, s + 7)),
            24,
            `pvp-step:${b.id}:${c}:${i}:${s}`,
          ).share;
      steps.push(`${GEAR_TIERS[i]} ${((sh / 12) * 100).toFixed(0)}`);
    }
    console.log('  steps', steps.join(', '));
    const lad: string[] = [];
    for (const c of CLASS_IDS) {
      lad.push(
        c +
          ' ' +
          GEAR_TIERS.map((t) => {
            let sh = 0;
            for (let s = 0; s < 2; s++)
              sh += shareVsTypical(
                fighter(c, L, gear(c, L, t, s)),
                b,
                2,
                12,
                `lad:${b.id}:${c}:${t}:${s}`,
              );
            return ((sh / 2) * 100).toFixed(0);
          }).join('/'),
      );
    }
    console.log('  ladder vs typical', lad.join('; '));
    const fr = CLASS_IDS.map((c) => {
      let sh = 0;
      for (let s = 0; s < 3; s++)
        sh += shareVsTypical(fresh(c, b, s), b, 3, 16, `fresh:${b.id}:${c}:${s}`);
      return sh / 3;
    });
    console.log(
      '  fresh',
      CLASS_IDS.map((c, i) => `${c} ${(fr[i]! * 100).toFixed(0)}`).join(', '),
      'mean',
      ((fr.reduce((x, y) => x + y) / 4) * 100).toFixed(0),
    );
    let tl = 0,
      n = 0;
    const ds: number[] = [];
    for (const a of CLASS_IDS)
      for (const d of CLASS_IDS)
        for (let s = 0; s < 25; s++) {
          const r = simulateDuel({
            challenger: fighter(a, L, sampleBuild(a, L - 1, s)),
            defender: typical(d, b, s),
            seed: `dur:${a}:${d}:${s}`,
          });
          n++;
          if (r.reason === 'timeLimit') tl++;
          ds.push(r.durationMs);
          const r2 = simulateDuel({
            challenger: typical(a, b, s),
            defender: typical(d, b, s + 1),
            seed: `dur2:${a}:${d}:${s}`,
          });
          n++;
          if (r2.reason === 'timeLimit') tl++;
          ds.push(r2.durationMs);
        }
    ds.sort((x, y) => x - y);
    console.log(
      '  duration median',
      ds[ds.length >> 1],
      'p95',
      ds[Math.floor(ds.length * 0.95)],
      'max',
      ds.at(-1),
      'timeLimit',
      tl,
      '/',
      n,
    );
  }
}
