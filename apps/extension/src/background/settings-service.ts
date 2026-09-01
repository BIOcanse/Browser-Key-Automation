import { COMMAND_CATALOG } from "../generated/command-config.js";
import { requestResult, SETTINGS_STORE, withReadOnly, withStrictReadWrite } from "./database.js";

const SETTINGS_ID = "settings.v1";

export interface RuntimeSettings {
  readonly revision: number;
  readonly artifactRetentionMs: number;
  readonly artifactMaximumBytes: number;
  readonly artifactMaximumCount: number;
  readonly artifactMaximumTotalBytes: number;
}

interface StoredSettings extends RuntimeSettings {
  readonly settingsId: typeof SETTINGS_ID;
}

export interface UpdateSettingsParams {
  readonly expectedRevision: number;
  readonly artifactRetentionMs: number;
  readonly artifactMaximumBytes: number;
  readonly artifactMaximumCount: number;
  readonly artifactMaximumTotalBytes: number;
}

export class SettingsServiceError extends Error {
  readonly code = "REVISION_CONFLICT" as const;
  readonly details: Readonly<Record<string, number>>;

  constructor(expectedRevision: number, actualRevision: number) {
    super("Settings changed; read the current revision before updating");
    this.name = "SettingsServiceError";
    this.details = { expectedRevision, actualRevision };
  }
}

function integerLimit(pointId: string): number {
  const value = COMMAND_CATALOG.limits[pointId as keyof typeof COMMAND_CATALOG.limits];
  if (typeof value !== "number") throw new Error(`Missing generated integer Freedom Point: ${pointId}`);
  return value;
}

export function defaultRuntimeSettings(): RuntimeSettings {
  return {
    revision: 1,
    artifactRetentionMs: integerLimit("runtime.artifact.default_retention_ms"),
    artifactMaximumBytes: integerLimit("runtime.artifact.default_maximum_bytes"),
    artifactMaximumCount: integerLimit("runtime.artifact.default_maximum_count"),
    artifactMaximumTotalBytes: integerLimit("runtime.artifact.default_maximum_total_bytes"),
  };
}

function defaults(): StoredSettings {
  return { settingsId: SETTINGS_ID, ...defaultRuntimeSettings() };
}

function publicSettings(value: StoredSettings): RuntimeSettings {
  return {
    revision: value.revision,
    artifactRetentionMs: value.artifactRetentionMs,
    artifactMaximumBytes: value.artifactMaximumBytes,
    artifactMaximumCount: value.artifactMaximumCount,
    artifactMaximumTotalBytes: value.artifactMaximumTotalBytes,
  };
}

async function readStoredSettings(transaction: IDBTransaction): Promise<StoredSettings | undefined> {
  return requestResult(
    transaction.objectStore(SETTINGS_STORE).get(SETTINGS_ID) as IDBRequest<StoredSettings | undefined>,
  );
}

export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  const current = await withReadOnly([SETTINGS_STORE], readStoredSettings);
  if (current !== undefined) return publicSettings(current);

  return withStrictReadWrite([SETTINGS_STORE], async (transaction) => {
    const raced = await readStoredSettings(transaction);
    if (raced !== undefined) return publicSettings(raced);
    const initial = defaults();
    await requestResult(transaction.objectStore(SETTINGS_STORE).add(initial));
    return publicSettings(initial);
  });
}

export async function updateRuntimeSettings(params: UpdateSettingsParams): Promise<RuntimeSettings> {
  return withStrictReadWrite([SETTINGS_STORE], async (transaction) => {
    const current = (await readStoredSettings(transaction)) ?? defaults();
    if (current.revision !== params.expectedRevision) {
      throw new SettingsServiceError(params.expectedRevision, current.revision);
    }
    const next: StoredSettings = {
      settingsId: SETTINGS_ID,
      revision: current.revision + 1,
      artifactRetentionMs: params.artifactRetentionMs,
      artifactMaximumBytes: params.artifactMaximumBytes,
      artifactMaximumCount: params.artifactMaximumCount,
      artifactMaximumTotalBytes: params.artifactMaximumTotalBytes,
    };
    await requestResult(transaction.objectStore(SETTINGS_STORE).put(next));
    return publicSettings(next);
  });
}
