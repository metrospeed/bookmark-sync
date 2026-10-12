import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSyncServer } from '../server/index.js';
const token='test-token-'+randomUUID();
async function fixture(t) {
  const server=createSyncServer({token,database:':memory:'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port;
  const post=(body,extra={})=>fetch(url+'/v1/sync',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...extra},body:typeof body==='string'?body:JSON.stringify(body)});
  return {server,url,post};
}
test('health works without authentication and sync requires the token',async t=>{const f=await fixture(t);assert.equal((await fetch(f.url+'/health')).status,200);assert.equal((await fetch(f.url+'/v1/sync',{method:'POST'})).status,401);assert.equal((await f.post({protocol:1,deviceId:randomUUID(),operations:[]})).status,200);});
test('HTTP sync persists records and retries are idempotent',async t=>{const f=await fixture(t);const body={protocol:1,deviceId:randomUUID(),operations:[{id:randomUUID(),seq:1,type:'patch',fields:{kind:'bookmark',title:'HTTP bookmark',url:'https://example.com',parentId:'root:toolbar',index:0}}]};const first=await f.post(body);assert.equal(first.headers.get('cache-control'),'no-store');const data=await first.json();assert.deepEqual(await (await f.post(body)).json(),data);});
test('rejects malformed JSON and wrong media types without modifying the database',async t=>{const f=await fixture(t);assert.equal((await f.post('{broken')).status,400);assert.equal((await f.post('{}',{'Content-Type':'text/plain'})).status,415);const data=await (await f.post({protocol:1,deviceId:randomUUID(),operations:[]})).json();assert.equal(data.records.length,0);});
test('website origins are blocked; extension origins can preflight',async t=>{const f=await fixture(t);assert.equal((await f.post({}, {Origin:'https://evil.example'})).status,403);const response=await fetch(f.url+'/v1/sync',{method:'OPTIONS',headers:{Origin:'chrome-extension://abcdefghijklmnop'}});assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),'chrome-extension://abcdefghijklmnop');assert.equal(response.headers.get('access-control-allow-headers'),'Authorization, Content-Type');});
test('HTTP method and route restrictions are explicit',async t=>{const f=await fixture(t);assert.equal((await fetch(f.url+'/v1/sync',{headers:{Authorization:'Bearer '+token}})).status,405);assert.equal((await fetch(f.url+'/missing',{headers:{Authorization:'Bearer '+token}})).status,404);});
test('oversized request is rejected',async t=>{const f=await fixture(t);const response=await f.post(JSON.stringify({padding:'x'.repeat(16*1024*1024)}));assert.equal(response.status,413);});
test('unauthorized request floods are rate limited',async t=>{const f=await fixture(t);let response;for(let i=0;i<121;i++)response=await fetch(f.url+'/v1/sync',{method:'POST'});assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'60');});
test('short or missing server tokens fail startup',()=>{assert.throws(()=>createSyncServer({database:':memory:',token:'short'}),/at least 32/);});
