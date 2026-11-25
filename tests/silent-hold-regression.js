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
assert(html.includes('name="ptRecoveryMode" value="silent"'));assert(html.includes('id="ptHoldMinutes"'));
const release=JSON.parse(fs.readFileSync('version.json','utf8'));
assert.equal(release.version,'4503');assert.equal(release.displayVersion,'4.5.3');
const holdSrc=html.indexOf('src="./silent-hold.js?v='+release.version+'"'),appSrc=html.indexOf('src="./app.js?v='+release.version+'"');
assert(holdSrc>=0&&appSrc>holdSrc);
assert(html.includes('name="pinetree-release" content="'+release.version+'"'));
assert(html.includes("const RELEASE='"+release.version+"'"));
assert(app.includes("window.PineTreeAppRelease='"+release.version+"'"));
assert(fs.readFileSync('sw.js','utf8').includes("VERSION='"+release.version+"'"));
assert(fs.readFileSync('repair.html','utf8').includes("const RELEASE='"+release.version+"'"));
assert(fs.readFileSync('styles.css','utf8').includes('--pt-base-release:'+release.version));
assert(fs.readFileSync('themes/forest-reading/theme.css','utf8').includes('--pt-theme-release:'+release.version));
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
assert(traceLines[0].includes('TRACE H7 raw seeked phase=restore src=chapter current=hold'));
assert(traceLines[0].includes('saved=37.00/500.00'));
assert(!traceLines[0].includes('blob:'));
ctx.snap(null);
assert(app.includes("ptHTrace('system nexttrack')"));
assert(app.includes("ptHTrace('chapter ended handler')"));
console.log('PASS local H2 source and chapter transition diagnostics');

/* H3: reproduce the device trace, not merely isolated facade properties.
 * The mock dispatches native events in the observed order. This is not WebKit. */
function h3Setup(){
  let mediaTime=0,serial=0,earlySeeks=0,playCalls=0,timerId=0;
  const timers=new Map();
  const handlers=new Map(),records=[],revoked=[],logs=[];
  const raw={
    src:'blob:hold',currentSrc:'blob:hold',duration:600,readyState:4,paused:false,ended:false,seeking:false,playbackRate:1,defaultPlaybackRate:1,muted:false,
    addEventListener(type,fn){if(!handlers.has(type))handlers.set(type,new Set());handlers.get(type).add(fn);},
    removeEventListener(type,fn){handlers.get(type)?.delete(fn);},
    dispatchEvent(e){for(const fn of [...(handlers.get(e.type)||[])])fn(e);},
    load(){this.currentSrc=this.src;this.duration=NaN;this.readyState=0;this.ended=false;this.paused=true;mediaTime=0;},
    play(){playCalls++;this.paused=false;return Promise.resolve();},pause(){this.paused=true;},
    get currentTime(){return mediaTime;},set currentTime(v){if(this.readyState<1)earlySeeks++;mediaTime=v;this.seeking=true;}
  };
  const el={textContent:''},noop=()=>{};
  const c={
    ptRawAudio:raw,state:{current:{id:'chapter'},fileUrl:'blob:original',suppressProgressWrites:false},
    URL:{createObjectURL:()=> 'blob:fresh-'+(++serial),revokeObjectURL:x=>revoked.push(x)},
    Event:class{constructor(type){this.type=type;}},setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    $:()=>el,navigator:{mediaSession:{}},ptRLog:x=>logs.push(x),ptLast:null,ptFlush:noop,ptBehavior:noop,
    setPlayButtonVisual:noop,updateProgressDisplay:noop,updateLyrics:noop,updateImmersiveUI:noop,updateMediaPosition:noop,updateMediaSession:noop,
    requestPlaybackAudioSession:noop,queuePauseSyncExport:noop,
    saveProgress:()=>{records.push({position:c.audio.currentTime,duration:c.audio.duration,ended:c.audio.ended});return Promise.resolve();}
  };
  vm.createContext(c);vm.runInContext(engine+'\nthis.snap=x=>ptHSnapshot=x;this.getSnapshot=()=>ptHSnapshot;this.restore=ptHRestore;this.remember=ptHRememberSource;this.facade=ptHoldFacade;',c);
  c.audio=c.facade(raw);
  c.remember({size:100,type:'audio/mpeg',slice(){return this;}},'blob:original');
  c.snap({id:'chapter',source:'blob:original',silence:'blob:hold',position:2.59,duration:421.68,rate:2,muted:false,phase:'hold'});
  let endings=0,pauses=0;c.audio.addEventListener('ended',()=>endings++);c.audio.addEventListener('pause',()=>pauses++);
  return {c,raw,records,revoked,logs,emit:type=>raw.dispatchEvent(new c.Event(type)),time:v=>{mediaTime=v;},counts:()=>({earlySeeks,playCalls,endings,pauses}),probes:()=>[...timers.values()].filter(t=>t.ms===20).length,tickProbe:()=>{const next=[...timers.entries()].find(([,t])=>t.ms===20);assert(next,'expected scheduled 20ms probe');timers.delete(next[0]);next[1].fn();},timerCount:()=>timers.size};
}
async function h3Begin(wantPlay=true){
  const x=h3Setup(),result=x.c.restore(wantPlay,'test');
  assert.equal(x.raw.src,'blob:fresh-1');assert.equal(x.c.state.fileUrl,'blob:fresh-1');
  assert.equal(x.counts().playCalls,wantPlay?1:0,'play issued synchronously within activation');
  assert.equal(x.counts().earlySeeks,0);
  await Promise.resolve();
  x.raw.duration=421.68;x.raw.readyState=1;x.emit('loadedmetadata');
  assert.equal(x.raw.currentTime,2.59);assert.equal(x.counts().earlySeeks,0);
  x.raw.readyState=4;x.raw.seeking=false;x.emit('seeked');
  await Promise.resolve();
  assert.equal(x.raw.playbackRate,wantPlay?1:2,'do not change rate immediately after seek');
  return {...x,result};
}
(async()=>{
  let x=await h3Begin();
  assert(x.c.getSnapshot(),'not released at seeked / play resolution');
  x.raw.duration=2.59;x.raw.ended=true;x.raw.paused=true;x.emit('pause');x.emit('ended');
  assert.equal(await x.result,false);
  assert.equal(x.counts().endings,0);assert.equal(x.counts().pauses,0);
  assert.equal(x.c.audio.currentTime,2.59);assert.equal(x.c.audio.duration,421.68);assert.equal(x.c.audio.ended,false);
  assert(x.records.some(p=>p.position===2.59&&!p.ended&&p.duration===421.68));
  assert(x.c.getSnapshot().phase==='failed');

  x=await h3Begin();x.time(2.9);x.emit('timeupdate');assert.equal(x.raw.playbackRate,2);assert(x.c.getSnapshot(),'retain snapshot through rate change');x.time(3.1);x.emit('timeupdate');assert.equal(await x.result,true);
  assert.equal(x.c.getSnapshot(),null);assert.equal(x.raw.muted,false);
  assert(x.revoked.includes('blob:original')&&x.revoked.includes('blob:hold'));assert(!x.revoked.includes('blob:fresh-1'));
  x.raw.duration=3.1;x.raw.ended=true;x.raw.paused=true;x.emit('pause');x.emit('ended');
  assert.equal(x.counts().endings,0);assert.equal(x.counts().pauses,0);
  assert.equal(x.c.audio.duration,421.68);assert.equal(x.c.audio.ended,false);
  assert(x.records.some(p=>!p.ended&&p.duration===421.68));
  assert(x.logs.some(l=>l.includes('BLOCK truncated chapter duration')));

  x=await h3Begin();x.time(2.9);x.emit('timeupdate');assert.equal(x.raw.playbackRate,2);assert(x.c.getSnapshot(),'retain snapshot through rate change');x.time(3.1);x.emit('timeupdate');assert.equal(await x.result,true);
  x.time(421.68);x.raw.ended=true;x.raw.paused=true;x.emit('pause');x.emit('ended');
  assert.equal(x.counts().endings,1);assert.equal(x.counts().pauses,1,'real EOF still reaches ordinary handlers');

  x=await h3Begin(false);assert.equal(await x.result,true);assert.equal(x.raw.paused,true);assert.equal(x.counts().playCalls,0);
  assert.equal(x.c.getSnapshot(),null);assert.equal(x.raw.currentTime,2.59);
  console.log('PASS H3: real H2 duration-collapse trace, fresh source, deferred seek, verified progress, post-resume protection, genuine EOF, paused restore');
})().catch(e=>{console.error(e);process.exitCode=1;});

/* H4 fallback is explicitly triggered by foreground Play and uses the normal loader. */
(async()=>{
  const begin=app.indexOf('let ptHSafeRecoveryPending=false;'),end=app.indexOf('async function startPlayback(',begin);
  assert(begin>=0&&end>begin);
  const snap={phase:'failed',id:'chapter',position:3.42,duration:458.52},track={id:'chapter'},calls=[],inputs=[{value:'silent',checked:true},{value:'smart',checked:false}];
  const c={ptHSnapshot:snap,state:{current:track},document:{hidden:false,querySelectorAll:()=>inputs},ptRMode:'silent',ptRBlocked:true,PT_R_MODE:'mode',audio:{paused:true},
    localStorage:{setItem:(k,v)=>calls.push(['mode',v])},saveProgress:async ended=>calls.push(['save',ended,snap.position]),
    ptRInvalidate:()=>{},ptRStop:()=>{},ptRStatus:()=>{},ptHTrace:()=>{},toast:()=>{},$:()=>({textContent:''}),
    loadTrack:async(t,o)=>{calls.push(['load',t.id,o.autoplay]);c.ptHSnapshot=null;c.audio.paused=false;}
  };
  vm.createContext(c);vm.runInContext(app.slice(begin,end)+'\nthis.recover=ptHSafeRecovery;',c);
  c.document.hidden=true;assert.equal(await c.recover(),false);assert.equal(calls.length,0);
  c.document.hidden=false;assert.equal(await c.recover(),true);
  assert.deepEqual(calls,[['save',false,3.42],['mode','smart'],['load','chapter',true]]);
  assert.equal(c.ptRMode,'smart');assert.equal(inputs[0].checked,false);assert.equal(inputs[1].checked,true);
  assert.equal(await c.recover(),false,'no fallback recursion');
  assert(app.includes("if(ptHSnapshot?.phase==='failed')return ptHSafeRecovery()"));
  console.log('PASS H4 foreground fallback saves original checkpoint and reloads same chapter once');
})().catch(e=>{console.error(e);process.exitCode=1;});

/* H7: sparse or throttled native timeupdate must not bypass the configured media-progress threshold.
 * Only the real media clock unlocks the rate change. Timer delays are simulated. */
(async()=>{
  let x=await h3Begin();
  assert.equal(x.probes(),1);
  x.emit('playing');x.emit('canplay');assert.equal(x.probes(),1,'no duplicate polling timers');
  x.time(2.69);x.tickProbe();assert.equal(x.raw.playbackRate,1);
  x.time(2.70);x.tickProbe();assert.equal(x.raw.playbackRate,1,'110ms advance must not unlock the 120ms threshold');
  assert.equal(x.probes(),1);assert(x.c.getSnapshot());
  x.time(2.72);x.tickProbe();assert.equal(x.raw.playbackRate,2,'130ms verified media advance unlocks rate before native timeupdate');
  assert.equal(x.probes(),0);assert(x.c.getSnapshot(),'second-stage validation remains mandatory');
  x.time(3.02);x.emit('timeupdate');assert.equal(await x.result,true);assert.equal(x.timerCount(),0);

  x=await h3Begin();
  x.time(2.9);x.emit('timeupdate');assert.equal(x.raw.playbackRate,2,'native fallback when probe is throttled');
  assert.equal(x.probes(),0);x.time(3.1);x.emit('timeupdate');assert.equal(await x.result,true);
  assert.equal(x.timerCount(),0);

  x=await h3Begin();
  x.raw.duration=2.59;x.raw.ended=true;x.raw.paused=true;x.emit('durationchange');
  assert.equal(await x.result,false);assert.equal(x.timerCount(),0,'failure cleans pending probe and deadline');
  assert.equal(x.c.getSnapshot().phase,'failed');
  assert.equal(x.counts().endings,0);

  x=await h3Begin();x.time(2.72);x.tickProbe();assert.equal(x.raw.playbackRate,2);
  x.raw.duration=2.72;x.raw.ended=true;x.raw.paused=true;x.emit('durationchange');x.emit('ended');
  assert.equal(await x.result,false);assert.equal(x.counts().endings,0,'early rate transition must never permit false EOF');
  assert.equal(x.c.getSnapshot().phase,'failed');assert.equal(x.c.audio.currentTime,2.59);assert.equal(x.timerCount(),0);
  x=await h3Begin(false);assert.equal(await x.result,true);assert.equal(x.timerCount(),0,'paused restore starts no probe');
  console.log('PASS H7: 120ms verified media advancement, 20ms probes, early-switch EOF guard, second-stage verification, fallback and cleanup');
})().catch(e=>{console.error(e);process.exitCode=1;});

/* H6: release the separate mix context when an iOS page goes into the background.
 * The normal MP3 and Hold engine must not be touched by the visibility guard. */
(()=>{
  const log=[],status={textContent:''},events=[],raw={src:'blob:chapter',currentSrc:'blob:chapter',readyState:4,paused:false,ended:false,currentTime:10,duration:200,playbackRate:2};
  let created=0,closed=0,stopped=0,registered=0;
  class MockContext{
    constructor(){created++;this.state='running';this.currentTime=0;this.destination={};}
    createBuffer(){return {getChannelData:()=>new Float32Array(96000)};}
    createBufferSource(){return {connect(){},disconnect(){},start(){},stop(){stopped++;}};}
    createGain(){return {gain:{value:0,setTargetAtTime(){}},connect(){}};}
    resume(){return Promise.resolve();}
    close(){closed++;return Promise.resolve();}
  }
  const c={ptRawAudio:raw,document:{hidden:false},window:{AudioContext:MockContext},state:{current:{id:'chapter'},fileUrl:'blob:chapter',uiTheme:'forest-reading'},isIOSHeadphoneEnvironment:()=>true,$:()=>status,setupMediaSession:()=>{registered++;},ptRLog:s=>log.push(s)};
  vm.createContext(c);vm.runInContext(engine+'\nthis.mixStart=ptMixStart;this.mixVisibility=ptMixVisibility;this.mixStop=ptMixStop;this.enable=v=>ptAmbientMixEnabled=v;this.snapshot=v=>ptHSnapshot=v;this.block=ptMixBackgroundBlocked;this.allowed=ptMixAllowed;',c);
  assert(c.block(true,true));assert(!c.block(false,true));assert(!c.block(true,false));
  assert(!c.allowed({enabled:true,sound:'rain',volume:10,loaded:true,paused:false,ended:false,holding:false,expired:false,backgroundBlocked:true}));
  c.enable(true);c.mixStart();assert.equal(created,1);
  c.document.hidden=true;c.mixVisibility();assert.equal(stopped,1);assert.equal(closed,1);assert.equal(registered,1);
  assert.equal(raw.currentTime,10);assert.equal(raw.playbackRate,2);assert.equal(raw.paused,false);assert.equal(raw.src,'blob:chapter');
  c.mixStart();assert.equal(created,1,'no background mix context recreation');
  c.document.hidden=false;c.mixVisibility();assert.equal(created,2,'restore mix on foreground');
  c.document.hidden=true;c.mixVisibility();c.document.hidden=false;
  raw.paused=true;c.mixVisibility();assert.equal(created,2,'do not start mix while paused');
  raw.paused=false;c.snapshot({phase:'hold'});c.mixVisibility();assert.equal(created,2,'do not start mix during Hold');
  c.snapshot(null);c.enable(false);c.mixVisibility();assert.equal(created,2,'preserve disabled setting');
  c.enable(true);c.isIOSHeadphoneEnvironment=()=>false;c.document.hidden=true;c.mixStart();assert.equal(created,3,'non-iOS background mix remains available');
  c.mixStop('test end');
  console.log('PASS H6 iOS visibility mix isolation, foreground restoration and normal MP3 invariants');
})();

/* Audio Control Center: exercise actual relocation logic on a minimal DOM fixture.
 * The fixture models original IDs/relationships; Safari rendering is separate. */
(()=>{
  class El{
    constructor(tag){this.tag=tag;this.children=[];this.parentElement=null;this.id='';this.className='';this.textContent='';this.dataset={};this.events={};this.attrs={};this.checked=false;this.value='';this.name='';this.classList={contains:x=>this.className.split(' ').includes(x),add:x=>{if(!this.className.split(' ').includes(x))this.className+=' '+x;},remove:x=>{this.className=this.className.split(' ').filter(v=>v!==x).join(' ');},toggle:(x,v)=>{const on=v===undefined?!this.classList.contains(x):!!v;on?this.classList.add(x):this.classList.remove(x);return on;}};this.tagName=tag.toUpperCase();}
    detach(){if(this.parentElement){const a=this.parentElement.children;a.splice(a.indexOf(this),1);this.parentElement=null;}}
    append(...nodes){for(const n of nodes){n.detach();n.parentElement=this;this.children.push(n);}}
    prepend(...nodes){for(const n of [...nodes].reverse()){n.detach();n.parentElement=this;this.children.unshift(n);}}
    insertBefore(n,ref){n.detach();n.parentElement=this;this.children.splice(this.children.indexOf(ref),0,n);}
    contains(n){for(let p=n;p;p=p.parentElement)if(p===this)return true;return false;}
    show(){this.open=true;}
    close(){this.open=false;for(const fn of this.events.close||[])fn({target:this});}
    before(...nodes){const p=this.parentElement;for(const n of nodes){n.detach();n.parentElement=p;p.children.splice(p.children.indexOf(this),0,n);}}
    after(...nodes){const p=this.parentElement;let i=p.children.indexOf(this)+1;for(const n of nodes){n.detach();n.parentElement=p;p.children.splice(i++,0,n);}}
    setAttribute(k,v){this.attrs[k]=v;}
    getAttribute(k){return this.attrs[k]??null;}
    addEventListener(t,fn){(this.events[t]??=[]).push(fn);}
    click(){for(const fn of this.events.click||[])fn({target:this,preventDefault(){},stopPropagation(){}});}
    matches(sel){
      if(sel.includes(','))return sel.split(',').some(s=>this.matches(s.trim()));
      if(sel.includes(' > ')){const [parent,child]=sel.split(' > ');return this.matches(child)&&!!this.parentElement?.matches(parent);}
      if(sel.includes(' ')){const i=sel.lastIndexOf(' ');return this.matches(sel.slice(i+1))&&!!this.parentElement?.closest(sel.slice(0,i));}
      if(sel.startsWith('.'))return this.className.split(' ').includes(sel.slice(1));
      if(sel.startsWith('#'))return this.id===sel.slice(1);
      if(sel.startsWith('input[')){if(this.tag!=='input')return false;for(const m of sel.matchAll(/\[(name|value)="([^"]+)"\]/g))if(this[m[1]]!==m[2])return false;return !sel.endsWith(':checked')||this.checked;}
      return this.tag===sel;
    }
    closest(sel){for(let n=this;n;n=n.parentElement)if(n.matches(sel))return n;return null;}
    querySelectorAll(sel){let found=[];for(const ch of this.children){if(ch.matches(sel))found.push(ch);found.push(...ch.querySelectorAll(sel));}return found;}
    querySelector(sel){return this.querySelectorAll(sel)[0]||null;}
    scrollIntoView(){this.scrolled=true;}
  }
  const body=new El('body'),node=(tag,parent,id='',cls='')=>{const e=new El(tag);e.id=id;e.className=cls;parent.append(e);return e;};
  const shell=node('div',body,'','app-shell'),top=node('header',shell,'','topbar'),header=node('div',top,'','header-actions');
  const layout=node('div',shell,'','layout'),library=node('div',layout,'','library'),reader=node('div',layout,'','reader'),toolbar=node('div',reader,'','lyrics-toolbar'),tools=node('div',toolbar,'','lyrics-tools');
  for(const id of ['themeOpen','bookManagerOpen','immersiveEnter','networkBadge','quickResume','cloudOpen'])node('button',header,id);
  for(const id of ['fontMinus','fontPlus','offsetMinus','offsetLabel','offsetPlus','lyricsCenterToggle','toggleLyricsMax','focusToggle'])node('button',tools,id);
  const extras=node('div',reader,'','listen-extras'),entry=node('button',extras,'lockScreenOpen');
  const sleep=node('button',extras,'sleepOpen'),del=node('button',extras,'forestDeleteShortcut');
  const speedHost=node('div',reader,'','speed-settings'),speedLabel=node('label',speedHost);node('output',speedLabel,'speedLabel');
  const speedRange=node('input',speedHost,'speedRange'),preset=node('div',speedHost,'','forest-speed-presets'),modeButton=node('button',speedHost,'playModeBtn');
  const original=node('dialog',body,'lockScreenDialog'),inner=node('div',original,'','dialog-inner'),head=node('div',inner,'','dialog-head');node('h2',head);
  const compat=node('div',inner,'','sync-guide');node('input',compat,'iosSingleButtonCompatibility');
  const field=node('fieldset',inner);node('legend',field);
  const radio=(parent,name,value)=>{const label=node('label',parent,'','lockscreen-choice');const i=node('input',label);i.name=name;i.value=value;node('strong',label);node('small',label);return i;};
  const modes=['standard','smart','experimental','silent'].map(v=>radio(field,'ptRecoveryMode',v));
  modes[3].checked=true;
  const subtitle=radio(inner,'lockScreenMode','lyrics');
  node('select',node('label',field),'ptHoldMinutes');
  const hold=node('div',field,'','sync-guide');node('strong',hold);node('p',hold);
  const holdSelect=node('select',hold,'ptAmbientHold');holdSelect.value='campfire';node('input',hold,'ptAmbientHoldVolume');node('output',hold,'ptAmbientHoldValue');
  const mix=node('div',field,'','sync-guide');node('strong',mix);const enabled=node('input',mix,'ptAmbientMixEnabled');enabled.checked=true;
  const mixSelect=node('select',mix,'ptAmbientMix');mixSelect.value='rain';node('input',mix,'ptAmbientMixVolume');node('output',mix,'ptAmbientMixValue');node('p',mix,'ptAmbientMixStatus','dialog-note');node('p',mix,'','dialog-note');
  node('p',field,'ptHoldStatus');const status=node('p',field,'ptRecoveryStatus');
  const diag=node('div',inner,'','sync-guide');node('pre',diag,'ptRecoveryDiagnostic');node('button',diag,'ptRecoveryCopy');node('button',diag,'ptRecoveryClear');
  const hp=node('div',inner,'','sync-guide');node('pre',hp,'headphoneDiagnostic');node('button',hp,'copyHeadphoneDiagnostic');
  const im=node('section',body,'immersiveMode'),imHost=node('div',im,'','im-speed'),imLabel=node('label',imHost);node('output',imLabel,'imSpeedLabel');
  const imRange=node('input',imHost,'imSpeed'),imPresets=node('div',imHost,'','im-speed-presets'),imMode=node('button',imHost,'imPlayMode'),imFooter=node('footer',im,'','im-footer');
  for(const id of ['imSleep','imCloud','imText','imBookmark','imBookmarkList'])node('button',imFooter,id);
  const get=id=>body.querySelector('#'+id),dialogs=[],storage=new Map(),state={immersive:false,lyricsMax:false,focusMode:false,lockScreenMode:'lyrics',speed:2,playMode:'sequence'};let wide=true,reflows=0,sleepClicks=0,deleteClicks=0,bookmarkClicks=0;
  get('imBookmark').addEventListener('click',()=>bookmarkClicks++);
  sleep.addEventListener('click',()=>sleepClicks++);del.addEventListener('click',()=>deleteClicks++);
  const c={document:{body,createElement:tag=>new El(tag),querySelector:s=>body.querySelector(s)},$:get,ptAmbientName:s=>({campfire:'森林篝火',rain:'松林細雨',silent:'完全無聲'})[s]||s,refreshLockScreenControls:()=>{},requestAnimationFrame:fn=>fn(),openDialog:id=>{get(id).show();dialogs.push(['open',id]);},closeDialog:id=>{get(id).close();dialogs.push(['close',id]);},state,window:{matchMedia:()=>({matches:wide}),addEventListener(){}},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},syncLyricsViewportPadding:()=>{},updateLyrics:()=>reflows++,PLAY_MODES:[{id:'sequence',label:'順序播放'},{id:'repeat-one',label:'單章循環'},{id:'repeat-all',label:'整本循環'}],setPlayMode:id=>{state.playMode=id;}};
  const start=app.indexOf('function ptAudioCenterElement('),end=app.indexOf('function refreshLockScreenControls()',start);
  assert(start>=0&&end>start);vm.createContext(c);vm.runInContext(app.slice(start,end)+'\nthis.install=ptAudioCenterInstall;this.refresh=ptAudioCenterRefresh;this.open=ptAudioCenterOpen;this.ui=ptUiInstall;this.checkDock=ptUiCheckDock;this.normalize=ptUiNormalize;this.speedRefresh=ptUiSpeedRefresh;this.lockRefresh=ptUiLockScreenRefresh;',c);
  assert(c.install());assert(c.install(),'installation is idempotent');
  const panel=get('ptAudioCenter');assert(panel);assert.equal(field.closest('dialog'),panel);assert.equal(get('ptAmbientHold'),holdSelect);assert.equal(get('ptAmbientMix'),mixSelect);assert.equal(get('ptRecoveryStatus'),status);
  assert.equal(body.querySelectorAll('#ptAudioCenter').length,1);assert.equal(body.querySelectorAll('#ptAudioHoldQuick').length,1);
  assert.equal(body.querySelectorAll('input[name="ptRecoveryMode"]').length,4);
  assert.equal(modes[3].closest('details'),null);for(const m of modes.slice(0,3))assert(m.closest('details'));
  assert.equal(subtitle.closest('dialog'),original);assert(compat.closest('details'));assert(diag.closest('details'));assert(hp.closest('details'));
  assert.equal(entry.textContent,'♫ 單音軌保活');assert(get('ptAudioHoldQuick').textContent.includes('森林篝火'));assert(get('ptAudioMixQuick').textContent.includes('松林細雨'));
  get('ptAudioHoldQuick').click();assert(panel.open&&hold.scrolled);
  get('ptAudioMixQuick').click();assert(mix.scrolled);get('ptAudioAdvanced').click();assert(original.open&&!panel.open);get('ptAudioBack').click();assert(panel.open&&!original.open);
  enabled.checked=false;c.refresh();assert(get('ptAudioMixQuick').textContent.endsWith('關閉'));
  assert.equal(holdSelect.value,'campfire');assert.equal(mixSelect.value,'rain');assert(modes[3].checked);
  assert(app.includes('ptAudioCenterInstall();setupEvents();setupImmersiveEvents();ptRInstall();ptHInstall();'));
  for(const id of ['lockScreenOpen','lockScreenDialog','ptAmbientHold','ptAmbientMix','ptRecoveryStatus','iosSingleButtonCompatibility','ptRecoveryDiagnostic','headphoneDiagnostic'])assert(html.includes('id="'+id+'"'),'original source anchor '+id);
  console.log('PASS Audio Control Center: original node identity, unique controls, navigation, legacy folding, state preservation');
  c.closeDialog('ptAudioCenter');
  storage.set('pinetree-ui-layout-v453',JSON.stringify({library:true,tools:false,unknown:true}));
  const originalFont=get('fontMinus'),originalMode=modes[3];
  c.ui();c.ui();
  assert(body.classList.contains('pt-ui-hide-library'));assert(!body.classList.contains('pt-ui-hide-tools'));
  assert.equal(get('ptUiToggle-library').attrs['aria-expanded'],'false');assert.equal(get('ptUiToggle-library').attrs['aria-controls'],library.id);
  assert.equal(body.querySelectorAll('#ptUiToggle-header').length,1);
  assert.equal(entry.textContent,'音效控制 ♪');assert.equal(get('ptUiTopEngine').textContent,'音效控制 ♪');
  assert(get('ptAudioHoldQuick').classList.contains('pt-ui-merged-sound'));assert(get('ptAudioMixQuick').classList.contains('pt-ui-merged-sound'));
  const lock=get('ptUiLockScreen');assert(lock&&lock.dataset.active==='true');lock.click();assert(original.open&&!panel.open);c.closeDialog('lockScreenDialog');
  state.lockScreenMode='standard';c.lockRefresh();assert.equal(lock.dataset.active,'false');
  const speedToggle=get('ptUiSpeedToggle'),playSelect=get('ptUiPlayModeSelect');
  assert(speedHost.classList.contains('pt-ui-speed-compact'));assert.equal(speedToggle.textContent,'倍速 2.00× ▾');
  assert.equal(speedToggle.attrs['aria-expanded'],'false');assert(speedRange.classList.contains('pt-ui-speed-detail'));assert.equal(modeButton.parentElement,speedHost);
  speedToggle.click();assert(speedHost.classList.contains('pt-ui-speed-expanded'));assert.equal(speedToggle.attrs['aria-expanded'],'true');
  speedToggle.click();assert(!speedHost.classList.contains('pt-ui-speed-expanded'));
  assert.deepEqual(playSelect.children.map(o=>o.value),['sequence','repeat-one','repeat-all']);
  playSelect.value='repeat-one';playSelect.events.change[0]();assert.equal(state.playMode,'repeat-one');
  state.speed=1.25;state.playMode='repeat-all';c.speedRefresh();assert.equal(speedToggle.textContent,'倍速 1.25× ▾');assert.equal(playSelect.value,'repeat-all');
  const imToggle=get('ptImSpeedToggle'),imSelect=get('ptImPlayModeSelect'),imQuick=get('ptImQuickActions'),imFold=get('ptImQuickToggle');
  assert(imToggle&&imSelect&&imQuick&&imFold);assert.equal(imToggle.textContent,'倍速 1.25× ▾');assert.equal(imSelect.value,'repeat-all');
  assert(imRange.classList.contains('pt-im-speed-detail'));assert.equal(imMode.parentElement,imHost);assert(imQuick.hidden);
  imToggle.click();assert(imHost.classList.contains('pt-im-speed-expanded'));assert(!speedHost.classList.contains('pt-ui-speed-expanded'));
  imToggle.click();assert(!imHost.classList.contains('pt-im-speed-expanded'));
  imSelect.value='repeat-one';imSelect.events.change[0]();assert.equal(playSelect.value,'repeat-one');assert.equal(state.playMode,'repeat-one');
  imFold.click();assert(!imQuick.hidden);assert.equal(storage.get('pinetree-immersive-quick-collapsed-v453'),'0');
  state.immersive=true;get('ptImSound').click();assert(panel.open&&panel.parentElement===body);c.closeDialog('ptAudioCenter');
  get('ptImLockScreen').click();assert(original.open);c.closeDialog('lockScreenDialog');
  get('ptImMore').click();assert(get('ptImMoreDialog').open);get('ptImBookmarkAction').click();assert.equal(bookmarkClicks,1);assert(!get('ptImMoreDialog').open);
  imFold.click();assert(imQuick.hidden);assert.equal(storage.get('pinetree-immersive-quick-collapsed-v453'),'1');
  assert(state.immersive);state.immersive=false;
  assert(get('imBookmark').classList.contains('pt-im-relocated'));assert.equal(get('imSleep').parentElement,imQuick);
  const right=top.querySelector('.pt-ui-header-right');
  assert(right&&right.parentElement===top);
  assert.equal(header.parentElement,right);
  assert.equal(get('ptUiToggle-header').parentElement.parentElement,right);
  assert.equal(get('ptUiToggle-library').parentElement.parentElement,right);
  const style=fs.readFileSync('styles.css','utf8');
  assert(style.includes('grid-template-columns:minmax(0,1fr) 180px minmax(0,1fr)'));
  assert(style.includes('.pt-ui-header>.pt-ui-header-right'));
  assert(style.includes('grid-column:3;grid-row:1;width:100%'));
  assert(style.includes('.pt-ui-header-right{display:contents;}'));
  assert(style.includes('.pt-ui-speed-compact:not(.pt-ui-speed-expanded)>.pt-ui-speed-detail'));
  assert(style.includes('.pt-im-speed-compact:not(.pt-im-speed-expanded)>.pt-im-speed-detail'));
  assert(style.includes('.pt-im-quick-actions[hidden]{display:none!important;}'));
  assert.equal(body.querySelectorAll('#ptImSpeedToggle').length,1);
  assert(style.includes("url('./themes/forest-reading/assets/forest-mobile.webp')"));
  assert(style.includes('.app-shell #forestDeleteShortcut.pt-ui-relocated{display:none!important;}'));

  assert.equal(get('fontMinus'),originalFont);assert.equal(originalFont.parentElement.id,'ptUiFontGroup');
  assert.equal(get('ptUiViewGroup').querySelector('#toggleLyricsMax'),get('toggleLyricsMax'));
  assert.equal(get('ptUiToggle-context').parentElement,extras.parentElement);assert.equal(get('ptUiToggle-tools').parentElement,toolbar);
  get('ptUiToggle-header').click();get('ptUiToggle-tools').click();get('ptUiToggle-context').click();
  assert(body.classList.contains('pt-ui-hide-header'));assert(body.classList.contains('pt-ui-hide-tools'));assert(body.classList.contains('pt-ui-hide-context'));
  assert.deepEqual(JSON.parse(storage.get('pinetree-ui-layout-v453')),{library:true,header:true,tools:true,context:true});
  get('ptUiToggle-library').click();assert(!body.classList.contains('pt-ui-hide-library'));assert(body.classList.contains('pt-ui-hide-tools'));
  const radioRow=originalMode.closest('.pt-ui-radio-row');assert(radioRow);const info=radioRow.querySelector('.pt-ui-info'),tip=get(info.attrs['aria-controls']);assert(tip.hidden);
  assert(!originalMode.closest('label').contains(info));info.click();assert(!tip.hidden);assert(originalMode.checked);info.click();assert(tip.hidden);
  get('ptUiDeleteChapter').click();assert.equal(deleteClicks,1);
  get('ptUiTopEngine').click();assert(panel.open&&panel.parentElement===layout);assert(body.classList.contains('pt-ui-dock-open'));
  get('ptAudioCenterClose').click();assert(!panel.open&&panel.parentElement===body);assert(!body.classList.contains('pt-ui-dock-open'));
  get('ptUiTopEngine').click();wide=false;c.checkDock();assert(!panel.open&&panel.parentElement===body);
  get('ptUiTopHold').click();assert(panel.open&&panel.parentElement===body);assert(!body.classList.contains('pt-ui-dock-open'));
  get('ptUiCenterSleep').click();assert(!panel.open);assert.equal(sleepClicks,1);
  wide=true;get('ptUiTopEngine').click();state.immersive=true;c.checkDock();assert(!panel.open);assert(state.immersive);
  const before=reflows;get('ptUiToggle-header').click();assert.equal(reflows,before);assert(state.immersive);state.immersive=false;
  assert.equal(get('ptAmbientHold'),holdSelect);assert.equal(get('ptAmbientMix'),mixSelect);assert.equal(modes[3],originalMode);
  assert(!JSON.parse(storage.get('pinetree-ui-layout-v453')).unknown);
  console.log('PASS collapsible UI: independent persisted flags, grouped original nodes, info disclosure, dock/modal, sleep and immersive isolation');
})();

/* Home bookmark shortcuts hidden; existing immersive access and handlers retained. */
assert(/#bookmarkAdd,#bookmarkOpen\{display:none!important;\}/.test(require('fs').readFileSync(require('path').join(__dirname,'../styles.css'),'utf8')));
assert(app.includes("$('bookmarkAdd').addEventListener('click',addBookmark)"));
assert(app.includes("$('bookmarkOpen').addEventListener('click'"));
assert(app.includes("$('imBookmark').addEventListener('click',addBookmark)"));
assert(app.includes("$('imBookmarkList').addEventListener('click'"));
console.log('PASS hide only home bookmark shortcuts');

/* Private campfire uses the exact same local samples for Hold and Mix.
 * Reject invalid PCM, leave other soundscapes unchanged and preserve H7. */
(()=>{
  vm.runInContext('this.decodeCampfire=ptPrivateCampfireDecode;this.applyCampfire=ptPrivateCampfireApply;this.samplesCampfire=ptAmbientSamples;',ctx);
  const original=ctx.samplesCampfire('campfire'),rain=ctx.samplesCampfire('rain');
  const bytes=new ArrayBuffer(44+16000),v=new DataView(bytes);
  for(const [off,s] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']])for(let i=0;i<s.length;i++)v.setUint8(off+i,s.charCodeAt(i));
  v.setUint32(4,bytes.byteLength-8,true);v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);v.setUint32(28,16000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);v.setUint32(40,16000,true);
  for(let i=0;i<8000;i++)v.setInt16(44+i*2,i%2?8192:-8192,true);
  const samples=ctx.decodeCampfire(bytes);assert.equal(samples.length,8000);assert.equal(samples[0],-.25);assert.equal(samples[1],.25);
  ctx.applyCampfire(samples);assert.equal(ctx.samplesCampfire('campfire'),samples);assert.deepEqual(ctx.samplesCampfire('rain'),rain);
  const wav=ctx.wav(1,'campfire',.2);assert.equal(wav[44],122);assert.equal(wav[45],134);assert.equal(wav[8044],122);
  const bad=bytes.slice(0);new DataView(bad).setUint32(24,48000,true);
  assert.throws(()=>ctx.decodeCampfire(bad));assert.throws(()=>ctx.decodeCampfire(new ArrayBuffer(44)));
  assert.equal(ctx.samplesCampfire('campfire'),samples,'bad input cannot replace existing samples');
  ctx.applyCampfire(null);assert.deepEqual(ctx.samplesCampfire('campfire'),original);
  assert(app.includes('ptPrivateCampfireInstall();ptInstall();'));
  assert(engine.includes('PT_H_RATE_ADVANCE=.12,PT_H_PROBE_MS=20'));
  console.log('PASS private campfire PCM validation, loop source shared by Hold/Mix, unchanged other soundscapes and H7 threshold');
})();
