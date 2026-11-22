import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { getPiece } from './storage';
import { seedRepertoire } from './repertoire';
import { startAutoSync } from './sync';
import { parsePcn, pcnToXml } from './codification';
import { midiInput } from './midiInput';
import { loadPiano, unlockAudio } from './synth';
import { Player } from './player';
import { createTrainer } from './learn';
import { createOudTrainer } from './oudLearn';
import { createTunerPage } from './oudTuner';
import { showLibrary } from './library';
import { checkForUpdate, isNative } from './updates';
import { enableHorizontalScroll } from './ui';

registerSW({ immediate: true });
enableHorizontalScroll();

const app = document.getElementById('app')!;
let player: { destroy(): void } | null = null;

function route(): void {
  player?.destroy();
  player = null;
  const m = location.hash.match(/^#\/jouer\/(.+)$/);
  const l = location.hash.match(/^#\/apprendre\/(.+)$/);
  if (m) void openPlayer(decodeURIComponent(m[1]));
  else if (l) openTrainer(l[1]);
  else if (location.hash === '#/oud/accorder') openTuner();
  else void showLibrary(app);
}

function openTuner(): void {
  const t = createTunerPage(() => { location.hash = '#/'; });
  player = t;
  app.replaceChildren(t.el);
  t.mount();
}

function openTrainer(id: string): void {
  const back = () => { location.hash = '#/'; };
  const t = createTrainer(id, back) ?? createOudTrainer(id, back);
  if (!t) { location.hash = '#/'; return; }
  player = t;
  app.replaceChildren(t.el);
  t.mount();
}

async function openPlayer(id: string): Promise<void> {
  const piece = await getPiece(id);
  if (!piece) { location.hash = '#/'; return; }
  // la codification PCN fait foi : la partition affichée en est toujours tirée
  if (piece.code) piece.xml = pcnToXml(parsePcn(piece.code), piece.title);
  const p = new Player(piece, () => { location.hash = '#/'; });
  player = p;
  app.replaceChildren(p.el);
  await p.mount();
}

window.addEventListener('hashchange', route);
void (async () => {
  await seedRepertoire();
  startAutoSync();
  void midiInput.start();
  route();
  // le son de piano se charge dès le démarrage ; le premier geste débloque l'audio (règle des navigateurs)
  void loadPiano();
  window.addEventListener('pointerdown', () => unlockAudio(), { once: true });
  // nouvelle version de l'APK ? (le navigateur, lui, se met à jour par le service worker)
  if (isNative()) void checkForUpdate();
})();
