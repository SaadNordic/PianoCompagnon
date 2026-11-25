// Mises à jour de l'appli.
// APK : compare le numéro de compilation embarqué (VITE_BUILD, fourni par GitHub Actions)
// à celui de la dernière publication GitHub, et propose de télécharger le nouvel APK.
// Navigateur : le service worker (PWA) récupère la nouvelle version et recharge la page.

import { Capacitor, CapacitorHttp } from '@capacitor/core';

const REPO = 'SaadNordic/PianoCompagnon';
export const APK_URL = `https://github.com/${REPO}/releases/latest/download/PianoCompagnon.apk`;
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

/** Numéro de la compilation installée (0 = version de développement). */
export const BUILD = Number(import.meta.env.VITE_BUILD ?? 0) || 0;
export const isNative = () => Capacitor.isNativePlatform();
export const versionLabel = () => (BUILD ? `version ${BUILD}` : 'version de développement');

export type UpdateState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'uptodate'; latest: number }
  | { state: 'available'; latest: number }
  | { state: 'error'; message: string };

let current: UpdateState = { state: 'idle' };
const listeners = new Set<(s: UpdateState) => void>();
const setState = (s: UpdateState) => { current = s; listeners.forEach(f => f(s)); };
export const onUpdateState = (f: (s: UpdateState) => void) => { listeners.add(f); f(current); return () => { listeners.delete(f); }; };

async function latestBuild(): Promise<number> {
  const headers = { Accept: 'application/vnd.github+json' };
  let data: { name?: string };
  if (isNative()) {
    const r = await CapacitorHttp.get({ url: RELEASE_API, headers, connectTimeout: 8000, readTimeout: 10000, responseType: 'json' });
    if (r.status !== 200) throw new Error(`GitHub a répondu ${r.status}`);
    data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  } else {
    const r = await fetch(RELEASE_API, { headers });
    if (!r.ok) throw new Error(`GitHub a répondu ${r.status}`);
    data = await r.json();
  }
  // titre de la publication : « My Music Inst - version 42 »
  const m = (data.name ?? '').match(/version\s+(\d+)/i);
  if (!m) throw new Error('Numéro de version introuvable sur GitHub');
  return Number(m[1]);
}

let running: Promise<UpdateState> | null = null;

/** Vérifie s'il existe une version plus récente. */
export function checkForUpdate(): Promise<UpdateState> {
  if (!running) {
    running = (async (): Promise<UpdateState> => {
      setState({ state: 'checking' });
      try {
        if (!isNative()) {
          const reg = await navigator.serviceWorker?.getRegistration();
          if (reg) {
            await reg.update();
            await new Promise(r => setTimeout(r, 1500));
            // registerType « autoUpdate » : la page se recharge d'elle-même quand la nouvelle version s'active
            if (reg.installing || reg.waiting) { setState({ state: 'available', latest: 0 }); return current; }
          }
          setState({ state: 'uptodate', latest: 0 });
          return current;
        }
        const latest = await latestBuild();
        setState(BUILD && latest > BUILD ? { state: 'available', latest } : { state: 'uptodate', latest });
      } catch (e) {
        setState({ state: 'error', message: `Vérification impossible : ${(e as Error).message}` });
      }
      return current;
    })().finally(() => { running = null; });
  }
  return running;
}

/** Lance l'installation : télécharge le nouvel APK (Android) ou recharge la page (navigateur). */
export function installUpdate(): void {
  if (isNative()) location.href = APK_URL; // ouvert par le navigateur du téléphone, qui propose l'installation
  else location.reload();
}
