/* Optional single-element Silent Hold, independently implemented for local Blob MP3.
 * Reference architecture: https://github.com/ajaxsys/pwa-audio-player/blob/HEAD/packages/core/src/keepAlive.ts
 * Finite silent PCM, logical chapter snapshot, no background autoplay or external requests. */
'use strict';
let ptHSnapshot=null,ptHGeneration=0,ptHTimer=null,ptHMinutes=5,ptHLastAction=0,ptHCleanup=null;
let ptHSourceBlob=null,ptHWatch=null;
// H7 experimental rate transition: require real playback advancement, not a wall-clock delay.
const PT_H_RATE_ADVANCE=.12,PT_H_PROBE_MS=20;
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
// Keep only the current chapter Blob (already in IndexedDB); generate a fresh URL
// on restore to avoid reusing WebKit's old media resource.
function ptHRememberSource(blob,url){ptHSourceBlob={blob,url};}
function ptHDurationMatches(actual,expected){
  return Number.isFinite(actual)&&Number.isFinite(expected)&&actual>0&&Math.abs(actual-expected)<=Math.max(.5,Math.min(2,expected*.005));
}
function ptHTruncated(actual,expected){
  return Number.isFinite(actual)&&Number.isFinite(expected)&&actual<expected-Math.max(.5,Math.min(2,expected*.005));
}
function ptHDispose(s){
  for(const url of [s.silence,...(s.retired||[])])if(url&&url!==s.source)try{URL.revokeObjectURL(url);}catch(_){}
  s.silence=null;s.retired=[];
}
function ptHProtectTruncated(raw){
  const w=ptHWatch;
  if(ptHSnapshot||!w||state.current?.id!==w.id||state.fileUrl!==w.source||raw.src!==w.source||raw.currentSrc!==w.source||raw.readyState<1)return false;
  if(!ptHTruncated(raw.duration,w.duration))return false;
  ptHSnapshot={...w,phase:'failed'};ptHWatch=null;
  ptHTrace('BLOCK truncated chapter duration');
  raw.pause();raw.muted=w.muted;ptHPublish();ptHSave();ptHStatus('音訊長度異常 · 已保護原章節及斷點，解鎖後按播放將使用安全續播');
  return true;
}
function ptHoldFacade(raw){
  const listeners=new WeakMap();
  return new Proxy(raw,{
    get(target,key){
      const s=ptHSnapshot;
      if(key==='addEventListener')return (type,fn,options)=>{
        if(typeof fn!=='function')return target.addEventListener(type,fn,options);
        let byType=listeners.get(fn);if(!byType){byType=new Map();listeners.set(fn,byType);}
        let wrap=byType.get(type);if(!wrap){wrap=function(e){if(['durationchange','pause','timeupdate','ended'].includes(type))ptHProtectTruncated(target);if(type==='ended')ptHTrace('facade ended '+(!ptHSnapshot&&ptHEndedIsCurrent(target)?'accepted':'blocked'));if(!ptHSnapshot&&(type!=='ended'||ptHEndedIsCurrent(target))){if(type==='timeupdate'&&ptHWatch&&target.src===ptHWatch.source&&ptHDurationMatches(target.duration,ptHWatch.duration)&&!target.seeking){ptHWatch.position=ptHClamp(target.currentTime,ptHWatch.duration);ptHWatch.rate=target.playbackRate;}fn.call(target,e);}};byType.set(type,wrap);}
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
// Local diagnostics: never include filenames, book titles, text, or Blob URLs.
function ptHTrace(event){
  try{
    const r=ptRawAudio,s=ptHSnapshot;
    const kind=url=>!url?'empty':url===state.fileUrl?'chapter':s&&url===s.silence?'hold':'other';
    const n=v=>Number.isFinite(v)?v.toFixed(2):'-';
    ptRLog('TRACE H7 '+event+' phase='+(s?.phase||'none')+' src='+kind(r.src)+' current='+kind(r.currentSrc)+' raw='+n(r.currentTime)+'/'+n(r.duration)+' saved='+n(s?.position)+'/'+n(s?.duration)+' rate='+n(r.playbackRate)+' seek='+Number(r.seeking)+' end='+Number(r.ended)+' paused='+Number(r.paused));
  }catch(_){}
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
  const s=ptHSnapshot;ptHWatch=null;ptHSourceBlob=null;if(!s)return;
  ptHGeneration++;ptHClear();ptRawAudio.pause();ptRawAudio.loop=false;ptRawAudio.muted=s.muted;
  ptHSnapshot=null;ptHDispose(s);ptHStatus(reason);
}
function ptHEnter(){
  const r=ptRawAudio;
  if(ptHProtectTruncated(r))return true;
  if(!ptHCanEnter({mode:ptRMode,ios:isIOSHeadphoneEnvironment(),loaded:!!(state.current&&state.fileUrl&&r.src===state.fileUrl&&r.readyState>=2&&Number.isFinite(r.duration)&&r.duration>0),paused:r.paused,ended:r.ended,seeking:r.seeking,sleep:!!(state.sleepDeadline||state.sleepEndChapter),busy:!!(state.importJob?.running||state.suppressProgressWrites||state.episodeDeleteRunning||ptHSnapshot)}))return false;
  const sound=ptAmbientResolve(ptAmbientHold);let silence;try{silence=URL.createObjectURL(new Blob([ptHWav(ptHMinutes,sound,ptAmbientHoldVolume/100)],{type:'audio/wav'}));}catch(e){ptHStatus('無聲音軌建立失敗');return false;}
  const s={id:state.current.id,source:r.src,position:ptHClamp(r.currentTime,r.duration),duration:r.duration,rate:r.playbackRate,muted:r.muted,silence,phase:'hold',deadline:Date.now()+ptHMinutes*60000};
  ptMixStop('進入保活');ptHWatch=null;ptHSnapshot=s;const gen=++ptHGeneration;ptHLastAction=Date.now();
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
  ptHClear();const gen=++ptHGeneration;s.phase='restore';ptHLastAction=Date.now();ptHTrace('restore begin play='+Number(wantPlay));
  let resolveResult;const result=new Promise(resolve=>{resolveResult=resolve;});
  let settled=false,playOK=!wantPlay,metadata=false,seekIssued=false,seekConfirmed=false,rateApplied=false,rateAt=null;
  let progressProbe=null,probeStartedAt=null;
  const target=wantPlay?Math.min(ptHClamp(s.position,s.duration),Math.max(0,s.duration-.6)):ptHClamp(s.position,s.duration);
  const events=['loadedmetadata','durationchange','seeked','canplay','playing','timeupdate','ended'];
  const valid=()=>ptHSnapshot===s&&gen===ptHGeneration;
  const stopProbe=()=>{if(progressProbe!==null){clearTimeout(progressProbe);progressProbe=null;}};
  // Background timeupdate may arrive only every ~750ms on iOS. Probe the
  // actual native media clock every 20ms during this short, verified stage.
  // Native events remain the fallback when WebKit throttles timers.
  const probe=()=>{if(progressProbe===null&&valid()&&!rateApplied)progressProbe=setTimeout(()=>{progressProbe=null;if(valid()&&!rateApplied)check();},PT_H_PROBE_MS);};
  const cleanup=()=>{stopProbe();for(const ev of events)r.removeEventListener(ev,check);r.removeEventListener('error',fail);if(!settled){settled=true;resolveResult(false);}};
  const fail=()=>{if(!valid())return;ptHTrace('restore failed / checkpoint retained');ptHClear();s.phase='failed';r.pause();r.muted=s.muted;ptHDispose(s);ptHPublish();ptHSave();ptHStatus('恢復受限 · 已保護原章節，解鎖後按播放將使用安全續播');};
  const finish=(ended=false)=>{
    if(!valid())return;ptHTrace('restore verified');settled=true;ptHClear();
    ptHWatch={...s,position:ptHClamp(r.currentTime,s.duration),silence:null,retired:[]};ptHSnapshot=null;
    r.muted=s.muted;ptHDispose(s);ptLast=null;
    ptHStatus(wantPlay?'已驗證原 MP3 續播':'真正暫停 · 斷點已保留');
    if(wantPlay&&!r.paused)r.dispatchEvent(new Event('play'));else{setPlayButtonVisual(false);$('playStatus').textContent='已暫停';try{navigator.mediaSession.playbackState='paused';}catch(_){}}
    updateProgressDisplay();updateLyrics(true);updateImmersiveUI(true);updateMediaPosition(true);updateMediaSession(true);ptBehavior();resolveResult(wantPlay?!r.paused||ended:true);
    if(ended)r.dispatchEvent(new Event('ended'));
  };
  const check=(e)=>{
    if(!valid()||!ptHOriginalReady(r,s))return;
    if(e?.type==='loadedmetadata')metadata=true;
    if(!metadata)return;
    // No seek until metadata belongs to this exact MP3 and its duration matches the snapshot.
    if(!ptHDurationMatches(r.duration,s.duration)){if(ptHTruncated(r.duration,s.duration)||e?.type==='ended')fail();return;}
    if(!seekIssued){
      seekIssued=true;ptHTrace('metadata verified; seek requested');
      if(Math.abs(r.currentTime-target)>.03){try{r.currentTime=target;}catch(_){fail();}return;}
      seekConfirmed=!r.seeking;
    }
    if(!seekConfirmed){
      if(r.seeking)return;
      if(Math.abs(r.currentTime-target)>.35){if(e?.type==='seeked')fail();return;}
      seekConfirmed=true;ptHTrace('seek verified');
    }
    if(!playOK||r.seeking)return;
    if(!wantPlay){if(r.paused){try{r.defaultPlaybackRate=s.rate;r.playbackRate=s.rate;}catch(_){fail();return;}finish();}return;}
    if(r.ended){if(e?.type==='ended'&&r.currentTime>=s.duration-.1&&target>=s.duration-1)finish(true);else fail();return;}
    if(r.paused)return;
    // Never release the snapshot merely because play() resolved at the seek position.
    // The H2 device log proved that an erroneous EOF can follow within 39ms.
    r.muted=s.muted;
    // H3 device trace: 2x was applied at seeked, then EOF within 15–42ms.
    // First observe actual 1x playback beyond the breakpoint; only then change rate.
    if(!rateApplied){
      const advance=Math.min(PT_H_RATE_ADVANCE,Math.max(.04,(s.duration-target)/3));
      if(probeStartedAt===null)probeStartedAt=Date.now();
      if(r.currentTime<target+advance){probe();return;}
      stopProbe();rateApplied=true;rateAt=r.currentTime;ptHTrace('1x verified '+(Date.now()-probeStartedAt)+'ms; applying saved rate');
      try{r.defaultPlaybackRate=s.rate;r.playbackRate=s.rate;}catch(_){fail();return;}
      if(s.rate===1)finish();return;
    }
    if(r.currentTime>=rateAt+Math.min(.15,Math.max(.02,(s.duration-rateAt)/3)))finish();
  };
  ptHCleanup=cleanup;
  for(const ev of events)r.addEventListener(ev,check);
  r.addEventListener('error',fail);
  try{
    if(!wantPlay)r.pause();
    r.muted=s.muted;r.loop=false;r.defaultPlaybackRate=1;r.playbackRate=1;
    if(ptHSourceBlob?.url===s.source&&ptHSourceBlob.blob){
      const blob=ptHSourceBlob.blob;
      const fresh=URL.createObjectURL(blob.slice(0,blob.size,blob.type));
      (s.retired??=[]).push(s.source);s.source=fresh;state.fileUrl=fresh;ptHSourceBlob.url=fresh;ptHTrace('fresh chapter URL');
    }
    r.src=s.source;r.load();
    ptHTimer=setTimeout(fail,12000);
    // Keep play() within the original UI/MediaSession user activation; seek only after metadata.
    if(wantPlay){requestPlaybackAudioSession();Promise.resolve(r.play()).then(()=>{if(valid()){playOK=true;check();}}).catch(fail);}
  }catch(_){fail();}
  if(valid()&&s.phase==='restore')ptHStatus(reason+' · 正在驗證原 MP3');
  return result;
}
function ptHHardStop(reason){if(ptHSnapshot){if(ptHSnapshot.phase!=='failed')ptHRestore(false,reason);return true;}return false;}
function ptHPauseFromUI(){if(!ptHEnter())audio.pause();}
function ptHMediaAction(kind){
  ptHTrace('system '+kind);
  if(ptHSnapshot){
    if(ptHSnapshot.phase==='failed'){if(kind==='play'){if(!document.hidden)startPlayback();else ptHStatus('恢復受限 · 請解鎖後按播放，使用安全續播');}return true;}
    if(Date.now()-ptHLastAction<700)return true;
    if(kind==='pause'&&ptHSnapshot.phase!=='hold')return true;
    ptHRestore(true,'系統 '+kind+' → 恢復');return true;
  }
  if(ptRMode!=='silent')return false;
  if(kind==='pause'||(kind==='play'&&!ptRawAudio.paused&&state.iosSingleButtonCompatibility)){if(ptHEnter())return true;}
  return false;
}
function ptHInstall(){
  ptAmbientInstall();
  ptHTrace('diagnostic build H7 installed');
  ptRawAudio.addEventListener('durationchange',()=>ptHProtectTruncated(ptRawAudio));
  for(const e of ['loadstart','loadedmetadata','durationchange','canplay','play','playing','pause','seeking','seeked','ended','error','emptied'])ptRawAudio.addEventListener(e,()=>{if(ptRMode==='silent'||ptHSnapshot)ptHTrace('raw '+e);});
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
/* Private, device-local campfire override. Canonical PCM only; no upload,
 * fetch, audio decoding context or asynchronous work inside the Hold action. */
const PT_CAMPFIRE_DB='pinetree-private-sounds-v1',PT_CAMPFIRE_MAX_SECONDS=600,PT_CAMPFIRE_LIMIT=44+8000*2*PT_CAMPFIRE_MAX_SECONDS;
let ptPrivateCampfire=null;
function ptPrivateCampfireDecode(bytes){
  if(!bytes||bytes.byteLength<44+16000||bytes.byteLength>PT_CAMPFIRE_LIMIT)throw Error('音效長度必須為 1–'+PT_CAMPFIRE_MAX_SECONDS+' 秒（最多 10 分鐘）');
  const v=new DataView(bytes),tag=(off,s)=>[...s].every((ch,i)=>v.getUint8(off+i)===ch.charCodeAt(0));
  const n=v.getUint32(40,true);
  if(!tag(0,'RIFF')||!tag(8,'WAVE')||!tag(12,'fmt ')||!tag(36,'data')||
     v.getUint32(4,true)!==bytes.byteLength-8||v.getUint32(16,true)!==16||
     v.getUint16(20,true)!==1||v.getUint16(22,true)!==1||v.getUint32(24,true)!==8000||
     v.getUint32(28,true)!==16000||v.getUint16(32,true)!==2||v.getUint16(34,true)!==16||
     n!==bytes.byteLength-44||n%2)throw Error('請選擇 PineTree 專用 8 kHz 單聲道 PCM16 WAV');
  const out=new Float32Array(n/2);
  for(let i=0;i<out.length;i++)out[i]=v.getInt16(44+i*2,true)/32768;
  return out;
}
function ptPrivateCampfireStore(action,bytes){
  return new Promise((resolve,reject)=>{
    let req,blocked=false;
    try{req=indexedDB.open(PT_CAMPFIRE_DB,1);}catch(e){reject(e);return;}
    req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('sounds'))req.result.createObjectStore('sounds');};
    req.onblocked=()=>{blocked=true;reject(Error('私人音效資料庫被其他頁面鎖定'));};
    req.onerror=()=>reject(req.error);
    req.onsuccess=()=>{
      const db=req.result;if(blocked){db.close();return;}
      let tx,q;
      try{
        tx=db.transaction('sounds',action==='get'?'readonly':'readwrite');
        const store=tx.objectStore('sounds');
        q=action==='get'?store.get('campfire'):action==='put'?store.put(bytes,'campfire'):store.delete('campfire');
      }catch(e){db.close();reject(e);return;}
      tx.oncomplete=()=>{db.close();resolve(action==='get'?q.result:undefined);};
      tx.onabort=()=>{db.close();reject(tx.error||Error('私人音效儲存失敗'));};
      tx.onerror=()=>{}; // abort event handles transactional failure
    };
  });
}
function ptPrivateCampfireApply(samples){
  ptPrivateCampfire=samples;
  // Never replace an active Hold source or alter the chapter playback state.
  // Refresh an existing foreground campfire mix only; H6 guards still apply.
  if(ptMixContext&&ptAmbientResolve(ptAmbientMix)==='campfire'){
    ptMixStop('森林篝火音源更新');ptMixStart();
  }
}
function ptPrivateCampfireInstall(){
  const host=$('ptAmbientHold')?.closest('.sync-guide');
  if(!host||$('ptPrivateCampfireStatus'))return;
  const wrap=document.createElement('div');wrap.className='sync-guide';
  const title=document.createElement('strong');title.textContent='私人森林篝火';
  const status=document.createElement('p');status.id='ptPrivateCampfireStatus';status.setAttribute('role','status');status.textContent='讀取本機音效…';
  const help=document.createElement('p');help.textContent='匯入 PineTree 專用 WAV 後，「森林篝火」會在暫停音效及說書背景音共用此錄音。格式：8 kHz 單聲道 PCM16 WAV，1–600 秒，最多 9,600,044 Bytes（約 9.6 MB）。只存在此裝置；下一次暫停時生效，不影響正在播放的章節。';
  const file=document.createElement('input');file.type='file';file.accept='.wav,audio/wav,audio/x-wav';file.hidden=true;
  const choose=document.createElement('button');choose.type='button';choose.className='btn btn-quiet';choose.textContent='匯入私人篝火 WAV';
  const reset=document.createElement('button');reset.type='button';reset.className='btn btn-quiet';reset.textContent='還原內建篝火';
  const update=(message='')=>{status.textContent=message||(ptPrivateCampfire?'已使用私人錄音 · '+(ptPrivateCampfire.length/8000).toFixed(1)+' 秒循環':'使用內建合成篝火');};
  const busy=(v)=>{choose.disabled=v;reset.disabled=v||!ptPrivateCampfire;};
  choose.addEventListener('click',()=>file.click());
  file.addEventListener('change',async()=>{
    const item=file.files?.[0];file.value='';if(!item)return;
    busy(true);try{
      if(item.size>PT_CAMPFIRE_LIMIT)throw Error('音效檔案過大：最多 10 分鐘、9,600,044 Bytes（8 kHz 單聲道 PCM16 WAV）');
      const bytes=await item.arrayBuffer(),samples=ptPrivateCampfireDecode(bytes);
      await ptPrivateCampfireStore('put',bytes);ptPrivateCampfireApply(samples);update();
    }catch(e){update('匯入失敗，保留原音效 · '+String(e?.message||e));}finally{busy(false);}
  });
  reset.addEventListener('click',async()=>{
    busy(true);try{await ptPrivateCampfireStore('delete');ptPrivateCampfireApply(null);update();}
    catch(e){update('還原失敗，保留原音效');}finally{busy(false);}
  });
  wrap.append(title,status,help,choose,reset,file);host.append(wrap);busy(true);
  ptPrivateCampfireStore('get').then(bytes=>{
    if(bytes)ptPrivateCampfireApply(ptPrivateCampfireDecode(bytes));update();
  }).catch(()=>update('私人音效讀取失敗 · 使用內建篝火')).finally(()=>busy(false));
}
function ptAmbientSamples(sound,rate=8000){
  if(sound==='campfire'&&rate===8000&&ptPrivateCampfire)return ptPrivateCampfire;
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
function ptMixBackgroundBlocked(ios,hidden){return !!(ios&&hidden);}
function ptMixAllowed(x){return !!(x.enabled&&x.sound!=='silent'&&x.volume>0&&x.loaded&&!x.paused&&!x.ended&&!x.holding&&!x.expired&&!x.backgroundBlocked);}
function ptMixStatus(message){const el=$('ptAmbientMixStatus');if(el)el.textContent=message;}
function ptMixStop(reason){
  ptMixGeneration++;
  const ctx=ptMixContext,src=ptMixSource;
  ptMixContext=null;ptMixSource=null;ptMixGain=null;
  try{src?.stop();src?.disconnect();}catch(_){}
  if(ctx){try{Promise.resolve(ctx.close()).catch(()=>{});}catch(_){}}
  if(ctx||src)ptHTrace('mix stop '+reason);
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
  if(ptMixBackgroundBlocked(isIOSHeadphoneEnvironment(),document.hidden)){
    if(ptMixContext||ptMixSource)ptMixStop('iOS 鎖屏相容');
    if(ptAmbientMixEnabled)ptMixStatus('鎖屏相容 · 解鎖後自動恢復混音');return;
  }
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
    ptMixSetGain();ptHTrace('mix start '+sound);ptMixStatus('嘗試啟動 '+ptAmbientName(sound));
    Promise.resolve(ctx.resume()).then(()=>{if(gen===ptMixGeneration&&ctx===ptMixContext){if(ptMixBackgroundBlocked(isIOSHeadphoneEnvironment(),document.hidden)){ptMixStop('iOS 鎖屏相容');return;}ptHTrace('mix context '+ctx.state);ptMixStatus(ctx.state==='running'?'混音中 · '+ptAmbientName(sound):'混音暫未啟動 · '+ctx.state);}}).catch(()=>{if(gen===ptMixGeneration){ptMixStop('系統拒絕');ptMixStatus('混音被系統限制 · 請在前景重試');}});
  }catch(_){if(gen===ptMixGeneration){ptMixStop('啟動失敗');ptMixStatus('環境音混音不可用');}}
}
function ptMixVisibility(){
  if(ptMixBackgroundBlocked(isIOSHeadphoneEnvironment(),document.hidden)){
    if(ptAmbientMixEnabled||ptMixContext||ptMixSource){
      ptMixStop('iOS 鎖屏相容');ptHTrace('mix background blocked');
      if(ptAmbientMixEnabled)ptMixStatus('鎖屏相容 · 解鎖後自動恢復混音');
      // No new audio session, no MP3 reload or synthetic playback action.
      // Re-register existing system callbacks without touching Hold or LRC.
      setupMediaSession();
    }
    return;
  }
  if(!document.hidden){if(ptAmbientMixEnabled)ptHTrace('mix foreground check');ptMixStart();}
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
  document.addEventListener('visibilitychange',ptMixVisibility);
  window.addEventListener('pageshow',ptMixVisibility);
  new MutationObserver(()=>{if(ptAmbientMix==='auto'){ptMixStop('主題切換');ptMixStart();}}).observe(document.body,{attributes:true,attributeFilter:['data-ui-theme']});
}
