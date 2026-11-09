"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const { createService } = require("./service");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-reset-"));
const OLD = "old-token-" + "a".repeat(48), NEW = "new-token-" + "b".repeat(48), CODE = "reset-code-" + "c".repeat(32);
let host, service, url;
function fakeHost() {
 return { engine: { settings: {}, liveBet: null, journal: { pendingOrder: () => null } }, active: false, running: false,
  async call(method) { if (method === "start") this.running = true; return { ok: true, running: this.running }; },
  async quiesce() { this.running = false; if (this.active) throw Error("open position"); },
  idle() { return !this.active; }, async importBundle() {}, async exportBundle() { return {}; }, async dispose() {} };
}
async function start() {
 host = fakeHost(); service = createService({ userDataDir: root, token: OLD, resetCode: CODE, host });
 await new Promise(r => service.server.listen(0, "127.0.0.1", r)); url = `http://127.0.0.1:${service.server.address().port}`;
}
async function call(route, body, token = OLD) {
 const response = await fetch(url + route, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, ...(body ? {"content-type":"application/json"} : {}) }, ...(body ? {body:JSON.stringify(body)} : {}) });
 return { status: response.status, body: await response.json() };
}
(async () => {
 await start();
 assert.equal((await call("/v1/register", {deviceId:"pc-a",requestId:"reg"})).status, 200);
 let r = await call("/v1/reset", {requestId:"r1",code:CODE,newToken:NEW});
 assert.equal(r.body.error, "reset_local_owner_unverified", "cannot take over offline local executor");
 assert.equal((await call("/v1/status")).status, 200);
 const proof = "device-proof-" + "p".repeat(40);
 assert.equal((await call("/v1/device-enroll", {deviceId:"pc-a",deviceProof:proof})).status,200);
 assert.equal((await call("/v1/reset", {deviceId:"pc-a",deviceProof:"wrong",requestId:"spoof",code:CODE,newToken:NEW,bundle:{}})).body.error,"device_proof_invalid");
 assert.ok(!service.owner.resetPending,"spoofed local reset cannot lock the account");
 assert.equal((await call("/v1/activate", {deviceId:"pc-a",requestId:"activate",bundle:{settings:{}}})).status, 200);
 r = await call("/v1/reset", {requestId:"r1",code:"wrong",newToken:NEW}); assert.equal(r.body.error,"reset_code_invalid");
 host.active = true;
 r = await call("/v1/reset", {requestId:"r1",code:CODE,newToken:NEW}); assert.equal(r.body.error,"reset_position_open");
 assert.equal(service.owner.resetPending,true); assert.equal((await call("/v1/command", {deviceId:"pc-a",requestId:"start",method:"start",args:[]})).body.error,"reset_in_progress");
 host.active = false;
 const command=JSON.stringify({deviceId:"pc-a",requestId:"late-old-command",method:"start",args:[]});
 let pendingRequest;
 const lateReply=new Promise((resolve,reject)=>{pendingRequest=http.request(url+"/v1/command",{method:"POST",headers:{authorization:`Bearer ${OLD}`,"content-type":"application/json","content-length":Buffer.byteLength(command)}},res=>{res.resume();res.on("end",()=>resolve(res.statusCode));});pendingRequest.on("error",reject);pendingRequest.flushHeaders();});
 await new Promise(resolve=>setTimeout(resolve,30));
 r = await call("/v1/reset", {requestId:"r1",code:CODE,newToken:NEW}); assert.equal(r.body.ok,true); assert.equal(service.owner.deviceId,null);
 pendingRequest.end(command); assert.equal(await lateReply,401,"preauthorized request cannot execute after credential rotation");
 assert.equal((await call("/v1/status")).status,401); assert.equal((await call("/v1/status",null,NEW)).body.resetUnclaimed,true);
 await service.close(); service = null; await start();
 assert.equal((await call("/v1/status")).status,401,"old token stays revoked after restart");
 r = await call("/v1/register",{deviceId:"pc-b",requestId:"claim"},NEW); assert.equal(r.body.owner,"server");
 assert.equal((await call("/v1/register",{deviceId:"pc-b",requestId:"claim"},NEW)).body.owner,"server","claim retry is idempotent");
 assert.equal((await call("/v1/command",{deviceId:"pc-a",requestId:"stale",method:"start",args:[]},NEW)).body.error,"owner_device_mismatch");
 assert.equal((await call("/v1/command",{deviceId:"pc-b",requestId:"new",method:"start",args:[]},NEW)).body.ok,true);
 await service.close(); service=null;
 const failedRoot=fs.mkdtempSync(path.join(os.tmpdir(),"vespera-reset-io-"));
 let ioService; const ioHost=fakeHost(); let stopped=false; ioHost.engine.stop=()=>{stopped=true;};
 try {
  ioService=createService({userDataDir:failedRoot,token:OLD,resetCode:CODE,host:ioHost});
  await new Promise(resolve=>ioService.server.listen(0,"127.0.0.1",resolve));
  const ioUrl=`http://127.0.0.1:${ioService.server.address().port}`;
  const rename=fs.renameSync; fs.renameSync=function(a,b){if(b===path.join(failedRoot,"ownership.json"))throw Error("simulated disk failure");return rename.call(this,a,b);};
  try { await fetch(ioUrl+"/v1/register",{method:"POST",headers:{authorization:`Bearer ${OLD}`,"content-type":"application/json"},body:JSON.stringify({deviceId:"x",requestId:"io"})}); }
  finally {fs.renameSync=rename;}
  assert.equal(stopped,true); assert.equal((await fetch(ioUrl+"/healthz")).status,503,"disk failure locks service");
  assert.equal((await fetch(ioUrl+"/v1/status",{headers:{authorization:`Bearer ${OLD}`}})).status,503);
 } finally {await ioService?.close();fs.rmSync(failedRoot,{recursive:true,force:true});}
 console.log("Device reset server tests ok");
})().catch(e => {console.error(e);process.exitCode=1;}).finally(async()=>{await service?.close();fs.rmSync(root,{recursive:true,force:true});});
