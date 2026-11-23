/* PineTree 4.4.16: dynamically exercise chapter-end playback modes without audio/files. */
'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const app=fs.readFileSync('app.js','utf8');
const begin=app.indexOf('async function handleTrackEnded(){');
const end=app.indexOf('function skipSeconds(n){',begin);
assert(begin>=0&&end>begin,'missing chapter-end transition');
const implementation=app.slice(begin,end);
async function run(mode,{atLast=false,sleep=false,changed=false}={}){
  const tracks=[{id:'first',book:'novel'},{id:'last',book:'novel'}],calls=[];
  const state={current:atLast?tracks[1]:tracks[0],playMode:mode,sleepEndChapter:sleep};
  const audio={ended:true},status={textContent:''};
  const context={
    state,audio,
    saveProgress:async done=>{calls.push(['saved',done]);if(changed)state.current={id:'other',book:'novel'};},
    stopSleepTimer:()=>calls.push(['sleep']),
    sortedBookTracks:()=>tracks,
    loadTrack:async(t,o)=>calls.push(['load',t.id,!!o.autoplay,!!o.restart]),
    drawChapterList:()=>calls.push(['redraw']),
    $:()=>status
  };
  vm.createContext(context);
  vm.runInContext(implementation+';globalThis.runEnded=handleTrackEnded;',context,{timeout:1000});
  await context.runEnded();
  return {calls,status:status.textContent};
}
(async()=>{
  let r=await run('sequence');
  assert(r.calls.some(c=>c[0]==='load'&&c[1]==='last'));
  r=await run('sequence',{atLast:true});
  assert(!r.calls.some(c=>c[0]==='load'));
  assert(r.status.includes('已播放完畢'));
  r=await run('repeat-one');
  assert(r.calls.some(c=>c[0]==='load'&&c[1]==='first'&&c[3]===true));
  r=await run('repeat-one',{atLast:true});
  assert(r.calls.some(c=>c[0]==='load'&&c[1]==='last'&&c[3]===true));
  r=await run('repeat-all',{atLast:true});
  assert(r.calls.some(c=>c[0]==='load'&&c[1]==='first'&&c[3]===true));
  r=await run('repeat-all');
  assert(r.calls.some(c=>c[0]==='load'&&c[1]==='last'));
  r=await run('repeat-one',{sleep:true});
  assert(r.calls.some(c=>c[0]==='sleep'));
  assert(!r.calls.some(c=>c[0]==='load'));
  r=await run('repeat-all',{atLast:true,sleep:true});
  assert(r.calls.some(c=>c[0]==='sleep'));
  assert(!r.calls.some(c=>c[0]==='load'));
  r=await run('repeat-one',{changed:true});
  assert(!r.calls.some(c=>c[0]==='load'));
  console.log('PASS 9 playback-mode transitions (sequence, repeat-one, repeat-all, sleep, race)');
})().catch(error=>{console.error(error);process.exitCode=1;});
