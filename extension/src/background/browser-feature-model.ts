export class BrowserOperationError extends Error {
  readonly code = "BROWSER_OPERATION_FAILED" as const;
  readonly details: {readonly reason: string; readonly commandMayHaveRun: boolean; readonly observation?:Readonly<Record<string,unknown>>};
  constructor(reason: string, commandMayHaveRun = false, observation?:Readonly<Record<string,unknown>>) {
    super(reason); this.name="BrowserOperationError"; this.details={reason,commandMayHaveRun,
      ...(observation!==undefined&&new TextEncoder().encode(JSON.stringify(observation)).byteLength<=8192?{observation}:{})};
  }
}
export function object(value:unknown):value is Record<string,unknown> {return value!==null&&typeof value==="object"&&!Array.isArray(value);}
export function exact(value:Record<string,unknown>,keys:readonly string[]):boolean {return Object.keys(value).length===keys.length&&keys.every((key)=>Object.hasOwn(value,key));}
export function integer(value:unknown,min=0,max=Number.MAX_SAFE_INTEGER):value is number {return Number.isSafeInteger(value)&&Number(value)>=min&&Number(value)<=max;}
export function text(value:unknown,maximum:number,empty=false):value is string {return typeof value==="string"&&(empty||value.length>0)&&new TextEncoder().encode(value).byteLength<=maximum;}
export function httpUrl(value:unknown):value is string {
  if(!text(value,8192))return false;
  try {const url=new URL(value);return ["http:","https:"].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}
}
import { COMMAND_CATALOG } from "../generated/command-config.js";

export function featureLimit(point:string):number {
  const value=COMMAND_CATALOG.limits[point as keyof typeof COMMAND_CATALOG.limits];
  if(typeof value!=="number")throw new Error(`Missing browser feature limit: ${point}`);return value;
}
/** The receipt remains owned by its caller after this bounded observation ends. */
export async function waitForFeatureReceipt<T>(receipt:Promise<T>,timeoutMs:number,reason:string,signal?:AbortSignal):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  let abort:(()=>void)|undefined;
  const stopped=new Promise<never>((_,reject)=>{
    if(!signal)return;
    abort=()=>reject(new BrowserOperationError("CAPTURE_INTERRUPTED"));
    signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
  });
  try{return await Promise.race([receipt,stopped,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new BrowserOperationError(reason)),timeoutMs);})]);}
  finally{if(timer!==undefined)clearTimeout(timer);if(abort)signal?.removeEventListener("abort",abort);}
}
