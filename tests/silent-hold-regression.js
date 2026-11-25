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

/* Ambient Hold and narration mix regression: test generated samples, independent
 * settings, no mix when the logical chapter is paused, and sleep isolation. */
vm.runInContext('this.samples=ptAmbientSamples;this.resolveSound=ptAmbientResolve;this.volume=ptAmbientVolume;this.mixAllowed=ptMixAllowed;',ctx);
for(const sound of ['campfire','rain','stream','onsen','brown']){
 const samples=ctx.samples(sound);assert.equal(samples.length,96000);
 assert(samples.every(Number.isFinite),sound+' has nonfinite samples');
 assert(samples.some(x=>Math.abs(x)>.005),sound+' is unexpectedly silent');
 assert(samples.every(x=>Math.abs(x)<=.80001),sound+' clips');
 assert.equal(Math.abs(samples[0]),0);assert.equal(Math.abs(samples[samples.length-1]),0);
}
assert(ctx.samples('silent').every(x=>x===0));
assert.equal(ctx.resolveSound('auto','capybara-onsen'),'onsen');
assert.equal(ctx.resolveSound('auto','forest-reading'),'campfire');
assert.equal(ctx.volume(100),30);assert.equal(ctx.volume(-1),0);
const audible=ctx.wav(1,'campfire',.1),quiet=ctx.wav(1,'campfire',0);
assert(audible.subarray(44).some(x=>x!==128));assert(quiet.subarray(44).every(x=>x===128));
assert.equal(audible[audible.length-1],128);
const mix={enabled:true,sound:'campfire',volume:10,loaded:true,paused:false,ended:false,holding:false,expired:false};
assert(ctx.mixAllowed(mix));
for(const change of [{enabled:false},{sound:'silent'},{volume:0},{loaded:false},{paused:true},{ended:true},{holding:true},{expired:true}])assert(!ctx.mixAllowed({...mix,...change}));
for(const id of ['ptAmbientHold','ptAmbientHoldVolume','ptAmbientHoldValue','ptAmbientMix','ptAmbientMixVolume','ptAmbientMixValue','ptAmbientMixEnabled','ptAmbientMixStatus'])assert.equal(html.split('id="'+id+'"').length-1,1,id);
assert(engine.includes("ptMixStop('進入保活')"));
assert(engine.includes("['pause','ended','emptied','loadstart','waiting','error']"));
assert(engine.includes("state.sleepDeadline-Date.now()"));
assert(!/new Audio\(|createMediaElementSource\(/.test(engine),'must not create competing media element or reroute primary MP3');
console.log('PASS offline ambient PCM, amplitude, fade, theme selection, independent settings, mix isolation and sleep guards');

/* Late native ended events from a temporary WAV must not save completed
 * progress, increment statistics or trigger auto-advance on the original MP3. */
vm.runInContext('this.originalReady=ptHOriginalReady;',ctx);
const chapterRaw={src:'blob:chapter',currentSrc:'blob:hold',duration:300,currentTime:300,readyState:4,ended:true,addEventListener(type,fn){this.handlers??={};(this.handlers[type]??=[]).push(fn);}};
const chapter=ctx.facade(chapterRaw);let advances=0,completedStats=0;
chapter.addEventListener('ended',()=>advances++);
chapter.addEventListener('ended',()=>completedStats++);
const fireEnded=()=>chapterRaw.handlers.ended.forEach(fn=>fn({type:'ended'}));
const saved={source:'blob:chapter',position:37,duration:500,rate:2,phase:'restore'};
ctx.snap(saved);
assert(!ctx.originalReady(chapterRaw,saved));fireEnded();assert.equal(advances,0);
ctx.snap(null);fireEnded();assert.equal(advances,0,'stale currentSrc must be ignored');
chapterRaw.currentSrc='blob:chapter';chapterRaw.duration=500;chapterRaw.currentTime=37;chapterRaw.ended=false;
assert(ctx.originalReady(chapterRaw,saved));fireEnded();assert.equal(advances,0,'queued ended after resume must be ignored');
chapterRaw.ended=true;fireEnded();assert.equal(advances,0,'ended flag alone must not finish a chapter at the saved position');
chapterRaw.currentTime=500;fireEnded();assert.equal(advances,1);assert.equal(completedStats,1,'true chapter end remains functional');
assert(!ctx.originalReady({...chapterRaw,readyState:0},saved));
assert(!ctx.originalReady({...chapterRaw,duration:NaN},saved));
console.log('PASS late WAV ended isolation, original-source readiness and genuine chapter end');

/* The H2 trace is local and categorizes sources without exposing Blob URLs. */
vm.runInContext('this.trace=ptHTrace;',ctx);
const traceLines=[];
ctx.ptRawAudio={src:'blob:private-chapter',currentSrc:'blob:private-hold',currentTime:5,duration:300,playbackRate:1,seeking:false,ended:false,paused:false};
ctx.state={fileUrl:'blob:private-chapter'};
ctx.ptRLog=x=>traceLines.push(x);
ctx.snap({source:'blob:private-chapter',silence:'blob:private-hold',position:37,duration:500,phase:'restore'});
ctx.trace('raw seeked');
assert(traceLines[0].includes('TRACE H2 raw seeked phase=restore src=chapter current=hold'));
assert(traceLines[0].includes('saved=37.00/500.00'));
assert(!traceLines[0].includes('blob:'));
ctx.snap(null);
assert(app.includes("ptHTrace('system nexttrack')"));
assert(app.includes("ptHTrace('chapter ended handler')"));
console.log('PASS local H2 source and chapter transition diagnostics');
