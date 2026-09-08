import { COMMAND_CATALOG } from "../../generated/command-config.js";
import { record, type ActionBinding, type ActionInstruction, type ActionSource, type TabBinding } from "../actions/model.js";
import type { CompileDiagnostic } from "../actions/compiler.js";
import { RecordingError, publicRecording, type RecordedNativeEvent, type RecordedDomEvent, type RecordedEvent, type RecordedLocator, type RecordingSession } from "./model.js";
export interface RecordingCompileOptions { readonly timing: "preserve" | "none"; readonly mergeInputs: "none" | "final"; readonly includeHover: boolean }
export function validRecordingCompileOptions(value:unknown):value is RecordingCompileOptions {
  return record(value)&&Object.keys(value).length===3&&["preserve","none"].includes(value.timing as string)&&["none","final"].includes(value.mergeInputs as string)&&typeof value.includeHover==="boolean";
}
export function compileRecording(session:RecordingSession,events:readonly RecordedEvent[],options:RecordingCompileOptions) {
  return session.mode==="real"?compileRealRecording(session,events,options):compileDomRecording(session,events,options);
}
export function compileDomRecording(session:RecordingSession,events:readonly RecordedEvent[],options:RecordingCompileOptions) {
  if(session.mode!=="dom")throw new RecordingError({reason:"RECORDING_MODE_MISMATCH"});
  const instructions:ActionInstruction[]=[],diagnostics:CompileDiagnostic[]=[];
  let runnable=session.state==="stopped"&&session.lostEvents===0,previousTime:number|null=null;
  if(!runnable)diagnostics.push({step:0,code:"RECORDING_HAS_GAPS",paths:[]});
  const domEvents=events.filter((event):event is RecordedDomEvent=>event.kind!=="native"&&event.kind!=="native_start"&&event.kind!=="native_geometry");
  if(domEvents.length!==events.length)throw new RecordingError({reason:"RECORDING_MODE_MISMATCH"});
  const ordered=[...domEvents].sort((a,b)=>a.activeMs-b.activeMs||a.sequence-b.sequence);
  if(ordered.some((event,index)=>event.sequence!==events[index]?.sequence))diagnostics.push({step:0,code:"CROSS_DOCUMENT_CAPTURE_TIME_ORDER",paths:[]});
  const logicalTabs=new Map<number,TabBinding>();
  for(const tab of session.tabs)logicalTabs.set(tab.tabId,{kind:"tab",alias:tab.alias,selector:{urlPattern:tab.initialUrl,urlMatch:"exact",title:null,windowId:null}});
  const documentPaths=new Map(session.documents.map(document=>[document,document.framePath]));
  const targetSource=(event:RecordedDomEvent,locator:unknown):ActionSource=>{
    const document=session.documents.find((item)=>item.documentId===event.documentId&&item.tabId===event.tabId&&item.frameId===event.frameId);
    const tab=logicalTabs.get(event.tabId);
    if(document===undefined||tab===undefined||!record(locator))throw new RecordingError({reason:"TARGET_EVIDENCE_MISSING"});
    if(document.locatorIssue!==null) {runnable=false;diagnostics.push({step:instructions.length,code:document.locatorIssue,paths:[]});}
    return {kind:"element",tab,locator:{...(locator as unknown as RecordedLocator),framePath:documentPaths.get(document)!}};
  };
  for(let index=0;index<ordered.length;index++) {
    let event=ordered[index]!;
    if(event.kind==="boundary")continue;
    if(event.kind==="navigation"&&event.origin!=="external"&&event.origin!=="page") {runnable=false;diagnostics.push({step:instructions.length,code:"NAVIGATION_CAUSE_REQUIRES_REVIEW",paths:[]});continue;}
    if(event.kind==="unsupported") {runnable=false;diagnostics.push({step:instructions.length,code:`UNSUPPORTED_${String(event.reason)}`,paths:[]});continue;}
    if(event.kind==="hover"&&!options.includeHover)continue;
    if(event.kind==="input"&&event.events==="input"&&options.mergeInputs==="final") {
      const target=JSON.stringify(event.target);let merged=0;
      while(index+1<ordered.length) {
        const next=ordered[index+1]!;
        if(next.kind!=="input"||next.events!=="input"||next.documentId!==event.documentId||JSON.stringify(next.target)!==target)break;
        event=next;index++;merged++;
      }
      if(merged>0)diagnostics.push({step:instructions.length,code:"INPUT_EVENTS_EXPLICITLY_MERGED",paths:[]});
    }
    let method:string,params:Record<string,unknown>,bindings:ActionBinding[];
    if(event.kind==="frame_navigation") {
      const document=session.documents.find(item=>item.documentId===event.documentId&&item.tabId===event.tabId&&item.frameId===event.frameId);
      const tab=logicalTabs.get(event.tabId);
      if(document===undefined||tab===undefined||document.framePath.length===0||typeof event.url!=="string"||event.url.length===0||event.origin!=="page") {
        runnable=false;diagnostics.push({step:instructions.length,code:"FRAME_NAVIGATION_REQUIRES_TARGET_REVIEW",paths:[]});continue;
      }
      if(document.locatorIssue!==null) {runnable=false;diagnostics.push({step:instructions.length,code:document.locatorIssue,paths:[]});}
      const sameDocument=event.transition==="history_state"||event.transition==="fragment";
      const previousPath=sameDocument?documentPaths.get(document)!:document.framePath;
      const framePath=[...previousPath.slice(0,-1),{...previousPath[previousPath.length-1]!,urlPattern:event.url,urlMatch:"exact" as const}];
      for(const [candidate,path] of documentPaths) {
        if(candidate.tabId===event.tabId&&path.length>=previousPath.length&&previousPath.every((segment,i)=>path[i]?.urlPattern===segment.urlPattern))
          documentPaths.set(candidate,[...framePath,...path.slice(previousPath.length)]);
      }
      documentPaths.set(document,framePath);
      method="page.wait";params={tabRef:null,framePath,until:sameDocument?"url":"complete",url:event.url};
      bindings=[{path:["tabRef"],source:tab}];
    } else if(event.kind==="navigation"||event.kind==="tab_activated"||event.kind==="zoom") {
      const tab=logicalTabs.get(event.tabId);
      if(tab===undefined)throw new RecordingError({reason:"TARGET_EVIDENCE_MISSING"});
      bindings=[{path:["tabRef"],source:tab}];
      method=event.kind==="zoom"?"page.zoom.set":event.kind==="tab_activated"?"tabs.activate":event.origin==="page"?"page.wait":event.transition==="reload"?"tabs.reload":"tabs.navigate";
      params=method==="page.zoom.set"?{tabRef:null,factor:event.factor}:method==="tabs.navigate"?{tabRef:null,url:event.url}:method==="tabs.reload"?{tabRef:null,bypassCache:false}:method==="page.wait"?{tabRef:null,until:"url",url:event.url}:{tabRef:null};
    } else if(event.kind==="drag") {
      const from=event.fromClient as {x:number;y:number},to=event.toClient as {x:number;y:number};
      const dx=to.x-from.x,dy=to.y-from.y,length=Math.hypot(dx,dy);
      let furthest=0;
      const nonLinear=event.mode==="pointer"&&(event.points as {x:number;y:number}[]).some(point=>{
        if(length===0)return Math.hypot(point.x-from.x,point.y-from.y)>2;
        const projected=((point.x-from.x)*dx+(point.y-from.y)*dy)/length;
        const invalid=Math.abs(dy*(point.x-from.x)-dx*(point.y-from.y))/length>2||projected < -2||projected > length+2||projected < furthest-2;
        furthest=Math.max(furthest,projected);return invalid;
      });
      if(nonLinear) {runnable=false;diagnostics.push({step:instructions.length,code:"POINTER_PATH_NEEDS_VIRTUAL_REPLAY_OR_EDIT",paths:[]});}
      method="dom.drag";params={nodeRef:null,toNodeRef:null,mode:event.mode,fromOffset:event.fromOffset,toOffset:event.toOffset,
        steps:Math.max(1,Math.min(COMMAND_CATALOG.limits["command.dom.drag.maximum_steps"],(event.points as unknown[]).length))};
      bindings=[{path:["nodeRef"],source:targetSource(event,event.from)},{path:["toNodeRef"],source:targetSource(event,event.to)}];
    } else {
      bindings=[{path:["nodeRef"],source:targetSource(event,event.target)}];
      if(event.kind==="click") {method="dom.click";params={nodeRef:null};}
      else if(event.kind==="focus") {method="dom.focus";params={nodeRef:null,preventScroll:true};}
      else if(event.kind==="input") {method="dom.edit";params={nodeRef:null,value:event.value,events:event.events,inputType:event.inputType,data:event.data};
        if(event.contentEditable)diagnostics.push({step:instructions.length,code:"CONTENTEDITABLE_PLAINTEXT_REPLACEMENT",paths:[]});}
      else if(event.kind==="select") {method="dom.select";params={nodeRef:null,values:event.values};}
      else if(event.kind==="scroll") {method="dom.scrollTo";params={nodeRef:null,left:event.left,top:event.top};}
      else if(event.kind==="hover") {method="dom.hover";params={nodeRef:null,phase:event.phase,offset:null};diagnostics.push({step:instructions.length,code:"SYNTHETIC_HOVER_DOES_NOT_SET_CSS_HOVER",paths:[]});}
      else {runnable=false;diagnostics.push({step:instructions.length,code:"UNSUPPORTED_EVENT",paths:[]});continue;}
    }
    const interval=options.timing==="none"||previousTime===null?0:Math.max(0,Math.round(event.activeMs-previousTime));
    if(interval>COMMAND_CATALOG.limits["command.actions.maximum_delay_ms"]) {runnable=false;diagnostics.push({step:instructions.length,code:"DELAY_EXCEEDS_ACTION_LIMIT",paths:[]});}
    instructions.push({method,schemaVersion:1,params,bindings,delayMs:interval});previousTime=event.activeMs;
    // Navigation completion is an explicit, editable observation in the preview.
    // Page-caused navigation never becomes a second navigate/reload effect.
    if(event.kind==="navigation") {
      if(method!=="page.wait")instructions.push({method:"page.wait",schemaVersion:1,params:{tabRef:null,until:"url",url:event.url},bindings,delayMs:0});
      if(event.transition!=="history_state")instructions.push({method:"page.wait",schemaVersion:1,params:{tabRef:null,until:"complete"},bindings,delayMs:0});
    }
  }
  if(instructions.length===0){runnable=false;diagnostics.push({step:0,code:"NO_REPLAYABLE_ACTIONS",paths:[]});}
  return {instructions,diagnostics,runnable,recording:publicRecording(session),recommendations:[
    "Add explicit ensure.run schema 2 preconditions and corrections before replay: check the target tab, viewport/zoom and window state against the recording baseline.",
    "Use current tab/window bindings, resolve elements afresh, and place preparation at complete gesture boundaries. Add a site-specific goal after irreversible clicks; never retry an unconfirmed submission.",
    "Review the compiled DOM event sequence. DOM input remains synthetic; CSS hover, trusted-event requirements and unsupported paths require an explicit edit or native recording.",
  ]};
}

function compileRealRecording(session:RecordingSession,events:readonly RecordedEvent[],options:RecordingCompileOptions) {
  const instructions:ActionInstruction[]=[],diagnostics:CompileDiagnostic[]=[];
  let runnable=session.state==="stopped"&&session.lostEvents===0,previousTime:number|null=null,hasInput=false;
  const issue=(code:string)=>{runnable=false;diagnostics.push({step:instructions.length,code,paths:[]});};
  if(!runnable)issue("RECORDING_HAS_GAPS");
  const tabs=new Map(session.tabs.map(tab=>[tab.tabId,{kind:"tab",alias:tab.alias,selector:{urlPattern:tab.initialUrl,urlMatch:"exact",title:null,windowId:null}} as TabBinding]));
  let currentTabId=session.tabId,windowCoordinates=false;
  const binding=():ActionBinding=>{
    const source=tabs.get(currentTabId);if(source===undefined)throw new RecordingError({reason:"TARGET_EVIDENCE_MISSING"});
    return {path:["tabRef"],source};
  };
  const push=(method:string,params:Record<string,unknown>,bindings:readonly ActionBinding[],activeMs:number,schemaVersion=1)=>{
    const delayMs=options.timing==="none"||previousTime===null?0:Math.max(0,Math.round(activeMs-previousTime));
    if(delayMs>COMMAND_CATALOG.limits["command.actions.maximum_delay_ms"])issue("DELAY_EXCEEDS_ACTION_LIMIT");
    instructions.push({method,schemaVersion,params,bindings,delayMs});previousTime=activeMs;
  };
  // Chrome's native window API supplies its own bounds units. Pointer positions
  // come directly from the App, so neither path needs a CSS calibration map.
  let previousWindow="";
  const restoreWindow=(window:RecordingSession["baseline"]["window"],at:number)=>{
    if(window.state===null||Object.values(window.bounds).some(value=>value===null)){issue("NATIVE_WINDOW_SNAPSHOT_INCOMPLETE");return;}
    const key=JSON.stringify([window.state,window.bounds]);if(key===previousWindow)return;previousWindow=key;
    const step=instructions.length;push("tabs.get",{tabRef:null},[binding()],at);
    const windowBinding:ActionBinding={path:["windowId"],source:{kind:"result",step,path:["tab","windowId"],valueType:"window_id"}};
    push("windows.setState",{windowId:null,state:window.state},[windowBinding],at);
    if(window.state==="normal")push("windows.setBounds",{windowId:null,...window.bounds},[windowBinding],at);
  };
  restoreWindow(session.baseline.window,0);
  const heldButtons=new Set<string>();
  const heldKeys=new Set<string>();
  for(const event of [...events].sort((a,b)=>a.activeMs-b.activeMs||a.sequence-b.sequence)) {
    if(event.kind==="native_start"||event.kind==="native_geometry")continue;
    if(event.kind==="window_changed") {restoreWindow(event.window as RecordingSession["baseline"]["window"],event.activeMs);hasInput=true;continue;}
    if(event.kind!=="native") {
      if(event.kind==="tab_activated")currentTabId=event.tabId;
      const compiled=compileDomRecording({...session,mode:"dom"},[event.kind==="navigation"?{...event,origin:"page"}:event],{...options,timing:"none"});
      for(const diagnostic of compiled.diagnostics)diagnostics.push({...diagnostic,step:instructions.length+diagnostic.step});
      if(!compiled.runnable)runnable=false;
      for(const instruction of compiled.instructions)push(instruction.method,{...instruction.params},instruction.bindings,event.activeMs,instruction.schemaVersion);
      continue;
    }
    const raw=event.raw;
    if(raw.kind!==3)continue;
    if(raw.coordinates!=="window") {issue("LEGACY_SCREEN_RECORDING_REQUIRES_NEW_CAPTURE");continue;}
    if([0x100,0x101,0x104,0x105].includes(raw.message)) {
      const bits=Number.parseInt(raw.keyLParam.slice(-8),16),up=raw.message===0x101||raw.message===0x105;
      const vk=Number(BigInt("0x"+raw.wParam)),key=`${vk}:${bits&0x01ff0000}`;
      if(vk===0xe5||vk===0xe7){issue("NATIVE_COMMITTED_TEXT_REQUIRED");continue;}
      if(up) {if(!heldKeys.delete(key))issue("NATIVE_KEYBOARD_GESTURE_UNFINISHED");}
      else if(bits&0x40000000) {if(!heldKeys.has(key))issue("NATIVE_KEYBOARD_GESTURE_UNFINISHED");}
      else {if(heldKeys.has(key))issue("NATIVE_KEYBOARD_GESTURE_UNFINISHED");heldKeys.add(key);}
      if(!windowCoordinates)push("input.calibrate",{tabRef:null},[binding()],event.activeMs);
      push("virtualKeyboard.events",{tabRef:null,events:[{action:up?"up":bits&0x40000000?"repeat":"down",virtualKey:Number(BigInt("0x"+raw.wParam)),
        scanCode:(bits>>>16)&0xff,extended:(bits&0x1000000)!==0,layout:/^0+$/u.test(raw.keyboardLayout)?null:raw.keyboardLayout}]},[binding()],event.activeMs);
      hasInput=true;continue;
    }
    if(raw.point===null) {issue("NATIVE_INPUT_UNSUPPORTED");continue;}
    if(raw.message===0x200&&!options.includeHover&&heldButtons.size===0)continue;
    const actions:Record<string,unknown>[]=[{kind:"moveWindow",x:raw.point.x,y:raw.point.y}],message=raw.message;
    const side=Number((BigInt("0x"+raw.wParam)>>16n)&0xffffn);
    const button=message===0x201||message===0x202?"left":message===0x204||message===0x205?"right":message===0x207||message===0x208?"middle":
      message===0x20b||message===0x20c?side===1?"back":side===2?"forward":null:null;
    if(button!==null) {
      const down=[0x201,0x204,0x207,0x20b].includes(message);
      if(down)heldButtons.add(button);else if(!heldButtons.delete(button))issue("NATIVE_POINTER_GESTURE_UNFINISHED");
      actions.push({kind:"button",button,action:down?"down":"up"});
    } else if(message===0x20a||message===0x20e) {
      const delta=Number(BigInt.asIntN(16,BigInt("0x"+raw.wParam)>>16n));
      actions.push({kind:"wheel",deltaX:message===0x20e?delta:0,deltaY:message===0x20a?delta:0});
    } else if(message!==0x200) {issue("NATIVE_MOUSE_MESSAGE_UNSUPPORTED");continue;}
    push("virtualMouse.input",{tabRef:null,actions},[binding()],event.activeMs);hasInput=true;windowCoordinates=true;
  }
  if(heldButtons.size>0)issue("NATIVE_POINTER_GESTURE_UNFINISHED");
  if(heldKeys.size>0)issue("NATIVE_KEYBOARD_GESTURE_UNFINISHED");
  if(!hasInput)issue("NO_REPLAYABLE_ACTIONS");
  return {instructions,diagnostics,runnable,recording:publicRecording(session),recommendations:[
    "Review the selected window and add explicit ensure.run checks and corrections before replay.",
    "Mouse coordinates are native pixels relative to the outer window. Five buttons and both wheel axes retain their order and timing.",
    "Window changes are recorded independently. Off-window pointer coordinates are never stored; incomplete gestures require review.",
  ]};
}
