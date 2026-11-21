# Piano Compagnon — guide pour Claude Code

Application personnelle de Saad (et de son fils) pour travailler le piano : partition affichée, piano numérique branché en USB-MIDI, la partition n'avance que sur les bonnes notes. Projet indépendant de Nordic Timber / ND.

## Stack
- **Appli** : Vite + TypeScript (sans framework), OpenSheetMusicDisplay pour la partition, emballée en **APK Android par Capacitor 8**.
- **MIDI** : plugin Java maison `android/app/src/main/java/app/pianocompagnon/MidiPlugin.java` (android.media.midi) dans l'APK ; Web MIDI dans un navigateur.
- **Serveur** (`serveur/`) : FastAPI, port **8010** sur `192.168.1.240` (accès VPN Fortinet), base SQL Server **PianoCompagnon** (mêmes identifiants SQL que NT). Tâche planifiée `PianoCompagnon` → `_run_piano.bat` (Python du venv NT).
- **Lecture PDF/photo** : API Claude depuis l'appli (`src/scan.ts`), clé saisie dans ⚙ sur le téléphone — jamais dans le code ni dans l'APK (dépôt et APK publics).

## Fichiers clés
- `src/codification.ts` — format maison **PCN** (une ligne par mesure). C'est la référence stockée ; le MusicXML en est régénéré à l'ouverture.
- `src/musicxml.ts` — notes → MusicXML (2 portées, voix multiples).
- `src/player.ts` — écran de jeu (mode attente, mains, boucle, écoute).
- `src/learn.ts` — modules Apprendre (lecture, accords, gammes, oreille).
- `src/storage.ts` / `src/sync.ts` / `src/api.ts` — stockage local par utilisateur + synchronisation.
- `src/repertoire.ts` — répertoire de départ (domaine public uniquement).

## Commandes
- Dev : `npm run dev` (port 5199 utilisé jusqu'ici), vérif : `npx tsc --noEmit`.
- **APK** : chaque push sur `main` → GitHub Actions compile, signe et publie
  `https://github.com/SaadNordic/PianoCompagnon/releases/latest/download/PianoCompagnon.apk`.
- Serveur : `serveur\deploy_serveur.bat` (mise à jour de l'API), `serveur\comptes.bat ajouter|motdepasse|liste`.

## Règles
- Clé de signature dans `cle-signature\` (ignorée par git) — ne jamais la publier ni la perdre.
- Aucun secret dans le dépôt (public) : `serveur\.env` est ignoré.
- Pas d'œuvres sous droits d'auteur dans le répertoire intégré.
- Textes de l'interface en français ; modals à taille fixe (seul le corps défile).
