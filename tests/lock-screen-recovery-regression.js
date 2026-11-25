'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const app=fs.readFileSync('app.js','utf8'),html=fs.readFileSync('index.html','utf8');
function extract(name){const a=app.indexOf('function '+name+'('),b=app.indexOf('\nfunction ',a+1);assert(a>=0&&b>a,name);return app.slice(a,b);}
const ctx={};vm.createContext(ctx);vm.runInContext(extract('ptRDecision')+'\n'+extract('ptRCanKeep')+'\nthis.decide=ptRDecision;this.keep=ptRCanKeep;',ctx);
const d={loaded:true,paused:true,ended:false,compatible:true,pending:false,since:20000,expired:false};
assert.equal(ctx.decide(d),'play');assert.equal(ctx.decide({...d,since:100}),'play');assert.equal(ctx.decide({...d,pending:true}),'duplicate');assert.equal(ctx.decide({...d,paused:false,since:200}),'duplicate');assert.equal(ctx.decide({...d,paused:false}),'pause');assert.equal(ctx.decide({...d,paused:false,compatible:false}),'play');assert.equal(ctx.decide({...d,expired:true}),'expired');assert.equal(ctx.decide({...d,loaded:false}),'empty');
const k={mode:'experimental',ios:true,paused:true,ended:false,loaded:true,sleep:false,blocked:false};
assert(ctx.keep(k));for(const change of [{mode:'standard'},{mode:'smart'},{ios:false},{paused:false},{ended:true},{loaded:false},{sleep:true},{blocked:true}])assert(!ctx.keep({...k,...change}));
const smart=extract('ptRPlay');
assert(!/audio\.load\(|audio\.src\s*=|audio\.currentTime\s*=|new Audio\(/.test(smart));
for(const id of ['ptRecoveryStatus','ptRecoveryDiagnostic','ptRecoveryCopy','ptRecoveryClear'])assert.equal(html.split('id="'+id+'"').length-1,1,id);
for(const mode of ['standard','smart','experimental'])assert(html.includes('name="ptRecoveryMode" value="'+mode+'"'));
assert(app.includes("ptRStop('睡眠定時設定',true)"));assert(app.includes("ptRStop('睡眠定時到期',true)"));assert(app.includes('osc.stop(ctx.currentTime+600)'));assert(app.includes("ptRStop('章節釋放',true)"));assert(app.includes("ptRMode!=='standard'"));
async function run(){
  let resolve,reject,plays=0,pauses=0,checks=0;const logs=[];
  const audio={src:'blob:original',paused:true,ended:false,currentTime:123,play(){plays++;return new Promise((a,b)=>{resolve=a;reject=b;});},pause(){pauses++;this.paused=true;}};
  const env={audio,state:{current:{id:'a'},iosSingleButtonCompatibility:true,sleepDeadline:0},ptRLast:0,ptRPending:false,ptREpoch:0,ptRLog:s=>logs.push(s),logMediaAction:s=>logs.push(s),ptRStop(){},ptRStatus:s=>logs.push(s),requestPlaybackAudioSession(){},isIOSHeadphoneEnvironment:()=>true,checkSleepTimer:()=>checks++,$:()=>null};
  env.ptRInvalidate=()=>{env.ptRPending=false;env.ptREpoch++;};
  vm.createContext(env);vm.runInContext(extract('ptRDecision')+'\n'+smart+'\nthis.run=ptRPlay;',env);
  env.run();assert.equal(plays,1,'play called synchronously');env.run();assert.equal(plays,1,'in-flight repeat ignored');
  audio.paused=false;resolve();await new Promise(setImmediate);assert.equal(env.ptRPending,false);assert.equal(audio.src,'blob:original');assert.equal(audio.currentTime,123);assert(logs.includes('智慧 Play 成功'));
  env.run();assert.equal(pauses,0,'immediate duplicate must not pause');
  env.ptRLast=Date.now()-1000;env.run();assert.equal(pauses,1,'single-button pause retained');
  env.run();assert.equal(plays,2);env.ptRInvalidate();reject(new Error('stale'));await new Promise(setImmediate);assert(!logs.some(x=>x.includes('智慧 Play 失敗')),'stale rejection ignored');
  env.state.sleepDeadline=Date.now()-1;env.run();assert.equal(plays,2);assert.equal(checks,1,'expired timer wins');
  console.log('PASS lock-screen decision, synchronous resume, duplicate suppression, headphone toggle, stale promise, sleep guard and bounded opt-in keepalive');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
