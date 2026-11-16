import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import api from '../.test-api.mjs';
import consoleWorker from '../.test-console.mjs';
import { createHmac } from 'node:crypto';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('shared/schema.sql', 'utf8'));
  db.exec("INSERT INTO users(user_id,created_at) VALUES ('owner',1),('other',1)");
  const hmac = token => createHmac('sha256', 'test-key').update('apitoken:' + token).digest('base64url');
  for (const [id, token, permission, owner, site] of [['w','pvuv_write','write','owner',null],['r','pvuv_read','read','owner',null],['o','pvuv_other','write','other',null]]) {
    db.prepare('INSERT INTO api_tokens(token_id,owner_id,name,token_hash,prefix,site_id,created_at,permission) VALUES(?,?,?,?,?,?,?,?)').run(id,owner,id,hmac(token),id,site,1,permission);
  }
  const DB={prepare(sql){let args=[];return {bind(...x){args=x;return this},async first(){return db.prepare(sql).get(...args) ?? null},async all(){return {results:db.prepare(sql).all(...args)}},async run(){const result=db.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}}}}}};
  const cache = new Map(); const messages=[];
  return {db,messages,env:{DB,HMAC_KEY:'test-key',SITE_CONFIG:{put:async(k,v)=>cache.set(k,v)},INGEST_QUEUE:{sendBatch:async(batch)=>messages.push(...batch)}},cache};
}
async function request(env, token, path, body) {return api.fetch(new Request('https://api.test'+path,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)}),env)}
test('write token creates an owned site and retries reuse it; read-only cannot write',async()=>{
  const {env,db,cache}=fixture();
  const body={domain:'example.com',name:'Example'};
  assert.equal((await request(env,'pvuv_read','/v1/sites',body)).status,403);
  const response=await request(env,'pvuv_write','/v1/sites',body);
  assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.created,true);assert.ok(result.site.site_id);
  assert.equal(db.prepare('SELECT owner_id FROM sites WHERE site_id=?').get(result.site.site_id).owner_id,'owner');
  assert.ok(cache.has('site:'+result.site.site_id));
  const again=await (await request(env,'pvuv_write','/v1/sites',body)).json();assert.equal(again.created,false);assert.equal(again.site.site_id,result.site.site_id);
  assert.equal((await request(env,'pvuv_other',`/v1/sites/${result.site.site_id}/tokens`,{})).status,403);
});
test('write token mints a site-scoped ingest-only token (details: tests/crawler-hits.test.mjs)',async()=>{
  const {env}=fixture();const created=await (await request(env,'pvuv_write','/v1/sites',{domain:'example.com',name:'Example'})).json();
  const response=await request(env,'pvuv_write',`/v1/sites/${created.site.site_id}/tokens`,{});
  assert.equal(response.status,200);const body=await response.json();assert.match(body.token,/^pvuv_/);assert.deepEqual(body.scopes,['ingest']);assert.equal(body.site_id,created.site.site_id);
});
test('write token creates a funnel only for an owned site',async()=>{
  const {env}=fixture();const created=await (await request(env,'pvuv_write','/v1/sites',{domain:'example.com',name:'Example'})).json();const id=created.site.site_id;
  const r=await request(env,'pvuv_write',`/v1/sites/${id}/funnels`,{name:'Game',steps:[{type:'page',value:'/'},{type:'event',value:'play_start'}]});assert.equal(r.status,200);assert.ok((await r.json()).funnel_id);
  assert.equal((await request(env,'pvuv_other',`/v1/sites/${id}/funnels`,{name:'x',steps:[]})).status,403);
});

test('console issues explicitly scoped write credentials while default remains read-only',async()=>{
  const {env,db}=fixture(); const payload=Buffer.from(JSON.stringify({u:'owner',exp:Date.now()+60000})).toString('base64url');
  const sig=createHmac('sha256','test-key').update('session|'+payload).digest('base64url');
  const issue=async body=>consoleWorker.fetch(new Request('https://console.test/api/tokens',{method:'POST',headers:{cookie:`_pvc_s=${payload}.${sig}`,'content-type':'application/json'},body:JSON.stringify(body)}),env);
  const read=await (await issue({name:'read'})).json();assert.equal(db.prepare('SELECT permission FROM api_tokens WHERE token_id=?').get(read.token_id).permission,'read');
  const write=await (await issue({name:'integration',permission:'write'})).json();assert.equal(db.prepare('SELECT permission FROM api_tokens WHERE token_id=?').get(write.token_id).permission,'write');
  assert.equal((await issue({name:'bad',permission:'ingest'})).status,400);
});
test('simultaneous site requests cannot create duplicate domains',async()=>{
  const {env,db}=fixture();const body={domain:'race.example.com',name:'Race'};
  const rs=await Promise.all(Array.from({length:5},()=>request(env,'pvuv_write','/v1/sites',body)));
  assert.ok(rs.every(r=>r.status===200));const ids=await Promise.all(rs.map(async r=>(await r.json()).site.site_id));assert.equal(new Set(ids).size,1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sites WHERE owner_id='owner'").get().n,1);
});
test('migration preserves old token permissions as read only',()=>{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE api_tokens(token_id TEXT PRIMARY KEY); INSERT INTO api_tokens VALUES (\'old\')');
  db.exec(readFileSync('migrations/0022_api_token_permissions.sql','utf8'));
  assert.equal(db.prepare('SELECT permission FROM api_tokens').get().permission,'read');
});
test('site creation accepts IDNA ASCII top-level domains',async()=>{
  const {env}=fixture();assert.equal((await request(env,'pvuv_write','/v1/sites',{domain:'example.xn--p1ai',name:'Example'})).status,200);
});
