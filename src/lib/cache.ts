/**
 * Persistent page cache (IndexedDB).
 *
 * Translation data and rendering data are cached separately so that a change to
 * the renderer never throws away OCR/translation work, and so that unmounting a
 * page from the DOM never destroys its processed result.
 *
 * Stable key shape:
 *   <chapterId>_page<NNN>_<sourceHash>_<targetLanguage>_<stageVersion>
 */

export const TRANSLATION_VERSION = "t4";
export const RENDER_VERSION = "r4";

const DB_NAME = "mangalens";
const DB_VERSION = 1;
const STORE_TRANSLATION = "translations";
const STORE_RENDER = "renders";
const STORE_META = "meta";

/** Soft caps so a 100+ page chapter cannot exhaust browser storage. */
const MAX_RENDER_ENTRIES = 80;
const MAX_RENDER_BYTES = 3_500_000;

type Store = typeof STORE_TRANSLATION | typeof STORE_RENDER | typeof STORE_META;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of [STORE_TRANSLATION, STORE_RENDER, STORE_META]) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function tx<T>(
  store: Store,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(store, mode);
      const req = run(t.objectStore(store));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function idbGet<T>(store: Store, key: string): Promise<T | null> {
  const value = await tx<T>(store, "readonly", (s) => s.get(key) as IDBRequest<T>);
  return value ?? null;
}

export async function idbSet(store: Store, key: string, value: unknown): Promise<void> {
  await tx(store, "readwrite", (s) => s.put(value, key) as IDBRequest<IDBValidKey>);
}

export async function idbDelete(store: Store, key: string): Promise<void> {
  await tx(store, "readwrite", (s) => s.delete(key) as IDBRequest<undefined>);
}

export async function idbClearAll(): Promise<void> {
  for (const store of [STORE_TRANSLATION, STORE_RENDER, STORE_META] as Store[]) {
    await tx(store, "readwrite", (s) => s.clear() as IDBRequest<undefined>);
  }
}

async function keys(store: Store): Promise<string[]> {
  const result = await tx<IDBValidKey[]>(
    store,
    "readonly",
    (s) => s.getAllKeys() as IDBRequest<IDBValidKey[]>,
  );
  return (result ?? []).map(String);
}

/** Short, stable, non-cryptographic hash of the page source identity. */
export function sourceHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193;
    h2 = (h2 + c * 31) | 0;
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

export interface CacheIdentity {
  chapterId: string;
  pageIndex: number;
  sourceKey: string;
  targetLanguage: string;
}

function base(id: CacheIdentity) {
  return `${id.chapterId}_page${String(id.pageIndex).padStart(3, "0")}_${sourceHash(id.sourceKey)}_${id.targetLanguage}`;
}

export function translationKey(id: CacheIdentity) {
  return `${base(id)}_${TRANSLATION_VERSION}`;
}

export function renderKey(id: CacheIdentity) {
  return `${base(id)}_${RENDER_VERSION}`;
}

// ---- typed helpers ---------------------------------------------------------

export const translationCache = {
  get: <T>(id: CacheIdentity) => idbGet<T>(STORE_TRANSLATION, translationKey(id)),
  set: (id: CacheIdentity, value: unknown) =>
    idbSet(STORE_TRANSLATION, translationKey(id), value),
  drop: (id: CacheIdentity) => idbDelete(STORE_TRANSLATION, translationKey(id)),
};

export const renderCache = {
  get: <T>(id: CacheIdentity) => idbGet<T>(STORE_RENDER, renderKey(id)),
  async set(id: CacheIdentity, value: unknown) {
    // Reconstruction plates are data URLs; skip pathologically large payloads
    // rather than filling the user's quota with one page.
    let bytes = 0;
    try {
      bytes = JSON.stringify(value).length;
    } catch {
      return;
    }
    if (bytes > MAX_RENDER_BYTES) return;
    await idbSet(STORE_RENDER, renderKey(id), value);
    void evictRenders(id.chapterId);
  },
  drop: (id: CacheIdentity) => idbDelete(STORE_RENDER, renderKey(id)),
};

/** Keeps the render store bounded, oldest keys first (keys sort by page). */
async function evictRenders(chapterId: string) {
  const all = await keys(STORE_RENDER);
  const mine = all.filter((k) => k.startsWith(`${chapterId}_`));
  const stale = all.filter((k) => !k.startsWith(`${chapterId}_`));
  for (const key of stale.slice(0, Math.max(0, stale.length - MAX_RENDER_ENTRIES))) {
    await idbDelete(STORE_RENDER, key);
  }
  if (mine.length > MAX_RENDER_ENTRIES) {
    for (const key of mine.slice(0, mine.length - MAX_RENDER_ENTRIES)) {
      await idbDelete(STORE_RENDER, key);
    }
  }
}

// ---- reading position ------------------------------------------------------

export interface ReadingPosition {
  chapterId: string;
  pageIndex: number;
  scrollY: number;
  mode: string;
  targetLanguage: string;
  fullscreen: boolean;
  updatedAt: number;
}

export async function saveReadingPosition(pos: ReadingPosition) {
  await idbSet(STORE_META, `pos:${pos.chapterId}`, pos);
}

export function loadReadingPosition(chapterId: string) {
  return idbGet<ReadingPosition>(STORE_META, `pos:${chapterId}`);
}
