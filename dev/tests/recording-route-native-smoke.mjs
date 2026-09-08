import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const executable=resolve('out/recording-route-probe/bin/recording-route-probe.exe');
await mkdir(resolve('out/test-artifacts'),{recursive:true});
const directory=await mkdtemp(resolve('out/test-artifacts/recording-route-native-'));
const hashes={};
for(const path of ['app/build.zig','dev/tests/experiments/input-recording/wire.h',
 'dev/tests/experiments/input-recording/observer.c','dev/tests/experiments/input-recording/probe.c',
 'out/recording-route-probe/bin/recording-route-probe.exe','out/recording-route-probe/bin/recording-observer-probe.dll']) {
 hashes[path]=createHash('sha256').update(await readFile(path)).digest('hex');
}
await writeFile(resolve(directory,'source-and-binary-hashes.json'),JSON.stringify(hashes,null,2));
const evidence={scope:'disposable observer route, synthetic queue input, actual window operations',runs:[]};

function run(args) {
 return new Promise((resolveRun,reject)=>{
  const process=spawn(executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';
  process.stdout.on('data',chunk=>{output+=chunk;});process.stderr.on('data',chunk=>{output+=chunk;});
  const timer=setTimeout(()=>{process.kill();reject(new Error(`Controller timed out: ${output}`));},15000);
  process.once('error',error=>{clearTimeout(timer);reject(error);});
  process.once('exit',code=>{clearTimeout(timer);resolveRun({code,output});});
 });
}

async function scenario(mode) {
 const raw=[],records=[];
 const fixture=spawn(executable,['target'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let ended=false;
 const exited=new Promise(resolveExit=>fixture.once('exit',code=>{ended=true;resolveExit(code);}));
 const ready=new Promise((resolveReady,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Recording fixture did not start')),5000);
  fixture.once('error',error=>{clearTimeout(timer);reject(error);});
  const lines=createInterface({input:fixture.stdout});
  lines.on('line',line=>{raw.push(line);try{const item=JSON.parse(line);if(item.kind==='ready'){clearTimeout(timer);resolveReady(item);}}catch{}});
 });
 fixture.stderr.on('data',chunk=>raw.push(String(chunk)));
 let binding,controller;
 try{
  binding=await ready;
  controller=await run([mode,binding.root,binding.sameChild,binding.otherChild,binding.unrelated]);
  for(const line of controller.output.trim().split(/\r?\n/u)){try{records.push(JSON.parse(line));}catch{}}
  evidence.runs.push({mode,binding,controller,records});
  assert.equal(controller.code,0,controller.output);
  const receipt=records.find(item=>item.kind==='receipt'),events=records.filter(item=>item.kind==='recorded');
  assert.ok(receipt);assert.equal(receipt.cleanup,true);assert.equal(receipt.attached,3);assert.equal(receipt.detached,3);
  assert.equal(receipt.inputAfterStop,true);assert.equal(receipt.cursorUnchanged,true);assert.equal(receipt.foregroundUnchanged,true);
  assert.equal(events.length,receipt.count);assert.deepEqual(events.map(item=>item.sequence),Array.from({length:events.length},(_,i)=>i+1));
  assert.ok(events.every(item=>item.source==='unknown'&&BigInt(item.qpc)>0n&&item.dpi>0));
  assert.ok(events.every(item=>item.point===null||item.point[0]>=item.window[0]&&item.point[0]<item.window[2]&&item.point[1]>=item.window[1]&&item.point[1]<item.window[3]),'Every stored point is inside its own event-time window');
  if(mode==='overflow') {
   assert.equal(events.length,256);assert.equal(receipt.lost,1,'Capacity is reported rather than overwritten');
  } else {
   assert.equal(receipt.lost,0);
   const inputs=events.filter(item=>item.eventKind===3),boundaries=events.filter(item=>item.eventKind===4||item.eventKind===5);
   assert.equal(inputs.length,8,'Outside messages, unrelated HWND and PM_NOREMOVE do not enter input history');
   assert.equal(inputs.filter(item=>item.message===0x200).length,3);
   assert.equal(inputs.filter(item=>item.message===0x201).length,1);
   assert.equal(inputs.filter(item=>item.message===0x202).length,0,'An outside release is not fabricated inside');
   assert.ok(inputs.every(item=>item.phase===3));assert.ok(!events.some(item=>item.hwnd===binding.unrelated));
   assert.equal(boundaries.filter(item=>item.eventKind===4).length,1);assert.equal(boundaries.filter(item=>item.eventKind===5).length,2);
   assert.equal(boundaries.find(item=>item.eventKind===4).point,null);
   const exit=boundaries.find(item=>item.eventKind===4),reentry=boundaries.filter(item=>item.eventKind===5).at(-1);
   const between=events.filter(item=>item.sequence>exit.sequence&&item.sequence<reentry.sequence);
   for(const box of [[260,180,720,540],[340,220,760,560]])assert.ok(between.some(item=>item.message===0x47&&JSON.stringify(item.position)===JSON.stringify(box)),`Missing original WINDOWPOS ${box}`);
   assert.ok(between.some(item=>item.message===5&&item.wparam==='1'&&item.iconic===1),'Minimize while outside remains recorded');
   assert.ok(between.some(item=>item.message===5&&item.wparam==='0'&&item.iconic===0),'Restore while outside remains recorded');
   assert.ok(reentry.window[0]!==events[0].window[0],'Reentry uses the moved window');
   const keydowns=inputs.filter(item=>item.message===0x100);
   assert.equal(keydowns.length,2);assert.equal(BigInt(keydowns[1].keyLparam)&0xffffn,3n);assert.equal((BigInt(keydowns[1].keyLparam)>>30n)&1n,1n);
   assert.ok(inputs.some(item=>item.message===0x102&&item.wparam===String(0x4e2d)),'Posted character is recorded without pretending it proves IME');
   assert.equal(new Set(inputs.map(item=>item.tid)).size,2);
  }
 }finally{
  if(binding&&!ended)await run(['close',binding.root]);
  if(!ended)await Promise.race([exited,new Promise(resolveWait=>{const timer=setTimeout(()=>{if(!ended)fixture.kill();resolveWait();},3000);timer.unref();})]);
  await writeFile(resolve(directory,`${mode}-fixture.log`),raw.join('\n'));
 }
}

try{
 await scenario('run');
 await scenario('overflow');
 console.log(`PASS: independent recording observer, window sequence, outside filtering, two threads, overflow and unchanged input environment. Evidence: ${directory}`);
}catch(error){evidence.error=String(error.stack??error);throw error;}
finally{await writeFile(resolve(directory,'evidence.json'),JSON.stringify(evidence,null,2));}
