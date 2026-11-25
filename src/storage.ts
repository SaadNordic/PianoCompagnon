// Stockage local (IndexedDB), séparé par utilisateur.
// Sans compte : espace « local ». Connecté : un espace par utilisateur, synchronisé avec le serveur.

import { get, set, del, keys, getMany, update } from 'idb-keyval';

export interface Piece {
  id: string;
  title: string;
  xml: string;
  source: 'musicxml' | 'midi' | 'demo' | 'scan' | 'pcn' | 'dictee';
  instrument?: 'oud'; // absent = piano
  code?: string; // codification PCN (référence quand elle existe)
  hasOriginal?: boolean; // photo(s) / PDF d'origine conservés
  addedAt: number;
  updatedAt?: number; // dernière modification (synchronisation)
  lastPlayedAt?: number;
  bestRun?: { wrong: number; seconds: number };
  // classement
  composer?: string;
  category?: string;
  tags?: string[];
  favorite?: boolean;
  difficulty?: number; // 1 à 5
  note?: string;
  playCount?: number;
}

// ---------- préférences simples (localStorage) ----------

export function pref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem('pc.' + key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch { return fallback; }
}
export function setPref(key: string, value: unknown): void {
  try { localStorage.setItem('pc.' + key, JSON.stringify(value)); } catch { /* ignoré */ }
}

/** Domaine affiché : piano ou oud. */
export type Domain = 'piano' | 'oud';
export const getDomain = () => pref<Domain>('domain', 'piano');
export const setDomain = (d: Domain) => setPref('domain', d);

// ---------- espace de l'utilisateur courant ----------

export interface Session { server: string; token: string; user: { id: number; login: string; name: string; admin?: boolean } }
export const getSession = () => pref<Session | null>('session', null);
export const setSession = (s: Session | null) => setPref('session', s);
/** Identifiant d'espace : « local » ou « u<id> ». */
export const ns = () => { const s = getSession(); return s ? `u${s.user.id}` : 'local'; };

const pieceKey = (id: string, n = ns()) => (n === 'local' ? 'piece:' : `p:${n}:`) + id;
const piecePrefix = (n = ns()) => (n === 'local' ? 'piece:' : `p:${n}:`);
export const origKey = (id: string, n = ns()) => (n === 'local' ? 'orig:' : `o:${n}:`) + id;

// ---------- éléments à synchroniser ----------

export interface Dirty { pieces: Record<string, number>; deleted: Record<string, number>; kv: Record<string, number>; origs: Record<string, number> }
const dirtyKey = (n = ns()) => `dirty:${n}`;
const emptyDirty = (): Dirty => ({ pieces: {}, deleted: {}, kv: {}, origs: {} });

export async function getDirty(n = ns()): Promise<Dirty> {
  return { ...emptyDirty(), ...((await get<Dirty>(dirtyKey(n))) ?? {}) };
}
async function markDirty(kind: keyof Dirty, id: string, n = ns()): Promise<void> {
  if (n === 'local') return; // sans compte : rien à envoyer
  await update<Dirty>(dirtyKey(n), d => {
    const x = { ...emptyDirty(), ...(d ?? {}) };
    x[kind] = { ...x[kind], [id]: Date.now() };
    if (kind === 'pieces') delete x.deleted[id];
    if (kind === 'deleted') delete x.pieces[id];
    return x;
  });
  changeListeners.forEach(f => f());
}
/** Retire des éléments envoyés, sauf s'ils ont été remodifiés depuis. */
export async function clearDirty(sent: Dirty, n = ns()): Promise<void> {
  await update<Dirty>(dirtyKey(n), d => {
    const x = { ...emptyDirty(), ...(d ?? {}) };
    for (const kind of Object.keys(sent) as (keyof Dirty)[]) {
      for (const [id, t] of Object.entries(sent[kind])) if (x[kind][id] === t) delete x[kind][id];
    }
    return x;
  });
}

const changeListeners = new Set<() => void>();
export const onLocalChange = (f: () => void) => { changeListeners.add(f); return () => changeListeners.delete(f); };

// ---------- partitions ----------

export async function listPieces(n = ns()): Promise<Piece[]> {
  const prefix = piecePrefix(n);
  const ks = (await keys()).filter(k => typeof k === 'string' && k.startsWith(prefix));
  const items = (await getMany<Piece | undefined>(ks)).filter((p): p is Piece => !!p);
  return items.sort((a, b) => (b.lastPlayedAt ?? b.addedAt) - (a.lastPlayedAt ?? a.addedAt));
}

export async function getPiece(id: string, n = ns()): Promise<Piece | undefined> {
  return get<Piece>(pieceKey(id, n));
}

/** Enregistre une partition (et la marque à synchroniser). */
export async function savePiece(p: Piece, n = ns()): Promise<void> {
  p.updatedAt = Date.now();
  await set(pieceKey(p.id, n), p);
  await markDirty('pieces', p.id, n);
}

/** Enregistre sans marquer (copie reçue du serveur, répertoire de départ). */
export async function storePiece(p: Piece, n = ns()): Promise<void> {
  await set(pieceKey(p.id, n), p);
}

export async function deletePiece(id: string, n = ns()): Promise<void> {
  await del(pieceKey(id, n));
  await del(origKey(id, n));
  await markDirty('deleted', id, n);
}

/** Suppression reçue du serveur (pas à renvoyer). */
export async function removePieceLocal(id: string, n = ns()): Promise<void> {
  await del(pieceKey(id, n));
  await del(origKey(id, n));
}

export const markOriginalsDirty = (id: string) => markDirty('origs', id);

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------- préférences propres à chaque utilisateur (synchronisées) ----------

interface Stamped<T> { v: T; t: number }
const ukey = (key: string, n = ns()) => `pc.${n}.${key}`;

export function upref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(ukey(key));
    if (raw === null) return fallback;
    return (JSON.parse(raw) as Stamped<T>).v;
  } catch { return fallback; }
}
export function uprefStamp(key: string): number {
  try { return (JSON.parse(localStorage.getItem(ukey(key)) ?? 'null') as Stamped<unknown> | null)?.t ?? 0; } catch { return 0; }
}
export function setUpref(key: string, value: unknown, fromServer?: number): void {
  try { localStorage.setItem(ukey(key), JSON.stringify({ v: value, t: fromServer ?? Date.now() })); } catch { /* ignoré */ }
  if (fromServer === undefined) void markDirty('kv', key);
}

/** Rattache les partitions du téléphone (sans compte) au compte qui vient de se connecter. */
export async function adoptLocalPieces(): Promise<number> {
  const n = ns();
  if (n === 'local') return 0;
  const local = await listPieces('local');
  for (const p of local) {
    if (await getPiece(p.id, n)) continue;
    const orig = await get(origKey(p.id, 'local'));
    if (orig) { await set(origKey(p.id, n), orig); await markDirty('origs', p.id, n); }
    await savePiece(p, n);
  }
  return local.length;
}
