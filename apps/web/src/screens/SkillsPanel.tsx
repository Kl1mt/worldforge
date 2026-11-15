import { useCallback, useEffect, useRef, useState } from 'react';
import { LOADOUT_PRESETS } from '@worldforge/game-core';
import { skillIcon } from '../content/assets';
import { PixelSprite } from '../components/PixelSprite';
import type { Load } from '../game/GameProvider';
import {
  CLASS_SKILL_NOTE,
  PASSIVE_SLOT,
  SLOT_LABELS,
  classSkills,
  defaultDraft,
  describeProblem,
  describeResource,
  describeSkillsFailure,
  fitsSlot,
  inSlot,
  isActive,
  isUnlocked,
  loadoutProblems,
  nextDrafts,
  placeSkill,
  presetName,
  resourceName,
  sameDraft,
  skillById,
  skillFacts,
  skillsApi,
  toDraft,
  unlockText,
  type LoadoutDraft,
  type SkillDefinition,
  type SkillsResponse,
  type SlotIndex,
} from '../game/skills';
import './skills.css';

type Notice = { kind: 'ok' | 'error'; text: string };
const SLOTS: SlotIndex[] = [0, 1, 2, PASSIVE_SLOT];

/**
 * A skill's icon: its A.18 art (`skillIcon`), else a framed glyph (the
 * name's initial, edged by kind) so the screen never shows a broken image.
 */
export function SkillGlyph({
  skill,
  scale = 1,
}: {
  skill: SkillDefinition | null;
  scale?: number;
}) {
  const sprite = skill ? skillIcon(skill.id) : null;
  if (skill && sprite) {
    return <PixelSprite sprite={sprite} scale={scale} alt="" className="skill-glyph__art" />;
  }
  const kind = !skill ? 'empty' : isActive(skill) ? skill.kind : 'passive';
  return (
    <span
      className={`skill-glyph skill-glyph--${kind}`}
      style={{ width: 32 * scale, height: 32 * scale }}
      aria-hidden="true"
    >
      {skill ? skill.name.charAt(0) : ''}
    </span>
  );
}

/** Where the book's button puts a skill: its own slot, or the chosen / first free spender slot. */
function targetSlot(skill: SkillDefinition, draft: LoadoutDraft, chosen: SlotIndex): SlotIndex {
  if (!isActive(skill)) return PASSIVE_SLOT;
  if (skill.kind === 'core') return 0;
  if (chosen === 1 || chosen === 2) return chosen;
  return draft.actives[1] === null ? 1 : draft.actives[2] === null ? 2 : 1;
}

function slotOf(draft: LoadoutDraft, id: string): SlotIndex | null {
  const i = draft.actives.indexOf(id);
  if (i >= 0) return i as SlotIndex;
  return draft.passive === id ? PASSIVE_SLOT : null;
}

const slotShort = (slot: SlotIndex) =>
  slot === PASSIVE_SLOT ? 'the passive slot' : `slot ${slot + 1}`;

/**
 * Ticket 9.2 (docs/SKILLS.md): the hero's skills and three loadout presets, on the character page.
 * Three actives and a passive per preset; one preset is in force. The checks here are only
 * feedback: the server validates every save against the hero's level and deeds.
 */
export function SkillsPanel({
  characterId,
  level,
  initial,
}: {
  characterId: string;
  /** The hero's level: a level-up re-reads the unlocks. */
  level: number;
  /** A first answer to show without a fetch (tests). */
  initial?: SkillsResponse;
}) {
  const [state, setState] = useState<Load<SkillsResponse>>(
    initial ? { kind: 'ready', value: initial } : { kind: 'loading' },
  );
  const [drafts, setDrafts] = useState<Record<number, LoadoutDraft>>(() =>
    initial ? nextDrafts({}, null, initial) : {},
  );
  const [editing, setEditing] = useState<number>(initial?.activePreset ?? 1);
  const [chosen, setChosen] = useState<SlotIndex>(1);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<'save' | 'switch' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const shown = useRef<SkillsResponse | null>(initial ?? null);

  /** Takes the server's answer; drafts with unsaved edits survive it (`nextDrafts`). */
  const accept = useCallback((next: SkillsResponse, saved?: number) => {
    const before = shown.current;
    shown.current = next;
    setDrafts((d) => nextDrafts(d, before, next, saved));
    if (!before) setEditing(next.activePreset);
    setState({ kind: 'ready', value: next });
  }, []);

  useEffect(() => {
    if (initial && attempt === 0 && level === initial.level) return;
    const controller = new AbortController();
    skillsApi.get(characterId, { signal: controller.signal }).then(
      (res) => {
        if (res.ok) accept(res.value);
        else
          setState((prev) =>
            // A failed refresh keeps the shown loadouts; only a first load shows the error.
            prev.kind === 'ready'
              ? prev
              : { kind: 'error', message: describeSkillsFailure(res.error) },
          );
      },
      () => {
        /* aborted */
      },
    );
    return () => controller.abort();
  }, [characterId, level, attempt, accept, initial]);

  if (state.kind === 'loading') {
    return (
      <section className="skills panel-iron" aria-labelledby="skills-title">
        <h2 id="skills-title" className="rule-heading">
          Skills
        </h2>
        <p className="skills__state" role="status">
          Opening the skill book…
        </p>
      </section>
    );
  }
  if (state.kind === 'error') {
    return (
      <section className="skills panel-iron" aria-labelledby="skills-title">
        <h2 id="skills-title" className="rule-heading">
          Skills
        </h2>
        <div className="skills__state" role="alert">
          <p>The skill book will not open. {state.message}</p>
          <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      </section>
    );
  }

  const view = state.value;
  const book = classSkills(view.classId);
  const preset = view.presets.find((p) => p.preset === editing) ?? view.presets[0]!;
  const saved = toDraft(preset);
  const draft = drafts[preset.preset] ?? saved;
  const dirty = !sameDraft(draft, saved);
  const problems = loadoutProblems(view, draft);
  const inForce = preset.preset === view.activePreset;
  const res = resourceName(view.classId);
  const isDefault = sameDraft(draft, defaultDraft(view.classId));

  const edit = (next: LoadoutDraft) => {
    setNotice(null);
    setDrafts((d) => ({ ...d, [preset.preset]: next }));
  };

  const save = async () => {
    setBusy('save');
    setNotice(null);
    const r = await skillsApi.savePreset(characterId, preset.preset, draft);
    setBusy(null);
    if (r.ok) {
      accept(r.value, preset.preset);
      setNotice({
        kind: 'ok',
        text: inForce
          ? `${presetName(preset.preset)} saved. Your hero fights with it from the next fight on.`
          : `${presetName(preset.preset)} saved. Choose “Fight with it” to put it in force.`,
      });
    } else setNotice({ kind: 'error', text: describeSkillsFailure(r.error) });
  };

  const switchTo = async () => {
    setBusy('switch');
    setNotice(null);
    const r = await skillsApi.switchPreset(characterId, preset.preset);
    setBusy(null);
    if (r.ok) {
      accept(r.value);
      setNotice({
        kind: 'ok',
        text: `Your hero now fights with ${presetName(preset.preset)}.`,
      });
    } else setNotice({ kind: 'error', text: describeSkillsFailure(r.error) });
  };

  const entry = (skill: SkillDefinition) => {
    const open = isUnlocked(view, skill.id);
    const at = slotOf(draft, skill.id);
    const target = targetSlot(skill, draft, chosen);
    const highlighted = fitsSlot(skill, chosen);
    return (
      <li
        key={skill.id}
        className={[
          'skill',
          open ? '' : 'skill--locked',
          at !== null ? 'skill--chosen' : '',
          highlighted && open ? 'skill--fits' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <SkillGlyph skill={skill} />
        <div className="skill__text">
          <p className="skill__name">
            <span className="display">{skill.name}</span>
            {at !== null ? (
              <span className="skill__tag">
                {at === PASSIVE_SLOT ? 'Passive in use' : `In slot ${at + 1}`}
              </span>
            ) : null}
          </p>
          <p className="skill__facts">{skillFacts(skill)}</p>
          <p className="skill__desc">{skill.description}</p>
          <p className={`skill__unlock${open ? '' : ' skill__unlock--locked'}`}>
            {open
              ? skill.unlock.deed
                ? `${unlockText(skill)} · learned`
                : `Level ${skill.unlock.level}`
              : unlockText(skill)}
          </p>
        </div>
        <div className="skill__act">
          {!open ? (
            <span className="skill__lock" aria-label="Locked">
              Locked
            </span>
          ) : at === target ? null : (
            <button
              type="button"
              className="btn btn--small"
              disabled={busy !== null}
              onClick={() => edit(placeSkill(draft, target, skill.id))}
            >
              {target === PASSIVE_SLOT ? 'Take as passive' : `Set in slot ${target + 1}`}
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <section className="skills panel-iron" aria-labelledby="skills-title">
      <h2 id="skills-title" className="rule-heading">
        Skills
      </h2>

      <div className={`skills__resource skills__resource--${view.classId}`}>
        <span className="skills__res-mark" aria-hidden="true" />
        <p>
          <span className="caps">{res}</span> {describeResource(view.classId)}
          {view.classId === 'warlock' && view.soulFragments > 0
            ? ` ${view.soulFragments} carried from the last kill.`
            : ''}
        </p>
      </div>

      <div className="skills__presets" role="tablist" aria-label="Loadout presets">
        {Array.from({ length: LOADOUT_PRESETS }, (_, i) => i + 1).map((n) => {
          const p = view.presets.find((x) => x.preset === n);
          const d = drafts[n];
          const changed = p && d ? !sameDraft(d, toDraft(p)) : false;
          return (
            <button
              key={n}
              type="button"
              role="tab"
              id={`skills-tab-${n}`}
              aria-selected={n === preset.preset}
              aria-controls="skills-editor"
              className={`skills__tab${n === view.activePreset ? ' skills__tab--force' : ''}`}
              onClick={() => {
                setEditing(n);
                setNotice(null);
              }}
            >
              <span className="display">{presetName(n)}</span>
              <span className="skills__tab-note">
                {n === view.activePreset ? 'In force' : p?.isDefault ? 'Default' : 'Saved'}
                {changed ? ' · unsaved' : ''}
                {p && p.problems.length > 0 ? ' · cannot be fielded' : ''}
              </span>
            </button>
          );
        })}
      </div>

      <div
        id="skills-editor"
        className="skills__editor"
        role="tabpanel"
        aria-labelledby={`skills-tab-${preset.preset}`}
      >
        {preset.problems.length > 0 ? (
          <p className="skills__warn" role="note">
            As saved, this loadout cannot be fielded (
            {preset.problems.map(describeProblem).join('; ')}
            ), so it fights as the default loadout until you change it.
          </p>
        ) : null}

        <ol className="skills__sockets" aria-label={`${presetName(preset.preset)} slots`}>
          {SLOTS.map((slot) => {
            const skill = skillById(inSlot(draft, slot)) ?? null;
            return (
              <li
                key={slot}
                className={`socket${slot === PASSIVE_SLOT ? ' socket--passive' : ''}${skill ? '' : ' socket--empty'}`}
              >
                <button
                  type="button"
                  className="socket__pick"
                  aria-pressed={chosen === slot}
                  onClick={() => setChosen(slot)}
                >
                  <SkillGlyph skill={skill} scale={2} />
                  <span className="socket__label caps">{SLOT_LABELS[slot]}</span>
                  <span className="socket__name">{skill ? skill.name : 'Empty'}</span>
                </button>
                {skill && slot !== 0 ? (
                  <button
                    type="button"
                    className="socket__clear"
                    aria-label={`Empty ${slotShort(slot)}`}
                    disabled={busy !== null}
                    onClick={() => edit(placeSkill(draft, slot, null))}
                  >
                    ×
                  </button>
                ) : null}
              </li>
            );
          })}
        </ol>

        <div className="skills__book">
          <section className="skills__group" aria-labelledby="skills-core">
            <h3 id="skills-core" className="caps">
              Class skills · slot 1
            </h3>
            <p className="skills__hint">Lands on its own every few attacks. {CLASS_SKILL_NOTE}</p>
            <ul>{book.core.map(entry)}</ul>
          </section>
          <section className="skills__group" aria-labelledby="skills-spenders">
            <h3 id="skills-spenders" className="caps">
              Spenders · slots 2 and 3
            </h3>
            <p className="skills__hint">
              Spend {res} in place of a basic attack when they are ready. Both slots may stay empty.
            </p>
            <ul>{book.spenders.map(entry)}</ul>
          </section>
          <section className="skills__group" aria-labelledby="skills-passives">
            <h3 id="skills-passives" className="caps">
              Passives · one or none
            </h3>
            <p className="skills__hint">Always on, in every fight.</p>
            <ul>{book.passives.map(entry)}</ul>
          </section>
        </div>

        <div className="skills__actions">
          {problems.length > 0 ? (
            <p className="skills__problems" role="alert">
              This loadout cannot be saved: {problems.join('; ')}.
            </p>
          ) : null}
          {notice ? (
            <p
              className={`skills__notice skills__notice--${notice.kind}`}
              role={notice.kind === 'error' ? 'alert' : 'status'}
            >
              {notice.text}
            </p>
          ) : null}
          <div className="skills__buttons">
            <button
              type="button"
              className="btn btn--brass"
              disabled={busy !== null || !dirty || problems.length > 0}
              aria-busy={busy === 'save'}
              onClick={() => void save()}
            >
              {busy === 'save' ? 'Saving…' : `Save ${presetName(preset.preset)}`}
            </button>
            {inForce ? (
              <span className="skills__force">Your hero fights with this loadout.</span>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={busy !== null || dirty}
                aria-busy={busy === 'switch'}
                title={dirty ? 'Save your changes first.' : undefined}
                onClick={() => void switchTo()}
              >
                {busy === 'switch' ? 'Switching…' : 'Fight with it'}
              </button>
            )}
            {dirty ? (
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                onClick={() => edit(saved)}
              >
                Undo changes
              </button>
            ) : null}
            {!isDefault ? (
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                onClick={() => edit(defaultDraft(view.classId))}
              >
                Back to the default
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <p className="skills__fine">
        Saving or switching the loadout in force first settles your hero’s progress with the old
        one, so no fight mixes two loadouts. A crypt run and a guild boss attempt keep the loadout
        they were started with, and your duel defence keeps the one it was set with: refresh your
        defence in the Arena to duel with a new loadout.
      </p>
    </section>
  );
}
