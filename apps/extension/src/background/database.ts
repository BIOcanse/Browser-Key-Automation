export const DATABASE_NAME = "browser-key-automation";
export const DATABASE_VERSION = 3;
export const KEY_STORE = "keys";
export const ADMIN_MUTATION_STORE = "admin_mutations";
export const ARTIFACT_STORE = "artifacts";
export const ARTIFACT_CHUNK_STORE = "artifact_chunks";
export const SETTINGS_STORE = "settings";

let databasePromise: Promise<IDBDatabase> | null = null;
let activeDatabase: IDBDatabase | null = null;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), { once: true });
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed")), { once: true });
  });
}

function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.addEventListener("upgradeneeded", () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(KEY_STORE)) {
      database.createObjectStore(KEY_STORE, { keyPath: "keyId" });
    }
    if (!database.objectStoreNames.contains(ADMIN_MUTATION_STORE)) {
      database.createObjectStore(ADMIN_MUTATION_STORE, { keyPath: "mutationId" });
    }
    if (!database.objectStoreNames.contains(ARTIFACT_STORE)) {
      database.createObjectStore(ARTIFACT_STORE, { keyPath: "artifactRef" });
    }
    if (!database.objectStoreNames.contains(ARTIFACT_CHUNK_STORE)) {
      database.createObjectStore(ARTIFACT_CHUNK_STORE, { keyPath: "chunkKey" });
    }
    if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
      database.createObjectStore(SETTINGS_STORE, { keyPath: "settingsId" });
    }
  });
  return new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    request.addEventListener("blocked", () => {
      if (settled) return;
      settled = true;
      reject(new DOMException("IndexedDB upgrade is blocked by another extension context", "InvalidStateError"));
    }, { once: true });
    request.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("IndexedDB open failed"));
    }, { once: true });
    request.addEventListener("success", () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      activeDatabase = database;
      database.addEventListener("versionchange", () => {
        database.close();
        if (activeDatabase === database) {
          activeDatabase = null;
          databasePromise = null;
        }
      });
      resolve(database);
    }, { once: true });
  });
}

export function getDatabase(): Promise<IDBDatabase> {
  if (databasePromise !== null) return databasePromise;
  let observed!: Promise<IDBDatabase>;
  observed = openDatabase().catch((error: unknown) => {
    if (databasePromise === observed) databasePromise = null;
    throw error;
  });
  databasePromise = observed;
  return databasePromise;
}

export async function withStrictReadWrite<T>(
  storeNames: readonly string[],
  operation: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const database = await getDatabase();
  const transaction = database.transaction([...storeNames], "readwrite", { durability: "strict" });
  const completion = transactionCompletion(transaction);
  try {
    const result = await operation(transaction);
    await completion;
    return result;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // The transaction may already be committed or aborted; the original error remains authoritative.
    }
    await completion.catch(() => undefined);
    throw error;
  }
}

export async function withReadOnly<T>(
  storeNames: readonly string[],
  operation: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const database = await getDatabase();
  const transaction = database.transaction([...storeNames], "readonly");
  const completion = transactionCompletion(transaction);
  const result = await operation(transaction);
  await completion;
  return result;
}

export { requestResult };
