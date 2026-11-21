// Appels au serveur Piano Compagnon.
// Dans l'APK : requêtes natives (CapacitorHttp), qui atteignent le serveur en http via le VPN.
// Dans un navigateur : fetch classique.

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { getSession } from './storage';

export const DEFAULT_SERVER = 'http://192.168.1.240:8010';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** status 0 = serveur injoignable (pas de VPN, pas de réseau). */
export async function request<T>(server: string, method: string, path: string, body?: unknown, token?: string, timeoutMs = 15000): Promise<T> {
  const url = server.replace(/\/+$/, '') + path;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let status: number;
  let data: unknown;
  try {
    if (Capacitor.isNativePlatform()) {
      const r = await CapacitorHttp.request({ url, method, headers, data: body, connectTimeout: 6000, readTimeout: timeoutMs, responseType: 'json' });
      status = r.status;
      data = typeof r.data === 'string' && r.data ? JSON.parse(r.data) : r.data;
    } else {
      const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      status = r.status;
      data = await r.json().catch(() => null);
    }
  } catch {
    throw new ApiError(0, 'Serveur injoignable (VPN activé ?)');
  }
  if (status >= 400) {
    const detail = (data as { detail?: unknown } | null)?.detail;
    throw new ApiError(status, typeof detail === 'string' ? detail : `Erreur ${status}`);
  }
  return data as T;
}

/** Appel authentifié avec la session courante. */
export async function api<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const s = getSession();
  if (!s) throw new ApiError(401, 'Non connecté');
  return request<T>(s.server, method, path, body, s.token, timeoutMs);
}
