"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const { ExecutionHost }=require("./executionHost"),{ ExecutionRouter }=require("./executionRouter"),{ createService }=require("../server/service");
const dirs=[];function dir(){const d=fs.mkdtempSync(path.join(os.tmpdir(),"vesp-remreset-"));dirs.push(d);return d;}
const factory=o=>new ExecutionHost({...o,engineOptions:{market:{bars:[],on(){},start(){},stop(){}},live:{configure(){},async getQuote(){return null;}}}});
(async()=>{
 const root=dir(),od=dir(),nd=dir(), token="token-"+"x".repeat(48),code="independent-code-"+"y".repeat(32);let service,owner,newDevice;
 try {
  service=createService({userDataDir:root,token,resetCode:code,hostFactory:factory});await new Promise(r=>service.server.listen(0,"127.0.0.1",r));const url=`http://127.0.0.1:${service.server.address().port}`;
  owner=new ExecutionRouter({userDataDir:od,host:factory({userDataDir:od}),pollMs:100000});
  newDevice=new ExecutionRouter({userDataDir:nd,host:factory({userDataDir:nd}),pollMs:100000,resetWaitMs:2000,resetRetryMs:50});
  await owner.configure({url,token});await owner.dispatch("saveSettings",[{sizingMode:"fixed",fixedStakes:[7,14]}]);
  await owner.poll();assert.equal(Boolean(service.owner.deviceProofHash),true,"original device enrolled its private proof");
  const resetPromise=newDevice.resetAccess({url,token,code});
  for(let i=0;i<50&&!service.owner.resetPending;i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(service.owner.resetPending,true);assert.equal(service.owner.owner,"local");
  const bad=await fetch(url+"/v1/reset/local-ready",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({requestId:service.owner.resetRequestId,deviceId:service.owner.deviceId,deviceProof:"wrong",bundle:{}})});
  assert.equal(bad.status,403,"another client cannot impersonate the owner");
  await owner.poll();assert.equal(owner.mode,"transition");assert.equal(service.owner.owner,"server");
  await assert.rejects(owner.dispatch("start"),err=>err.code==="handoff_pending");
  const done=await resetPromise;assert.equal(done.ok,true,"one click waits for the original device");
  await newDevice.configure({url,token:done.newToken});assert.equal(newDevice.mode,"server");
  assert.deepEqual((await newDevice.dispatch("snapshot")).settings.fixedStakes,[7,14]);
  await assert.rejects(owner.dispatch("start"),err=>err.code==="handoff_pending");
  console.log("Remote local-owner reset tests ok");
 }finally{owner?.dispose();newDevice?.dispose();await service?.close();for(const d of dirs)fs.rmSync(d,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
