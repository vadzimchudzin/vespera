"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {ExecutionHost}=require("./executionHost"),{ExecutionRouter}=require("./executionRouter"),{createService}=require("../server/service");
const dirs=[];function dir(){const d=fs.mkdtempSync(path.join(os.tmpdir(),"vesp-remreset-live-"));dirs.push(d);return d;}
const hashes=["0x"+"a".repeat(64),"0x"+"b".repeat(64)];let count=0;
const live={configure(){},async getQuote(){return null;},async getBalance(){return null;},
 async submitSale({onPrepared}){const id=hashes[count++];await onPrepared({orderId:id,maker:"wallet",tokenId:"123",shares:10,limitPrice:0.3,feeRate:0.07,feeExponent:1});return {ok:true,evidence:{orderId:id}};},
 async inspectOrder(pending){const first=pending.evidence.orderId===hashes[0];return {ok:true,kind:"sold",sale:{orderId:pending.evidence.orderId,tokenId:"123",shares:first?"6":"4",proceedsUsd:first?"3":"2",feeUsd:"0.1"},evidence:{orderId:pending.evidence.orderId}};}};
const factory=o=>new ExecutionHost({...o,engineOptions:{market:{bars:[],on(){},start(){},stop(){}},live}});
(async()=>{
 const root=dir(),od=dir(),nd=dir(),token="token-"+"x".repeat(48),code="independent-code-"+"y".repeat(32);let service,owner,newDevice;
 try{
  service=createService({userDataDir:root,token,resetCode:code,hostFactory:factory});await new Promise(r=>service.server.listen(0,"127.0.0.1",r));const url=`http://127.0.0.1:${service.server.address().port}`;
  const oldHost=factory({userDataDir:od});owner=new ExecutionRouter({userDataDir:od,host:oldHost,pollMs:100000});
  newDevice=new ExecutionRouter({userDataDir:nd,host:factory({userDataDir:nd}),pollMs:100000,resetWaitMs:0});
  await owner.configure({url,token});await owner.poll();
  oldHost.store.save({mode:"auto",dryRun:false});oldHost.engine.mode="auto";
  const bet={mode:"auto",dryRun:false,clientOrderId:"buy-1",side:"UP",tokenId:"123",shares:"10",sizeUsd:"4",feeUsd:"0.04",entryPrice:0.4,slug:"mock",placedAt:1};
  oldHost.engine.journal.write({type:"order_sent",...bet});oldHost.engine.liveBet={...bet};
  await assert.rejects(newDevice.resetAccess({url,token,code}),e=>e.code==="reset_waiting_owner");
  await owner.poll();assert.equal(count,1);assert.equal(owner.host.engine.liveBet.shares,"4.000000");assert.equal(service.owner.owner,"local");
  owner.dispose();owner=new ExecutionRouter({userDataDir:od,host:factory({userDataDir:od}),pollMs:100000});
  assert.equal(owner.mode,"transition");assert.equal(owner.host.engine.liveBet.shares,"4.000000");
  for (let i=0;i<100 && owner.polling;i++) await new Promise(r=>setTimeout(r,10));
  if (count < 2) await owner.poll();
  assert.equal(count,2);assert.equal(service.owner.owner,"server");
  const result=await newDevice.resetAccess({url,code});assert.equal(result.ok,true);
  const row=service.host.engine.journal.restoreEntries.find(e=>e.type==="settled" && e.clientOrderId==="buy-1");
  assert.equal(row.pnl,"0.76");assert.equal(service.host.engine.liveBet,null);
  console.log("Remote reset of live position after restart tests ok");
 }finally{owner?.dispose();newDevice?.dispose();await service?.close();for(const d of dirs)fs.rmSync(d,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
