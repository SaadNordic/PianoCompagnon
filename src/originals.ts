// Originaux des partitions lues par photo ou PDF : conservés à côté de la codification.

import { get, set, del } from 'idb-keyval';
import { h } from './ui';

export interface OriginalFile { name: string; type: string; blob: Blob }

const KEY = (id: string) => 'orig:' + id;
const isPdf = (f: { name: string; type: string }) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

export async function saveOriginals(id: string, files: File[]): Promise<void> {
  await set(KEY(id), files.map(f => ({ name: f.name, type: f.type || (isPdf(f) ? 'application/pdf' : 'image/jpeg'), blob: f })));
}

export async function getOriginals(id: string): Promise<OriginalFile[]> {
  return (await get<OriginalFile[]>(KEY(id))) ?? [];
}

export async function deleteOriginals(id: string): Promise<void> {
  await del(KEY(id));
}

/** Affiche les originaux (photos, et pages des PDF) dans un conteneur. */
export async function renderOriginals(container: HTMLElement, id: string): Promise<void> {
  container.replaceChildren(h('p', { class: 'meta' }, 'Chargement de l\'original…'));
  const files = await getOriginals(id);
  if (!files.length) { container.replaceChildren(h('p', { class: 'meta' }, 'Aucun original enregistré pour cette partition.')); return; }
  const out: HTMLElement[] = [];
  for (const f of files) {
    if (isPdf(f)) {
      try {
        const pdfjs = await import('pdfjs-dist');
        const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        const doc = await pdfjs.getDocument({ data: new Uint8Array(await f.blob.arrayBuffer()) }).promise;
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const viewport = page.getViewport({ scale: 2 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.className = 'orig-page';
          await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
          out.push(canvas);
        }
      } catch (e) {
        out.push(h('p', { class: 'meta' }, `Impossible d'afficher le PDF « ${f.name} » : ${(e as Error).message}`));
      }
    } else {
      const img = h('img', { class: 'orig-page', alt: f.name, src: URL.createObjectURL(f.blob) });
      out.push(img);
    }
  }
  container.replaceChildren(...out);
}
