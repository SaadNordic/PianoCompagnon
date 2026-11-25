# My Music Inst

Application de travail du piano : vous importez une partition, vous branchez votre piano numérique en USB-MIDI,
et la partition n'avance que lorsque vous jouez les bonnes notes (mode attente).

- Partitions : MusicXML (`.xml`, `.musicxml`, `.mxl`) et MIDI (`.mid`, converti en partition deux portées)
- Deux mains, main droite ou main gauche (l'appli joue l'autre main), boucle de mesures, écoute au tempo
- Apprendre : lecture de notes, accords, gammes, oreille
- Application web installable (PWA) : Chrome sur Android. Sur iPad, passer par un navigateur compatible Web MIDI.

Développement : `npm install`, puis `npm run dev`.
