// Écran d'accueil : bibliothèque de partitions (recherche, classement, tri) + modules Apprendre.

import { h, toast, openModal, tabs } from './ui';
import { importFile, ImportError } from './importers';
import { listPieces, savePiece, deletePiece, newId, pref, setPref, getSession, listPieces as listIn, adoptLocalPieces, type Piece } from './storage';
import { syncNow, onSyncState, onRemoteChange, login, logout, type SyncState } from './sync';
import { DEFAULT_SERVER, request, api } from './api';
import { setSession } from './storage';
import { seedRepertoire } from './repertoire';
import { openCatalogue } from './catalogueUi';
import { midiInput, statusLabel } from './midiInput';
import { unlockAudio } from './synth';
import { EXERCISES, getStats } from './learn';
import { isScanFile, scanScore, getApiKey, setApiKey, ScanError, type ScanProgress } from './scan';
import { parsePcn, pcnToXml, normalizePcn, PCN_HELP } from './codification';
import { saveOriginals, renderOriginals } from './originals';

type SortKey = 'recent' | 'added' | 'title' | 'composer' | 'difficulty' | 'plays';
const SORTS: [SortKey, string][] = [
  ['recent', 'Joué récemment'], ['added', 'Ajouté récemment'], ['title', 'Titre (A → Z)'],
  ['composer', 'Compositeur'], ['difficulty', 'Difficulté'], ['plays', 'Le plus joué']
];
const FAV = '★ Favoris';
const ALL = 'Tout';
const NONE = 'Sans catégorie';

/** Minuscules sans accents, pour une recherche tolérante. */
const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const stars = (n = 0) => '★'.repeat(n) + '☆'.repeat(5 - n);

let unsubMidi: (() => void) | null = null;
let unsubSync: (() => void)[] = [];

export async function showLibrary(app: HTMLElement): Promise<void> {
  let pieces = await listPieces();
  let query = '';
  let filter = pref<string>('lib.filter', ALL);
  let sort = pref<SortKey>('lib.sort', 'recent');

  const listEl = h('div', { class: 'pieces' });
  const chipsEl = h('div', { class: 'filters' });
  const countEl = h('span', { class: 'count' });

  const reload = async () => { pieces = await listPieces(); renderChips(); renderList(); };

  // ---------- import ----------
  const fileInput = h('input', { type: 'file', multiple: true, style: 'display:none' }) as HTMLInputElement;
  const cameraInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: 'display:none' }) as HTMLInputElement;
  fileInput.addEventListener('change', async () => {
    const all = [...(fileInput.files ?? [])];
    fileInput.value = '';
    await handleFiles(all);
  });
  cameraInput.addEventListener('change', async () => {
    const all = [...(cameraInput.files ?? [])];
    cameraInput.value = '';
    await handleFiles(all);
  });

  const handleFiles = async (all: File[]) => {
    const scans = all.filter(isScanFile);
    const files = all.filter(f => !isScanFile(f));
    if (scans.length) { runScan(scans); if (!files.length) return; }
    const added: Piece[] = [];
    for (const f of files) {
      try {
        const imp = await importFile(f);
        const p: Piece = {
          id: newId(), title: imp.title, xml: imp.xml, source: imp.source, addedAt: Date.now(),
          composer: imp.composer, code: imp.code, category: filter !== ALL && filter !== FAV && filter !== NONE ? filter : undefined
        };
        await savePiece(p);
        added.push(p);
      } catch (e) {
        toast(e instanceof ImportError ? e.message : `Erreur avec ${f.name} : ${(e as Error).message}`, 5000);
      }
    }
    await reload();
    if (added.length === 1 && !scans.length) editPiece(added[0], true); // on propose tout de suite de la classer
    else if (added.length) toast(`${added.length} partition${added.length > 1 ? 's' : ''} ajoutée${added.length > 1 ? 's' : ''}`);
  };

  // ---------- reconnaissance PDF / photos ----------
  const runScan = (scans: File[]) => {
    if (!getSession() && !getApiKey()) { toast('Connectez-vous à votre compte (VPN activé) pour lire une partition.', 4000); openAccount(); return; }
    const controller = new AbortController();
    const status = h('div', { class: 'scan-status' }, 'Préparation des pages…');
    const elapsed = h('div', { class: 'scan-elapsed' });
    const t0 = Date.now();
    const timer = window.setInterval(() => {
      const s = Math.round((Date.now() - t0) / 1000);
      elapsed.textContent = `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
    }, 1000);
    const body = h('div', { class: 'scan-body' }, [
      h('div', { class: 'scan-spinner' }),
      status, elapsed,
      h('p', { class: 'meta' }, `${scans.length} fichier${scans.length > 1 ? 's' : ''} : ${scans.map(f => f.name).join(', ')}`),
      h('p', { class: 'meta' }, 'Claude lit la partition note par note. Comptez 1 à 3 minutes par page ; vous pouvez laisser le téléphone posé.')
    ]);
    const close = openModal('Lecture de la partition', body, [
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => close() }, 'Annuler')
    ], () => { controller.abort(); clearInterval(timer); });
    const label = (p: ScanProgress) => p.phase === 'prepare' ? 'Préparation des pages…'
      : p.phase === 'reading' || !p.measures ? 'Claude lit la partition…'
      : `Transcription : ${p.measures} mesure${p.measures > 1 ? 's' : ''}…`;
    const fallbackTitle = scans[0].name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
    scanScore(scans, fallbackTitle, p => { status.textContent = label(p); }, controller.signal)
      .then(async r => {
        clearInterval(timer);
        const p: Piece = {
          id: newId(), title: r.title, composer: r.composer, xml: r.xml, code: r.code, hasOriginal: true, source: 'scan', addedAt: Date.now(),
          category: filter !== ALL && filter !== FAV && filter !== NONE ? filter : undefined,
          note: r.warning
        };
        await saveOriginals(p.id, scans);
        await savePiece(p);
        close();
        await reload();
        toast(`${r.measures} mesures reconnues${r.warning ? ' — ' + r.warning : ''}`, r.warning ? 6000 : 2500);
        editPiece(p, true);
      })
      .catch(e => {
        clearInterval(timer);
        if (controller.signal.aborted) return;
        status.textContent = e instanceof ScanError ? e.message : `Erreur : ${(e as Error).message}`;
        status.classList.add('bad');
        body.querySelector('.scan-spinner')?.remove();
      });
  };

  // ---------- réglages ----------
  const openSettings = (then?: () => void) => {
    const key = h('input', { type: 'password', value: getApiKey(), placeholder: 'sk-ant-…', autocomplete: 'off' }) as HTMLInputElement;
    const body = h('div', { class: 'form' }, [
      h('h3', {}, 'Lecture des PDF et des photos'),
      h('p', { class: 'meta' }, 'Avec un compte, la lecture des PDF et photos passe par le serveur : aucune clé à saisir. Cette clé ne sert que pour utiliser l\'appli sans compte.'),
      h('label', { class: 'field' }, [h('span', {}, 'Clé API Claude'), key]),
      h('p', { class: 'meta' }, "La clé reste uniquement sur ce téléphone. Elle n'est envoyée qu'à Anthropic, au moment de lire une partition.")
    ]);
    const close = openModal('Réglages', body, [
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => close() }, 'Fermer'),
      h('button', { class: 'primary', onclick: () => {
        setApiKey(key.value);
        close();
        toast(key.value.trim() ? 'Clé enregistrée' : 'Clé effacée');
        if (key.value.trim()) then?.();
      } }, 'Enregistrer')
    ]);
    setTimeout(() => key.focus(), 50);
  };

  // ---------- fiche d'une partition ----------
  const editPiece = (p: Piece, isNew = false) => {
    const categories = [...new Set(pieces.map(x => x.category).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, 'fr'));
    const field = (label: string, input: HTMLElement) => h('label', { class: 'field' }, [h('span', {}, label), input]);
    const title = h('input', { value: p.title }) as HTMLInputElement;
    const composer = h('input', { value: p.composer ?? '', placeholder: 'ex. Chopin', list: 'dl-composers' }) as HTMLInputElement;
    const category = h('input', { value: p.category ?? '', placeholder: 'ex. Classique, Variété, Exercices…', list: 'dl-categories' }) as HTMLInputElement;
    const tags = h('input', { value: (p.tags ?? []).join(', '), placeholder: 'ex. valse, débutant, mariage' }) as HTMLInputElement;
    const difficulty = h('select', {}, [0, 1, 2, 3, 4, 5].map(n => {
      const o = h('option', { value: String(n) }, n ? `${stars(n)}  (${n}/5)` : 'Non précisée') as HTMLOptionElement;
      if ((p.difficulty ?? 0) === n) o.selected = true;
      return o;
    })) as HTMLSelectElement;
    const fav = h('input', { type: 'checkbox' }) as HTMLInputElement;
    fav.checked = !!p.favorite;
    const note = h('textarea', { rows: 3, placeholder: 'Doigtés, passages à travailler…' }) as HTMLTextAreaElement;
    note.value = p.note ?? '';
    const composers = [...new Set(pieces.map(x => x.composer).filter(Boolean) as string[])];
    const form = h('div', { class: 'form' }, [
      field('Titre', title), field('Compositeur', composer), field('Catégorie', category),
      field('Étiquettes (séparées par des virgules)', tags), field('Difficulté', difficulty),
      h('label', { class: 'check' }, [fav, h('span', {}, 'Favori')]),
      field('Note personnelle', note),
      h('datalist', { id: 'dl-categories' }, categories.map(c => h('option', { value: c }))),
      h('datalist', { id: 'dl-composers' }, composers.map(c => h('option', { value: c }))),
      h('p', { class: 'meta' }, [
        `Ajoutée le ${new Date(p.addedAt).toLocaleDateString('fr-FR')}`,
        p.playCount ? ` · jouée ${p.playCount} fois` : '',
        p.bestRun ? ` · record : ${p.bestRun.wrong} faute${p.bestRun.wrong > 1 ? 's' : ''} en ${fmtTime(p.bestRun.seconds)}` : ''
      ].join(''))
    ]);
    // codification PCN (modifiable)
    const codeArea = h('textarea', { class: 'pcn', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off' }) as HTMLTextAreaElement;
    codeArea.value = p.code ?? '';
    const codeStatus = h('div', { class: 'meta' });
    const checkCode = () => {
      const r = parsePcn(codeArea.value);
      codeStatus.className = 'meta ' + (r.measures && !r.problems.length ? 'ok' : 'bad');
      codeStatus.textContent = !r.measures ? 'Aucune mesure reconnue.'
        : `${r.measures} mesures, ${r.notes.length} notes.` + (r.problems.length ? ` À vérifier : ${r.problems.slice(0, 6).join(' ; ')}${r.problems.length > 6 ? '…' : ''}` : ' Tout est cohérent.');
      return r;
    };
    const codeTab = () => {
      checkCode();
      codeArea.addEventListener('input', () => checkCode());
      return h('div', { class: 'pcn-tab' }, [
        h('p', { class: 'meta' }, 'Codification de la partition (format PCN) : c\'est ce qui est enregistré dans la base. Corrigez une mesure ici, la partition est régénérée à l\'enregistrement.'),
        codeArea, codeStatus,
        h('details', { class: 'pcn-help' }, [h('summary', {}, 'Comment écrire'), h('pre', {}, PCN_HELP)])
      ]);
    };
    const origTab = () => {
      const box = h('div', { class: 'orig-box' });
      void renderOriginals(box, p.id);
      return box;
    };
    const tabDefs = [{ label: 'Fiche', render: () => form }];
    if (p.code) tabDefs.push({ label: 'Codification', render: codeTab });
    if (p.hasOriginal) tabDefs.push({ label: 'Original', render: origTab });
    const t = tabs(tabDefs);
    const body = tabDefs.length > 1 ? t.el : form;

    const save = async () => {
      if (p.code !== undefined) {
        const parsed = checkCode();
        if (!parsed.measures) { t.select(1); toast('Codification illisible : corrigez-la avant d\'enregistrer.', 4000); return false; }
        const newTitle = title.value.trim() || p.title;
        p.code = normalizePcn(codeArea.value, newTitle, composer.value.trim() || undefined);
        p.xml = pcnToXml(parsePcn(p.code), newTitle);
      }
      p.title = title.value.trim() || p.title;
      p.composer = composer.value.trim() || undefined;
      p.category = category.value.trim() || undefined;
      p.tags = tags.value.split(',').map(t => t.trim()).filter(Boolean);
      p.difficulty = Number(difficulty.value) || undefined;
      p.favorite = fav.checked;
      p.note = note.value.trim() || undefined;
      await savePiece(p);
      close();
      await reload();
      return true;
    };
    const close = openModal(isNew ? 'Nouvelle partition — classer' : 'Fiche de la partition', body, [
      ...(isNew ? [] : [h('button', { class: 'danger', onclick: async () => {
        if (!confirm(`Supprimer « ${p.title} » de la bibliothèque ?`)) return;
        await deletePiece(p.id);
        close();
        await reload();
      } }, 'Supprimer')]),
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => void save() }, 'Enregistrer'),
      h('button', { class: 'primary', onclick: async () => { if (await save()) open(p); } }, 'Jouer')
    ], undefined, tabDefs.length > 1);
    if (isNew) setTimeout(() => category.focus(), 50);
  };

  const open = (p: Piece) => { unlockAudio(); location.hash = `#/jouer/${encodeURIComponent(p.id)}`; };

  // ---------- filtres et liste ----------
  const renderChips = () => {
    const cats = [...new Set(pieces.map(p => p.category).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, 'fr'));
    const hasNone = pieces.some(p => !p.category) && cats.length > 0;
    const all = [ALL, ...(pieces.some(p => p.favorite) ? [FAV] : []), ...cats, ...(hasNone ? [NONE] : [])];
    if (!all.includes(filter)) filter = ALL;
    chipsEl.replaceChildren(...all.map(c => h('button', { class: 'fchip' + (c === filter ? ' on' : ''), onclick: () => {
      filter = c; setPref('lib.filter', c); renderChips(); renderList();
    } }, c)));
  };

  const renderList = () => {
    const q = norm(query.trim());
    let shown = pieces.filter(p => {
      if (filter === FAV && !p.favorite) return false;
      if (filter === NONE && p.category) return false;
      if (filter !== ALL && filter !== FAV && filter !== NONE && p.category !== filter) return false;
      if (!q) return true;
      const hay = norm([p.title, p.composer, p.category, ...(p.tags ?? []), p.note].filter(Boolean).join(' '));
      return q.split(/\s+/).every(w => hay.includes(w));
    });
    const cmp: Record<SortKey, (a: Piece, b: Piece) => number> = {
      recent: (a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0) || b.addedAt - a.addedAt,
      added: (a, b) => b.addedAt - a.addedAt,
      title: (a, b) => a.title.localeCompare(b.title, 'fr'),
      composer: (a, b) => (a.composer ?? '~').localeCompare(b.composer ?? '~', 'fr') || a.title.localeCompare(b.title, 'fr'),
      difficulty: (a, b) => (a.difficulty ?? 9) - (b.difficulty ?? 9) || a.title.localeCompare(b.title, 'fr'),
      plays: (a, b) => (b.playCount ?? 0) - (a.playCount ?? 0)
    };
    shown = shown.sort(cmp[sort]);
    countEl.textContent = `${shown.length} / ${pieces.length}`;
    if (!pieces.length) {
      listEl.replaceChildren(h('p', { class: 'empty' }, 'Aucune partition pour le moment. Importez un fichier MusicXML ou MIDI.'));
      return;
    }
    if (!shown.length) {
      listEl.replaceChildren(h('p', { class: 'empty' }, 'Aucune partition ne correspond.'));
      return;
    }
    listEl.replaceChildren(...shown.map(p => h('div', { class: 'piece' }, [
      h('button', { class: 'icon fav' + (p.favorite ? ' is-fav' : ''), title: 'Favori', onclick: async () => {
        p.favorite = !p.favorite; await savePiece(p); renderChips(); renderList();
      } }, p.favorite ? '★' : '☆'),
      h('button', { class: 'piece-main', onclick: () => open(p) }, [
        h('div', { class: 'piece-title' }, p.title),
        h('div', { class: 'piece-sub' }, [
          p.composer ? h('span', { class: 'composer' }, p.composer) : null,
          p.category ? h('span', { class: 'cat' }, p.category) : null,
          ...(p.tags ?? []).map(t => h('span', { class: 'tagchip' }, '#' + t)),
          p.difficulty ? h('span', { class: 'diff', title: `Difficulté ${p.difficulty}/5` }, stars(p.difficulty)) : null,
          p.bestRun ? h('span', { class: 'rec' }, `record ${p.bestRun.wrong} faute${p.bestRun.wrong > 1 ? 's' : ''} · ${fmtTime(p.bestRun.seconds)}`) : null,
          !p.composer && !p.category && !p.tags?.length && !p.bestRun
            ? h('span', {}, p.source === 'midi' ? 'MIDI' : p.source === 'demo' ? 'Exemple' : p.source === 'scan' ? 'PDF / photo' : p.source === 'pcn' ? 'Codification PCN' : 'MusicXML') : null
        ])
      ]),
      h('button', { class: 'icon', title: 'Fiche, classement', onclick: () => editPiece(p) }, '✎')
    ])));
  };

  // ---------- page ----------
  const search = h('input', { type: 'search', class: 'search', placeholder: '🔍 Rechercher : titre, compositeur, catégorie, étiquette…' }) as HTMLInputElement;
  search.addEventListener('input', () => { query = search.value; renderList(); });
  const sortSel = h('select', { title: 'Trier', onchange: (e: Event) => {
    sort = (e.target as HTMLSelectElement).value as SortKey; setPref('lib.sort', sort); renderList();
  } }, SORTS.map(([k, t]) => {
    const o = h('option', { value: k }, t) as HTMLOptionElement;
    if (k === sort) o.selected = true;
    return o;
  }));

  // ---------- compte ----------
  const accountBtn = h('button', { class: 'account' });
  const paintAccount = (st: SyncState) => {
    const s = getSession();
    if (!s) { accountBtn.textContent = '👤 Se connecter'; accountBtn.className = 'account off'; return; }
    const icon = st.state === 'syncing' ? '⟳' : st.state === 'ok' ? '✓' : st.state === 'offline' ? '⚡' : st.state === 'error' ? '⚠' : '';
    accountBtn.textContent = `👤 ${s.user.name} ${icon}`;
    accountBtn.className = 'account ' + st.state;
    accountBtn.title = st.state === 'ok' ? 'Synchronisé' : st.state === 'offline' ? `Serveur injoignable (VPN ?) — ${st.pending} modification(s) en attente` : st.state === 'error' ? st.message : 'Synchronisation…';
  };
  unsubSync.forEach(f => f());
  unsubSync = [onSyncState(paintAccount), onRemoteChange(() => void reload())];
  const openAccount = () => {
    const s = getSession();
    if (!s) {
      const server = h('input', { value: pref('server', DEFAULT_SERVER), autocomplete: 'off', inputmode: 'url' }) as HTMLInputElement;
      const user = h('input', { autocomplete: 'username', autocapitalize: 'off' }) as HTMLInputElement;
      const pass = h('input', { type: 'password', autocomplete: 'current-password' }) as HTMLInputElement;
      const msg = h('p', { class: 'meta bad' });
      const name = h('input', { autocomplete: 'name' }) as HTMLInputElement;
      const nameField = h('label', { class: 'field', style: 'display:none' }, [h('span', {}, 'Votre prénom (affiché dans l\'appli)'), name]);
      const intro = h('p', { class: 'meta' });
      let setupMode = false;
      const checkSetup = async () => {
        try {
          const r = await request<{ needsSetup: boolean }>(server.value.trim(), 'GET', '/api/setup');
          setupMode = r.needsSetup;
        } catch { setupMode = false; }
        nameField.style.display = setupMode ? '' : 'none';
        intro.textContent = setupMode
          ? 'Premier lancement : créez le compte administrateur (le vôtre). Vous pourrez ensuite créer les autres comptes depuis « Mon compte ».'
          : '';
        go.textContent = setupMode ? 'Créer mon compte' : 'Se connecter';
      };
      server.addEventListener('change', () => void checkSetup());
      const body = h('div', { class: 'form' }, [
        intro,
        nameField,
        h('p', { class: 'meta' }, 'Connectez-vous pour retrouver votre répertoire et votre progression sur tous vos appareils. Chaque personne a son propre compte. Activez le VPN pour joindre le serveur.'),
        h('label', { class: 'field' }, [h('span', {}, 'Identifiant'), user]),
        h('label', { class: 'field' }, [h('span', {}, 'Mot de passe'), pass]),
        h('details', {}, [h('summary', { class: 'meta' }, 'Adresse du serveur'), h('label', { class: 'field' }, [server])]),
        msg
      ]);
      const go = h('button', { class: 'primary', onclick: async () => {
        msg.textContent = '';
        go.setAttribute('disabled', '');
        try {
          setPref('server', server.value.trim());
          if (setupMode) {
            if (pass.value.length < 6) throw new Error('Mot de passe : 6 caractères minimum.');
            const r = await request<{ token: string; user: { id: number; login: string; name: string; admin?: boolean } }>(
              server.value.trim(), 'POST', '/api/setup', { login: user.value.trim(), name: name.value.trim() || user.value.trim(), password: pass.value });
            setSession({ server: server.value.trim().replace(/\/+$/, ''), token: r.token, user: r.user });
          } else {
            await login(server.value.trim(), user.value.trim(), pass.value);
          }
          close();
          const local = (await listIn('local')).filter(p => !p.id.startsWith('rep-'));
          if (local.length && confirm(`Rattacher à votre compte les ${local.length} partition(s) déjà présentes sur ce téléphone ?`)) await adoptLocalPieces();
          await seedRepertoire();
          await reload();
          toast(`Bonjour ${getSession()?.user.name} !`);
          void syncNow();
        } catch (e) {
          msg.textContent = (e as Error).message;
        } finally { go.removeAttribute('disabled'); }
      } }, 'Se connecter');
      const close = openModal('Connexion', body, [h('span', { class: 'spacer' }), h('button', { onclick: () => close() }, 'Annuler'), go]);
      void checkSetup();
      setTimeout(() => user.focus(), 50);
      return;
    }
    const state = h('p', { class: 'meta' });
    const un = onSyncState(st => {
      state.textContent = st.state === 'ok' ? `Synchronisé à ${new Date(st.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.`
        : st.state === 'syncing' ? 'Synchronisation en cours…'
        : st.state === 'offline' ? `Serveur injoignable (VPN activé ?). ${st.pending} modification(s) attendent d'être envoyées.`
        : st.state === 'error' ? st.message : '';
    });
    const newPass = h('input', { type: 'password', autocomplete: 'new-password', placeholder: '6 caractères minimum' }) as HTMLInputElement;
    const passMsg = h('p', { class: 'meta' });
    const passBox = h('div', { class: 'row-field' }, [newPass, h('button', { onclick: async () => {
      try {
        if (newPass.value.length < 6) throw new Error('6 caractères minimum.');
        await api('POST', '/api/me/password', { password: newPass.value });
        newPass.value = ''; passMsg.className = 'meta ok'; passMsg.textContent = 'Mot de passe changé.';
      } catch (e) { passMsg.className = 'meta bad'; passMsg.textContent = (e as Error).message; }
    } }, 'Changer')]);
    const adminBox = h('div', { class: 'form' });
    if (s.user.admin) {
      const list = h('div', { class: 'users' });
      const refresh = async () => {
        try {
          const users = await api<{ login: string; name: string; admin: boolean }[]>('GET', '/api/users');
          list.replaceChildren(...users.map(u => h('div', { class: 'user-row' }, [
            h('span', {}, `${u.name} (${u.login})${u.admin ? ' — administrateur' : ''}`),
            h('button', { onclick: async () => {
              const p = prompt(`Nouveau mot de passe pour ${u.name} (6 caractères minimum) :`);
              if (!p) return;
              try { await api('POST', `/api/users/${encodeURIComponent(u.login)}/password`, { password: p }); toast('Mot de passe changé'); }
              catch (e) { toast((e as Error).message, 4000); }
            } }, 'Mot de passe…')
          ])));
        } catch (e) { list.textContent = (e as Error).message; }
      };
      const nl = h('input', { placeholder: 'identifiant (ex. adam)', autocapitalize: 'off' }) as HTMLInputElement;
      const nn = h('input', { placeholder: 'prénom affiché' }) as HTMLInputElement;
      const np = h('input', { type: 'password', placeholder: 'mot de passe (6 min.)', autocomplete: 'new-password' }) as HTMLInputElement;
      const addMsg = h('p', { class: 'meta' });
      adminBox.append(
        h('h3', {}, 'Comptes'), list,
        h('div', { class: 'add-user' }, [nl, nn, np, h('button', { class: 'primary', onclick: async () => {
          try {
            await api('POST', '/api/users', { login: nl.value.trim(), name: nn.value.trim() || nl.value.trim(), password: np.value });
            addMsg.className = 'meta ok'; addMsg.textContent = `Compte « ${nl.value.trim()} » créé.`;
            nl.value = nn.value = np.value = '';
            void refresh();
          } catch (e) { addMsg.className = 'meta bad'; addMsg.textContent = (e as Error).message.includes('pattern') ? 'Identifiant : lettres, chiffres, . - _ uniquement.' : (e as Error).message; }
        } }, 'Créer le compte')]),
        addMsg
      );
      void refresh();
    }
    const body = h('div', { class: 'form' }, [
      h('h3', {}, s.user.name),
      h('p', { class: 'meta' }, `Identifiant : ${s.user.login} · serveur ${s.server}`),
      state,
      h('p', { class: 'meta' }, 'Vos partitions, fiches, originaux et scores sont gardés sur cet appareil et enregistrés sur le serveur dès qu\'il est joignable.'),
      h('label', { class: 'field' }, [h('span', {}, 'Changer mon mot de passe'), passBox]),
      passMsg,
      adminBox
    ]);
    const close = openModal('Mon compte', body, [
      h('button', { class: 'danger', onclick: async () => {
        if (!confirm('Se déconnecter ? Vos données restent sur le serveur et sur ce téléphone (invisibles tant que vous n\'êtes pas reconnecté).')) return;
        await logout();
        close();
        await seedRepertoire();
        await reload();
      } }, 'Se déconnecter'),
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => void syncNow() }, '⟳ Synchroniser'),
      h('button', { class: 'primary', onclick: () => close() }, 'Fermer')
    ], un);
  };
  accountBtn.addEventListener('click', openAccount);

  const chip = h('div', { class: 'chip' });
  unsubMidi?.();
  unsubMidi = midiInput.onStatus(s => {
    chip.className = 'chip ' + (s.state === 'connected' ? 'ok' : 'warn');
    chip.textContent = (s.state === 'connected' ? '🎹 ' : '⚠ ') + statusLabel(s);
  });

  app.replaceChildren(h('div', { class: 'library' }, [
    h('header', { class: 'lib-head' }, [
      h('img', { src: 'icon.svg', alt: '', class: 'logo' }),
      h('div', {}, [h('h1', {}, 'Piano Compagnon'), h('div', { class: 'tag' }, 'La partition avance quand vous jouez juste.')]),
      chip,
      accountBtn,
      h('button', { class: 'icon', title: 'Réglages', onclick: () => openSettings() }, '⚙')
    ]),
    h('div', { class: 'actions' }, [
      h('button', { class: 'primary big-btn', onclick: () => fileInput.click() }, '＋ Importer (PDF, photo, MusicXML, MIDI)'),
      h('button', { class: 'cam-btn', title: 'Photographier une page de partition', onclick: () => cameraInput.click() }, '📷'),
      h('button', { class: 'cat-btn', title: 'Catalogue de pièces célèbres', onclick: () => openCatalogue(() => void reload(), id => open({ id } as Piece)) }, '📚 Catalogue'),
      fileInput, cameraInput
    ]),
    h('div', { class: 'lib-title' }, [h('h2', {}, 'Mes partitions'), countEl]),
    h('div', { class: 'lib-tools' }, [search, sortSel]),
    chipsEl,
    listEl,
    h('h2', {}, 'Apprendre'),
    h('div', { class: 'learn-grid' }, EXERCISES.map(e => {
      const st = getStats(e.id);
      return h('button', { class: 'learn-card', onclick: () => { unlockAudio(); location.hash = `#/apprendre/${e.id}`; } }, [
        h('div', { class: 'lc-icon' }, e.icon),
        h('div', { class: 'lc-title' }, e.title),
        h('div', { class: 'lc-desc' }, e.desc),
        st.total ? h('div', { class: 'lc-stats' }, `${st.total} réussites · meilleure série ${st.best}`) : null
      ]);
    })),
    h('details', { class: 'help' }, [
      h('summary', {}, 'Brancher le piano et trouver des partitions'),
      h('div', { html: `
        <p><b>Branchement :</b> câble USB-C (téléphone) vers USB-B (prise carrée à l'arrière du piano). Le voyant en haut passe au vert avec le nom du piano.</p>
        <p><b>Formats acceptés :</b> PDF et photos (lus par Claude : renseignez votre clé dans ⚙), codification PCN (<code>.pcn</code>), MusicXML (<code>.musicxml</code>, <code>.xml</code>, <code>.mxl</code>) et MIDI (<code>.mid</code>). Plusieurs photos importées ensemble = les pages d'un même morceau. Une partition lue par photo peut contenir des erreurs : écoutez-la avec ▶ pour vérifier.</p>
        <p><b>Où trouver des partitions :</b> MuseScore (exporter en MusicXML), IMSLP / Mutopia (domaine public), ou tout fichier MIDI.</p>
        <p><b>Classer :</b> touchez ✎ pour renseigner compositeur, catégorie, étiquettes, difficulté. ☆ met en favori.</p>
        <p><b>Pendant le jeu :</b> la note attendue s'allume sur le clavier (bleu = main droite, orange = main gauche). Touchez une mesure pour y aller, ⟲ pour répéter un passage. En « MD » ou « MG », l'appli joue l'autre main pour vous.</p>` })
    ])
  ]));
  renderChips();
  renderList();
}
