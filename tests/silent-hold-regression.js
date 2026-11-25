'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const app=fs.readFileSync('app.js','utf8'),html=fs.readFileSync('index.html','utf8'),engine=fs.readFileSync('silent-hold.js','utf8');
const ctx={};vm.createContext(ctx);vm.runInContext(engine+'\nthis.wav=ptHWav;this.can=ptHCanEnter;this.clamp=ptHClamp;this.facade=ptHoldFacade;this.snap=x=>ptHSnapshot=x;',ctx);
const base={mode:'silent',ios:true,loaded:true,paused:false,ended:false,seeking:false,sleep:false,busy:false};
assert(ctx.can(base));for(const v of [{mode:'smart'},{ios:false},{loaded:false},{paused:true},{ended:true},{seeking:true},{sleep:true},{busy:true}])assert(!ctx.can({...base,...v}));
for(const n of [1,5,10,30]){const b=ctx.wav(n);assert.equal(b.length,44+480000*n);assert.equal(String.fromCharCode(...b.slice(0,4)),'RIFF');assert.equal(b[44],128);assert.equal(b[b.length-1],128);assert.equal(new DataView(b.buffer).getUint32(40,true),480000*n);}
assert.throws(()=>ctx.wav(60));assert.equal(ctx.clamp(-10,100),0);assert.equal(ctx.clamp(200,100),99.95);
const raw={currentTime:1,duration:60,src:'blob:silence',paused:false,ended:true,seeking:false,readyState:4,playbackRate:1,addEventListener(type,fn){this.fn=fn;}};
let calls=0;const audio=ctx.facade(raw);audio.addEventListener('timeupdate',()=>calls++);raw.fn();assert.equal(calls,1);
const snap={position:37,duration:500,source:'blob:original',rate:1.5};ctx.snap(snap);
assert.equal(audio.currentTime,37);assert.equal(audio.duration,500);assert.equal(audio.src,'blob:original');assert.equal(audio.paused,true);assert.equal(audio.ended,false);assert.equal(audio.playbackRate,1.5);raw.fn();assert.equal(calls,1);audio.currentTime=45;assert.equal(snap.position,45);assert.equal(raw.currentTime,1);ctx.snap(null);raw.fn();assert.equal(calls,2);
assert(html.includes('name="ptRecoveryMode" value="silent"'));assert(html.includes('id="ptHoldMinutes"'));assert(html.indexOf('src="./silent-hold.js?v=4502"')<html.indexOf('src="./app.js?v=4502"'));
assert(app.includes("ptHHardStop('睡眠定時設定')"));assert(app.includes("ptHHardStop('睡眠定時到期')"));assert(app.includes("ptHDiscard('章節釋放')"));assert(engine.includes('ptHSave()'));assert(app.includes("if(ptHMediaAction('pause'))return"));
console.log('PASS finite WAV lengths, eligibility, frozen logical time, event isolation, sleep and release guards');
