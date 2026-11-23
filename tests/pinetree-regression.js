/* PineTree 4.4.16 targeted regression checks.
 * Run: node REGRESSION_TESTS.js <path-to-app.js> <path-to-index.html>
 * Does not touch IndexedDB, audio blobs, iCloud files, or the repository.
 */
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const [jsPath,htmlPath]=process.argv.slice(2);
if(!jsPath||!htmlPath){console.error('Usage: node REGRESSION_TESTS.js app.js index.html');process.exit(2);}
const app=fs.readFileSync(jsPath,'utf8'), html=fs.readFileSync(htmlPath,'utf8');
const tests=[];
function test(label,run){run();tests.push(label);console.log('PASS',label);}
function pickerTag(id){
  const matches=Array.from(html.matchAll(/<input\b[^>]*>/g)).map(x=>x[0]).filter(tag=>new RegExp('\\bid="'+id+'"').test(tag));
  assert.equal(matches.length,1,`${id} should appear exactly once`);
  return matches[0];
}
test('Both iOS media pickers show any file type (no accept filter)',()=>{
  for(const id of ['filePicker','chapterSyncFiles']){
    const tag=pickerTag(id);
    assert(!/\baccept\s*=/.test(tag),id+' still has accept');
    assert(/\bmultiple\b/.test(tag),id+' should allow MP3 and LRC together');
  }
});
test('Selected files are validated by extension within importer, not native iOS picker',()=>{
  assert(app.includes("if(!/\\.(mp3|lrc)$/i.test(file.name))continue;"),'file extension validation missing');
  assert(/\(mp3\|lrc\)/i.test(app));
  assert(app.includes("const kind=/\\.mp3$/i.test(file.name)?'mp3':'lrc';"),'MP3 and LRC grouping missing');
  assert(app.includes("guidedPicker.removeAttribute('accept')"));
});
test('Same Windows-safe JSON filename retained and displayed correctly',()=>{
  assert(app.includes("const SYNC_JSON_NAME='AAudioBook_PineTree_Sync.json';"));
  assert(html.includes('AAudioBook_PineTree_Sync.json'));
  assert(!html.includes('~AudioBook_PineTree_Sync.json'));
  assert(app.includes("for await (const entry of syncFolderHandle.values())"),'legacy read fallback lost');
});
test('Player database schema and headphone/lockscreen paths still present',()=>{
  assert(app.includes("const DB_NAME = 'lyra-audiobooks-v1';"));
  assert(app.includes('const DB_VERSION = 2;'));
  assert(app.includes('function handleHeadphonePlayAction(){'));
  assert(app.includes('function lockScreenInfo(){'));
  assert(app.includes('function updateMediaSession('));
});
test('Release markers and deployment manifest stay consistent',()=>{
  const marker=html.match(/pinetree-release" content="(\d{4,12})"/);
  assert(marker,'HTML release marker missing');
  const repo=path.dirname(jsPath);
  // During pre-install staged-file tests, version.json is still old by design.
  if(path.basename(jsPath)!=='app.js')return;
  const version=JSON.parse(fs.readFileSync(path.join(repo,'version.json'),'utf8'));
  const sw=fs.readFileSync(path.join(repo,'sw.js'),'utf8');
  assert.equal(marker[1],version.version,'HTML release differs from version.json');
  assert(sw.includes(`const VERSION='${version.version}'`),'SW release differs from version.json');
  for(const [file,content] of [['app.js',app],['index.html',html]]){
    const actual=crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,file))).digest('hex');
    assert.equal(actual,version.files[file],file+' differs from version.json SHA-256');
  }
});
function chapterHandler(){
  const drawStart=app.indexOf('function drawChapterList(){');
  assert(drawStart>=0);
  const start=app.indexOf("btn.addEventListener('click',()=>{",drawStart);
  const end=app.indexOf('});fragment.append(btn);',start);
  assert(start>=0&&end>start,'chapter click handler not found');
  const handler=app.slice(start,end+3);
  assert(!handler.includes('openChapterSync('),'chapter tap must never open JSON sync modal');
  return handler;
}
function simulate({localTrack,waiting,selectionMode=false}){
  const handler=chapterHandler(), calls=[];
  const track={id:'book\u000000001_chapter',book:'book',name:'00001_chapter'};
  const input={value:'old',removeAttribute(x){calls.push(['removeAttr',x]);},click(){calls.push(['pickerClick']);}};
  const context={
    t:track, waiting:waiting?{missing:true}:null,
    state:{episodeSelectionMode:selectionMode,tracks:localTrack?[{...track,audioPresent:localTrack.audioPresent}]:[]},
    btn:{addEventListener(name,callback){this.onTap=callback;},},
    fragment:{append(){calls.push(['append']);}},
    toggleEpisodeSelection(id){calls.push(['select',id]);},
    loadTrack(t,o){calls.push(['load',t.id,o.autoplay]);},
    setImportPickerHint(flag){calls.push(['hint',flag]);},
    $(id){assert.equal(id,'filePicker');return input;},
    openChapterSync(){calls.push(['badSyncModal']);}
  };
  // State declaration is lexical and must be visible when the handler runs.
  vm.createContext(context);
  vm.runInContext('let pendingChapterTap=null; '+handler+'\nbtn.onTap(); globalThis.__pending=pendingChapterTap;',context,{timeout:500});
  return {calls,pending:context.__pending,input};
}
test('Tap existing MP3 (even when desktop update is pending) plays it immediately',()=>{
  const r=simulate({localTrack:{audioPresent:true},waiting:true});
  assert(r.calls.some(c=>c[0]==='load'&&c[2]===true));
  assert(!r.calls.some(c=>c[0]==='pickerClick'||c[0]==='badSyncModal'));
});
test('Tap JSON-only new book chapter opens native MP3/LRC picker instead of sync modal',()=>{
  const r=simulate({localTrack:null,waiting:true});
  assert(r.calls.some(c=>c[0]==='pickerClick'));
  assert(r.calls.some(c=>c[0]==='removeAttr'&&c[1]==='accept'));
  assert(!r.calls.some(c=>c[0]==='load'||c[0]==='badSyncModal'));
  assert.equal(r.pending.book,'book');
  assert.equal(r.pending.id,'book\u000000001_chapter');
  assert.equal(r.input.value,'');
});
test('Tap chapter with cleaned-up MP3 opens picker instead of trying to load broken audio',()=>{
  const r=simulate({localTrack:{audioPresent:false},waiting:false});
  assert(r.calls.some(c=>c[0]==='pickerClick'));
  assert(!r.calls.some(c=>c[0]==='load'||c[0]==='badSyncModal'));
});
test('Chapter multi-select takes precedence over playback/import',()=>{
  const r=simulate({localTrack:null,waiting:true,selectionMode:true});
  assert(r.calls.some(c=>c[0]==='select'));
  assert(!r.calls.some(c=>c[0]==='pickerClick'||c[0]==='load'||c[0]==='badSyncModal'));
});
test('After successful import, tapped chapter requires real stored MP3 and loads without autoplay',()=>{
  assert(app.includes('const tappedChapter=pendingChapterTap?.book===book?pendingChapterTap:null;'));
  assert(app.includes('if(ready&&await hasAudioKey(ready.id))'));
  assert(app.includes('await loadTrack(ready,{autoplay:false});'));
  assert(app.includes('if(tappedChapter)pendingChapterTap=null;'));
  assert(app.includes("if(!files.length){pendingChapterTap=null;setImportPickerHint(false);return;}"));
});
test('Playback mode UI, persistence and chapter-end handler are installed',()=>{
  for(const id of ['playModeBtn','imPlayMode'])assert(html.includes('id="'+id+'"'),id+' is missing');
  assert(app.includes("localStorage.setItem('pinetree-play-mode-v1',mode.id)"));
  assert(app.includes('setPlayMode(state.playMode,{persist:false})'));
  assert(app.includes("audio.addEventListener('ended',handleTrackEnded);"));
  assert(app.includes("state.playMode==='repeat-one'"));
  assert(app.includes("state.playMode==='repeat-all'"));
  assert(app.includes("if(state.sleepEndChapter){stopSleepTimer("),'sleep priority missing');
});
console.log(`\n${tests.length} targeted regression checks passed.`);
