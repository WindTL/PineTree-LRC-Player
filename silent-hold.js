/* Optional single-element Silent Hold, independently implemented for local Blob MP3.
 * Reference architecture: https://github.com/ajaxsys/pwa-audio-player/blob/HEAD/packages/core/src/keepAlive.ts
 * Finite silent PCM, logical chapter snapshot, no background autoplay or external requests. */
'use strict';
let ptHSnapshot=null,ptHGeneration=0,ptHTimer=null,ptHMinutes=5,ptHLastAction=0,ptHCleanup=null;
function ptHClamp(t,d){return Math.max(0,Math.min(Math.max(0,d-.05),Number(t)||0));}
function ptHCanEnter(x){return x.mode==='silent'&&x.ios&&x.loaded&&!x.paused&&!x.ended&&!x.seeking&&!x.sleep&&!x.busy;}
function ptHWav(minutes,sound='silent',volume=0){
  if(![1,5,10,30].includes(minutes))throw RangeError('hold length');
  const n=8000*60*minutes,b=new Uint8Array(44+n),v=new DataView(b.buffer);
  for(const [off,s] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']])for(let i=0;i<s.length;i++)b[off+i]=s.charCodeAt(i);
  v.setUint32(4,36+n,true);v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);v.setUint32(28,8000,true);v.setUint16(32,1,true);v.setUint16(34,8,true);v.setUint32(40,n,true);b.fill(128,44);if(sound!=='silent'&&volume>0){const samples=ptAmbientSamples(sound,8000),gain=Math.max(0,Math.min(1,volume));for(let i=0;i<n;i++){const fade=Math.min(1,(n-i)/80000);b[44+i]=Math.max(0,Math.min(255,Math.round(128+127*samples[i%samples.length]*gain*fade)));}}return b;
}
// An ended event queued for the temporary WAV must never complete an MP3.
function ptHEndedIsCurrent(raw){
  return raw.ended===true&&raw.readyState>=1&&!!raw.currentSrc&&raw.currentSrc===raw.src&&Number.isFinite(raw.duration)&&raw.duration>0&&Number.isFinite(raw.currentTime)&&raw.currentTime>=raw.duration-.5;
}
function ptHOriginalReady(raw,s){
  return raw.src===s.source&&raw.currentSrc===s.source&&raw.readyState>=1&&Number.isFinite(raw.duration)&&raw.duration>0;
}
function ptHoldFacade(raw){
  const listeners=new WeakMap();
  return new Proxy(raw,{
    get(target,key){
      const s=ptHSnapshot;
      if(key==='addEventListener')return (type,fn,options)=>{
        if(typeof fn!=='function')return target.addEventListener(type,fn,options);
        let byType=listeners.get(fn);if(!byType){byType=new Map();listeners.set(fn,byType);}
        let wrap=byType.get(type);if(!wrap){wrap=function(e){if(!ptHSnapshot&&(type!=='ended'||ptHEndedIsCurrent(target)))fn.call(target,e);};byType.set(type,wrap);}
        target.addEventListener(type,wrap,options);
      };
      if(key==='removeEventListener')return (type,fn,options)=>target.removeEventListener(type,listeners.get(fn)?.get(type)||fn,options);
      if(s){
        if(key==='currentTime')return s.position;
        if(key==='duration')return s.duration;
        if(key==='src'||key==='currentSrc')return s.source;
        if(key==='paused')return true;
        if(key==='ended'||key==='seeking')return false;
        if(key==='readyState')return 4;
        if(key==='playbackRate'||key==='defaultPlaybackRate')return s.rate;
        if(key==='pause')return ()=>ptHHardStop('原引擎停止');
        if(key==='play')return ()=>ptHRestore(true,'原引擎 Play');
      }
      const val=Reflect.get(target,key,target);return typeof val==='function'?val.bind(target):val;
    },
    set(target,key,value){const s=ptHSnapshot;if(s){
      if(key==='currentTime'){s.position=ptHClamp(value,s.duration);return true;}
      if(key==='playbackRate'||key==='defaultPlaybackRate'){s.rate=value;return true;}
    }return Reflect.set(target,key,value,target);}
  });
}
function ptHStatus(s){const el=$('ptHoldStatus');if(el)el.textContent=s;ptRLog('Silent Hold: '+s);}
function ptHClear(){if(ptHTimer!==null){clearTimeout(ptHTimer);ptHTimer=null;}if(ptHCleanup){const c=ptHCleanup;ptHCleanup=null;c();}}
function ptHPublish(){
  setPlayButtonVisual(false);$('playStatus').textContent='已暫停 · '+(ptAmbientResolve(ptAmbientHold)==='silent'?'無聲保活':'環境音保活');
  updateProgressDisplay();updateLyrics(true);updateImmersiveUI(true);updateMediaPosition(true);updateMediaSession(true);
  try{navigator.mediaSession.playbackState='paused';}catch(_){}
}
function ptHSave(){ptLast=null;ptFlush();ptBehavior();if(!state.suppressProgressWrites)Promise.resolve(saveProgress()).then(queuePauseSyncExport).catch(()=>{});}
function ptHDiscard(reason){
  const s=ptHSnapshot;if(!s)return;
  ptHGeneration++;ptHClear();ptRawAudio.pause();ptRawAudio.loop=false;ptRawAudio.muted=s.muted;
  ptHSnapshot=null;try{URL.revokeObjectURL(s.silence);}catch(_){}ptHStatus(reason);
}
function ptHEnter(){
  const r=ptRawAudio;
  if(!ptHCanEnter({mode:ptRMode,ios:isIOSHeadphoneEnvironment(),loaded:!!(state.current&&state.fileUrl&&r.src===state.fileUrl&&r.readyState>=2&&Number.isFinite(r.duration)&&r.duration>0),paused:r.paused,ended:r.ended,seeking:r.seeking,sleep:!!(state.sleepDeadline||state.sleepEndChapter),busy:!!(state.importJob?.running||state.suppressProgressWrites||state.episodeDeleteRunning||ptHSnapshot)}))return false;
  const sound=ptAmbientResolve(ptAmbientHold);let silence;try{silence=URL.createObjectURL(new Blob([ptHWav(ptHMinutes,sound,ptAmbientHoldVolume/100)],{type:'audio/wav'}));}catch(e){ptHStatus('無聲音軌建立失敗');return false;}
  const s={id:state.current.id,source:r.src,position:ptHClamp(r.currentTime,r.duration),duration:r.duration,rate:r.playbackRate,muted:r.muted,silence,phase:'hold',deadline:Date.now()+ptHMinutes*60000};
  ptMixStop('進入保活');ptHSnapshot=s;const gen=++ptHGeneration;ptHLastAction=Date.now();
  ptRStop('Silent Hold',true);ptRInvalidate('Silent Hold');ptHSave();
  try{
    r.loop=false;r.src=s.silence;r.defaultPlaybackRate=1;r.playbackRate=1;
    Promise.resolve(r.play()).then(()=>{if(ptHSnapshot===s&&gen===ptHGeneration){ptHPublish();ptHStatus((sound==='silent'?'無聲保活':'環境音保活：'+ptAmbientName(sound))+' · '+ptHMinutes+' 分鐘上限');}}).catch(()=>{if(ptHSnapshot===s&&gen===ptHGeneration)ptHHardStop('無聲播放被拒');});
    ptHTimer=setTimeout(()=>{if(ptHSnapshot===s&&gen===ptHGeneration)ptHHardStop('保活到期');},ptHMinutes*60000);
    ptHPublish();ptHStatus('啟動'+(sound==='silent'?'無聲':'環境音')+'保活');return true;
  }catch(e){ptHHardStop('無聲音軌切換失敗');return true;}
}
function ptHRestore(wantPlay,reason){
  const s=ptHSnapshot,r=ptRawAudio;
  if(!s)return Promise.resolve(false);
  if(s.phase==='restore'&&wantPlay)return Promise.resolve(false);
  if(state.current?.id!==s.id||state.fileUrl!==s.source){ptHDiscard('來源已變更');return Promise.resolve(false);}
  ptHClear();const gen=++ptHGeneration;s.phase='restore';ptHLastAction=Date.now();
  let resolveResult;const result=new Promise(resolve=>{resolveResult=resolve;});
  let settled=false,playOK=!wantPlay;
  const valid=()=>ptHSnapshot===s&&gen===ptHGeneration;
  const cleanup=()=>{for(const ev of ['loadedmetadata','seeked','canplay'])r.removeEventListener(ev,check);r.removeEventListener('error',fail);if(!settled){settled=true;resolveResult(false);}};
  const fail=()=>{if(!valid())return;ptHClear();r.pause();s.phase='failed';r.muted=s.muted;ptHPublish();ptHStatus('恢復受限 · 保留斷點，請解鎖重試');};
  const check=()=>{
    if(!valid()||!ptHOriginalReady(r,s))return;
    const pos=ptHClamp(s.position,s.duration);
    if(pos>=r.duration){fail();return;}
    if(Math.abs(r.currentTime-pos)>.25){try{r.currentTime=pos;}catch(_){fail();}return;}
    if(r.seeking||r.ended||!playOK||(wantPlay&&r.paused))return;
    settled=true;ptHClear();ptHSnapshot=null;r.muted=s.muted;try{URL.revokeObjectURL(s.silence);}catch(_){}
    ptLast=null;ptHStatus(wantPlay?'已恢復原 MP3':'真正暫停 · 斷點已保留');
    if(wantPlay&&!r.paused)r.dispatchEvent(new Event('play'));else{setPlayButtonVisual(false);$('playStatus').textContent='已暫停';try{navigator.mediaSession.playbackState='paused';}catch(_){}}
    updateProgressDisplay();updateLyrics(true);updateImmersiveUI(true);updateMediaPosition(true);updateMediaSession(true);ptBehavior();resolveResult(wantPlay?!r.paused:true);
  };
  ptHCleanup=cleanup;
  for(const ev of ['loadedmetadata','seeked','canplay'])r.addEventListener(ev,check);
  r.addEventListener('error',fail);
  try{
    if(!wantPlay)r.pause();
    r.muted=true;r.loop=false;r.src=s.source;r.defaultPlaybackRate=s.rate;r.playbackRate=s.rate;
    if(ptHOriginalReady(r,s)){try{r.currentTime=ptHClamp(s.position,s.duration);}catch(_){}}
    ptHTimer=setTimeout(fail,12000);
    if(wantPlay){requestPlaybackAudioSession();Promise.resolve(r.play()).then(()=>{if(valid()){playOK=true;check();}}).catch(fail);}
    else{r.load();check();}
  }catch(_){fail();}
  ptHStatus(reason+' · 正在還原原 MP3');return result;
}
function ptHHardStop(reason){if(ptHSnapshot){ptHRestore(false,reason);return true;}return false;}
function ptHPauseFromUI(){if(!ptHEnter())audio.pause();}
function ptHMediaAction(kind){
  if(ptHSnapshot){
    if(Date.now()-ptHLastAction<700)return true;
    if(kind==='pause'&&ptHSnapshot.phase!=='hold')return true;
    ptHRestore(true,'系統 '+kind+' → 恢復');return true;
  }
  if(ptRMode!=='silent')return false;
  if(Date.now()-ptHLastAction<700)return true;
  if(kind==='pause'||(kind==='play'&&!ptRawAudio.paused&&state.iosSingleButtonCompatibility)){if(ptHEnter())return true;}
  return false;
}
function ptHInstall(){
  ptAmbientInstall();
  const select=$('ptHoldMinutes');try{const n=Number(localStorage.getItem('pinetree-hold-minutes-v1'));if([1,5,10,30].includes(n))ptHMinutes=n;}catch(_){}
  select.value=String(ptHMinutes);select.addEventListener('change',()=>{ptHHardStop('調整保活時長');ptHMinutes=[1,5,10,30].includes(Number(select.value))?Number(select.value):5;try{localStorage.setItem('pinetree-hold-minutes-v1',String(ptHMinutes));}catch(_){}});
  const r=ptRawAudio;
  r.addEventListener('timeupdate',()=>{if(ptHSnapshot?.phase==='hold'){if(Date.now()>=ptHSnapshot.deadline)ptHHardStop('保活到期');else try{navigator.mediaSession.playbackState='paused';}catch(_){}}});
  for(const ev of ['ended','error','pause'])r.addEventListener(ev,()=>{const s=ptHSnapshot;if(s?.phase==='hold'&&r.src===s.silence&&(ev!=='pause'||r.paused)&&(ev!=='pause'||Date.now()-ptHLastAction>700))ptHHardStop('無聲音軌 '+ev);});
  document.addEventListener('visibilitychange',()=>{if(ptHSnapshot?.phase==='hold'&&Date.now()>=ptHSnapshot.deadline)ptHHardStop('保活到期');});
  window.addEventListener('pagehide',()=>{if(ptHSnapshot){saveProgress();ptHHardStop('頁面離開');}});
}

/* Ambient Hold + optional audiobook soundscape. Original synthesized, offline PCM.
 * Hold uses the existing finite media source. Mix uses Web Audio only; no competing
 * media element, no MediaSession ownership or library / progress writes. */
const PT_AMBIENT_KEY='pinetree-ambient-v1';
let ptAmbientHold='silent',ptAmbientHoldVolume=10,ptAmbientMix='campfire',ptAmbientMixVolume=10,ptAmbientMixEnabled=false;
let ptMixContext=null,ptMixSource=null,ptMixGain=null,ptMixGeneration=0;
const PT_AMBIENT_SOUNDS=['silent','campfire','rain','stream','onsen','brown','auto'];
function ptAmbientName(s){return ({silent:'完全無聲',campfire:'森林篝火',rain:'松林細雨',stream:'月下溪流',onsen:'柚香溫泉',brown:'棕噪音',auto:'主題匹配'})[s]||'完全無聲';}
function ptAmbientResolve(s,theme=state.uiTheme){return s==='auto'?(theme==='capybara-onsen'?'onsen':'campfire'):s;}
function ptAmbientVolume(n){return Math.max(0,Math.min(30,Number(n)||0));}
function ptAmbientSamples(sound,rate=8000){
  const size=rate*12,out=new Float32Array(size);
  if(sound==='silent')return out;
  let seed=19349663,lo=0,slow=0,crackle=0,peak=0;
  const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let i=0;i<size;i++){
    const white=rand()*2-1;lo=.94*lo+.06*white;slow=.995*slow+.005*white;
    const t=i/rate;
    if(sound==='campfire'){
      if(rand()<.0014)crackle=.25+rand()*.75;
      crackle*=.965;
      out[i]=.55*lo+.11*white+.42*crackle*white;
    }else if(sound==='rain'){
      out[i]=.25*lo+.38*white*(.85+.15*Math.sin(t*2.1));
    }else if(sound==='stream'){
      out[i]=(.32*white+.75*lo)*(.73+.16*Math.sin(t*3.1)+.11*Math.sin(t*5.4));
    }else if(sound==='onsen'){
      out[i]=.85*lo+.12*white+.22*slow+.06*Math.sin(t*2.4)*lo;
    }else{
      out[i]=3.1*lo+2.4*slow;
    }
    peak=Math.max(peak,Math.abs(out[i]));
  }
  // Fade the short crossfade seam to zero; repeating buffer remains click-free.
  const edge=Math.floor(rate*.10),scale=.8/Math.max(.8,peak);
  for(let i=0;i<size;i++)out[i]*=scale*Math.min(1,i/edge,(size-1-i)/edge);
  return out;
}
function ptMixAllowed(x){return !!(x.enabled&&x.sound!=='silent'&&x.volume>0&&x.loaded&&!x.paused&&!x.ended&&!x.holding&&!x.expired);}
function ptMixStatus(message){const el=$('ptAmbientMixStatus');if(el)el.textContent=message;}
function ptMixStop(reason){
  ptMixGeneration++;
  const ctx=ptMixContext,src=ptMixSource;
  ptMixContext=null;ptMixSource=null;ptMixGain=null;
  try{src?.stop();src?.disconnect();}catch(_){}
  if(ctx){try{Promise.resolve(ctx.close()).catch(()=>{});}catch(_){}}
  ptMixStatus(ptAmbientMixEnabled?'環境音待命 · '+reason:'說書混音已關閉');
}
function ptMixSetGain(){
  if(!ptMixGain||!ptMixContext)return;
  const ms=state.sleepDeadline?state.sleepDeadline-Date.now():Infinity;
  const fade=$('ptFade')?.checked?Math.max(0,Math.min(1,ms/60000)):1;
  const gain=ptAmbientMixVolume/100*fade;
  try{ptMixGain.gain.setTargetAtTime(gain,ptMixContext.currentTime,.08);}catch(_){}
}
function ptMixStart(){
  const sound=ptAmbientResolve(ptAmbientMix);
  if(!ptMixAllowed({enabled:ptAmbientMixEnabled,sound,volume:ptAmbientMixVolume,loaded:!!(state.current&&state.fileUrl&&ptRawAudio.src===state.fileUrl&&ptRawAudio.readyState>=2),paused:ptRawAudio.paused,ended:ptRawAudio.ended,holding:!!ptHSnapshot,expired:!!(state.sleepDeadline&&Date.now()>=state.sleepDeadline)}))return;
  if(ptMixContext){ptMixSetGain();return;}
  const C=window.AudioContext||window.webkitAudioContext;
  if(!C){ptMixStatus('此瀏覽器不支援環境音混音');return;}
  const gen=++ptMixGeneration;
  try{
    const ctx=new C();ptMixContext=ctx;
    const samples=ptAmbientSamples(sound),buffer=ctx.createBuffer(1,samples.length,8000);
    buffer.getChannelData(0).set(samples);
    const src=ctx.createBufferSource(),gain=ctx.createGain();ptMixSource=src;ptMixGain=gain;
    src.buffer=buffer;src.loop=true;gain.gain.value=0;src.connect(gain);gain.connect(ctx.destination);src.start();
    ptMixSetGain();ptMixStatus('嘗試啟動 '+ptAmbientName(sound));
    Promise.resolve(ctx.resume()).then(()=>{if(gen===ptMixGeneration&&ctx===ptMixContext)ptMixStatus(ctx.state==='running'?'混音中 · '+ptAmbientName(sound):'混音暫未啟動 · '+ctx.state);}).catch(()=>{if(gen===ptMixGeneration){ptMixStop('系統拒絕');ptMixStatus('混音被系統限制 · 請在前景重試');}});
  }catch(_){if(gen===ptMixGeneration){ptMixStop('啟動失敗');ptMixStatus('環境音混音不可用');}}
}
function ptAmbientInstall(){
  try{const c=JSON.parse(localStorage.getItem(PT_AMBIENT_KEY)||'{}');
    if(PT_AMBIENT_SOUNDS.includes(c.hold))ptAmbientHold=c.hold;
    if(PT_AMBIENT_SOUNDS.includes(c.mix))ptAmbientMix=c.mix;
    if(Number.isFinite(c.holdVolume))ptAmbientHoldVolume=ptAmbientVolume(c.holdVolume);
    if(Number.isFinite(c.mixVolume))ptAmbientMixVolume=ptAmbientVolume(c.mixVolume);
    ptAmbientMixEnabled=c.enabled===true;
  }catch(_){}
  const hold=$('ptAmbientHold'),hv=$('ptAmbientHoldVolume'),mix=$('ptAmbientMix'),mv=$('ptAmbientMixVolume'),enabled=$('ptAmbientMixEnabled');
  if(!hold||!hv||!mix||!mv||!enabled)return;
  hold.value=ptAmbientHold;hv.value=String(ptAmbientHoldVolume);mix.value=ptAmbientMix;mv.value=String(ptAmbientMixVolume);enabled.checked=ptAmbientMixEnabled;
  const save=()=>{try{localStorage.setItem(PT_AMBIENT_KEY,JSON.stringify({hold:ptAmbientHold,holdVolume:ptAmbientHoldVolume,mix:ptAmbientMix,mixVolume:ptAmbientMixVolume,enabled:ptAmbientMixEnabled}));}catch(_){}};
  const labels=()=>{$('ptAmbientHoldValue').textContent=ptAmbientHoldVolume+'%';$('ptAmbientMixValue').textContent=ptAmbientMixVolume+'%';};
  const changeHold=()=>{ptHHardStop('環境音設定變更');ptAmbientHold=PT_AMBIENT_SOUNDS.includes(hold.value)?hold.value:'silent';ptAmbientHoldVolume=ptAmbientVolume(hv.value);labels();save();};
  hold.addEventListener('change',changeHold);hv.addEventListener('change',changeHold);
  hv.addEventListener('input',()=>{$('ptAmbientHoldValue').textContent=ptAmbientVolume(hv.value)+'%';});
  mix.addEventListener('change',()=>{ptAmbientMix=PT_AMBIENT_SOUNDS.includes(mix.value)?mix.value:'campfire';save();ptMixStop('更換環境音');ptMixStart();});
  mv.addEventListener('input',()=>{ptAmbientMixVolume=ptAmbientVolume(mv.value);labels();save();if(ptAmbientMixVolume===0)ptMixStop('音量為零');else{ptMixSetGain();ptMixStart();}});
  enabled.addEventListener('change',()=>{ptAmbientMixEnabled=enabled.checked;save();if(enabled.checked){ptMixStatus('環境音待命');ptMixStart();}else ptMixStop('關閉');});
  labels();ptMixStatus(ptAmbientMixEnabled?'環境音待命':'說書混音已關閉');
  for(const e of ['play','playing','canplay'])audio.addEventListener(e,ptMixStart);
  for(const e of ['pause','ended','emptied','loadstart','waiting','error'])audio.addEventListener(e,()=>ptMixStop(e));
  audio.addEventListener('timeupdate',ptMixSetGain);
  window.addEventListener('pagehide',()=>ptMixStop('頁面離開'));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)ptMixStart();});
  new MutationObserver(()=>{if(ptAmbientMix==='auto'){ptMixStop('主題切換');ptMixStart();}}).observe(document.body,{attributes:true,attributeFilter:['data-ui-theme']});
}
