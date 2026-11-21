import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { getPiece, savePiece, deletePiece, pref, setPref } from './storage';
import { REPERTOIRE } from './repertoire';
import { parsePcn, pcnToXml } from './codification';
import { midiInput } from './midiInput';
import { Player } from './player';
import { createTrainer } from './learn';
import { showLibrary } from './library';

registerSW({ immediate: true });

const app = document.getElementById('app')!;
let player: { destroy(): void } | null = null;

/** Répertoire de départ (domaine public), ajouté une fois ; remplace l'ancien morceau d'exemple. */
async function seedRepertoire(): Promise<void> {
  if (pref('seeded.rep1', false)) return;
  await deletePiece('demo-ode');
  let t = Date.now();
  for (const r of REPERTOIRE) {
    if (await getPiece(r.id)) continue;
    await savePiece({
      id: r.id, title: r.title, composer: r.composer, difficulty: r.difficulty, tags: r.tags, category: 'Classique',
      code: r.code, xml: pcnToXml(parsePcn(r.code), r.title), source: 'pcn', addedAt: t--
    });
  }
  setPref('seeded.rep1', true);
}

function route(): void {
  player?.destroy();
  player = null;
  const m = location.hash.match(/^#\/jouer\/(.+)$/);
  const l = location.hash.match(/^#\/apprendre\/(.+)$/);
  if (m) void openPlayer(decodeURIComponent(m[1]));
  else if (l) openTrainer(l[1]);
  else void showLibrary(app);
}

function openTrainer(id: string): void {
  const t = createTrainer(id, () => { location.hash = '#/'; });
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
  void midiInput.start();
  route();
})();
