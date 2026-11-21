import { get, set, del, keys, getMany } from 'idb-keyval';

export interface Piece {
  id: string;
  title: string;
  xml: string;
  source: 'musicxml' | 'midi' | 'demo' | 'scan';
  addedAt: number;
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

const PREFIX = 'piece:';

export async function listPieces(): Promise<Piece[]> {
  const ks = (await keys()).filter(k => typeof k === 'string' && k.startsWith(PREFIX));
  const items = (await getMany<Piece | undefined>(ks)).filter((p): p is Piece => !!p);
  return items.sort((a, b) => (b.lastPlayedAt ?? b.addedAt) - (a.lastPlayedAt ?? a.addedAt));
}

export async function getPiece(id: string): Promise<Piece | undefined> {
  return get<Piece>(PREFIX + id);
}

export async function savePiece(p: Piece): Promise<void> {
  await set(PREFIX + p.id, p);
}

export async function deletePiece(id: string): Promise<void> {
  await del(PREFIX + id);
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// petites préférences (synchrones, sans risque si le stockage est bloqué)
export function pref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem('pc.' + key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch { return fallback; }
}
export function setPref(key: string, value: unknown): void {
  try { localStorage.setItem('pc.' + key, JSON.stringify(value)); } catch { /* ignoré */ }
}
