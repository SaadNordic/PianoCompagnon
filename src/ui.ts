type Child = Node | string | null | undefined | false;
type Attrs = Record<string, unknown>;

/** Petit créateur d'éléments DOM. */
export function h(tag: string, attrs: Attrs = {}, children: Child | Child[] = []): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of Array.isArray(children) ? children : [children]) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

let toastTimer = 0;
export function toast(msg: string, ms = 1600): void {
  let t = document.querySelector('.toast') as HTMLElement | null;
  if (!t) { t = h('div', { class: 'toast' }); document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t!.classList.remove('show'), ms);
}

/** Fenêtre modale à taille fixe : seul le corps défile. Renvoie la fonction de fermeture. */
export function openModal(title: string, body: HTMLElement, footer: HTMLElement[], onClose?: () => void, flush = false): () => void {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  const overlay = h('div', { class: 'modal-overlay', onclick: (e: Event) => { if (e.target === overlay) close(); } }, [
    h('div', { class: 'modal', role: 'dialog' }, [
      h('div', { class: 'modal-head' }, [h('div', { class: 'modal-title' }, title), h('button', { class: 'icon', onclick: close, title: 'Fermer' }, '✕')]),
      h('div', { class: 'modal-body' + (flush ? ' flush' : '') }, body),
      h('div', { class: 'modal-foot' }, footer)
    ])
  ]);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  return close;
}

/**
 * Rangées défilant à l'horizontale (.filters) : au doigt elles glissent d'elles-mêmes ;
 * à la souris on ajoute la molette et le glisser-déposer. Installé une fois pour toute l'appli.
 */
export function enableHorizontalScroll(selector = '.filters'): void {
  document.addEventListener('wheel', e => {
    const row = (e.target as HTMLElement).closest?.(selector) as HTMLElement | null;
    if (!row || row.scrollWidth <= row.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    const max = row.scrollWidth - row.clientWidth;
    // au bout de la rangée, on laisse la page défiler normalement
    if ((e.deltaY < 0 && row.scrollLeft <= 0) || (e.deltaY > 0 && row.scrollLeft >= max - 1)) return;
    e.preventDefault();
    row.scrollLeft += e.deltaY;
  }, { passive: false });

  document.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const row = (e.target as HTMLElement).closest?.(selector) as HTMLElement | null;
    if (!row || row.scrollWidth <= row.clientWidth) return;
    const x0 = e.clientX, left0 = row.scrollLeft;
    let dragging = false;
    const move = (m: PointerEvent) => {
      if (!dragging && Math.abs(m.clientX - x0) < 6) return;
      dragging = true;
      row.classList.add('dragging');
      row.scrollLeft = left0 - (m.clientX - x0);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      row.classList.remove('dragging');
      // un glissement ne doit pas sélectionner la puce sous la souris
      if (dragging) document.addEventListener('click', ev => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
}

export interface MenuItem { icon: string; label: string; desc?: string; onClick: () => void }

/** Ligne de menu : icône, libellé, description, chevron. */
export function menuRow(item: MenuItem): HTMLElement {
  return h('button', { class: 'mrow', onclick: item.onClick }, [
    h('span', { class: 'mrow-icon' }, item.icon),
    h('span', { class: 'mrow-text' }, [h('span', { class: 'mrow-label' }, item.label), item.desc ? h('span', { class: 'mrow-desc' }, item.desc) : null]),
    h('span', { class: 'mrow-chev' }, '›')
  ]);
}

/** Menu d'actions qui monte du bas de l'écran (liste courte et fixe). */
export function openSheet(title: string, items: MenuItem[]): () => void {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  const overlay = h('div', { class: 'sheet-overlay', onclick: (e: Event) => { if (e.target === overlay) close(); } }, [
    h('div', { class: 'sheet', role: 'menu' }, [
      h('div', { class: 'sheet-title' }, title),
      ...items.map(it => menuRow({ ...it, onClick: () => { close(); it.onClick(); } })),
      h('button', { class: 'sheet-cancel', onclick: close }, 'Annuler')
    ])
  ]);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  return close;
}

export interface TabDef { label: string; render: () => HTMLElement }

/** Onglets : barre fixe, seul le contenu défile ; chaque onglet garde son état. */
export function tabs(defs: TabDef[], start = 0): { el: HTMLElement; select: (i: number) => void } {
  const bar = h('div', { class: 'tabbar' });
  const pane = h('div', { class: 'tabpane' });
  const cache = new Map<number, HTMLElement>();
  const buttons = defs.map((d, i) => h('button', { class: 'tab', onclick: () => select(i) }, d.label));
  bar.append(...buttons);
  const select = (i: number) => {
    buttons.forEach((b, j) => b.classList.toggle('on', i === j));
    if (!cache.has(i)) cache.set(i, defs[i].render());
    pane.replaceChildren(cache.get(i)!);
    pane.scrollTop = 0;
  };
  select(Math.min(start, defs.length - 1));
  return { el: h('div', { class: 'tabs' }, [bar, pane]), select };
}
