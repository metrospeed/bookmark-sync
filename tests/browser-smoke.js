// Optional smoke test using an installed Chromium browser. Uses only a fresh test profile.
import { spawn } from 'node:child_process';
import { mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createSyncServer } from '../server/index.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const temp=join(root,'.tmp','smoke-'+randomUUID());
await mkdir(temp,{recursive:true});
const token=randomUUID()+randomUUID();
const server=createSyncServer({token,database:':memory:'});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const serverUrl='http://127.0.0.1:'+server.address().port;
let browser,ws;
try {
  const unpacked=join(temp,'extension');
  await cp(join(root,'dist/chrome'),unpacked,{recursive:true});
  const manifest=JSON.parse(await readFile(join(unpacked,'manifest.json'),'utf8'));
  manifest.host_permissions=['http://127.0.0.1/*']; // Test profile only; shipped manifest remains optional.
  await writeFile(join(unpacked,'manifest.json'),JSON.stringify(manifest));
  const executable=process.env.BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  browser=spawn(executable,['--headless=new','--disable-gpu','--in-process-gpu','--no-sandbox','--no-first-run','--no-default-browser-check','--enable-unsafe-extension-debugging','--remote-debugging-port=0','--user-data-dir='+join(temp,'profile'),'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  const endpoint=await new Promise((resolve,reject)=>{
    let output='';const timeout=setTimeout(()=>reject(new Error('Browser startup timed out: '+output.slice(-500))),15000);
    browser.on('error',error=>{clearTimeout(timeout);reject(error);});
    browser.stderr.on('data',chunk=>{output+=chunk;const match=output.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timeout);resolve(match[1]);}});
  });
  ws=new WebSocket(endpoint);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  let counter=0;const requests=new Map();
  ws.onmessage=event=>{const result=JSON.parse(event.data);if(!result.id)return;const pending=requests.get(result.id);requests.delete(result.id);clearTimeout(pending?.timeout);if(result.error)pending?.reject(new Error(result.error.message));else pending?.resolve(result.result);};
  const cdp=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++counter;const timeout=setTimeout(()=>{requests.delete(id);reject(new Error(method+' timed out'));},10000);requests.set(id,{resolve,reject,timeout});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
  const {id}=await cdp('Extensions.loadUnpacked',{path:unpacked});
  const {targetId}=await cdp('Target.createTarget',{url:'chrome-extension://'+id+'/options.html'});
  const {sessionId}=await cdp('Target.attachToTarget',{targetId,flatten:true});
  await cdp('Runtime.enable',{},sessionId);
  const evaluate=async expression=>{
    const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.text+' '+JSON.stringify(result.exceptionDetails.exception));
    return result.result.value;
  };
  assert.equal(await evaluate("(async()=>{for(let i=0;i<500;i++){if(document.title==='Settings · Bookmark Sync')return document.title;await new Promise(r=>setTimeout(r,10));}return document.title;})()"),'Settings · Bookmark Sync');
  const settings={serverUrl,token,deviceName:'Browser test',autoSync:false};
  const configured=await evaluate('chrome.runtime.sendMessage('+JSON.stringify({type:'saveSettings',settings})+')');
  assert.equal(configured.ok,true,configured.error);
  await evaluate("chrome.bookmarks.create({parentId:'1',title:'Real browser bookmark',url:'https://example.com/'})");
  const synced=await evaluate('chrome.runtime.sendMessage({type:"sync"})');
  assert.equal(synced.ok,true,synced.error);assert.equal(synced.result.count,1);
  const result=await (await fetch(serverUrl+'/v1/sync',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({protocol:1,deviceId:randomUUID(),operations:[]})})).json();
  const link=result.records.find(r=>!r.deleted&&r.kind==='bookmark');assert.equal(link.title,'Real browser bookmark');
  const remoteDevice=randomUUID();
  await fetch(serverUrl+'/v1/sync',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({protocol:1,deviceId:remoteDevice,operations:[{id:link.id,seq:1,type:'patch',fields:{title:'Updated from server'}}]})});
  assert.equal((await evaluate('chrome.runtime.sendMessage({type:"sync"})')).ok,true);
  assert.equal((await evaluate('chrome.bookmarks.search({url:"https://example.com/"})'))[0].title,'Updated from server');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1200,height:1000,deviceScaleFactor:1,mobile:false},sessionId);
  const screenshot=await cdp('Page.captureScreenshot',{format:'png'},sessionId);
  await writeFile(join(root,'.tmp','browser-settings.png'),Buffer.from(screenshot.data,'base64'));
  console.log('PASS: real Chromium extension loads, configures, uploads, and pulls changes.');
  await cdp('Browser.close');
} finally {
  ws?.close();browser?.kill();
  await new Promise(resolve=>server.close(resolve));
  // Validate our generated path before recursive deletion.
  // Keep the isolated profile for diagnosis if Windows still holds browser files.
  if(resolve(temp).startsWith(resolve(join(root,'.tmp')) + sep)) await rm(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});
}
