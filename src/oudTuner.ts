// Accordeur du oud : écoute la corde au micro, indique s'il faut tendre ou détendre.

import { h } from './ui';
import { micInput, micBanner, refHz, setRefHz } from './mic';
import { pitchToHz } from './pitch';
import { TUNINGS, CUSTOM, currentStrings, customStrings, oudName, playOud, setTuning, tuningId } from './oud';

const IN_TUNE = 5; // cents
const CONFIRM_FRAMES = 10; // une demi-seconde de justesse pour valider une corde
const MEMORY_MS = 1500; // l'affichage reste un instant quand le son s'éteint

const fmtHz = (hz: number) => hz.toFixed(1).replace('.', ',');

export interface TunerHandle { el: HTMLElement; mount(): void; destroy(): void }

export function createTuner(onChange?: () => void): TunerHandle {
  let strings = currentStrings();
  let locked: number | null = null;
  let tuned = new Set<number>();
  let recent: number[] = [];
  let lastHeard = 0;
  let good = 0;
  let unsub: (() => void)[] = [];

  const nameEl = h('div', { class: 'tn-name' }, '—');
  const hzEl = h('div', { class: 'tn-hz' }, 'Pincez une corde');
  const needle = h('div', { class: 'tn-needle' });
  const centsEl = h('div', { class: 'tn-cents' });
  const msgEl = h('div', { class: 'tn-msg' });
  const scale = h('div', { class: 'tn-scale' }, [
    h('span', { class: 'tn-zone' }),
    ...[-50, -25, 0, 25, 50].map(c => h('span', { class: 'tn-tick', style: `left:${50 + c}%` }, [h('i', {}), h('b', {}, c > 0 ? `+${c}` : String(c))])),
    needle
  ]);
  const stringsEl = h('div', { class: 'tn-strings' });
  const modeEl = h('p', { class: 'meta tn-mode' });
  const noteEl = h('p', { class: 'meta' });
  const editEl = h('div', { class: 'tn-edit' });
  const refEl = h('span', { class: 'tn-ref' });

  const select = h('select', { onchange: (e: Event) => {
    const id = (e.target as HTMLSelectElement).value;
    setTuning(id);
    applyTuning();
  } }) as HTMLSelectElement;

  const paintSelect = () => {
    const id = tuningId();
    select.replaceChildren(...[...TUNINGS.map(t => [t.id, t.label] as const), [CUSTOM, 'Personnalisé'] as const].map(([v, label]) => {
      const o = h('option', { value: v }, label) as HTMLOptionElement;
      o.selected = v === id;
      return o;
    }));
    noteEl.textContent = TUNINGS.find(t => t.id === id)?.note ?? '';
  };

  const applyTuning = () => {
    strings = currentStrings();
    tuned = new Set();
    locked = null;
    paintSelect();
    paintStrings();
    onChange?.();
  };

  const changeString = (i: number, delta: number) => {
    const next = [...(tuningId() === CUSTOM ? customStrings() : strings)];
    next[i] = Math.max(28, Math.min(72, next[i] + delta));
    setTuning(CUSTOM, next);
    strings = next;
    tuned.delete(i);
    paintSelect();
    paintStrings();
    playOud(strings[i], 1.6, 95);
    onChange?.();
  };

  const paintStrings = () => {
    stringsEl.replaceChildren(...strings.map((p, i) => h('button', {
      class: 'tn-string' + (locked === i ? ' on' : '') + (tuned.has(i) ? ' tuned' : ''),
      title: 'Écouter cette corde et la régler',
      onclick: () => {
        locked = locked === i ? null : i;
        if (locked !== null) playOud(p, 1.6, 95);
        recent = [];
        paintStrings();
      }
    }, [h('span', { class: 'tn-sname' }, oudName(p, true)), h('span', { class: 'tn-shz' }, `${fmtHz(pitchToHz(p, refHz()))} Hz`), h('span', { class: 'tn-check' }, tuned.has(i) ? '✓' : '')])));
    modeEl.textContent = locked === null
      ? 'Automatique : l’accordeur reconnaît la corde. Touchez une corde pour entendre sa note et ne régler qu’elle.'
      : `Réglage de la corde ${oudName(strings[locked], true)}. Touchez-la de nouveau pour revenir en automatique.`;
    if (locked === null) editEl.replaceChildren();
    else {
      const i = locked;
      editEl.replaceChildren(
        h('span', { class: 'meta' }, 'Changer la note de cette corde'),
        h('button', { class: 'icon', title: 'Un demi-ton plus bas', onclick: () => changeString(i, -1) }, '−'),
        h('button', { class: 'icon', title: 'Un demi-ton plus haut', onclick: () => changeString(i, 1) }, '+')
      );
    }
  };

  const paintRef = () => { refEl.textContent = `La = ${refHz()} Hz`; };
  const bumpRef = (d: number) => {
    setRefHz(Math.max(415, Math.min(466, refHz() + d)));
    paintRef();
    paintStrings();
  };

  const clearDisplay = () => {
    nameEl.textContent = '—';
    nameEl.className = 'tn-name';
    hzEl.textContent = 'Pincez une corde';
    centsEl.textContent = '';
    msgEl.textContent = '';
    msgEl.className = 'tn-msg';
    needle.style.left = '50%';
    needle.className = 'tn-needle idle';
  };

  const onFrame = (pitch: number | null) => {
    const t = performance.now();
    if (pitch === null) {
      good = 0;
      if (lastHeard && t - lastHeard > MEMORY_MS) { lastHeard = 0; recent = []; clearDisplay(); }
      return;
    }
    lastHeard = t;
    recent.push(pitch);
    if (recent.length > 5) recent.shift();
    const p = [...recent].sort((a, b) => a - b)[Math.floor(recent.length / 2)];
    let idx = locked;
    if (idx === null) {
      idx = 0;
      strings.forEach((s, i) => { if (Math.abs(s - p) < Math.abs(strings[idx!] - p)) idx = i; });
    }
    const target = strings[idx];
    const cents = (p - target) * 100;
    const ok = Math.abs(cents) <= IN_TUNE;
    nameEl.textContent = oudName(target, true);
    nameEl.className = 'tn-name' + (ok ? ' ok' : '');
    hzEl.textContent = `${fmtHz(pitchToHz(p, refHz()))} Hz entendus · cible ${fmtHz(pitchToHz(target, refHz()))} Hz`;
    const shown = Math.round(cents);
    centsEl.textContent = `${shown > 0 ? '+' : ''}${shown} cent${Math.abs(shown) > 1 ? 's' : ''}`;
    needle.style.left = `${50 + Math.max(-50, Math.min(50, cents))}%`;
    needle.className = 'tn-needle' + (ok ? ' ok' : '');
    if (ok) {
      msgEl.textContent = '✓ Juste';
      msgEl.className = 'tn-msg ok';
      if (++good >= CONFIRM_FRAMES && !tuned.has(idx)) { tuned.add(idx); paintStrings(); }
    } else {
      good = 0;
      const far = Math.abs(cents) > 100 ? ` (${Math.abs(Math.round(cents / 100))} demi-ton${Math.abs(cents) >= 150 ? 's' : ''})` : '';
      msgEl.textContent = cents < 0 ? `▲ Trop bas${far} : tendez la corde` : `▼ Trop haut${far} : détendez la corde`;
      msgEl.className = 'tn-msg bad';
    }
  };

  const banner = micBanner();
  const el = h('div', { class: 'tuner' }, [
    banner.el,
    h('div', { class: 'tn-display' }, [nameEl, hzEl, scale, centsEl, msgEl]),
    stringsEl,
    modeEl,
    editEl,
    h('div', { class: 'tn-settings' }, [
      h('label', { class: 'field' }, [h('span', {}, 'Accord du oud'), select]),
      h('div', { class: 'field' }, [
        h('span', {}, 'Note de référence'),
        h('div', { class: 'tn-refrow' }, [
          h('button', { class: 'icon', onclick: () => bumpRef(-1) }, '−'), refEl,
          h('button', { class: 'icon', onclick: () => bumpRef(1) }, '+')
        ])
      ])
    ]),
    noteEl
  ]);

  paintSelect();
  paintRef();
  paintStrings();
  clearDisplay();

  return {
    el,
    mount() {
      unsub = [micInput.onFrame(f => onFrame(f.pitch))];
      void micInput.start();
    },
    destroy() {
      unsub.forEach(f => f());
      unsub = [];
      banner.destroy();
      micInput.stop();
    }
  };
}

/** Accordeur en plein écran (depuis l'accueil). */
export function createTunerPage(onBack: () => void): TunerHandle {
  const tuner = createTuner();
  const el = h('div', { class: 'trainer' }, [
    h('header', { class: 'bar' }, [
      h('button', { class: 'icon', title: 'Retour', onclick: onBack }, '←'),
      h('div', { class: 'title' }, 'Accorder le oud')
    ]),
    h('div', { class: 'tuner-page' }, tuner.el)
  ]);
  return { el, mount: () => tuner.mount(), destroy: () => tuner.destroy() };
}
