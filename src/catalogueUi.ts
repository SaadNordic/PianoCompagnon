// Fenêtre « Catalogue » : pièces célèbres du domaine public, ajoutées au répertoire à la demande.

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { CATALOGUE, MUTOPIA, type CatalogueItem } from './catalogue';
import { importFile } from './importers';
import { getPiece, savePiece, getSession, type Piece } from './storage';
import { api } from './api';
import { h, openModal, toast } from './ui';

const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Télécharge le MIDI : en direct dans l'APK, par le serveur dans un navigateur. */
async function fetchMidi(item: CatalogueItem): Promise<Uint8Array> {
  if (Capacitor.isNativePlatform()) {
    const r = await CapacitorHttp.get({ url: MUTOPIA + item.path, responseType: 'arraybuffer', connectTimeout: 10000, readTimeout: 30000 });
    if (r.status !== 200) throw new Error(`Mutopia a répondu ${r.status}`);
    return b64ToBytes(String(r.data));
  }
  if (getSession()) {
    const r = await api<{ data: string }>('GET', `/api/catalogue?path=${encodeURIComponent(item.path)}`, undefined, 40000);
    return b64ToBytes(r.data);
  }
  const r = await fetch(MUTOPIA + item.path);
  if (!r.ok) throw new Error(`Mutopia a répondu ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

export async function addFromCatalogue(item: CatalogueItem): Promise<Piece> {
  const bytes = await fetchMidi(item);
  const name = item.path.split('/').pop() || 'piece.mid';
  const imp = await importFile(new File([bytes as BlobPart], name, { type: 'audio/midi' }));
  const p: Piece = {
    id: item.id, title: item.title, composer: item.composer, xml: imp.xml, source: 'midi', addedAt: Date.now(),
    category: 'Classique', difficulty: item.difficulty, tags: ['catalogue'],
    note: `Source : Mutopia Project (mutopiaproject.org), ${item.license}.`
  };
  await savePiece(p);
  return p;
}

export function openCatalogue(onAdded: () => void, onOpen: (id: string) => void): void {
  let composer = 'Tous';
  let query = '';
  const listEl = h('div', { class: 'cat-list' });
  const search = h('input', { type: 'search', placeholder: '🔍 Rechercher : nocturne, menuet, sonate…' }) as HTMLInputElement;
  const chips = h('div', { class: 'filters' });
  const composers = ['Tous', ...new Set(CATALOGUE.map(i => i.composer))];

  const render = async () => {
    chips.replaceChildren(...composers.map(c => h('button', { class: 'fchip' + (c === composer ? ' on' : ''), onclick: () => { composer = c; void render(); } }, c)));
    const q = norm(query.trim());
    const items = CATALOGUE.filter(i => (composer === 'Tous' || i.composer === composer) && (!q || norm(`${i.title} ${i.composer}`).includes(q)));
    const rows = await Promise.all(items.map(async item => {
      const have = !!(await getPiece(item.id));
      const btn = h('button', { class: have ? '' : 'primary' }, have ? 'Ouvrir' : 'Ajouter') as HTMLButtonElement;
      btn.addEventListener('click', async () => {
        if (have) { close(); onOpen(item.id); return; }
        btn.disabled = true;
        btn.textContent = '…';
        try {
          await addFromCatalogue(item);
          toast(`« ${item.title} » ajouté au répertoire`);
          onAdded();
          void render();
        } catch (e) {
          btn.disabled = false;
          btn.textContent = 'Ajouter';
          toast(`Échec : ${(e as Error).message}`, 5000);
        }
      });
      return h('div', { class: 'cat-row' }, [
        h('div', { class: 'cat-info' }, [
          h('div', { class: 'piece-title' }, item.title),
          h('div', { class: 'piece-sub' }, [h('span', { class: 'composer' }, item.composer), h('span', { class: 'diff', title: `Difficulté ${item.difficulty}/5` }, stars(item.difficulty))])
        ]),
        btn
      ]);
    }));
    listEl.replaceChildren(...(rows.length ? rows : [h('p', { class: 'meta' }, 'Aucune pièce ne correspond.')]));
  };
  search.addEventListener('input', () => { query = search.value; void render(); });

  const body = h('div', { class: 'form' }, [
    h('p', { class: 'meta' }, `${CATALOGUE.length} pièces célèbres du domaine public (Bach, Mozart, Beethoven, Chopin, Satie, Debussy…), issues du Mutopia Project. « Ajouter » les copie dans votre répertoire.`),
    search, chips, listEl
  ]);
  const close = openModal('📚 Catalogue', body, [h('span', { class: 'spacer' }), h('button', { class: 'primary', onclick: () => close() }, 'Fermer')]);
  void render();
}
