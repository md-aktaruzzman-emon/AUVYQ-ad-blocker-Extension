/** Small promise-based IndexedDB wrapper used for larger bounded stores (threat log, pack staging). */

const DB_NAME = 'auvyq';
const DB_VERSION = 1;

export interface IdbStore {
  get<T>(store: string, key: string): Promise<T | undefined>;
  put<T>(store: string, key: string, value: T): Promise<void>;
  delete(store: string, key: string): Promise<void>;
  getAll<T>(store: string, limit: number): Promise<T[]>;
}

let dbPromise: Promise<IdbStore> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
  });
}

export function getIdb(): Promise<IdbStore> {
  if (dbPromise) return dbPromise;
  dbPromise = openDatabase().then((db) => {
    const run = <T>(store: string, mode: IDBTransactionMode, fn: (os: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = fn(tx.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
      });
    return {
      get: <T>(store: string, key: string) => run<T>(store, 'readonly', (os) => os.get(key) as IDBRequest<T>),
      put: async <T>(store: string, key: string, value: T) => {
        await run(store, 'readwrite', (os) => os.put(value as never, key));
      },
      delete: async (store: string, key: string) => {
        await run(store, 'readwrite', (os) => os.delete(key));
      },
      getAll: <T>(store: string, limit: number) =>
        run<T[]>(store, 'readonly', (os) => os.getAll(null, limit) as IDBRequest<T[]>)
    };
  });
  return dbPromise;
}
