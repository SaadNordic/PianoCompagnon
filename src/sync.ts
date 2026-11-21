// Synchronisation avec le serveur : envoie les modifications locales, récupère celles
// faites sur un autre appareil. La version la plus récente (updatedAt) l'emporte.

import { api, request, ApiError } from './api';
import {
  getSession, setSession, ns, getDirty, clearDirty, getPiece, storePiece, removePieceLocal, onLocalChange,
  upref, uprefStamp, setUpref, pref, setPref, type Piece, type Session
} from './storage';
import { getOriginals, blobToBase64 } from './originals';
import { parsePcn, pcnToXml } from './codification';

export type SyncState =
  | { state: 'off' } // pas de compte
  | { state: 'syncing' }
  | { state: 'ok'; at: number }
  | { state: 'offline'; pending: number }
  | { state: 'error'; message: string };

let current: SyncState = { state: getSession() ? 'offline' : 'off', pending: 0 } as SyncState;
const listeners = new Set<(s: SyncState) => void>();
const remoteListeners = new Set<() => void>();

export const onSyncState = (f: (s: SyncState) => void) => { listeners.add(f); f(current); return () => listeners.delete(f); };
/** Appelé quand des données reçues du serveur ont changé la bibliothèque. */
export const onRemoteChange = (f: () => void) => { remoteListeners.add(f); return () => remoteListeners.delete(f); };
const setState = (s: SyncState) => { current = s; listeners.forEach(f => f(s)); };

const lastPullKey = () => `sync.lastPull.${ns()}`;

interface PullResponse {
  now: number;
  pieces: { id: string; data: Piece | null; updatedAt: number; deleted: boolean }[];
  kv: { key: string; value: unknown; updatedAt: number }[];
}

let running: Promise<void> | null = null;

export function syncNow(): Promise<void> {
  if (!getSession()) { setState({ state: 'off' }); return Promise.resolve(); }
  if (!running) running = doSync().finally(() => { running = null; });
  return running;
}

async function doSync(): Promise<void> {
  setState({ state: 'syncing' });
  const space = ns();
  try {
    // 1. envoyer les modifications locales
    const dirty = await getDirty();
    const pieces: unknown[] = [];
    for (const id of Object.keys(dirty.pieces)) {
      const p = await getPiece(id);
      if (!p) continue;
      // la partition se régénère depuis la codification : inutile d'envoyer le MusicXML
      const data = p.code ? { ...p, xml: '' } : p;
      pieces.push({ id, data, updatedAt: p.updatedAt ?? Date.now() });
    }
    for (const [id, t] of Object.entries(dirty.deleted)) pieces.push({ id, updatedAt: t, deleted: true });
    const kv = Object.keys(dirty.kv).map(key => ({ key, value: upref(key, null), updatedAt: uprefStamp(key) }));
    if (pieces.length || kv.length) await api('POST', '/api/sync', { pieces, kv }, 60000);
    for (const id of Object.keys(dirty.origs)) {
      const files = await getOriginals(id);
      const payload = await Promise.all(files.map(async f => ({ name: f.name, type: f.type, data: await blobToBase64(f.blob) })));
      await api('PUT', `/api/originals/${encodeURIComponent(id)}`, { files: payload }, 120000);
    }
    await clearDirty(dirty);

    // 2. récupérer les modifications faites ailleurs
    const since = Math.max(0, pref<number>(lastPullKey(), 0) - 5000);
    const r = await api<PullResponse>('GET', `/api/sync?since=${since}`, undefined, 60000);
    if (ns() !== space) return; // l'utilisateur a changé entre-temps
    let changed = false;
    for (const rp of r.pieces) {
      const local = await getPiece(rp.id);
      if ((local?.updatedAt ?? 0) >= rp.updatedAt) continue;
      if (rp.deleted || !rp.data) { if (local) { await removePieceLocal(rp.id); changed = true; } continue; }
      const p = rp.data;
      if (p.code) p.xml = pcnToXml(parsePcn(p.code), p.title);
      p.updatedAt = rp.updatedAt;
      await storePiece(p);
      changed = true;
    }
    for (const k of r.kv) {
      if (uprefStamp(k.key) < k.updatedAt) { setUpref(k.key, k.value, k.updatedAt); changed = true; }
    }
    setPref(lastPullKey(), r.now);
    setState({ state: 'ok', at: Date.now() });
    if (changed) remoteListeners.forEach(f => f());
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      setState({ state: 'error', message: 'Session expirée : reconnectez-vous' });
    } else if (e instanceof ApiError && e.status === 0) {
      const d = await getDirty();
      setState({ state: 'offline', pending: Object.keys(d.pieces).length + Object.keys(d.deleted).length + Object.keys(d.kv).length });
    } else {
      setState({ state: 'error', message: (e as Error).message });
    }
  }
}

// ---------- connexion ----------

export async function login(server: string, loginName: string, password: string): Promise<Session> {
  const r = await request<{ token: string; user: Session['user'] }>(server, 'POST', '/api/login', { login: loginName, password });
  const s: Session = { server: server.replace(/\/+$/, ''), token: r.token, user: r.user };
  setSession(s);
  return s;
}

export async function logout(): Promise<void> {
  const s = getSession();
  if (s) await request(s.server, 'POST', '/api/logout', undefined, s.token).catch(() => { /* hors ligne : tant pis */ });
  setSession(null);
  setState({ state: 'off' });
}

// ---------- déclenchement automatique ----------

let debounce = 0;
export function startAutoSync(): void {
  onLocalChange(() => {
    clearTimeout(debounce);
    debounce = window.setTimeout(() => void syncNow(), 3000);
  });
  window.addEventListener('online', () => void syncNow());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void syncNow(); });
  setInterval(() => void syncNow(), 5 * 60 * 1000);
  void syncNow();
}
