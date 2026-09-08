import { COMMAND_CATALOG } from "../../generated/command-config.js";
import { RECORDING_STORE, RECORDING_EVENT_STORE, requestResult, withReadOnly, withStrictReadWrite } from "../database.js";
import { RecordingError, type RecordedEvent, type RecordingSession } from "./model.js";
const range = (recordingId: string, after = 0) => IDBKeyRange.bound([recordingId,after],[recordingId,Number.MAX_SAFE_INTEGER],true);
export async function loadRecording(ownerKeyId: string, recordingId: string): Promise<RecordingSession> {
  const record = await withReadOnly([RECORDING_STORE], (transaction) => requestResult(transaction.objectStore(RECORDING_STORE).get(recordingId) as IDBRequest<RecordingSession | undefined>));
  if (record === undefined || record.ownerKeyId !== ownerKeyId || record.retainUntil <= Date.now()) throw new RecordingError({reason:"NOT_FOUND"});
  return record;
}
export async function inventoryRecordings(): Promise<readonly RecordingSession[]> {
  return withReadOnly([RECORDING_STORE], (transaction) => requestResult(transaction.objectStore(RECORDING_STORE).getAll() as IDBRequest<RecordingSession[]>));
}
export async function createRecording(session: RecordingSession): Promise<void> {
  await withStrictReadWrite([RECORDING_STORE,RECORDING_EVENT_STORE],async(transaction)=>{
    const store=transaction.objectStore(RECORDING_STORE);
    const records=await requestResult(store.getAll() as IDBRequest<RecordingSession[]>);
    let count=0;
    for(const record of records) {
      if(record.retainUntil<=Date.now()) { await requestResult(store.delete(record.recordingId)); await requestResult(transaction.objectStore(RECORDING_EVENT_STORE).delete(range(record.recordingId))); continue; }
      count++;
      if(["recording","pausing","stopping","paused"].includes(record.state) && (record.windowId===session.windowId && (record.scope==="window" || session.scope==="window") || record.tabId===session.tabId)) throw new RecordingError({reason:"SCOPE_OCCUPIED"});
    }
    if(count>=COMMAND_CATALOG.limits["command.recording.maximum_count"]) throw new RecordingError({reason:"REPOSITORY_LIMIT"});
    await requestResult(store.add(session));
  });
}
export async function changeRecording(recordingId: string, transform: (current: RecordingSession) => { readonly session: RecordingSession; readonly events?: readonly RecordedEvent[] }): Promise<RecordingSession> {
  return withStrictReadWrite([RECORDING_STORE,RECORDING_EVENT_STORE],async(transaction)=>{
    const store=transaction.objectStore(RECORDING_STORE);
    const current=await requestResult(store.get(recordingId) as IDBRequest<RecordingSession|undefined>);
    if(current===undefined) throw new RecordingError({reason:"NOT_FOUND"});
    const change=transform(current);
    const added=change.events??[];
    if(added.length>0 && (added[0]!.sequence!==current.eventCount+1 || added.some((event,index)=>event.recordingId!==recordingId || event.sequence!==current.eventCount+index+1))) throw new RecordingError({reason:"EVENT_SEQUENCE_INVALID"});
    const bytes=added.reduce((sum,event)=>sum+new TextEncoder().encode(JSON.stringify(event)).byteLength,0);
    if(current.eventCount+added.length>COMMAND_CATALOG.limits["command.recording.maximum_events"] || current.byteLength+bytes>COMMAND_CATALOG.limits["command.recording.maximum_bytes"]) throw new RecordingError({reason:"RECORDING_LIMIT"});
    const session={...change.session,eventCount:current.eventCount+added.length,byteLength:current.byteLength+bytes,updatedAt:Date.now()};
    for(const event of added) await requestResult(transaction.objectStore(RECORDING_EVENT_STORE).add(event));
    await requestResult(store.put(session));return session;
  });
}
export async function readRecordingEvents(ownerKeyId: string, recordingId: string, afterSequence: number, limit: number, complete = false) {
  return withReadOnly([RECORDING_STORE,RECORDING_EVENT_STORE],async(transaction)=>{
    const recording=await requestResult(transaction.objectStore(RECORDING_STORE).get(recordingId) as IDBRequest<RecordingSession|undefined>);
    if(recording===undefined || recording.ownerKeyId!==ownerKeyId || recording.retainUntil<=Date.now()) throw new RecordingError({reason:"NOT_FOUND"});
    if(complete && !["stopped","interrupted"].includes(recording.state)) throw new RecordingError({reason:"STOP_BEFORE_COMPILING"});
    const records=await requestResult(transaction.objectStore(RECORDING_EVENT_STORE).getAll(range(recordingId,afterSequence),limit) as IDBRequest<RecordedEvent[]>);
    const events:RecordedEvent[]=[];let bytes=0;
    for(const event of records) {
      if(event.sequence!==afterSequence+events.length+1) throw new RecordingError({reason:"EVENTS_INCOMPLETE"});
      const size=new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if(!complete && bytes+size>COMMAND_CATALOG.limits["command.inline.maximum_result_json_bytes"]/2) break;
      bytes+=size;events.push(event);
    }
    if(complete && events.length!==recording.eventCount) throw new RecordingError({reason:"EVENTS_INCOMPLETE"});
    if(!complete && events.length===0 && afterSequence<recording.eventCount) throw new RecordingError({reason:"EVENT_PAGE_TOO_LARGE"});
    return {recording,events,nextAfterSequence:afterSequence+events.length<recording.eventCount?afterSequence+events.length:null};
  });
}
export async function deleteRecording(ownerKeyId: string, recordingId: string) {
  await loadRecording(ownerKeyId,recordingId);
  return withStrictReadWrite([RECORDING_STORE,RECORDING_EVENT_STORE],async(transaction)=>{
    const store=transaction.objectStore(RECORDING_STORE);
    const current=await requestResult(store.get(recordingId) as IDBRequest<RecordingSession|undefined>);
    if(current===undefined || current.ownerKeyId!==ownerKeyId) throw new RecordingError({reason:"NOT_FOUND"});
    if(!["stopped","interrupted"].includes(current.state)) throw new RecordingError({reason:"STOP_BEFORE_DELETING"});
    await requestResult(store.delete(recordingId));await requestResult(transaction.objectStore(RECORDING_EVENT_STORE).delete(range(recordingId)));
    return {deleted:true};
  });
}
