// Originaux des partitions lues par photo ou PDF : conservés à côté de la codification,
// localement et sur le serveur (récupérés à la demande sur un autre appareil).

import { get, set, del } from 'idb-keyval';
import { h } from './ui';
import { origKey, markOriginalsDirty, getSession } from './storage';
import { api } from './api';

export interface OriginalFile { name: string; type: string; blob: Blob }

const isPdf = (f: { name: string; type: string }) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

export async function saveOriginals(id: string, files: File[]): Promise<void> {
  await set(origKey(id), files.map(f => ({ name: f.name, type: f.type || (isPdf(f) ? 'application/pdf' : 'image/jpeg'), blob: f })));
  await markOriginalsDirty(id);
}

export async function getOriginals(id: string): Promise<OriginalFile[]> {
  return (await get<OriginalFile[]>(origKey(id))) ?? [];
}

export async function deleteOriginals(id: string): Promise<void> {
  await del(origKey(id));
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Originaux locaux, ou téléchargés depuis le serveur s'ils n'ont pas encore été récupérés. */
async function loadOriginals(id: string): Promise<OriginalFile[]> {
  const local = await getOriginals(id);
  if (local.length || !getSession()) return local;
  const r = await api<{ files: { name: string; type: string; data: string }[] }>('GET', `/api/originals/${encodeURIComponent(id)}`, undefined, 60000);
  const files = r.files.map(f => ({ name: f.name, type: f.type, blob: base64ToBlob(f.data, f.type) }));
  if (files.length) await set(origKey(id), files);
  return files;
}

/** Affiche les originaux (photos, et pages des PDF) dans un conteneur. */
export async function renderOriginals(container: HTMLElement, id: string): Promise<void> {
  container.replaceChildren(h('p', { class: 'meta' }, 'Chargement de l\'original…'));
  let files: OriginalFile[];
  try { files = await loadOriginals(id); } catch (e) {
    container.replaceChildren(h('p', { class: 'meta' }, `Original indisponible : ${(e as Error).message}`));
    return;
  }
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
      out.push(h('img', { class: 'orig-page', alt: f.name, src: URL.createObjectURL(f.blob) }));
    }
  }
  container.replaceChildren(...out);
}
