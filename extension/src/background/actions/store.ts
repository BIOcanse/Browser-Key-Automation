import { COMMAND_CATALOG } from "../../generated/command-config.js";
import { ACTION_STORE, ACTION_STEP_STORE, requestResult, withReadOnly, withStrictReadWrite } from "../database.js";
import { ActionError, type ActionInstruction, type ActionMetadata, type ActionSnapshot } from "./model.js";

interface StepRecord { readonly actionId: number; readonly index: number; readonly instruction: ActionInstruction }
const range = (actionId: number, offset = 0, end = Number.MAX_SAFE_INTEGER) => IDBKeyRange.bound([actionId, offset], [actionId, end]);
async function metadata(transaction: IDBTransaction, actionId: number): Promise<ActionMetadata> {
  const result = await requestResult(transaction.objectStore(ACTION_STORE).get(actionId) as IDBRequest<ActionMetadata | undefined>);
  if (result === undefined) throw new ActionError({ reason: "NOT_FOUND" });
  return result;
}
export async function saveAction(name: string, description: string, instructions: readonly ActionInstruction[], edit: { actionId: number; revision: number } | null = null): Promise<ActionMetadata> {
  const byteLength = new TextEncoder().encode(JSON.stringify(instructions)).byteLength;
  if (byteLength > COMMAND_CATALOG.limits["command.actions.maximum_bytes"]) throw new ActionError({ reason: "BODY_LIMIT" });
  return withStrictReadWrite([ACTION_STORE, ACTION_STEP_STORE], async (transaction) => {
    const store = transaction.objectStore(ACTION_STORE), steps = transaction.objectStore(ACTION_STEP_STORE);
    const previous = edit === null ? null : await metadata(transaction, edit.actionId);
    if (previous !== null && previous.revision !== edit!.revision) throw new ActionError({ reason: "REVISION_CONFLICT", revision: previous.revision });
    const inventory = await requestResult(store.getAll() as IDBRequest<ActionMetadata[]>);
    if ((previous === null && inventory.length >= COMMAND_CATALOG.limits["command.actions.maximum_count"]) ||
      inventory.reduce((sum, item) => sum + item.byteLength, 0) - (previous?.byteLength ?? 0) + byteLength > COMMAND_CATALOG.limits["command.actions.maximum_total_bytes"]) throw new ActionError({ reason: "REPOSITORY_LIMIT" });
    const now = Date.now();
    const content = { name, description, revision: (previous?.revision ?? 0) + 1, stepCount: instructions.length, byteLength, createdAt: previous?.createdAt ?? now, updatedAt: now };
    const actionId = previous?.actionId ?? Number(await requestResult(store.add(content)));
    if (!Number.isSafeInteger(actionId) || actionId < 1) throw new ActionError({ reason: "ID_EXHAUSTED" });
    const next: ActionMetadata = { actionId, ...content };
    await requestResult(store.put(next));
    if (previous !== null) await requestResult(steps.delete(range(actionId)));
    for (let index = 0; index < instructions.length; index += 1) await requestResult(steps.add({ actionId, index, instruction: instructions[index] }));
    return next;
  });
}
export async function listActions(afterActionId: number, limit: number, query: string): Promise<{ items: ActionMetadata[]; nextAfterActionId: number | null }> {
  return withReadOnly([ACTION_STORE], async (transaction) => {
    const items: ActionMetadata[] = [];
    const search = query.toLocaleLowerCase();
    let nextAfterActionId: number | null = null, bytes = 0;
    await new Promise<void>((resolve, reject) => {
      const cursor = transaction.objectStore(ACTION_STORE).openCursor(IDBKeyRange.lowerBound(afterActionId, true));
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (current === null) { resolve(); return; }
        const item = current.value as ActionMetadata;
        if (`${item.name}\n${item.description}`.toLocaleLowerCase().includes(search)) {
          const size = new TextEncoder().encode(JSON.stringify(item)).byteLength;
          if (items.length >= limit || bytes + size > COMMAND_CATALOG.limits["command.inline.maximum_result_json_bytes"] / 2) {
            if (items.length === 0) { reject(new ActionError({ reason: "PAGE_LIMIT" })); return; }
            nextAfterActionId = items[items.length - 1]!.actionId; resolve(); return;
          }
          items.push(item); bytes += size;
        }
        current.continue();
      };
    });
    return { items, nextAfterActionId };
  });
}
export async function readAction(actionId: number, offset: number, limit: number): Promise<ActionMetadata & { instructions: readonly ActionInstruction[]; offset: number; nextOffset: number | null }> {
  return withReadOnly([ACTION_STORE, ACTION_STEP_STORE], async (transaction) => {
    const meta = await metadata(transaction, actionId);
    if (offset > meta.stepCount) throw new ActionError({ reason: "OFFSET_INVALID" });
    const records = await requestResult(transaction.objectStore(ACTION_STEP_STORE).getAll(range(actionId, offset), limit) as IDBRequest<StepRecord[]>);
    const instructions: ActionInstruction[] = []; let bytes = 0;
    for (const item of records) {
      if (item.index !== offset + instructions.length) throw new ActionError({ reason: "BODY_INCOMPLETE" });
      const size = new TextEncoder().encode(JSON.stringify(item.instruction)).byteLength;
      if (bytes + size > COMMAND_CATALOG.limits["command.inline.maximum_result_json_bytes"] / 2) break;
      instructions.push(item.instruction); bytes += size;
    }
    if (instructions.length === 0 && offset < meta.stepCount) throw new ActionError({ reason: "USE_ARTIFACT_EXPORT" });
    return { ...meta, instructions, offset, nextOffset: offset + instructions.length < meta.stepCount ? offset + instructions.length : null };
  });
}
export async function snapshotAction(actionId: number): Promise<ActionSnapshot> {
  return withReadOnly([ACTION_STORE, ACTION_STEP_STORE], async (transaction) => {
    const meta = await metadata(transaction, actionId);
    const records = await requestResult(transaction.objectStore(ACTION_STEP_STORE).getAll(range(actionId)) as IDBRequest<StepRecord[]>);
    if (records.length !== meta.stepCount || records.some((item, index) => item.index !== index)) throw new ActionError({ reason: "BODY_INCOMPLETE" });
    return { ...meta, instructions: records.map((item) => item.instruction) };
  });
}
export async function deleteAction(actionId: number, revision: number): Promise<{ deleted: true }> {
  return withStrictReadWrite([ACTION_STORE, ACTION_STEP_STORE], async (transaction) => {
    const current = await metadata(transaction, actionId);
    if (current.revision !== revision) throw new ActionError({ reason: "REVISION_CONFLICT", revision: current.revision });
    await requestResult(transaction.objectStore(ACTION_STORE).delete(actionId));
    await requestResult(transaction.objectStore(ACTION_STEP_STORE).delete(range(actionId)));
    return { deleted: true };
  });
}
