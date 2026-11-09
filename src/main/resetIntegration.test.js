"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { ExecutionHost } = require("./executionHost"), { ExecutionRouter } = require("./executionRouter"), { createService } = require("../server/service");
const { RemoteClient } = require("./remoteClient");
const roots=[]; function dir(){ const d=fs.mkdtempSync(path.join(os.tmpdir(),"vespera-reset-int-")); roots.push(d); return d; }
const TOKEN="existing-token-"+"a".repeat(45), CODE="independent-recovery-code-"+"b".repeat(30);
const engineOptions=()=>({market:{bars:[],on(){},start(){},stop(){}},live:{configure(){},async getQuote(){return null;}}});
const factory=options=>new ExecutionHost({...options,engineOptions:engineOptions()});
(async()=>{
 const serverDir=dir(), oldDir=dir(), newDir=dir(); let service, old, fresh;
 try {
  service=createService({userDataDir:serverDir,token:TOKEN,resetCode:CODE,hostFactory:factory});
  await new Promise(r=>service.server.listen(0,"127.0.0.1",r)); const url=`http://127.0.0.1:${service.server.address().port}`;
  const oldHost=factory({userDataDir:oldDir}); old=new ExecutionRouter({userDataDir:oldDir,host:oldHost,pollMs:100000});
  await old.configure({url,token:TOKEN});
  await old.dispatch("saveSettings",[{sizingMode:"fixed",fixedStakes:[5,10,20]}]);
  const freshHost=factory({userDataDir:newDir}); fresh=new ExecutionRouter({userDataDir:newDir,host:freshHost,pollMs:100000});
  await assert.rejects(fresh.resetAccess({url,token:TOKEN,code:CODE}),e=>e.code==="reset_local_owner_unverified");
  assert.equal(service.owner.owner,"local");
  await assert.rejects(old.resetAccess({url,code:"bad"}),e=>e.code==="reset_code_invalid");
  assert.equal(old.mode,"local");
  const reset=await old.resetAccess({url,code:CODE}); assert.equal(reset.ok,true); assert.equal(reset.newToken.length,43);
  assert.equal(service.owner.owner,"server"); assert.equal(service.owner.resetUnclaimed,true);
  await assert.rejects(new RemoteClient({url,token:TOKEN}).request("/v1/status"), e=>e.code==="remote_unauthorized");
  await assert.rejects(old.dispatch("start"),e=>e.code==="remote_unauthorized");
  await fresh.configure({url,token:reset.newToken}); assert.equal(fresh.mode,"server");
  const state=await fresh.dispatch("snapshot"); assert.deepEqual(state.settings.fixedStakes,[5,10,20],"owner account is imported without overwriting it from new device");
  assert.equal((await fresh.dispatch("start")).ok,true);
  await fresh.dispatch("stop");
  // Server-owned real position: partial fill retains a lock until the next
  // confirmed sale. All data here is mocked; no live order is sent.
  const e=service.host.engine;
  const bet={mode:"auto",dryRun:false,clientOrderId:"live-buy",side:"UP",tokenId:"123",shares:"10",sizeUsd:"4",feeUsd:"0.04",entryPrice:0.4,slug:"mock",placedAt:1};
  e.journal.write({type:"order_sent",...bet}); e.liveBet={...bet};
  let count=0; const hashes=["0x"+"a".repeat(64),"0x"+"b".repeat(64)];
  e.live.submitSale=async ({onPrepared})=>{const id=hashes[count]; count++; await onPrepared({orderId:id,maker:"wallet",tokenId:"123",shares:10,limitPrice:0.3,feeRate:0.07,feeExponent:1}); return {ok:true,evidence:{orderId:id}};};
  e.live.inspectOrder=async pending=>{const first=pending.evidence.orderId===hashes[0];return {ok:true,kind:"sold",sale:{orderId:pending.evidence.orderId,tokenId:"123",shares:first?"6":"4",proceedsUsd:first?"3":"2",feeUsd:"0.1"},evidence:{orderId:pending.evidence.orderId}};};
  const thirdDir=dir(), thirdHost=factory({userDataDir:thirdDir});
  const third=new ExecutionRouter({userDataDir:thirdDir,host:thirdHost,pollMs:100000,resetWaitMs:0});
  try {
   await assert.rejects(third.resetAccess({url,token:reset.newToken,code:CODE}),err=>err.code==="reset_position_open");
   assert.equal(count,1); assert.equal(e.liveBet.shares,"4.000000"); assert.equal(service.owner.resetPending,true);
   await assert.rejects(fresh.dispatch("start"),err=>err.code==="reset_in_progress");
   const again=await third.resetAccess({url,code:CODE}); assert.equal(count,2); assert.equal(e.liveBet,null); assert.equal(again.ok,true);
   assert.equal(e.journal.restoreEntries.find(x=>x.type==="settled" && x.clientOrderId==="live-buy").pnl,"0.76");
   assert.equal(service.owner.resetUnclaimed,true); assert.equal((await third.configure({url,token:again.newToken})).mode,"server");
   const fourthDir=dir(); let drop=true;
   const clientFactory=options=>{const client=new RemoteClient(options); return {async request(route,body) {const reply=await client.request(route,body); if (route==="/v1/reset" && drop) {drop=false; const err=Error("lost response");err.code="remote_unavailable";throw err;} return reply;}};};
   let fourth=new ExecutionRouter({userDataDir:fourthDir,host:factory({userDataDir:fourthDir}),clientFactory,pollMs:100000});
   try {
    await assert.rejects(fourth.resetAccess({url,token:again.newToken,code:CODE}),err=>err.code==="remote_unavailable");
    assert.equal(service.owner.resetUnclaimed,true);
    fourth.dispose(); fourth=new ExecutionRouter({userDataDir:fourthDir,host:factory({userDataDir:fourthDir}),clientFactory,pollMs:100000});
    const recovered=await fourth.resetAccess({url,code:CODE});
    assert.equal(recovered.ok,true,"lost reset reply is recovered with the pre-saved new token");
    assert.equal(count,2,"lost response does not repeat a sale");
    assert.equal((await fourth.configure({url,token:recovered.newToken})).mode,"server");
   } finally {fourth.dispose();}
  } finally {third.dispose();}
  console.log("Reset end-to-end integration tests ok");
 } finally {old?.dispose();fresh?.dispose();await service?.close(); for(const d of roots) fs.rmSync(d,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
