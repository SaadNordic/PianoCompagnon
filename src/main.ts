import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { h, toast } from './ui';
import { importFile, ImportError } from './importers';
import { demoPiece } from './musicxml';
import { listPieces, getPiece, savePiece, deletePiece, newId, pref, setPref, type Piece } from './storage';
import { midiInput, statusLabel, type MidiStatus } from './midiInput';
import { Player } from './player';
import { unlockAudio } from './synth';

registerSW({ immediate: true });

const app = document.getElementById('app')!;
let player: Player | null = null;

async function seedDemo(): Promise<void> {
  if (pref('seeded', false)) return;
  await savePiece({ id: 'demo-ode', title: 'Ode à la joie (exemple)', xml: demoPiece(), source: 'demo', addedAt: Date.now() });
  setPref('seeded', true);
}

function route(): void {
  player?.destroy();
  player = null;
  const m = location.hash.match(/^#\/jouer\/(.+)$/);
  if (m) void openPlayer(decodeURIComponent(m[1]));
  else void showLibrary();
}

async function openPlayer(id: string): Promise<void> {
  const piece = await getPiece(id);
  if (!piece) { location.hash = '#/'; return; }
  player = new Player(piece, () => { location.hash = '#/'; });
  app.replaceChildren(player.el);
  await player.mount();
}

function midiChip(): HTMLElement {
  const chip = h('div', { class: 'chip' });
  const paint = (s: MidiStatus) => {
    chip.className = 'chip ' + (s.state === 'connected' ? 'ok' : 'warn');
    chip.textContent = (s.state === 'connected' ? '🎹 ' : '⚠ ') + statusLabel(s);
  };
  midiInput.onStatus(paint);
  return chip;
}

function fmtTime(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function showLibrary(): Promise<void> {
  const pieces = await listPieces();
  const fileInput = h('input', { type: 'file', multiple: true, style: 'display:none' }) as HTMLInputElement;
  fileInput.addEventListener('change', async () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    let lastId = '';
    for (const f of files) {
      try {
        const imp = await importFile(f);
        const p: Piece = { id: newId(), title: imp.title, xml: imp.xml, source: imp.source, addedAt: Date.now() };
        await savePiece(p);
        lastId = p.id;
        toast(`« ${imp.title} » ajouté`);
      } catch (e) {
        toast(e instanceof ImportError ? e.message : `Erreur avec ${f.name} : ${(e as Error).message}`, 5000);
      }
    }
    if (files.length === 1 && lastId) location.hash = `#/jouer/${lastId}`;
    else void showLibrary();
  });

  const list = pieces.length
    ? h('div', { class: 'pieces' }, pieces.map(p => h('div', { class: 'piece' }, [
      h('button', { class: 'piece-main', onclick: () => { unlockAudio(); location.hash = `#/jouer/${encodeURIComponent(p.id)}`; } }, [
        h('div', { class: 'piece-title' }, p.title),
        h('div', { class: 'piece-sub' }, [
          p.source === 'midi' ? 'MIDI' : p.source === 'demo' ? 'Exemple' : 'MusicXML',
          p.bestRun ? ` · record : ${p.bestRun.wrong} faute${p.bestRun.wrong > 1 ? 's' : ''}, ${fmtTime(p.bestRun.seconds)}` : ''
        ].join(''))
      ]),
      h('button', { class: 'icon del', title: 'Supprimer', onclick: async () => {
        if (!confirm(`Supprimer « ${p.title} » de la bibliothèque ?`)) return;
        await deletePiece(p.id);
        void showLibrary();
      } }, '🗑')
    ])))
    : h('p', { class: 'empty' }, 'Aucune partition pour le moment. Importez un fichier MusicXML ou MIDI.');

  app.replaceChildren(h('div', { class: 'library' }, [
    h('header', { class: 'lib-head' }, [
      h('img', { src: 'icon.svg', alt: '', class: 'logo' }),
      h('div', {}, [h('h1', {}, 'Piano Compagnon'), h('div', { class: 'tag' }, 'La partition avance quand vous jouez juste.')]),
      midiChip()
    ]),
    h('div', { class: 'actions' }, [
      h('button', { class: 'primary big-btn', onclick: () => fileInput.click() }, '＋ Importer une partition'),
      fileInput
    ]),
    h('h2', {}, 'Mes partitions'),
    list,
    h('details', { class: 'help' }, [
      h('summary', {}, 'Brancher le piano et trouver des partitions'),
      h('div', { html: `
        <p><b>Branchement :</b> câble USB-C (téléphone) vers USB-B (prise carrée du piano). Ouvrez l'appli dans <b>Chrome</b> et acceptez l'accès aux appareils MIDI. Le voyant passe au vert.</p>
        <p><b>Formats acceptés :</b> MusicXML (<code>.musicxml</code>, <code>.xml</code>, <code>.mxl</code>) et MIDI (<code>.mid</code>). PDF, photo et audio arrivent bientôt.</p>
        <p><b>Où trouver des partitions :</b> MuseScore (exporter en MusicXML), IMSLP / Mutopia (domaine public), ou tout fichier MIDI.</p>
        <p><b>Pendant le jeu :</b> la note attendue s'allume sur le clavier (bleu = main droite, orange = main gauche). Touchez une mesure pour y aller, utilisez « Boucle » pour répéter un passage. En « Main droite » ou « Main gauche », l'appli joue l'autre main pour vous.</p>` })
    ])
  ]));
}

window.addEventListener('hashchange', route);
void (async () => {
  await seedDemo();
  void midiInput.start();
  route();
})();
