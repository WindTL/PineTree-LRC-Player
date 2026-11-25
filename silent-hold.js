/* Optional single-element Silent Hold, independently implemented for local Blob MP3.
 * Reference architecture: https://github.com/ajaxsys/pwa-audio-player/blob/HEAD/packages/core/src/keepAlive.ts
 * Finite silent PCM, logical chapter snapshot, no background autoplay or external requests. */
'use strict';
let ptHSnapshot=null,ptHGeneration=0,ptHTimer=null,ptHMinutes=5,ptHLastAction=0,ptHCleanup=null;
function ptHClamp(t,d){return Math.max(0,Math.min(Math.max(0,d-.05),Number(t)||0));}
function ptHCanEnter(x){return x.mode==='silent'&&x.ios&&x.loaded&&!x.paused&&!x.ended&&!x.seeking&&!x.sleep&&!x.busy;}
function ptHWav(minutes){
  if(![1,5,10,30].includes(minutes))throw RangeError('hold length');
  const n=8000*60*minutes,b=new Uint8Array(44+n),v=new DataView(b.buffer);
  for(const [off,s] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']])for(let i=0;i<s.length;i++)b[off+i]=s.charCodeAt(i);
  v.setUint32(4,36+n,true);v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);v.setUint32(28,8000,true);v.setUint16(32,1,true);v.setUint16(34,8,true);v.setUint32(40,n,true);b.fill(128,44);return b;
}
function ptHoldFacade(raw){
  const listeners=new WeakMap();
  return new Proxy(raw,{
    get(target,key){
      const s=ptHSnapshot;
      if(key==='addEventListener')return (type,fn,options)=>{
        if(typeof fn!=='function')return target.addEventListener(type,fn,options);
        let byType=listeners.get(fn);if(!byType){byType=new Map();listeners.set(fn,byType);}
        let wrap=byType.get(type);if(!wrap){wrap=function(e){if(!ptHSnapshot)fn.call(target,e);};byType.set(type,wrap);}
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
  setPlayButtonVisual(false);$('playStatus').textContent='已暫停 · 無聲保活';
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
  let silence;try{silence=URL.createObjectURL(new Blob([ptHWav(ptHMinutes)],{type:'audio/wav'}));}catch(e){ptHStatus('無聲音軌建立失敗');return false;}
  const s={id:state.current.id,source:r.src,position:ptHClamp(r.currentTime,r.duration),duration:r.duration,rate:r.playbackRate,muted:r.muted,silence,phase:'hold',deadline:Date.now()+ptHMinutes*60000};
  ptHSnapshot=s;const gen=++ptHGeneration;ptHLastAction=Date.now();
  ptRStop('Silent Hold',true);ptRInvalidate('Silent Hold');ptHSave();
  try{
    r.loop=false;r.src=s.silence;r.defaultPlaybackRate=1;r.playbackRate=1;
    Promise.resolve(r.play()).then(()=>{if(ptHSnapshot===s&&gen===ptHGeneration){ptHPublish();ptHStatus('無聲保活中 · '+ptHMinutes+' 分鐘上限');}}).catch(()=>{if(ptHSnapshot===s&&gen===ptHGeneration)ptHHardStop('無聲播放被拒');});
    ptHTimer=setTimeout(()=>{if(ptHSnapshot===s&&gen===ptHGeneration)ptHHardStop('保活到期');},ptHMinutes*60000);
    ptHPublish();ptHStatus('啟動無聲保活');return true;
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
    if(!valid()||r.src!==s.source||r.readyState<1)return;
    const pos=ptHClamp(s.position,s.duration);
    if(Math.abs(r.currentTime-pos)>.25){try{r.currentTime=pos;}catch(_){fail();}return;}
    if(r.seeking||!playOK)return;
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
    try{r.currentTime=s.position;}catch(_){}
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
  if(kind==='pause'||(kind==='play'&&!ptRawAudio.paused&&state.iosSingleButtonCompatibility)){if(ptHEnter())return true;}
  return false;
}
function ptHInstall(){
  const select=$('ptHoldMinutes');try{const n=Number(localStorage.getItem('pinetree-hold-minutes-v1'));if([1,5,10,30].includes(n))ptHMinutes=n;}catch(_){}
  select.value=String(ptHMinutes);select.addEventListener('change',()=>{ptHHardStop('調整保活時長');ptHMinutes=[1,5,10,30].includes(Number(select.value))?Number(select.value):5;try{localStorage.setItem('pinetree-hold-minutes-v1',String(ptHMinutes));}catch(_){}});
  const r=ptRawAudio;
  r.addEventListener('timeupdate',()=>{if(ptHSnapshot?.phase==='hold'){if(Date.now()>=ptHSnapshot.deadline)ptHHardStop('保活到期');else try{navigator.mediaSession.playbackState='paused';}catch(_){}}});
  for(const ev of ['ended','error','pause'])r.addEventListener(ev,()=>{const s=ptHSnapshot;if(s?.phase==='hold'&&r.src===s.silence&&(ev!=='pause'||r.paused)&&(ev!=='pause'||Date.now()-ptHLastAction>700))ptHHardStop('無聲音軌 '+ev);});
  document.addEventListener('visibilitychange',()=>{if(ptHSnapshot?.phase==='hold'&&Date.now()>=ptHSnapshot.deadline)ptHHardStop('保活到期');});
  window.addEventListener('pagehide',()=>{if(ptHSnapshot){saveProgress();ptHHardStop('頁面離開');}});
}
