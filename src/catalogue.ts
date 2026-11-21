// Catalogue de pièces célèbres du domaine public, téléchargées à la demande depuis le
// Mutopia Project (partitions libres, fichiers MIDI). Chaque entrée indique sa licence.

export interface CatalogueItem {
  id: string;
  title: string;
  composer: string;
  difficulty: number; // 1 (facile) à 5 (virtuose), estimation
  path: string; // chemin sous https://www.mutopiaproject.org/ftp/
  license: string;
}

const PD = 'domaine public';
const BYSA3 = 'CC BY-SA 3.0';
const BYSA4 = 'CC BY-SA 4.0';

const bach = (id: string, title: string, difficulty: number, path: string, license = PD): CatalogueItem =>
  ({ id: 'cat-bach-' + id, title, composer: 'J. S. Bach', difficulty, path: 'BachJS/' + path, license });
const lvb = (id: string, title: string, difficulty: number, path: string, license = PD): CatalogueItem =>
  ({ id: 'cat-lvb-' + id, title, composer: 'Beethoven', difficulty, path: 'BeethovenLv/' + path, license });
const chopin = (id: string, title: string, difficulty: number, path: string, license = PD): CatalogueItem =>
  ({ id: 'cat-chopin-' + id, title, composer: 'Chopin', difficulty, path: 'ChopinFF/' + path, license });
const other = (composer: string, dir: string, id: string, title: string, difficulty: number, path: string, license = PD): CatalogueItem =>
  ({ id: `cat-${dir.toLowerCase()}-${id}`, title, composer, difficulty, path: `${dir}/${path}`, license });
const mozart = (id: string, t: string, d: number, p: string, l = PD) => other('Mozart', 'MozartWA', id, t, d, p, l);
const satie = (id: string, t: string, d: number, p: string, l = PD) => other('Satie', 'SatieE', id, t, d, p, l);
const debussy = (id: string, t: string, d: number, p: string, l = PD) => other('Debussy', 'DebussyC', id, t, d, p, l);
const schumann = (id: string, t: string, d: number, p: string, l = PD) => other('Schumann', 'SchumannR', id, t, d, p, l);
const schubert = (id: string, t: string, d: number, p: string, l = PD) => other('Schubert', 'SchubertF', id, t, d, p, l);

export const CATALOGUE: CatalogueItem[] = [
  // ---------- Bach ----------
  bach('anh114', 'Menuet en sol majeur (BWV Anh. 114)', 2, 'BWVAnh114/anna-magdalena-04/anna-magdalena-04.mid'),
  bach('anh115', 'Menuet en sol mineur (BWV Anh. 115)', 2, 'BWVAnh115/anna-magdalena-05/anna-magdalena-05.mid'),
  bach('anh113', 'Menuet en fa majeur (BWV Anh. 113)', 1, 'BWVAnh113/anna-magdalena-03/anna-magdalena-03.mid'),
  bach('anh120', 'Menuet en la mineur (BWV Anh. 120)', 1, 'BWVAnh120/BWV-120/BWV-120.mid'),
  bach('anh121', 'Menuet en do mineur (BWV Anh. 121)', 2, 'BWVAnh121/BWV-121/BWV-121.mid'),
  bach('anh126', 'Musette en ré majeur (BWV Anh. 126)', 2, 'BWVAnh126/anna-magdalena-22/anna-magdalena-22.mid'),
  bach('anh127', 'Marche en mi bémol majeur (BWV Anh. 127)', 2, 'BWVAnh127/BWV-127/BWV-127.mid'),
  bach('anh119', 'Polonaise en sol mineur (BWV Anh. 119)', 2, 'BWVAnh119/BWV-119/BWV-119.mid'),
  bach('926', 'Petit prélude en ré mineur (BWV 926)', 2, 'BWV926/bach-praeludium-02/bach-praeludium-02.mid'),
  bach('846p', 'Prélude n° 1 en do majeur — Clavier bien tempéré (BWV 846)', 3, 'BWV846/wtk1-prelude1/wtk1-prelude1.mid'),
  bach('846f', 'Fugue n° 1 en do majeur — Clavier bien tempéré (BWV 846)', 4, 'BWV846/wtk1-fugue1/wtk1-fugue1.mid'),
  bach('847p', 'Prélude n° 2 en do mineur — Clavier bien tempéré (BWV 847)', 4, 'BWV847/bwv847a/bwv847a.mid'),
  bach('848p', 'Prélude n° 3 en do dièse majeur (BWV 848)', 4, 'BWV848/bwv848a/bwv848a.mid'),
  bach('772', 'Invention à 2 voix n° 1 en do majeur (BWV 772)', 3, 'BWV772/bach-invention-01/bach-invention-01.mid', BYSA3),
  bach('775', 'Invention à 2 voix n° 4 en ré mineur (BWV 775)', 3, 'BWV775/bach-invention-04/bach-invention-04.mid'),
  bach('779', 'Invention à 2 voix n° 8 en fa majeur (BWV 779)', 3, 'BWV779/bach-invention-08/bach-invention-08.mid'),
  bach('784', 'Invention à 2 voix n° 13 en la mineur (BWV 784)', 3, 'BWV784/bach-invention-13/bach-invention-13.mid'),
  bach('787', 'Sinfonia n° 1 en do majeur (BWV 787)', 4, 'BWV787/bwv787/bwv787.mid'),
  bach('988a', 'Variations Goldberg — Aria (BWV 988)', 4, 'BWV988/bwv-988-aria/bwv-988-aria.mid', BYSA3),
  bach('1056', 'Arioso (BWV 1056)', 3, 'BWV1056/arioso/arioso.mid', 'CC BY 3.0'),
  bach('haupt', 'Choral « O Haupt voll Blut und Wunden » (Passion selon saint Matthieu)', 2, 'O_Haupt_voll_Blut/O_Haupt_voll_Blut.mid'),
  bach('903', 'Fantaisie chromatique (BWV 903)', 5, 'BWV903/bwv903fan/bwv903fan.mid'),

  // ---------- Beethoven ----------
  lvb('elise', 'Lettre à Élise (WoO 59), complète', 3, 'WoO59/fur_Elise_WoO59/fur_Elise_WoO59.mid'),
  lvb('woo82', 'Menuet en mi bémol majeur (WoO 82)', 2, 'WoO82/menuett_WoO82/menuett_WoO82.mid'),
  lvb('woo55', 'Prélude en fa mineur (WoO 55)', 3, 'WoO55/prelude_WoO55/prelude_WoO55.mid'),
  lvb('49-1-1', 'Sonate facile op. 49 n° 1 — Andante', 3, 'O49/LVB_Sonate_49no1_1/LVB_Sonate_49no1_1.mid'),
  lvb('49-1-2', 'Sonate facile op. 49 n° 1 — Rondo', 3, 'O49/LVB_Sonate_49no1_2/LVB_Sonate_49no1_2.mid'),
  lvb('49-2-1', 'Sonate facile op. 49 n° 2 — Allegro ma non troppo', 3, 'O49/LVB_Sonate_49no2_1/LVB_Sonate_49no2_1.mid'),
  lvb('49-2-2', 'Sonate facile op. 49 n° 2 — Tempo di Menuetto', 3, 'O49/LVB_Sonate_49no2_2/LVB_Sonate_49no2_2.mid'),
  lvb('path-2', 'Sonate « Pathétique » — Adagio cantabile (2e mouvement)', 4, 'O13/pathetique-2/pathetique-2.mid'),
  lvb('path-1', 'Sonate « Pathétique » — Grave, Allegro (1er mouvement)', 5, 'O13/pathetique-1/pathetique-1.mid'),
  lvb('path-3', 'Sonate « Pathétique » — Rondo (3e mouvement)', 5, 'O13/pathetique-3/pathetique-3.mid'),
  lvb('tempete', 'Sonate « La Tempête » op. 31 n° 2 — 1er mouvement', 5, 'O31/LVB_Sonate_31no2_1/LVB_Sonate_31no2_1.mid'),
  lvb('tempete-2', 'Sonate « La Tempête » op. 31 n° 2 — Adagio', 4, 'O31/LVB_Sonate_31no2_2/LVB_Sonate_31no2_2.mid'),
  lvb('appass-2', 'Sonate « Appassionata » — Andante con moto', 4, 'O57/LVB_Sonate_57_2/LVB_Sonate_57_2.mid'),
  lvb('79-1', 'Sonate op. 79 — Presto alla tedesca', 4, 'O79/LVB_Sonate_79_1/LVB_Sonate_79_1.mid'),
  lvb('79-2', 'Sonate op. 79 — Andante', 3, 'O79/LVB_Sonate_79_2/LVB_Sonate_79_2.mid'),
  lvb('2-1-1', 'Sonate n° 1 op. 2 n° 1 — Allegro', 4, 'O2/LVB_Sonate_02no1_1/LVB_Sonate_02no1_1.mid'),
  lvb('rondo129', 'Rondo a capriccio « La colère pour un sou perdu » (op. 129)', 5, 'O129/beethoven_rondo_op129/beethoven_rondo_op129.mid'),
  lvb('sym5', 'Symphonie n° 5 — réduction pour piano', 5, 'O67/beethoven_fifth_op67/beethoven_fifth_op67.mid'),

  // ---------- Chopin ----------
  chopin('p4', 'Prélude op. 28 n° 4 en mi mineur', 3, 'O28/Chop-28-4/Chop-28-4.mid'),
  chopin('p6', 'Prélude op. 28 n° 6 en si mineur', 3, 'O28/Chop-28-6/Chop-28-6.mid'),
  chopin('p7', 'Prélude op. 28 n° 7 en la majeur', 2, 'O28/Chop-28-7/Chop-28-7.mid'),
  chopin('p9', 'Prélude op. 28 n° 9 en mi majeur', 3, 'O28/Chop-28-9/Chop-28-9.mid', BYSA4),
  chopin('p15', 'Prélude op. 28 n° 15 « La Goutte d\'eau »', 4, 'O28/Chop-28-15/Chop-28-15.mid'),
  chopin('p20', 'Prélude op. 28 n° 20 en do mineur', 3, 'O28/Chop-28-20/Chop-28-20.mid'),
  chopin('p45', 'Prélude op. 45 en do dièse mineur', 4, 'O45/chopin_prelude_op45/chopin_prelude_op45.mid'),
  chopin('n9-2', 'Nocturne op. 9 n° 2 en mi bémol majeur', 4, 'O9/chopin_nocturne_op9_n2/chopin_nocturne_op9_n2.mid', BYSA3),
  chopin('n9-1', 'Nocturne op. 9 n° 1 en si bémol mineur', 4, 'O9/nocturne_in_b-flat_minor/nocturne_in_b-flat_minor.mid', 'CC BY-SA 2.5'),
  chopin('n72', 'Nocturne posthume en mi mineur (op. 72 n° 1)', 4, 'O72/nocturne_in_e_minor/nocturne_in_e_minor.mid', BYSA4),
  chopin('n27-2', 'Nocturne op. 27 n° 2 en ré bémol majeur', 5, 'O27/chopin-nocturne-8/chopin-nocturne-8.mid', BYSA3),
  chopin('v69-2', 'Valse op. 69 n° 2 en si mineur', 3, 'O69/w10-h-moll-cfi/w10-h-moll-cfi.mid'),
  chopin('v64-1', 'Valse op. 64 n° 1 « Valse minute »', 4, 'O64/chopin_valse_op64_no1/chopin_valse_op64_no1.mid'),
  chopin('m6-1', 'Mazurka op. 6 n° 1', 3, 'O6/Mazurka-Op6-No1/Mazurka-Op6-No1.mid', 'CC BY 3.0'),
  chopin('m33-1', 'Mazurka op. 33 n° 1', 3, 'O33/Mazurka-Op33-No1/Mazurka-Op33-No1.mid', 'CC BY 3.0'),
  chopin('fi66', 'Fantaisie-Impromptu op. 66', 5, 'O66/chopin_fantaisie-impromptu/chopin_fantaisie-impromptu.mid'),
  chopin('b1', 'Ballade n° 1 en sol mineur op. 23', 5, 'O23/chopin-op23-ballade-1/chopin-op23-ballade-1.mid', BYSA4),
  chopin('e10-12', 'Étude op. 10 n° 12 « Révolutionnaire »', 5, 'O10/op-10-12-wfi/op-10-12-wfi.mid'),
  chopin('e25-1', 'Étude op. 25 n° 1 « Harpe éolienne »', 5, 'O25/chopin-op-25-01/chopin-op-25-01.mid'),

  // ---------- Mozart ----------
  mozart('turque', 'Marche turque — Rondo alla turca (sonate K. 331)', 4, 'KV331/KV331_3_RondoAllaTurca/KV331_3_RondoAllaTurca.mid'),
  mozart('331-tema', 'Sonate K. 331 — Thème (Andante grazioso)', 3, 'KV331/KV331_1_1_tema/KV331_1_1_tema.mid'),
  mozart('545-1', 'Sonate facile K. 545 — Allegro', 3, 'KV545/K545-1/K545-1.mid', BYSA3),
  mozart('545-2', 'Sonate facile K. 545 — Andante', 3, 'KV545/K545-2/K545-2.mid', BYSA3),
  mozart('545-3', 'Sonate facile K. 545 — Rondo', 3, 'KV545/K545-3/K545-3.mid', BYSA3),
  mozart('397', 'Fantaisie en ré mineur K. 397', 4, 'KV397/Fantasia/Fantasia.mid'),

  // ---------- Satie, Debussy (France) ----------
  satie('gym1', 'Gymnopédie n° 1', 2, 'gymnopedie_1/gymnopedie_1.mid'),
  satie('gym2', 'Gymnopédie n° 2', 2, 'gymnopedie_2/gymnopedie_2.mid'),
  satie('gym3', 'Gymnopédie n° 3', 2, 'gymnopedie_3/gymnopedie_3.mid'),
  satie('gno1', 'Gnossienne n° 1', 3, 'Gnossienne/no_1/no_1.mid', BYSA4),
  satie('gno2', 'Gnossienne n° 2', 3, 'Gnossienne/no_2/no_2.mid', BYSA4),
  satie('gno3', 'Gnossienne n° 3', 3, 'Gnossienne/no_3/no_3.mid', BYSA4),
  debussy('clair', 'Clair de lune (Suite bergamasque)', 4, 'L75/debussy_Ste_Bergamesq_Clair/debussy_Ste_Bergamesq_Clair.mid'),
  debussy('arab1', 'Première Arabesque', 4, 'L66/debussy_Arabesque_1/debussy_Arabesque_1.mid'),
  debussy('arab2', 'Deuxième Arabesque', 4, 'L66/debussy_Arabesque_2/debussy_Arabesque_2.mid', BYSA4),

  // ---------- Schumann, Schubert, Grieg, Liszt ----------
  schumann('reverie', 'Rêverie — Träumerei (Scènes d’enfants)', 3, 'O15/SchumannOp15No07/SchumannOp15No07.mid'),
  schumann('pays', 'Des pays et des hommes étrangers (Scènes d’enfants)', 2, 'O15/SchumannOp15No01/SchumannOp15No01.mid'),
  schumann('melodie', 'Mélodie (Album pour la jeunesse)', 1, 'O68/schumann-op68-01-melodie/schumann-op68-01-melodie.mid', 'CC BY-SA 2.5'),
  schumann('laboureur', 'Le gai laboureur (Album pour la jeunesse)', 2, 'O68/schumann-op68-10-gai-laboureur/schumann-op68-10-gai-laboureur.mid', 'CC BY-SA 2.5'),
  schumann('cavalier', 'Le cavalier sauvage (Album pour la jeunesse)', 2, 'O68/schumann-op68-08-cavalier-sauvage/schumann-op68-08-cavalier-sauvage.mid', 'CC BY-SA 2.5'),
  schubert('imp2', 'Impromptu op. 90 n° 2 en mi bémol', 4, 'D899/SchubertF-D899-2-Impromptu/SchubertF-D899-2-Impromptu.mid'),
  schubert('imp3', 'Impromptu op. 90 n° 3 en sol bémol', 4, 'D899/SchubertF-D899-3-Impromptu/SchubertF-D899-3-Impromptu.mid'),
  schubert('imp4', 'Impromptu op. 90 n° 4 en la bémol', 4, 'D899/SchubertF-D899-4-Impromptu/SchubertF-D899-4-Impromptu.mid'),
  schubert('moment3', 'Moment musical n° 3 en fa mineur', 3, 'D780/MomentsNo3/MomentsNo3.mid'),
  schubert('marche1', 'Marche militaire n° 1 (piano)', 3, 'D733/SchubertF-D733-1-TroisMarches/SchubertF-D733-1-TroisMarches.mid'),
  other('Grieg', 'GriegE', 'roi', 'Dans l’antre du roi de la montagne (Peer Gynt)', 3, 'O46/Dans_l_antre_du_roi_de_la_montagne/Dans_l_antre_du_roi_de_la_montagne.mid'),
  other('Grieg', 'GriegE', 'trolls', 'Marche des trolls (Pièces lyriques)', 4, 'O54/Troldtog/Troldtog.mid'),
  other('Liszt', 'LisztF', 'consol3', 'Consolation n° 3', 4, 'S.172/liszt-consolation-no3/liszt-consolation-no3.mid', 'CC BY 3.0')
];

export const MUTOPIA = 'https://www.mutopiaproject.org/ftp/';
