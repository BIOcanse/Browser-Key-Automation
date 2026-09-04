export const DATABASE_NAME = "browser-key-automation";
export const DATABASE_VERSION = 4;
export const KEY_STORE = "keys";
export const ADMIN_MUTATION_STORE = "admin_mutations";
export const ARTIFACT_STORE = "artifacts";
export const ARTIFACT_CHUNK_STORE = "artifact_chunks";
export const SETTINGS_STORE = "settings";
export const EXECUTION_TRACE_STORE = "execution_traces";

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
    if (!database.objectStoreNames.contains(EXECUTION_TRACE_STORE)) {
      database.createObjectStore(EXECUTION_TRACE_STORE, { keyPath: "ownerKeyId" });
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
  options?: { readonly timeoutMs: number },
): Promise<T> {
  let transaction: IDBTransaction | null = null;
  let completion: Promise<void> | null = null;
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const deadline = options === undefined ? null : new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      try { transaction?.abort(); }
      catch { /* The transaction may already have reached a terminal state. */ }
      reject(new DOMException("IndexedDB transaction exceeded its bounded deadline", "TimeoutError"));
    }, options.timeoutMs);
  });
  const within = <V>(promise: Promise<V>): Promise<V> => deadline === null ? promise : Promise.race([promise, deadline]);
  try {
    const database = await within(getDatabase());
    transaction = database.transaction([...storeNames], "readwrite", { durability: "strict" });
    completion = transactionCompletion(transaction);
    const result = await within(operation(transaction));
    await within(completion);
    return result;
  } catch (error) {
    try {
      transaction?.abort();
    } catch {
      // The transaction may already be committed or aborted; the original error remains authoritative.
    }
    if (completion !== null) {
      if (timedOut) void completion.catch(() => undefined);
      else await completion.catch(() => undefined);
    }
    throw error;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

export async function withReadOnly<T>(
  storeNames: readonly string[],
  operation: (transaction: IDBTransaction) => Promise<T>,
  options?: { readonly timeoutMs: number },
): Promise<T> {
  let transaction: IDBTransaction | null = null;
  let completion: Promise<void> | null = null;
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const deadline = options === undefined ? null : new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      try { transaction?.abort(); }
      catch { /* The transaction may already have reached a terminal state. */ }
      reject(new DOMException("IndexedDB transaction exceeded its bounded deadline", "TimeoutError"));
    }, options.timeoutMs);
  });
  const within = <V>(promise: Promise<V>): Promise<V> => deadline === null ? promise : Promise.race([promise, deadline]);
  try {
    const database = await within(getDatabase());
    transaction = database.transaction([...storeNames], "readonly");
    completion = transactionCompletion(transaction);
    const result = await within(operation(transaction));
    await within(completion);
    return result;
  } catch (error) {
    try { transaction?.abort(); }
    catch { /* The transaction may already be completed or aborted. */ }
    if (completion !== null) {
      if (timedOut) void completion.catch(() => undefined);
      else await completion.catch(() => undefined);
    }
    throw error;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

export { requestResult };
