import { COMMAND_CATALOG } from "../../generated/command-config.js";
import { createTextArtifact, isArtifactRefShape, readArtifactBytes } from "../artifact-service.js";
import { compileInstructions, type CompiledAction, type ParseInstruction } from "./compiler.js";
import { ActionError, integer, onlyKeys, record, text } from "./model.js";
import { snapshotAction } from "./store.js";
import { compileRecording, validRecordingCompileOptions } from "../recording/compiler.js";
import { readRecordingEvents } from "../recording/store.js";

export function parseActionParams(method: string, params: Record<string, unknown>): boolean {
  if (method === "actions.list") return onlyKeys(params, ["afterActionId", "limit", "query"]) && integer(params.afterActionId) &&
    integer(params.limit, 1, COMMAND_CATALOG.limits["command.actions.maximum_page_size"]) && text(params.query, true);
  if (method === "actions.get") return onlyKeys(params, ["actionId", "offset", "limit"]) && integer(params.actionId, 1) && integer(params.offset) && integer(params.limit, 1, COMMAND_CATALOG.limits["command.actions.maximum_page_size"]);
  if (method === "actions.export") return onlyKeys(params, ["actionId"]) && integer(params.actionId, 1);
  if (method === "actions.delete") return onlyKeys(params, ["actionId", "revision"]) && integer(params.actionId, 1) && integer(params.revision, 1);
  if (method === "actions.run") return onlyKeys(params, ["actionId", "inputs", "timeoutMs"]) && integer(params.actionId, 1) && record(params.inputs) &&
    integer(params.timeoutMs, 1, COMMAND_CATALOG.limits["command.actions.maximum_timeout_ms"]);
  if (method === "actions.compile") return onlyKeys(params, ["instructions"]) && validInstructionSource(params.instructions);
  if (method === "actions.create" || method === "actions.update") return onlyKeys(params, method === "actions.create" ? ["name", "description", "instructions"] : ["actionId", "revision", "name", "description", "instructions"]) &&
    text(params.name) && text(params.description, true) && validInstructionSource(params.instructions) &&
    (method === "actions.create" || integer(params.actionId, 1) && integer(params.revision, 1));
  return false;
}
function validInstructionSource(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= COMMAND_CATALOG.limits["command.actions.maximum_steps"] ||
    record(value) && onlyKeys(value, ["artifactRef"]) && isArtifactRefShape(value.artifactRef) ||
    record(value) && onlyKeys(value,["recordingId","options"]) && typeof value.recordingId==="string" && /^rr1\.[a-f0-9-]{36}$/u.test(value.recordingId) && validRecordingCompileOptions(value.options);
}
export async function compileSource(ownerKeyId: string, source: unknown, parse: ParseInstruction): Promise<CompiledAction> {
  if(record(source)&&typeof source.recordingId==="string"&&validRecordingCompileOptions(source.options)) {
    const snapshot=await readRecordingEvents(ownerKeyId,source.recordingId,0,COMMAND_CATALOG.limits["command.recording.maximum_events"],true);
    const recording=compileRecording(snapshot.recording,snapshot.events,source.options);
    // A preview may contain unresolved evidence, but saving/executing it requires an explicit edit and successful recompilation.
    let normalized:CompiledAction={instructions:recording.instructions,permissions:[],capabilities:[],diagnostics:[],runnable:false};
    if(recording.instructions.length>0) {
      try {normalized=compileInstructions(recording.instructions,parse);}
      catch(error) {
        if(!(error instanceof ActionError))throw error;
        normalized={...normalized,diagnostics:[{step:error.details.step??0,code:error.details.reason,paths:[]}]};
      }
    }
    return {...normalized,diagnostics:[...recording.diagnostics,...normalized.diagnostics],runnable:recording.runnable&&normalized.runnable,recording:recording.recording,recommendations:recording.recommendations};
  }
  let instructions = source;
  if (record(source) && typeof source.artifactRef === "string") {
    const body = await readArtifactBytes(ownerKeyId, source.artifactRef, COMMAND_CATALOG.limits["command.actions.maximum_bytes"]);
    if (body.mediaType !== "application/json") throw new ActionError({ reason: "SOURCE_MEDIA_TYPE" });
    try { instructions = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes)); }
    catch { throw new ActionError({ reason: "SOURCE_JSON_INVALID" }); }
  }
  return compileInstructions(instructions, parse);
}
export async function compilePreview(ownerKeyId: string, compiled: CompiledAction) {
  const bytes = new TextEncoder().encode(JSON.stringify(compiled)).byteLength;
  if (bytes <= COMMAND_CATALOG.limits["command.inline.maximum_result_json_bytes"] / 2) return { ...compiled, stepCount: compiled.instructions.length, complete: true, artifact: null };
  const artifact = await createTextArtifact(ownerKeyId, "application/json", JSON.stringify(compiled.instructions));
  return { instructions: [], stepCount: compiled.instructions.length, complete: false, artifact,
    runnable: compiled.runnable, recording: compiled.recording ?? null, recommendations: compiled.recommendations ?? [],
    permissions: compiled.permissions, capabilities: compiled.capabilities, diagnostics: compiled.diagnostics.slice(0, COMMAND_CATALOG.limits["command.actions.maximum_page_size"]), diagnosticsTruncated: compiled.diagnostics.length > COMMAND_CATALOG.limits["command.actions.maximum_page_size"] };
}
export async function exportAction(ownerKeyId: string, actionId: number) {
  const { instructions, ...action } = await snapshotAction(actionId);
  return { action, artifact: await createTextArtifact(ownerKeyId, "application/json", JSON.stringify(instructions)) };
}
