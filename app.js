/* PineTree Lyra 4.0 stage 1 · seasonal themes + flagship themed buttons on top of centered lyrics, experimental lock-screen LRC metadata, sleep timer, bookmarks and eye-care themes.
 * Works with imported MP3 + timestamped LRC files only; no server uploads.
 * Keeps Lyra 1.x IndexedDB data by upgrading the SAME database to v2.
 */
'use strict';
const DB_NAME = 'lyra-audiobooks-v1';
const DB_VERSION = 2;
const DEFAULT_BG = '#0F2A1F';
const DEFAULT_PANEL = '#163427';
const DEFAULT_ACCENT = '#E0B84F';
const FOREST_MIGRATION_KEY = 'lyra-forest-theme-v31-applied';
const PRE_FOREST_BACKUP_KEY = 'lyra-theme-before-forest-v31';
const $ = id => document.getElementById(id);
const audio = $('audio');
const COLLATOR = new Intl.Collator('zh-Hans', {numeric:true, sensitivity:'base'});
const bounded = (n, lo, hi, fallback) => Number.isFinite(n) ? Math.max(lo, Math.min(hi,n)) : fallback;
const storedNumber = (key, fallback) => Number(localStorage.getItem(key) ?? fallback);
const state = {
  db:null, books:[], tracks:[], progresses:new Map(), selectedBook:null,
  current:null, fileUrl:null, coverUrls:new Map(), lines:[], lineIndex:-1,
  loadingToken:0, seeking:false, lastSave:0, userScrollUntil:0, followResumeTimer:null, toastTimer:null,
  fontSize:bounded(storedNumber('lyra-font',21),14,38,21),
  delay:bounded(storedNumber('lyra-delay',0),-20,20,0),
  speed:bounded(storedNumber('lyra-speed',1),.5,3,1),
  bgColor:/^#[0-9a-fA-F]{6}$/.test(localStorage.getItem('lyra-bg-color')||'') ? localStorage.getItem('lyra-bg-color') : DEFAULT_BG,
  lyricsMax:localStorage.getItem('lyra-lyrics-max')==='1',
  panelLinked:localStorage.getItem('lyra-panel-linked')!=='0',
  panelColor:/^#[0-9a-fA-F]{6}$/.test(localStorage.getItem('lyra-panel-color')||'') ? localStorage.getItem('lyra-panel-color') : DEFAULT_PANEL,
  accentColor:/^#[0-9a-fA-F]{6}$/.test(localStorage.getItem('lyra-accent-color')||'') ? localStorage.getItem('lyra-accent-color') : DEFAULT_ACCENT,
  artTheme:['prism-black','prism-green','prism-red','prism-gold','wood-fire-earth','christmas-season','new-year-festival'].includes(localStorage.getItem('pinetree-art-theme-v380')||localStorage.getItem('pinetree-art-theme-v374'))?(localStorage.getItem('pinetree-art-theme-v380')||localStorage.getItem('pinetree-art-theme-v374')):'',
  uiTheme:['forest-reading','jade-night','pine-morning','warm-tea','christmas-season','new-year-festival','prism-black','prism-green','prism-red','prism-gold','wood-fire-earth'].includes(localStorage.getItem('pinetree-ui-theme-v380')||'')?localStorage.getItem('pinetree-ui-theme-v380'):'',
  chapterQuery:'', mobileTab:'player', listDrawBook:null, listDrawQuery:'',
  importJob:null, suppressProgressWrites:false, importReport:[],
  episodeSelectionMode:false,selectedEpisodeIds:new Set(),episodeDeleteRunning:false,
  focusMode:localStorage.getItem('pinetree-focus-mode')==='1',
  keepAwake:localStorage.getItem('pinetree-keep-awake')==='1',wakeLock:null,
  themeMotion:localStorage.getItem('pinetree-theme-motion-v310')!=='0',
  mediaResumeError:'',
  immersive:localStorage.getItem('pinetree-immersive-v4101')==='1',
  immersiveLastLyricKey:'',
  lineSpacing:bounded(storedNumber('pinetree-line-spacing',1.85),1.4,2.6,1.85),
  lyricsCentered:localStorage.getItem('pinetree-lyrics-centered-v372')!=='0',
  sleepDeadline:0,sleepEndChapter:false,sleepInterval:null,cleanupRunning:false,cleanupPreviewToken:0,
  lockScreenMode:localStorage.getItem('pinetree-lockscreen-mode-v37')==='lyrics'?'lyrics':'standard',
  lockScreenSpeed:['fast','balanced','quiet'].includes(localStorage.getItem('pinetree-lockscreen-speed-v371'))?localStorage.getItem('pinetree-lockscreen-speed-v371'):'fast',
  lockScreenMetaKey:'',lockScreenLastAt:0,lockScreenLastText:'',lockScreenMediaError:false,
  iosSingleButtonCompatibility:localStorage.getItem('pinetree-ios-earphone-onebutton-v4394')!=='0',
  calibrationStyle:['wave','dial','moon'].includes(localStorage.getItem('pinetree-calibration-style')||'')?localStorage.getItem('pinetree-calibration-style'):'moon',
  fireflyTrails:localStorage.getItem('pinetree-firefly-trails')!=='0',
  fireflyIntensity:['soft','medium','high','cinematic'].includes(localStorage.getItem('pinetree-firefly-intensity-v436')||'')?localStorage.getItem('pinetree-firefly-intensity-v436'):'high',

};
const normalizeBook = value => (value || '').trim().normalize('NFC').replace(/\u0000/g,'').slice(0,90);
const stem = name => name.replace(/^.*[\\/]/,'').replace(/\.(mp3|lrc)$/i,'').normalize('NFC').trim().toLocaleLowerCase();
const readableStem = name => name.replace(/^.*[\\/]/,'').replace(/\.(mp3|lrc)$/i,'').trim();
const trackId = (book, name) => `${book}\u0000${stem(name)}`;
// Presentation only: clean a sortable filename prefix without modifying track IDs, files or imports.
function chapterDisplayName(name){return String(name||'').replace(/^\d{4,7}[_-](?=第\s*\d+\s*章)/u,'').replace(/^(第\s*\d+\s*章)[_\s-]+/u,'$1　');}

const DELETED_BOOKS_KEY='pinetree-deleted-books-v33';
const IMPORT_CHECKPOINT_KEY='pinetree-import-checkpoint-v33';
const SETTINGS_UPDATED_KEY='pinetree-settings-updated-v33';
const BOOKMARKS_KEY='pinetree-bookmarks-v36';
const RELEASE_SEEN_KEY='pinetree-release-seen-v4394';
window.PineTreeAppRelease='4394';
function readBookmarks(){try{return (JSON.parse(localStorage.getItem(BOOKMARKS_KEY)||'[]')||[]).filter(x=>x&&typeof x.id==='string').slice(0,2000);}catch{return [];}}
function writeBookmarks(items){try{localStorage.setItem(BOOKMARKS_KEY,JSON.stringify(items.slice(0,2000)));return true;}catch(error){console.warn('書籤儲存失敗',error);toast('書籤儲存失敗：本機空間可能不足');return false;}}

function loadDeletedBooks(){try{return JSON.parse(localStorage.getItem(DELETED_BOOKS_KEY)||'{}')||{};}catch{return {};}}
function writeDeletedBooks(records){localStorage.setItem(DELETED_BOOKS_KEY,JSON.stringify(records));}
function markSettingsChanged(){localStorage.setItem(SETTINGS_UPDATED_KEY,String(Date.now()));}
const nextUIFrame=()=>new Promise(resolve=>setTimeout(resolve,18));
function displayBytes(n){if(!Number.isFinite(n)||n<0)return '?';return n>=1024**3?(n/1024**3).toFixed(2)+' GB':n>=1024**2?(n/1024**2).toFixed(1)+' MB':n>=1024?(n/1024).toFixed(0)+' KB':n+' B';}

function toast(message, ms=3400){const el=$('toast');el.textContent=message;el.classList.add('show');clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>el.classList.remove('show'),ms);}
function formatTime(time){if(!Number.isFinite(time)||time<0)return '00:00';const n=Math.floor(time),h=Math.floor(n/3600);return (h?`${h}:`:'')+String(Math.floor(n%3600/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');}
function openDatabase(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,DB_VERSION);req.onupgradeneeded=()=>{const db=req.result;for(const store of ['tracks','audio','progress','books'])if(!db.objectStoreNames.contains(store))db.createObjectStore(store,{keyPath:'id'});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);req.onblocked=()=>toast('旧版 Lyra 仍在运行，请关闭其他标签后刷新');});}
function getStore(name,id){return new Promise((resolve,reject)=>{const req=state.db.transaction(name).objectStore(name)[id===undefined?'getAll':'get'](...(id===undefined?[]:[id]));req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
function putStore(name,record){return new Promise((resolve,reject)=>{const tx=state.db.transaction(name,'readwrite');tx.objectStore(name).put(record);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
function hasAudioKey(id){return new Promise((resolve,reject)=>{const req=state.db.transaction('audio').objectStore('audio').getKey(id);req.onsuccess=()=>resolve(req.result!==undefined);req.onerror=()=>reject(req.error);});}
function putTrackAndAudio(meta,file){return new Promise((resolve,reject)=>{const tx=state.db.transaction(['tracks','audio'],'readwrite');tx.objectStore('tracks').put(meta);if(file)tx.objectStore('audio').put({id:meta.id,blob:file});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
function removeAudioOnly(track){return new Promise((resolve,reject)=>{const tx=state.db.transaction(['tracks','audio'],'readwrite');tx.objectStore('audio').delete(track.id);tx.objectStore('tracks').put({...track,audioPresent:false,updatedAt:Date.now()});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
function deleteTrackData(id){return new Promise((resolve,reject)=>{const tx=state.db.transaction(['tracks','audio','progress'],'readwrite');for(const store of ['tracks','audio','progress'])tx.objectStore(store).delete(id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
function deleteTrackBatch(ids){return new Promise((resolve,reject)=>{const tx=state.db.transaction(['tracks','audio','progress'],'readwrite');for(const id of ids)for(const store of ['tracks','audio','progress'])tx.objectStore(store).delete(id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
function deleteBookData(book){return new Promise((resolve,reject)=>{const tx=state.db.transaction(['books','tracks','audio','progress'],'readwrite');tx.objectStore('books').delete(book);const trackStore=tx.objectStore('tracks'),audioStore=tx.objectStore('audio'),progressStore=tx.objectStore('progress');const cursor=trackStore.openCursor();cursor.onsuccess=()=>{const item=cursor.result;if(!item)return;if(item.value.book===book){audioStore.delete(item.primaryKey);progressStore.delete(item.primaryKey);item.delete();}item.continue();};tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
async function migrateLegacyBooks(){const [books,tracks]=await Promise.all([getStore('books'),getStore('tracks')]);const known=new Set(books.map(x=>x.id));for(const book of new Set(tracks.map(x=>x.book))){if(!known.has(book)){await putStore('books',{id:book,createdAt:Date.now(),coverBlob:null});known.add(book);}}}
function coverUrl(book){if(!book?.coverBlob)return '';if(!state.coverUrls.has(book.id))state.coverUrls.set(book.id,URL.createObjectURL(book.coverBlob));return state.coverUrls.get(book.id);}
function revokeCover(bookId){const old=state.coverUrls.get(bookId);if(old)URL.revokeObjectURL(old);state.coverUrls.delete(bookId);}
function sortedBookTracks(book){return state.tracks.filter(t=>t.book===book).sort((a,b)=>COLLATOR.compare(a.name,b.name));}
function getBook(id){return state.books.find(b=>b.id===id);}
function bookTitle(id){const b=getBook(id);return (b?.title||b?.id||id||'我的小说书库');}
function updateBookBrand(){
  const id=state.selectedBook || state.current?.book;
  const name=id?bookTitle(id):'我的小说书库';
  $('brandTitle').textContent=name;
  // Keep the PineTree app icon in the header; novel name stays in the adjacent title.
  $('brandTitle').title=name;
  document.title=`${name} · PineTree 有聲書`;
}
function updateLyricsCenterButton(){const btn=$('lyricsCenterToggle');if(!btn)return;btn.setAttribute('aria-pressed',String(state.lyricsCentered));btn.textContent=state.lyricsCentered?'◎ 置中':'≋ 自由';btn.title=state.lyricsCentered?'播放時自動將當前字幕置中':'目前為自由滾動，不會自動拉回正中央';}
function setLyricsCentered(value,persist=true){state.lyricsCentered=!!value;updateLyricsCenterButton();if(persist){localStorage.setItem('pinetree-lyrics-centered-v372',state.lyricsCentered?'1':'0');markSettingsChanged();}state.userScrollUntil=0;syncLyricsViewportPadding();requestAnimationFrame(()=>updateLyrics(true));}
function setLyricsMax(value, persist=true){
  state.lyricsMax=!!value;
  document.body.classList.toggle('lyrics-maximized',state.lyricsMax);
  const btn=$('toggleLyricsMax');
  btn.textContent=state.lyricsMax?'⇲ 返回':'⛶ 最大化';
  btn.setAttribute('aria-pressed',String(state.lyricsMax));
  btn.title=state.lyricsMax?'退出字幕最大化':'字幕最大化';
  if(persist){localStorage.setItem('lyra-lyrics-max',state.lyricsMax?'1':'0');markSettingsChanged();}
  requestAnimationFrame(()=>{syncLyricsViewportPadding();updateLyrics(true);});
}
async function refreshLibrary(preferred){const [books,tracks,progress]=await Promise.all([getStore('books'),getStore('tracks'),getStore('progress')]);state.books=books.sort((a,b)=>COLLATOR.compare(a.title||a.id,b.title||b.id));state.tracks=tracks;state.progresses=new Map(progress.map(x=>[x.id,x]));state.selectedEpisodeIds=new Set([...state.selectedEpisodeIds].filter(id=>tracks.some(t=>t.id===id)));const want=preferred!==undefined?preferred:(state.selectedBook||localStorage.getItem('lyra-selected-book'));state.selectedBook=state.books.some(b=>b.id===want)?want:(state.books[0]?.id||null);if(state.selectedBook)localStorage.setItem('lyra-selected-book',state.selectedBook);else localStorage.removeItem('lyra-selected-book');if(state.current&&!state.tracks.some(t=>t.id===state.current.id))clearCurrent('请选择章节开始播放');drawBookGrid();drawChapterList();updateBookControls();updateStoryArt();updateBookBrand();}
function drawBookGrid(){const grid=$('bookGrid');grid.replaceChildren();$('bookCount').textContent=`${state.books.length} 本`;$('totalChapters').textContent=`${state.tracks.length} 章`;if(!state.books.length){const el=document.createElement('div');el.className='book-grid-empty';el.textContent='书架还是空的 ☁️\n先创建第一本小说，再导入章节';el.style.whiteSpace='pre-line';grid.append(el);return;}for(const b of state.books){const tile=document.createElement('button');tile.type='button';tile.className='book-tile'+(state.selectedBook===b.id?' active':'');tile.setAttribute('aria-label',`打开小说 ${bookTitle(b.id)}`);tile.setAttribute('aria-pressed',String(state.selectedBook===b.id));const art=document.createElement('div');art.className='cover-thumb';const url=coverUrl(b);if(url){const img=document.createElement('img');img.src=url;img.alt='';art.append(img);}else art.textContent='📖';const title=document.createElement('span');title.className='tile-name';title.textContent=bookTitle(b.id);const count=document.createElement('span');count.className='tile-count';count.textContent=`${state.tracks.filter(t=>t.book===b.id).length} 章`;tile.append(art,title,count);tile.addEventListener('click',()=>selectBook(b.id));grid.append(tile);}}
function updateBookSwitcher(){
  const sel=$('bookSelect'); const existing=sel.value;
  sel.replaceChildren();
  if(!state.books.length){const opt=new Option('请先添加小说','');sel.add(opt);sel.disabled=true;}
  else{
    sel.disabled=false;
    for(const b of state.books)sel.add(new Option(bookTitle(b.id),b.id));
    sel.value=state.selectedBook||existing||state.books[0].id;
  }
  const avatar=$('activeBookThumb');avatar.replaceChildren();
  const book=getBook(state.selectedBook),url=coverUrl(book);
  if(url){const image=document.createElement('img');image.src=url;image.alt='';avatar.append(image);}
  else avatar.textContent=(book?bookTitle(book.id).slice(0,1):'书');
}
function updateBookControls(){
  const has=!!state.selectedBook;
  $('activeBookName').textContent=has?bookTitle(state.selectedBook):'请先创建一本小说';
  for(const id of ['importBtn','folderBtn','coverBtn','deleteBookBtn','renameBookBtn'])$(id).disabled=!has;
  updateBookSwitcher();
}
async function selectBook(book){
  if(!getBook(book))return;
  const changed=state.selectedBook!==book;
  if(changed){state.selectedEpisodeIds.clear();state.episodeSelectionMode=false;updateEpisodeSelectionUI();}
  if(changed&&state.current?.book!==book){await saveProgress();}
  state.selectedBook=book;
  localStorage.setItem('lyra-selected-book',book);
  state.chapterQuery='';$('chapterSearch').value='';
  drawBookGrid();drawChapterList();updateBookControls();updateStoryArt();updateBookBrand();
  if(changed&&state.current?.book!==book){
    const candidates=sortedBookTracks(book);
    const id=localStorage.getItem('lyra-last-book-track:'+book);
    const previous=candidates.find(t=>t.id===id) || candidates.slice().sort((a,b)=>(state.progresses.get(b.id)?.updatedAt||0)-(state.progresses.get(a.id)?.updatedAt||0))[0];
    if(previous)await loadTrack(previous,{autoplay:false});
    else clearCurrent('请选择章节开始播放');
  }
}
function episodeVisibleTracks(){
  const all=state.selectedBook?sortedBookTracks(state.selectedBook):[];
  const q=state.chapterQuery.toLocaleLowerCase().trim();
  return q?all.filter((t,i)=>t.name.toLocaleLowerCase().includes(q)||String(i+1).includes(q)):all;
}
function updateEpisodeSelectionUI(){
  const toggle=$('episodeSelectMode'),actions=$('episodeSelectActions'),hint=$('episodeSelectHint'),deleteButton=$('episodeDeleteSelected');
  if(!toggle||!actions)return;
  const count=state.selectedEpisodeIds.size,active=state.episodeSelectionMode;
  toggle.setAttribute('aria-pressed',String(active));
  toggle.textContent=active?'✕ 完成選取':'☑ 選取章節';
  toggle.disabled=state.episodeDeleteRunning;
  actions.hidden=!active;
  if(hint)hint.textContent=active?`已選取 ${count} 章 · 點擊章節勾選（不會播放）`:'可刪除個別或多個章節';
  if(deleteButton){deleteButton.textContent=`刪除所選 (${count})`;deleteButton.disabled=!count||state.episodeDeleteRunning;}
  $('episodeSelectVisible').disabled=state.episodeDeleteRunning||!episodeVisibleTracks().length;
  $('episodeClearSelection').disabled=state.episodeDeleteRunning||!count;
  if(state.episodeDeleteRunning)toggle.textContent='正在刪除…';
}
function setEpisodeSelectionMode(value){
  if(state.episodeDeleteRunning)return;
  state.episodeSelectionMode=!!value;
  if(!value)state.selectedEpisodeIds.clear();
  drawChapterList();
}
function toggleEpisodeSelection(id){
  if(state.episodeDeleteRunning)return;
  if(state.selectedEpisodeIds.has(id))state.selectedEpisodeIds.delete(id);
  else state.selectedEpisodeIds.add(id);
  drawChapterList();
}
function selectVisibleEpisodes(){
  if(!state.episodeSelectionMode||state.episodeDeleteRunning)return;
  for(const t of episodeVisibleTracks())state.selectedEpisodeIds.add(t.id);
  drawChapterList();
}
function clearEpisodeSelection(){
  if(state.episodeDeleteRunning)return;
  state.selectedEpisodeIds.clear();drawChapterList();
}
async function deleteEpisodes(ids,{confirmed=false}={}){
  if(state.episodeDeleteRunning||state.importJob?.running){toast('正在匯入或刪除，請完成後再操作');return false;}
  const chosen=Array.from(new Set(ids)).map(id=>state.tracks.find(t=>t.id===id)).filter(t=>t&&t.book===state.selectedBook);
  if(!chosen.length){toast('請先選取要刪除的章節');return false;}
  const total=chosen.length;
  if(!confirmed){
    const sample=chosen.slice(0,4).map(t=>'・'+t.name).join('\n');
    const extra=total>4?`\n…以及其他 ${total-4} 章`:'';
    if(!confirm(`確定刪除《${bookTitle(state.selectedBook)}》選取的 ${total} 章？\n\n${sample}${extra}\n\n這會永久刪除 PineTree 本機的 MP3／LRC 副本、章節目錄、播放進度及這些章節的書籤。\n\n不會刪除 iCloud Drive／「檔案」App 原始檔案；將來可重新匯入。`))return false;
  }
  const book=state.selectedBook;
  state.episodeDeleteRunning=true;updateEpisodeSelectionUI();
  const label=$('episodeDeleteProgress');label.hidden=false;
  let removed=0;
  const idsToDelete=new Set(chosen.map(t=>t.id));
  // Stop the current track only when it belongs to the removal set.
  const deletingCurrent=!!(state.current&&idsToDelete.has(state.current.id));
  if(deletingCurrent){state.suppressProgressWrites=true;clearCurrent('此章節已從本機刪除');}
  const removedIds=new Set();
  try{
    for(let i=0;i<chosen.length;i+=25){
      const batch=chosen.slice(i,i+25).map(t=>t.id);
      label.textContent=`正在刪除本機章節：${removed} / ${total}，請勿關閉 App…`;
      await nextUIFrame();
      await deleteTrackBatch(batch);
      for(const id of batch)removedIds.add(id);
      removed+=batch.length;
      label.textContent=`已刪除 ${removed} / ${total} 章`;
      await nextUIFrame();
    }
    toast(`已刪除 ${removed} 章；iCloud Drive 原始檔案保持不變`,5500);
    return true;
  }catch(error){
    console.error('批次刪除失敗',error);
    toast(`刪除中斷：已完成 ${removed}/${total} 章，其他章節仍保留。${error?.message||''}`,6500);
    return false;
  }finally{
    // Only remove bookmarks of successfully deleted tracks; keep bookmarks on failure.
    if(removedIds.size){
      const bookmarks=readBookmarks().filter(b=>!removedIds.has(b.trackId));
      writeBookmarks(bookmarks);
      for(const id of removedIds){
        if(localStorage.getItem('lyra-last-id')===id)localStorage.removeItem('lyra-last-id');
        if(localStorage.getItem('lyra-last-book-track:'+book)===id)localStorage.removeItem('lyra-last-book-track:'+book);
      }
    }
    state.suppressProgressWrites=false;
    state.episodeDeleteRunning=false;
    state.selectedEpisodeIds.clear();
    state.episodeSelectionMode=false;
    await refreshLibrary(book);
    label.hidden=true;
    showStorageEstimate();
  }
}
async function deleteSelectedEpisodes(){await deleteEpisodes([...state.selectedEpisodeIds]);}
function drawChapterList(){
  const list=$('chapterList');
  const keepScroll=state.listDrawBook===state.selectedBook&&state.listDrawQuery===state.chapterQuery;
  const previousScroll=keepScroll?list.scrollTop:0;
  list.replaceChildren();
  state.listDrawBook=state.selectedBook;state.listDrawQuery=state.chapterQuery;
  const all=state.selectedBook?sortedBookTracks(state.selectedBook):[];
  const query=state.chapterQuery.toLocaleLowerCase().trim();
  const tracks=query?all.filter((t,i)=>t.name.toLocaleLowerCase().includes(query)||String(i+1).includes(query)):all;
  updateEpisodeSelectionUI();
  $('libraryInfo').textContent=`${tracks.length}${query?` / ${all.length}`:''} 章`;
  $('chapterCounter').textContent=state.selectedBook?`显示 ${tracks.length} / ${all.length} 章 · 已存储在本机`:'请选择一本小说';
  if(!tracks.length){
    const empty=document.createElement('div');empty.className='empty-library';
    empty.textContent=query?'没有找到匹配的章节':state.selectedBook?'还没有章节。点击「导入 MP3 / LRC」开始添加。':'点击右上角「书库管理」创建第一本小说';
    list.append(empty);return;
  }
  const indices=new Map(all.map((t,i)=>[t.id,i+1]));
  const fragment=document.createDocumentFragment();
  tracks.forEach(t=>{
    const chosen=state.selectedEpisodeIds.has(t.id);
    const btn=document.createElement('button');btn.type='button';btn.className='chapter-item'+(state.current?.id===t.id?' active':'')+(state.episodeSelectionMode?' selecting':'')+(chosen?' selected':'');btn.title=t.name;btn.dataset.trackId=t.id;
    if(state.episodeSelectionMode)btn.setAttribute('aria-pressed',String(chosen));
    const num=document.createElement('span');num.className='chapter-no';num.textContent=String(indices.get(t.id)).padStart(3,'0');
    const info=document.createElement('span');info.className='chapter-info';
    const name=document.createElement('span');name.className='chapter-title';name.textContent=chapterDisplayName(t.name);
    const sub=document.createElement('span');sub.className='chapter-subtitle';
    const p=state.progresses.get(t.id);
    sub.textContent=(t.hasLrc?'LRC 同步字幕':'僅 MP3')+(t.audioPresent===false?' · MP3 已清理，需重新匯入':'')+(p?.ended?' · 已聽完':p?.position>1?` · 續聽 ${formatTime(p.position)}`:'');
    const sym=document.createElement('span');sym.className='note-icon';sym.textContent=t.audioPresent===false?'⇩':state.current?.id===t.id?'▶':t.hasLrc?'♫':'♪';
    info.append(name,sub);
    if(state.episodeSelectionMode){const marker=document.createElement('span');marker.className='episode-checkbox';marker.setAttribute('aria-hidden','true');marker.textContent=chosen?'✓':'';btn.append(marker);}
    btn.append(num,info,sym);
    btn.addEventListener('click',()=>state.episodeSelectionMode?toggleEpisodeSelection(t.id):loadTrack(t,{autoplay:true}));fragment.append(btn);
  });
  list.append(fragment);
  list.scrollTop=previousScroll;
}
function scrollActiveChapter(){
  const list=$('chapterList');
  const node=Array.from(list.children).find(el=>el.dataset.trackId===state.current?.id);
  if(!node||list.clientHeight<1)return;
  const viewport=list.getBoundingClientRect(), target=node.getBoundingClientRect();
  const desired=list.scrollTop+(target.top+target.height/2)-(viewport.top+viewport.height/2);
  list.scrollTop=Math.max(0,Math.min(list.scrollHeight-list.clientHeight,desired));
}
function jumpToCurrent(){
  if(!state.current){toast('请先选择一个章节');return;}
  if(state.current.book!==state.selectedBook){selectBook(state.current.book);return;}
  if(state.chapterQuery){state.chapterQuery='';$('chapterSearch').value='';drawChapterList();}
  const node=Array.from($('chapterList').children).find(el=>el.dataset.trackId===state.current.id);
  if(node)node.scrollIntoView({behavior:'smooth',block:'center'});
}
function setMobileTab(tab,persist=false){
  state.mobileTab=tab==='chapters'?'chapters':'player';
  document.body.classList.toggle('mobile-view-player',state.mobileTab==='player');
  document.body.classList.toggle('mobile-view-chapters',state.mobileTab==='chapters');
  $('mobileTabPlayer').classList.toggle('active',state.mobileTab==='player');
  $('mobileTabChapters').classList.toggle('active',state.mobileTab==='chapters');
  $('mobileTabPlayer').setAttribute('aria-pressed',String(state.mobileTab==='player'));
  $('mobileTabChapters').setAttribute('aria-pressed',String(state.mobileTab==='chapters'));
  if(state.mobileTab==='chapters')requestAnimationFrame(scrollActiveChapter);
  else requestAnimationFrame(()=>{syncLyricsViewportPadding();updateLyrics(true);});
  if(persist)localStorage.setItem('lyra-mobile-tab',state.mobileTab);
}

async function createBook(event){event.preventDefault();const name=normalizeBook($('newBookName').value);if(!name){toast('请输入小说名称');return;}const similar=state.books.find(b=>COLLATOR.compare(b.id,name)===0||COLLATOR.compare(b.title||b.id,name)===0);if(similar){selectBook(similar.id);toast('这本小说已经存在，已为你打开');return;}try{await putStore('books',{id:name,title:name,createdAt:Date.now(),updatedAt:Date.now(),coverBlob:null});const deleted=loadDeletedBooks();delete deleted[name];writeDeletedBooks(deleted);$('newBookName').value='';await refreshLibrary(name);toast(`已创建《${name}》；关闭书库管理后即可导入章节`);}catch(error){console.error(error);toast('创建失败：可能是浏览器存储被限制');}}
async function renameBook(){
  const id=state.selectedBook;
  if(!id)return;
  const existing=getBook(id);
  if(!existing)return;
  const oldName=bookTitle(id);
  const entered=prompt('修改此小说在 Lyra 书架中的名称（不会改动「文件」App 原文件夹）：',oldName);
  if(entered===null)return;
  const title=normalizeBook(entered);
  if(!title){toast('书名不能留空');return;}
  const duplicate=state.books.some(b=>b.id!==id&&COLLATOR.compare(b.title||b.id,title)===0);
  if(duplicate){toast('另一部小说已使用这个名称');return;}
  try{
    await putStore('books',{...existing,title,updatedAt:Date.now()});
    await refreshLibrary(id);
    if(state.current?.book===id){$('currentBook').textContent=title;updateMediaSession();}
    toast(`已更名为《${title}》，章节与播放记录保留`);
  }catch(error){console.error(error);toast('修改书名失败，请重试');}
}
// The iOS Files picker may download iCloud objects BEFORE its 'change' event;
// web pages cannot observe that system transfer. Our own import starts afterwards.
function setImportPickerHint(waiting){
  const hint=$('importHelp');
  hint.textContent=waiting?'正在等待「檔案」App 選取檔案；若檔案存於 iCloud，iOS 可能正在下載原件，這個階段無法顯示百分比。':'📱 iPhone：可同時選 MP3 / LRC；大量章節建議每次匯入 20–50 章。';
}
function reportImportStatus(job,step,detail='',processed){
  if(!job)return;
  if(processed!==undefined)job.done=processed;
  const pct=job.total?Math.round(job.done/job.total*100):0;
  $('importPhase').textContent=step;
  $('importDetail').textContent=detail;
  $('importCount').textContent=job.total?`${job.done} / ${job.total} 章（${pct}%）`:'正在分析檔案…';
  $('importBar').value=job.total?pct:0;
  $('importCounters').textContent=`新增 ${job.added} · 更新 ${job.updated} · 略過 ${job.skipped} · 失敗 ${job.failed} · 缺 LRC ${job.missingLrc} · 重複 ${job.duplicates}`;
  $('importElapsed').textContent=`已耗時 ${Math.floor((Date.now()-job.startedAt)/1000)} 秒`;
  if(job.total){localStorage.setItem(IMPORT_CHECKPOINT_KEY,JSON.stringify({book:job.book,done:job.done,total:job.total,startedAt:job.startedAt}));}
}
function closeImportUI(){if(state.importJob?.running)return;closeDialog('importDialog');}
function cancelImport(){const job=state.importJob;if(!job||!job.running)return;job.cancelled=true;$('cancelImport').disabled=true;reportImportStatus(job,'正在安全停止…','完成當前檔案寫入後停止，已成功匯入的章節不會消失。');}
function importReportText(job){
  return [
    `PineTree v3.7.3 匯入報告 · ${new Date().toLocaleString()}`,
    `小說：${bookTitle(job.book)} · 狀態：${job.cancelled?'使用者取消':'完成'}`,
    `檔案：${job.fileCount} · 章節組：${job.total}`,
    `新增：${job.added}；更新：${job.updated}；已存在略過：${job.skipped}；缺少 MP3：${job.orphans}；缺少 LRC：${job.missingLrc}；重複：${job.duplicates}；跳過 Read：${job.excludedRead}；失敗：${job.failed}`,
    '',...job.report
  ].join('\n');
}
function downloadImportReport(){const job=state.importJob;if(!job)return;const url=URL.createObjectURL(new Blob([importReportText(job)],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='PineTree_匯入報告.txt';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
async function showStorageEstimate(){
  const el=$('importStorage');
  try{const usage=await navigator.storage?.estimate?.();
    el.textContent=usage?.quota?`瀏覽器儲存：已用約 ${displayBytes(usage.usage||0)} / 系統估計配額 ${displayBytes(usage.quota)}（並非保證可用容量）`:'iPhone 儲存容量由系統管理，請留意剩餘空間';
  }catch{el.textContent='無法查詢瀏覽器容量；原始 iCloud 檔案不會刪除';}
}
async function importFiles(fileList){
  setImportPickerHint(false);
  if(state.importJob?.running){toast('另一批檔案正在匯入中');return;}
  const book=state.selectedBook;
  if(!book){toast('請先選擇一本小說');return;}
  const job={book,running:true,cancelled:false,total:0,done:0,added:0,updated:0,skipped:0,failed:0,orphans:0,missingLrc:0,duplicates:0,excludedRead:0,report:[],startedAt:Date.now(),fileCount:fileList?.length||0};
  state.importJob=job;
  $('cancelImport').disabled=false;$('closeImport').disabled=true;$('downloadImportReport').disabled=true;
  for(const id of ['importBtn','folderBtn','deleteBookBtn'])$(id).disabled=true;
  openDialog('importDialog');
  reportImportStatus(job,'正在讀取檔案清單…','此階段不會修改任何原始 iCloud 檔案。');
  await nextUIFrame();
  try{
    const files=Array.from(fileList||[]);
    const groups=new Map();let valid=0;
    for(let i=0;i<files.length;i++){
      if(job.cancelled)break;
      const file=files[i];
      const relative=file.webkitRelativePath||'';
      if(/(?:^|\/)read(?:\/|$)/i.test(relative)){job.excludedRead++;continue;}
      if(!/\.(mp3|lrc)$/i.test(file.name))continue;
      valid++;
      const id=trackId(book,file.name);
      let group=groups.get(id);
      if(!group){group={id,book,name:readableStem(file.name),mp3:null,lrc:null};groups.set(id,group);}
      const kind=/\.mp3$/i.test(file.name)?'mp3':'lrc';
      if(group[kind]){job.duplicates++;job.report.push(`重複檔名：${file.name}；優先採用最近修改的副本`);if((group[kind].lastModified||0)<=(file.lastModified||0))group[kind]=file;}
      else group[kind]=file;
      if(i%125===0){reportImportStatus(job,'正在掃描檔名…',`已檢查 ${i+1} / ${files.length} 個檔案`);await nextUIFrame();}
    }
    job.total=groups.size;
    if(!valid){reportImportStatus(job,'沒有找到 MP3 / LRC','請從「檔案」App 選擇 .mp3 與 .lrc 檔案，或用 Windows 選整個 output_mp3。');return;}
    const bytes=[...groups.values()].reduce((sum,g)=>sum+(g.mp3?.size||0),0);
    if(!job.cancelled && (groups.size>120||bytes>300*1024*1024)){
      const go=confirm(`你選擇了 ${groups.size} 組章節，MP3 合計約 ${displayBytes(bytes)}。\n\n在 iPhone 匯入數百章可能耗時、耗電且佔用大量本機儲存。\n建議先選 20–50 章測試。\n\n要繼續本次大量匯入嗎？`);
      if(!go){job.cancelled=true;job.report.push('使用者取消大量匯入；尚未寫入本批音訊。');}
    }
    // Individual transactions keep completed chapters durable if iOS suspends the PWA.
    const force=$('forceImportReplace').checked;
    let processed=0;
    for(const group of groups.values()){
      if(job.cancelled)break;
      try{
        const old=await getStore('tracks',group.id);
        if(!old && !group.mp3){job.orphans++;job.skipped++;job.report.push(`未配對 MP3：${group.name}.lrc`);processed++;}
        else{
          const freshLrc=group.lrc?await group.lrc.text():null;
          const lyricsChanged=freshLrc!==null && freshLrc!==(old?.lrcText||'');
          const signature=group.mp3?`${group.mp3.size}:${group.mp3.lastModified||0}`:null;
          // Legacy imports may not have a timestamp; same-size audio is assumed unchanged unless force is chosen.
          const signatureMatches=!!old&&!!group.mp3&&old.bytes===group.mp3.size&&
            (!old.mp3Signature || old.mp3Signature===signature);
          // A chapter metadata record may exist without its MP3. Check before skipping,
          // otherwise a failed historical import could never repair that chapter.
          const hasStoredAudio=signatureMatches?await hasAudioKey(group.id):false;
          const sameAudio=signatureMatches&&hasStoredAudio;
          if(group.mp3&&!group.lrc&&!old?.hasLrc){job.missingLrc++;job.report.push(`缺少 LRC：${group.name}.mp3`);}
          let writeAudio=!!group.mp3&&(!old||force||!sameAudio);
          let updateMeta=!old||writeAudio||lyricsChanged;
          if(!updateMeta){job.skipped++;processed++;}
          else{
            const meta={...old,id:group.id,book:group.book,name:group.name,
              hasLrc:freshLrc!==null?!!freshLrc:!!old?.hasLrc,
              lrcText:freshLrc!==null?freshLrc:(old?.lrcText||''),
              bytes:writeAudio?group.mp3.size:(old?.bytes||0),
              mp3Signature:writeAudio?signature:(old?.mp3Signature||null),
              audioPresent:writeAudio?true:(old?.audioPresent!==false),
              updatedAt:Date.now()};
            if(writeAudio)await putTrackAndAudio(meta,group.mp3);
            else await putStore('tracks',meta);
            if(old)job.updated++;else job.added++;
            if(state.current?.id===group.id){state.current=meta;displayLyrics(meta.lrcText);state.lockScreenMetaKey='';updateMediaSession(true);}
            processed++;
          }
        }
      }catch(error){job.failed++;processed++;const desc=`${group.name}：${error?.message||error}`;job.report.push(desc);console.warn('匯入失敗',desc);
        if(error?.name==='QuotaExceededError'||/quota|storage|空間不足/i.test(error?.message||'')){
          job.cancelled=true;job.report.push('裝置儲存空間可能不足，已停止後續寫入；先清理空間後再繼續。');
        }
      }
      if(processed===1||processed%3===0||processed===groups.size){
        reportImportStatus(job,job.cancelled?'準備停止…':'正在儲存 MP3 / LRC…',`${group.name} · 已完成 ${processed} 組`,processed);
        await nextUIFrame();
      }
    }
    reportImportStatus(job,job.cancelled?'匯入已停止':'匯入已完成',
      job.cancelled?'已成功匯入的章節保留；重新選同一批可略過已有章節。':`成功處理 ${processed} 組；未配對 LRC ${job.orphans}，Read 跳過 ${job.excludedRead}；可下載報告。`,processed);
  }catch(error){job.failed++;job.report.push('整批中斷：'+(error?.stack||error));reportImportStatus(job,'匯入發生錯誤',error?.message||String(error));console.error(error);}
  finally{
    job.running=false;
    $('cancelImport').disabled=true;$('closeImport').disabled=false;$('downloadImportReport').disabled=false;
    for(const id of ['importBtn','folderBtn','deleteBookBtn'])$(id).disabled=false;
    localStorage.removeItem(IMPORT_CHECKPOINT_KEY);
    $('filePicker').value='';$('folderPicker').value='';
    try{await refreshLibrary(book);}catch(err){console.warn('刷新書庫失敗',err);}
    showStorageEstimate();
    toast(`匯入${job.cancelled?'已停止':'完成'}：新增 ${job.added}，更新 ${job.updated}，略過 ${job.skipped}，失敗 ${job.failed}`,6500);
  }
}
async function imageToBlob(file){if(file.size>20*1024*1024)throw new Error('图片超过 20MB，请压缩后重试');if(!file.type.startsWith('image/')&&!/\.(png|jpe?g|webp|heic|heif)$/i.test(file.name))throw new Error('请选择 JPG、PNG 或其他有效图片');const url=URL.createObjectURL(file);try{const img=new Image();await new Promise((res,rej)=>{img.onload=res;img.onerror=()=>rej(new Error('无法读取封面图片，建议转换成 JPG'));img.src=url;});const ratio=Math.min(1,960/img.naturalWidth,1280/img.naturalHeight);const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*ratio));canvas.height=Math.max(1,Math.round(img.naturalHeight*ratio));const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.86));if(!blob)throw new Error('无法转换图片');return blob;}finally{URL.revokeObjectURL(url);}}
async function setCover(file){const book=state.selectedBook;if(!book||!file)return;try{const blob=await imageToBlob(file);const previous=getBook(book);await putStore('books',{...previous,coverBlob:blob,updatedAt:Date.now()});revokeCover(book);await refreshLibrary(book);if(state.current?.book===book)updateMediaSession();toast('封面已保存！关闭再打开也不会消失');}catch(error){console.error(error);toast(error.message||'封面导入失败');}finally{$('coverPicker').value='';}}
async function deleteBook(){const book=state.selectedBook;if(!book)return;const displayName=bookTitle(book);const count=sortedBookTracks(book).length;const message=`确定从 Lyra 删除《${bookTitle(book)}》吗？\n\n将删除这本书的封面、${count} 章 MP3/LRC 副本以及全部播放记录。\n\n⚠️ 此操作无法撤销，但不会删除 iPhone「文件」App 中的原始文件。`;if(!confirm(message))return;try{if(state.current?.book===book)clearCurrent('请选择章节开始播放');await deleteBookData(book);const tombstones=loadDeletedBooks();tombstones[book]=Date.now();writeDeletedBooks(tombstones);revokeCover(book);localStorage.removeItem('lyra-last-book-track:'+book);await refreshLibrary(null);
    if(!state.current){
      const remaining=state.selectedBook?sortedBookTracks(state.selectedBook):[];
      const lastId=localStorage.getItem('lyra-last-book-track:'+state.selectedBook);
      const next=remaining.find(t=>t.id===lastId) || remaining[0];
      if(next)await loadTrack(next,{autoplay:false});else clearCurrent('请选择章节开始播放');
    }
    toast(`已删除《${displayName}》，其他小说保持不变`);}catch(error){console.error(error);toast('删除失败，请重试');}}
function parseLRC(source){const entries=[];let offset=0;for(const raw of(source||'').replace(/^\uFEFF/,'').split(/\r?\n/)){const shift=raw.match(/^\s*\[offset\s*:\s*([+-]?\d+)\s*\]/i);if(shift){offset=Number(shift[1])/1000;continue;}const stamps=[...raw.matchAll(/\[(?:(\d+):)?(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];if(!stamps.length)continue;const words=raw.replace(/\[(?:(\d+):)?(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g,'').trim();if(!words)continue;for(const x of stamps){const hours=Number(x[1]||0),mins=Number(x[2]),secs=Number(x[3]);if(secs>=60||(x[1]&&mins>=60))continue;const fraction=Number(`0.${x[4]||'0'}`);entries.push({time:Math.max(0,hours*3600+mins*60+secs+fraction+offset),text:words});}}entries.sort((a,b)=>a.time-b.time);return entries;}
function displayPlaceholder(title,note){const el=$('lyricsWindow');el.replaceChildren();const box=document.createElement('div');box.className='lyrics-placeholder';const symbol=document.createElement('span');symbol.textContent='“';const p=document.createElement('p');p.textContent=title;const small=document.createElement('small');small.textContent=note;box.append(symbol,p,small);el.append(box);}
// Use the true scroll viewport rather than subtracting offsetTop values from
// different offsetParents.  That mixed-coordinate calculation in v3.7.2 worked
// in fullscreen but placed highlighted lines near the bottom in normal mode.
function syncLyricsViewportPadding(){
  const win=$('lyricsWindow');
  if(!win)return;
  const lines=win.querySelectorAll('.lyric-line');
  // Enough padding is crucial: without it the first/last line cannot reach
  // the center, because scrollTop is clamped by the browser.
  let before=24,after=24;
  if(state.lyricsCentered&&lines.length&&win.clientHeight>0){
    const viewport=win.clientHeight;
    before=Math.max(18,Math.ceil((viewport-lines[0].getBoundingClientRect().height)/2));
    after=Math.max(18,Math.ceil((viewport-lines[lines.length-1].getBoundingClientRect().height)/2));
  }
  win.style.setProperty('--lyrics-pad-start',before+'px');
  win.style.setProperty('--lyrics-pad-end',after+'px');
}
function centerActiveLyric(el,force=false){
  const win=$('lyricsWindow');
  if(!el||!win||win.clientHeight<1)return;
  // Coordinates are from the same viewport, so this works in both normal
  // player mode and maximized mode, with or without headers above it.
  const viewportRect=win.getBoundingClientRect();
  const lineRect=el.getBoundingClientRect();
  const currentCenter=lineRect.top+lineRect.height/2;
  const viewportCenter=viewportRect.top+viewportRect.height/2;
  const desired=win.scrollTop+(currentCenter-viewportCenter);
  const maxTop=Math.max(0,win.scrollHeight-win.clientHeight);
  const top=Math.max(0,Math.min(maxTop,desired));
  if(Math.abs(top-win.scrollTop)<1)return;
  if(force){
    // A forced center must be instantaneous even if CSS sets scroll-behavior:smooth.
    // This also prevents a visible drift after resizing/maximizing lyrics.
    const former=win.style.scrollBehavior;
    win.style.scrollBehavior='auto';win.scrollTo({top,behavior:'instant'});win.style.scrollBehavior=former;
  }else win.scrollTo({top,behavior:'smooth'});
}
function displayLyrics(lrc){
  state.lines=parseLRC(lrc);
  state.lineIndex=-1;
  const container=$('lyricsWindow');
  container.replaceChildren();
  if(!state.lines.length){
    $('lrcState').textContent='· 无时间轴';
    displayPlaceholder('还没有同步文字','导入同名 .lrc 文件即可同步显示');
    syncLyricsViewportPadding();
    return;
  }
  $('lrcState').textContent=`· ${state.lines.length} 行`;
  const frag=document.createDocumentFragment();
  state.lines.forEach((line,i)=>{
    const element=document.createElement('div');
    element.className='lyric-line';
    element.dataset.index=i;
    element.textContent=line.text;
    element.title=`${formatTime(line.time)} · 点击跳转`;
    frag.append(element);
  });
  container.append(frag);
  syncLyricsViewportPadding();
  container.scrollTop=0;
  updateLyrics(true);
}
function lyricIndex(time){
  let low=0,high=state.lines.length-1,result=-1;
  while(low<=high){
    const mid=(low+high)>>1;
    if(state.lines[mid].time<=time){result=mid;low=mid+1;}
    else high=mid-1;
  }
  return result;
}
function updateLyrics(force=false){
  if(!state.lines.length)return;
  const idx=lyricIndex((Number(audio.currentTime)||0)-state.delay);
  if(idx===state.lineIndex&&!force)return;
  const win=$('lyricsWindow');
  const lines=win.querySelectorAll('.lyric-line');
  if(state.lineIndex>=0&&lines[state.lineIndex])lines[state.lineIndex].classList.remove('active');
  state.lineIndex=idx;
  if(idx>=0&&lines[idx]){
    const el=lines[idx];
    el.classList.add('active');
    // "Free scroll" means no automatic scrolling; auto-follow only occurs
    // in centered mode, and temporarily pauses while the user reads manually.
    if(state.lyricsCentered&&Date.now()>=state.userScrollUntil){
      centerActiveLyric(el,force);
    }
  }
}
async function saveProgress(ended=false){if(!state.db||!state.current||state.suppressProgressWrites||!state.fileUrl||audio.readyState<1||!Number.isFinite(audio.duration)||audio.duration<=0)return;const id=state.current.id;const done=ended||audio.ended;const record={id,position:done?(Number(audio.duration)||0):(Number(audio.currentTime)||0),ended:done,updatedAt:Date.now()};state.progresses.set(id,record);try{await putStore('progress',record);}catch(error){console.warn('进度保存失败：',error);}}
function releaseAudio(){if(!audio.paused)state.skipNextPauseAutoSync=true;audio.pause();audio.removeAttribute('src');audio.load();if(state.fileUrl)URL.revokeObjectURL(state.fileUrl);state.fileUrl=null;}
function updateStoryArt(){const cover=$('currentCover'),fallback=$('storyArtFallback');const book=getBook(state.current?.book||state.selectedBook);const title=book?bookTitle(book.id):'选择一本小说';$('storyBookName').textContent=title;$('storyBookName').title=title;$('storyBookName').classList.toggle('long-title',title.length>15);const url=coverUrl(book);if(url){cover.src=url;cover.hidden=false;fallback.hidden=true;}else{cover.hidden=true;cover.removeAttribute('src');fallback.hidden=false;}}
// Experimental lock-screen subtitles use OS media metadata, not native system karaoke lyrics.
// iOS may throttle/suspend background JavaScript, timeupdate and metadata rendering.
// No background polling: react only to actual audio events, and throttle metadata changes.
const LOCKSCREEN_MODE_KEY='pinetree-lockscreen-mode-v37';
// Only update when the LRC sentence actually changes; speed caps bursts of
// exceptionally short lines. iOS controls final lock-screen paint latency.
const LOCKSCREEN_SPEED_KEY='pinetree-lockscreen-speed-v371';
const LOCKSCREEN_INTERVALS=Object.freeze({fast:650,balanced:1500,quiet:3500});
function safeLyricTitle(text){
  // Prevent very long/wrapped metadata and control characters in the lock screen.
  return Array.from(String(text||'').replace(/[\u0000-\u001F\u007F]+/g,' ').replace(/\s+/g,' ').trim()).slice(0,64).join('');
}
function lockScreenLineIndex(){
  if(!state.current||!state.lines.length)return -1;
  return lyricIndex((Number(audio.currentTime)||0)-state.delay);
}
function lockScreenInfo(){
  // v4.3.3 compatibility: the selected LRC mode determines the system metadata.
  // Never silently replace an LRC sentence with a fixed chapter just because
  // the PWA was backgrounded or headphones are connected.
  const chapter=chapterDisplayName(state.current?.name||'未選擇章節');
  const book=state.current?bookTitle(state.current.book):'PineTree 有聲書';
  const index=state.lockScreenMode==='lyrics'?lockScreenLineIndex():-1;
  const lyric=index>=0?safeLyricTitle(state.lines[index]?.text):'';
  const active=state.lockScreenMode==='lyrics'&&!!lyric;
  return {title:active?lyric:chapter,artist:active?chapter:'PineTree 有聲書',album:book,
    key:`${state.current?.id||''}|${state.lockScreenMode}|${active?index:'chapter'}|${active?lyric:''}`,active};
}
function refreshLockScreenControls(){
  const experimental=state.lockScreenMode==='lyrics';
  const info=lockScreenInfo();
  const status=$('lockScreenStatus');
  const preview=$('lockScreenPreviewTitle');
  const second=$('lockScreenPreviewArtist');
  const button=$('lockScreenOpen');
  if(button){button.textContent=experimental?'🔒 鎖屏字幕 · 實驗':'🔒 鎖屏資訊';button.title=experimental?'目前使用實驗性 LRC 鎖屏字幕；點此調整':'目前顯示標準章節資訊；點此調整';}
  if(preview)preview.textContent=info.title;
  if(second)second.textContent=info.artist+' · '+info.album;
  if(status)status.textContent=!('mediaSession' in navigator)||typeof MediaMetadata!=='function'
    ?'此瀏覽器沒有提供完整媒體資訊介面，會保留一般播放功能。'
    :experimental
      ?info.active?'目前有字幕可嘗試顯示；鎖屏後是否逐句更新取決於 iOS。':'目前章節沒有可用的時間軸字幕，會退回章節標題。'
      :'目前使用標準模式：顯示章節標題與 PineTree 名稱。';
  for(const input of document.querySelectorAll('input[name="lockScreenMode"]'))input.checked=input.value===state.lockScreenMode;
  for(const input of document.querySelectorAll('input[name="lockScreenSpeed"]'))input.checked=input.value===state.lockScreenSpeed;
}
function setLockScreenMode(mode,{persist=true}={}){
  if(mode!=='standard'&&mode!=='lyrics')return;
  state.lockScreenMode=mode;
  state.lockScreenMetaKey='';
  state.lockScreenLastAt=0;
  state.lockScreenMediaError=false;
  if(persist){localStorage.setItem(LOCKSCREEN_MODE_KEY,mode);markSettingsChanged();}
  refreshLockScreenControls();
  updateMediaSession(true);
}
function setLockScreenSpeed(speed,{persist=true}={}){
  if(!Object.prototype.hasOwnProperty.call(LOCKSCREEN_INTERVALS,speed))return;
  state.lockScreenSpeed=speed;
  if(persist){localStorage.setItem(LOCKSCREEN_SPEED_KEY,speed);markSettingsChanged();}
  refreshLockScreenControls();
  // Do not force re-draw the same line, but allow the next changed line promptly.
  state.lockScreenLastAt=0;
  updateMediaSession();
}
function updateMediaSession(force=false){
  if(!state.current||!('mediaSession' in navigator)||typeof MediaMetadata!=='function'||state.lockScreenMediaError)return;
  // A paused background session should not be churned, but if the browser
  // still emits timeupdate while audio plays, LRC is updated at v4.3.3 speed.
  if(document.hidden&&audio.paused&&!force)return;
  const info=lockScreenInfo();
  if(info.key===state.lockScreenMetaKey&&!force)return;
  const now=Date.now();
  // Restore v4.3.3: fast 650ms / balanced 1.5s / quiet 3.5s.
  // No additional 8-second background throttle.
  if(!force&&state.lockScreenMetaKey&&now-state.lockScreenLastAt<LOCKSCREEN_INTERVALS[state.lockScreenSpeed])return;
  const book=getBook(state.current.book),url=coverUrl(book);
  try{
    navigator.mediaSession.metadata=new MediaMetadata({
      title:info.title,artist:info.artist,album:info.album,
      artwork:url?[{src:url,type:'image/jpeg'}]:[{src:new URL('./icon-512.png?v=4394',document.baseURI).href,sizes:'512x512',type:'image/png'}]
    });
    state.lockScreenMetaKey=info.key;
    state.lockScreenLastText=info.title;
    state.lockScreenLastAt=now;
  }catch(error){
    if(info.active){
      try{
        navigator.mediaSession.metadata=new MediaMetadata({title:state.current.name,
          artist:'PineTree 有聲書',album:info.album,
          artwork:url?[{src:url,type:'image/jpeg'}]:[{src:new URL('./icon-512.png?v=4394',document.baseURI).href,sizes:'512x512',type:'image/png'}]});
        state.lockScreenMetaKey=info.key;
        state.lockScreenLastAt=now;
        return;
      }catch(_){}
    }
    state.lockScreenMediaError=true;
    console.warn('鎖屏媒體資訊更新失敗；不影響音訊播放',error);
  }
}

let lastMediaPositionUpdateAt=0;
function updateMediaPosition(force=false){
  if(!('mediaSession' in navigator)||!navigator.mediaSession.setPositionState)return;
  if(!Number.isFinite(audio.duration)||audio.duration<=0)return;
  const now=Date.now();
  if(!force && now-lastMediaPositionUpdateAt<(document.hidden?12000:4000))return;
  try{navigator.mediaSession.setPositionState({duration:audio.duration,playbackRate:audio.playbackRate,position:Math.max(0,Math.min(audio.duration,audio.currentTime))});lastMediaPositionUpdateAt=now;}catch(_){}
}
// iOS Safari/PWA: explicitly use a long-form media playback audio session.
// This can improve lock-screen media resume, but cannot revive a suspended WebKit process.
function requestPlaybackAudioSession(){
  try{if(navigator.audioSession && navigator.audioSession.type!=='playback')navigator.audioSession.type='playback';}
  catch(error){console.info('Audio Session API unavailable:',error?.message||error);}
}
function setPlayButtonVisual(playing){
  const button=$('playBtn');if(!button)return;
  button.dataset.playing=playing?'true':'false';
  document.body.dataset.playing=playing?'true':'false';
  button.setAttribute('aria-label',playing?'暫停':'播放');
  button.title=playing?'暫停':'播放';
}
function setThemeMotion(value,{persist=true}={}){
  state.themeMotion=!!value;
  document.body.dataset.themeMotion=state.themeMotion?'on':'off';
  const control=$('themeMotion');if(control)control.checked=state.themeMotion;
  if(persist){localStorage.setItem('pinetree-theme-motion-v310',state.themeMotion?'1':'0');markSettingsChanged();}
}
function setFireflyIntensity(value,{persist=true}={}){
  const allowed=['soft','medium','high','cinematic'];
  state.fireflyIntensity=allowed.includes(value)?value:'high';
  document.body.dataset.fireflyIntensity=state.fireflyIntensity;
  const control=$('fireflyIntensity');if(control)control.value=state.fireflyIntensity;
  installForestFireflies();
  if(persist){localStorage.setItem('pinetree-firefly-intensity-v436',state.fireflyIntensity);markSettingsChanged();}
}
const CALIBRATION_ART={wave:'聲波精準',dial:'翡翠儀表',moon:'月夜同步'};
function setCalibrationStyle(value,{persist=true}={}){
  state.calibrationStyle=Object.prototype.hasOwnProperty.call(CALIBRATION_ART,value)?value:'moon';
  const style=state.calibrationStyle;
  document.body.dataset.calibrationStyle=style;
  const src=document.querySelector('button.calibration-choice[data-calibration-style="'+style+'"] img')?.getAttribute('src');
  for(const id of ['offsetArtwork','calibrationPreviewImage']){
    const img=$(id);if(img&&src)img.setAttribute('src',src);
  }
  for(const b of document.querySelectorAll('button.calibration-choice')){
    const active=b.dataset.calibrationStyle===style;
    b.setAttribute('aria-pressed',String(active));
    b.querySelector('.calibration-selected').textContent=active?'✓ 已選用':'選用';
  }
  if($('calibrationCurrentName'))$('calibrationCurrentName').textContent=CALIBRATION_ART[style];
  if(persist)localStorage.setItem('pinetree-calibration-style',style);
  renderOffsetLabel();
}
function setFireflyTrails(value,{persist=true}={}){
  state.fireflyTrails=!!value;document.body.dataset.fireflyTrails=state.fireflyTrails?'on':'off';
  const el=$('fireflyTrails');if(el)el.checked=state.fireflyTrails;
  if(persist)localStorage.setItem('pinetree-firefly-trails',state.fireflyTrails?'1':'0');
}
function installForestFireflies(){
  const host=$('forestFireflies');if(!host)return;
  if(host.parentElement!==document.body)document.body.appendChild(host);
  const presets={soft:{count:48,opacity:.78},medium:{count:84,opacity:.88},high:{count:128,opacity:.98},cinematic:{count:176,opacity:1}};
  const level=presets[state.fireflyIntensity]?state.fireflyIntensity:'high',cfg=presets[level];
  document.body.dataset.fireflyIntensity=level;
  host.style.setProperty('--firefly-opacity',String(cfg.opacity));
  const frag=document.createDocumentFragment();
  for(let i=0;i<cfg.count;i++){
    const f=document.createElement('i');f.className='forest-firefly';
    // Deterministic viewport-wide distribution; one straight drift per cycle.
    // Tail always points opposite the velocity, and the particle fades before recycling.
    const x=1+((i*47.237)%98),y=1+((i*31.733)%98);
    const angle=((i*137.508)%360)*Math.PI/180,dist=70+(i*17)%145;
    const dx=Math.cos(angle)*dist,dy=Math.sin(angle)*dist;
    const size=3+(i*7)%5;const tail=12+(i*13)%36;
    const vars={x:x.toFixed(2)+'%',y:y.toFixed(2)+'%',d:size+'px',dx:dx.toFixed(2)+'px',dy:dy.toFixed(2)+'px',angle:angle.toFixed(4)+'rad',tail:tail+'px',t:(5.8+(i*7%13)*.62).toFixed(2)+'s',delay:(-i*.731).toFixed(2)+'s',peak:(.72+(i*5%27)/100).toFixed(2)};
    for(const [k,v] of Object.entries(vars))f.style.setProperty('--'+k,v);
    frag.append(f);
  }
  host.replaceChildren(frag);
}
function installThemeParticles(){
  const host=$('themeParticles');if(!host)return;
  host.replaceChildren();
  const frag=document.createDocumentFragment();
  for(let i=0;i<22;i++){
    const particle=document.createElement('span');particle.className='theme-particle';
    // Deterministic, no timers or JavaScript animation loops.
    const x=(17*i+9)%100,drift=(i%2?-1:1)*(6+(i*7)%22);
    particle.style.setProperty('--particle-x',`${x}%`);
    particle.style.setProperty('--particle-drift',`${drift}px`);
    particle.style.setProperty('--particle-delay',`${-((i*13)%89)/10}s`);
    particle.style.setProperty('--particle-duration',`${7+(i*5)%12}s`);
    particle.style.setProperty('--particle-size',`${2+(i*7)%6}px`);
    frag.append(particle);
  }
  host.append(frag);
}
const headphoneActionLog=[];
function logMediaAction(action){
  const time=new Date().toLocaleTimeString('zh-TW',{hour12:false});
  headphoneActionLog.push(`${time} ${action} · ${document.hidden?'背景':'前景'} · ${audio.paused?'暫停':'播放'}`);
  if(headphoneActionLog.length>24)headphoneActionLog.shift();
  const box=$('headphoneDiagnostic');if(box)box.textContent=headphoneActionLog.slice(-5).join('\n')||'尚未收到耳機媒體操作';
}
function playFromMediaControls(){
  if(!state.current||!audio.src){logMediaAction('Play 指令：沒有載入章節');return false;}
  requestPlaybackAudioSession();
  try{
    // Keep audio.play() directly in the media action handler's user activation.
    const promise=audio.play();
    if(promise&&typeof promise.then==='function')promise.then(()=>{
      state.mediaResumeError='';if($('playStatus'))$('playStatus').textContent='正在播放';
      logMediaAction('Play 成功');
    }).catch(error=>{
      state.mediaResumeError=String(error?.name||error);
      logMediaAction('Play 被系統拒絕：'+state.mediaResumeError);
      if($('playStatus'))$('playStatus').textContent='鎖屏續播受 iOS 限制 · 請解鎖回到 App';
    });
    return true;
  }catch(error){state.mediaResumeError=String(error?.name||error);logMediaAction('Play 失敗：'+state.mediaResumeError);return false;}
}
// Some iOS headphone controls deliver a `play` action for the same physical
// single-button press even while audio is already playing. In that case a
// literal audio.play() is a no-op and makes the headset Pause appear broken.
// This *opt-out*, iOS-only fallback must not change LRC metadata updates.
let lastHeadphonePlayActionAt=0;
function isIOSHeadphoneEnvironment(){
  return /iPhone|iPad|iPod/i.test(navigator.userAgent||'') ||
    (/Macintosh/i.test(navigator.userAgent||'') && navigator.maxTouchPoints>1);
}
function setIOSSingleButtonCompatibility(enabled,{persist=true}={}){
  state.iosSingleButtonCompatibility=!!enabled;
  const control=$('iosSingleButtonCompatibility');
  if(control)control.checked=state.iosSingleButtonCompatibility;
  if(persist)localStorage.setItem('pinetree-ios-earphone-onebutton-v4394',enabled?'1':'0');
  logMediaAction('耳機單鍵相容模式：'+(enabled?'開啟':'關閉'));
}
function handleHeadphonePlayAction(){
  const now=Date.now();
  const compatible=isIOSHeadphoneEnvironment()&&state.iosSingleButtonCompatibility;
  // Avoid two near-simultaneous `play` callbacks undoing a single tap.
  if(compatible && now-lastHeadphonePlayActionAt<440){
    logMediaAction('Play 重複事件已略過');
    return;
  }
  lastHeadphonePlayActionAt=now;
  if(compatible && state.current && audio.src && !audio.paused && !audio.ended){
    // Immediate pause inside the system media action. No metadata refresh,
    // URL revocation, new Audio instance or timers: protect LRC and resume.
    logMediaAction('iOS 單鍵相容：播放中的 Play → Pause');
    audio.pause();
    return;
  }
  logMediaAction('收到耳機/鎖屏 Play → 播放');
  playFromMediaControls();
}
function setupMediaSession(){if(!('mediaSession' in navigator))return;
 const handlers={
   play:()=>handleHeadphonePlayAction(),
   pause:()=>{logMediaAction('收到耳機/鎖屏 Pause');if(!audio.paused)audio.pause();},
   stop:()=>{logMediaAction('收到 Stop');if(!audio.paused)audio.pause();},
   previoustrack:()=>adjacentTrack(-1),nexttrack:()=>adjacentTrack(1),
   seekbackward:({seekOffset}={})=>skipSeconds(-(seekOffset||15)),
   seekforward:({seekOffset}={})=>skipSeconds(seekOffset||15),
   seekto:({seekTime})=>{if(Number.isFinite(seekTime))audio.currentTime=seekTime;}
 };
 for(const [action,fn]of Object.entries(handlers))try{navigator.mediaSession.setActionHandler(action,fn);}catch(_){}
}
function clearCurrent(message='请选择章节'){++state.loadingToken;state.current=null;state.lockScreenMetaKey='';releaseAudio();try{if('mediaSession'in navigator)navigator.mediaSession.metadata=null;}catch(_){}state.lines=[];state.lineIndex=-1;localStorage.removeItem('lyra-last-id');$('currentBook').textContent=state.selectedBook?bookTitle(state.selectedBook):'READY TO LISTEN';$('currentTitle').textContent=message;$('chapterHint').textContent='从章节目录选择一章';$('playBtn').disabled=true;$('seekBar').disabled=true;$('deleteBtn').disabled=true;$('bookmarkAdd').disabled=true;setPlayButtonVisual(false);$('playStatus').textContent='未选章节';$('lrcState').textContent='· 暂无字幕';$('elapsed').textContent='00:00';$('duration').textContent='00:00';displayPlaceholder(message,'MP3 和 LRC 将保存在本机书库');updateStoryArt();updateBookBrand();drawChapterList();}
async function loadTrack(track,{autoplay=false,restart=false}={}){if(!track)return;const token=++state.loadingToken;if(state.current&&state.current.id!==track.id&&!audio.ended)await saveProgress();if(token!==state.loadingToken)return;releaseAudio();state.current=track;localStorage.setItem('lyra-last-id',track.id);localStorage.setItem('lyra-last-book-track:'+track.book,track.id);$('currentBook').textContent=bookTitle(track.book);$('currentTitle').textContent=chapterDisplayName(track.name);$('chapterHint').textContent='自动保存续听进度 · 点击字幕可跳转';$('deleteBtn').disabled=false;$('bookmarkAdd').disabled=false;$('playBtn').disabled=true;$('seekBar').disabled=true;$('playStatus').textContent='读取音频中…';state.lockScreenMetaKey='';displayLyrics(track.lrcText||'');updateStoryArt();updateBookBrand();drawChapterList();if(window.matchMedia('(max-width:850px)').matches)setMobileTab('player',true);else requestAnimationFrame(scrollActiveChapter);
  try{const [stored,progress]=await Promise.all([getStore('audio',track.id),getStore('progress',track.id)]);if(token!==state.loadingToken)return;if(!stored?.blob)throw new Error('本章 MP3 已清理或未匯入；請從 iCloud Drive 重新匯入同名 MP3');const resumeAt=restart||progress?.ended?0:Math.max(0,Number(progress?.position)||0);state.fileUrl=URL.createObjectURL(stored.blob);audio.src=state.fileUrl;audio.defaultPlaybackRate=state.speed;audio.playbackRate=state.speed;audio.load();$('playBtn').disabled=false;$('seekBar').disabled=false;updateMediaSession();let restored=false;const resume=()=>{if(token!==state.loadingToken||restored)return;const d=audio.duration;if(Number.isFinite(d)&&d>0){if(resumeAt>0&&resumeAt<d-1){try{audio.currentTime=resumeAt;}catch(_) {}}restored=true;updateProgressDisplay();updateLyrics(true);updateMediaPosition();}};if(audio.readyState>=1)resume();else{audio.addEventListener('loadedmetadata',resume,{once:true});audio.addEventListener('canplay',resume,{once:true});}$('playStatus').textContent=progress?.ended?'已听完 · 从头开始':resumeAt>1?`续听 ${formatTime(resumeAt)}`:'准备播放';if(autoplay)await startPlayback();}catch(error){if(token!==state.loadingToken)return;console.error(error);$('playBtn').disabled=true;$('seekBar').disabled=true;$('playStatus').textContent='音频读取失败';toast(`播放失败：${error.message||error}`);}}
async function startPlayback({fromLockScreen=false}={}){
  if(!state.current){if(!fromLockScreen)toast('請先選擇小說章節');return false;}
  requestPlaybackAudioSession();
  // Keep the same audio element and Blob URL while paused; never unload it to 'refresh' the lock screen.
  if(!audio.src){if(fromLockScreen)return false;await loadTrack(state.current,{autoplay:false});}
  try{
    await audio.play();
    state.mediaResumeError='';
    $('playStatus').textContent='正在播放';
    return true;
  }catch(error){
    console.warn('播放暫停或恢復被系統限制',error);
    state.mediaResumeError=String(error?.name||error);
    $('playStatus').textContent=fromLockScreen?'iOS 鎖屏恢復受限 · 請開啟 App':'未能播放 · 請點播放重試';
    if(!document.hidden)toast('iPhone 可能需要開啟 App 再按播放；長時間鎖屏暫停後 WebKit 可能凍結播放工作階段',6500);
    return false;
  }
}
function skipSeconds(n){if(!state.current||!Number.isFinite(audio.duration))return;audio.currentTime=Math.max(0,Math.min(audio.duration,audio.currentTime+n));updateProgressDisplay();updateLyrics();saveProgress();}
function adjacentTrack(delta){const list=state.current?sortedBookTracks(state.current.book):[];const i=list.findIndex(t=>t.id===state.current?.id);if(i<0||!list[i+delta]){toast(delta>0?'这已是本书最后一章':'这已是本书第一章');return;}return loadTrack(list[i+delta],{autoplay:true});}
function updateProgressDisplay(){const cur=Number(audio.currentTime)||0,d=Number(audio.duration)||0;$('elapsed').textContent=formatTime(cur);$('duration').textContent=formatTime(d);const pct=d>0?Math.max(0,Math.min(100,cur/d*100)):0;const seekScene=$('seekScene');if(seekScene)seekScene.style.setProperty('--seek-progress',pct+'%');$('seekBar').style.setProperty('--seek-progress',pct+'%');if(!state.seeking)$('seekBar').value=d>0?String(Math.min(1000,Math.round(cur/d*1000))):'0';}
async function deleteCurrent(){if(!state.current)return;await deleteEpisodes([state.current.id]);}
function changeFont(delta){state.fontSize=bounded(state.fontSize+delta,14,38,21);document.documentElement.style.setProperty('--font-size',`${state.fontSize}px`);localStorage.setItem('lyra-font',state.fontSize);markSettingsChanged();requestAnimationFrame(()=>{syncLyricsViewportPadding();updateLyrics(true);});}
function renderOffsetLabel(){
  const el=$('offsetLabel');if(!el)return;
  const value=state.delay;
  const abs=Math.abs(value).toFixed(1);
  const compact=`${value>0?'+':value<0?'−':''}${abs}s`;
  if($('offsetValue'))$('offsetValue').textContent=compact;
  else el.textContent=compact;
  if($('calibrationPreviewValue'))$('calibrationPreviewValue').textContent=compact;
  el.dataset.adjusted=String(value!==0);
  el.dataset.zero=String(value===0);
  el.setAttribute('aria-label',`LRC 字幕校準：${value===0?'零秒':value>0?'延後':'提前'}${abs} 秒`);
}
function changeDelay(delta){state.delay=bounded(Math.round((state.delay+delta)*2)/2,-20,20,0);localStorage.setItem('lyra-delay',state.delay);markSettingsChanged();renderOffsetLabel();updateLyrics(true);updateMediaSession(true);}
function setSpeed(value){state.speed=Math.round(bounded(Number(value),.5,3,1)*20)/20;audio.defaultPlaybackRate=state.speed;audio.playbackRate=state.speed;localStorage.setItem('lyra-speed',state.speed);$('speedRange').value=state.speed;$('speedLabel').textContent=`${state.speed.toFixed(2)}×`;for(const p of document.querySelectorAll('[data-speed-preset]'))p.setAttribute('aria-pressed',String(Math.abs(Number(p.dataset.speedPreset)-state.speed)<.026));updateMediaPosition();}
const isHex=x=>/^#[0-9a-f]{6}$/i.test(x);
function rgb(hex){return [1,3,5].map(p=>parseInt(hex.slice(p,p+2),16));}
function mixColor(a,b,weight){const x=rgb(a),y=rgb(b);return '#'+x.map((v,i)=>Math.round(v*(1-weight)+y[i]*weight).toString(16).padStart(2,'0')).join('');}
function luminance(hex){
  const c=rgb(hex).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
  return .2126*c[0]+.7152*c[1]+.0722*c[2];
}
function autoPanel(hex){
  return mixColor(hex,luminance(hex)>.46?'#000000':'#ffffff',luminance(hex)>.46?.045:.105);
}
const ART_THEME_IDS=new Set(['prism-black','prism-green','prism-red','prism-gold','wood-fire-earth','christmas-season','new-year-festival']);
const UI_THEME_IDS=new Set(['forest-reading','jade-night','pine-morning','warm-tea','christmas-season','new-year-festival','prism-black','prism-green','prism-red','prism-gold','wood-fire-earth']);
function refreshThemePresetButtons(){
  for(const button of document.querySelectorAll('.theme-preset')){
    const colorMatch=[['page',state.bgColor],['panel',state.panelColor],['accent',state.accentColor]].every(([key,value])=>button.dataset[key]?.toLowerCase()===value.toLowerCase());
    const artMatch=(button.dataset.artTheme||'')===state.artTheme;
    const uiMatch=(button.dataset.uiTheme||'')===state.uiTheme;
    const requireArt=Object.prototype.hasOwnProperty.call(button.dataset,'artTheme');
    const requireUi=Object.prototype.hasOwnProperty.call(button.dataset,'uiTheme');
    button.setAttribute('aria-pressed',String(colorMatch && (!requireArt || artMatch) && (!requireUi || uiMatch)));
  }
}
function setArtTheme(id,persist=true){
  state.artTheme=ART_THEME_IDS.has(id)?id:'';
  if(state.artTheme)document.body.dataset.artTheme=state.artTheme;
  else delete document.body.dataset.artTheme;
  if(persist)localStorage.setItem('pinetree-art-theme-v380',state.artTheme);
  refreshThemePresetButtons();
}
function setUITheme(id,persist=true){
  state.uiTheme=UI_THEME_IDS.has(id)?id:'';
  if(state.uiTheme)document.body.dataset.uiTheme=state.uiTheme;
  else delete document.body.dataset.uiTheme;
  if(persist)localStorage.setItem('pinetree-ui-theme-v380',state.uiTheme);
  refreshThemePresetButtons();
}
function setTheme(page,panel,accent,{linked=state.panelLinked}={}){
  if(![page,panel,accent].every(isHex))return;
  state.bgColor=page;state.panelColor=panel;state.accentColor=accent;state.panelLinked=!!linked;
  const light=luminance(panel)>.32;
  const [r,g,b]=rgb(panel);
  const green=!light && g>=r*1.16 && g>=b*1.08 && (g-r)>11;
  const exactForest=page.toLowerCase()===DEFAULT_BG.toLowerCase() && panel.toLowerCase()===DEFAULT_PANEL.toLowerCase() && accent.toLowerCase()===DEFAULT_ACCENT.toLowerCase();
  const root=document.documentElement;
  const values={
    '--bg':page,'--panel':panel,
    '--panel-alt':exactForest?'#1D4030':mixColor(panel,light?'#000000':'#ffffff',light?.036:.057),
    '--field':exactForest?'#254636':mixColor(panel,light?'#000000':'#ffffff',light?.072:.106),
    '--border':exactForest?'#315243':mixColor(panel,light?'#000000':'#ffffff',light?.19:.20),
    '--text':green?'#F3F1E8':(light?'#1c2736':'#f4f6fb'),
    '--soft':green?'#D9D5C8':(light?'#394a5a':'#d6e2f0'),
    '--muted':green?'#A7B2AA':(light?'#536576':'#a2b3c9'),
    '--accent':accent,'--accent-text':luminance(accent)>.32?(green?'#163427':'#132033'):'#ffffff',
    '--accent-faint':accent+'26',
    '--lyric-surface':exactForest?'#10261D':mixColor(panel,light?'#ffffff':'#000000',light?.015:.21),
    '--lyric-inactive':green?'#C7CBC5':(light?'#445464':'#bdc9d9'),
    '--lyric-active':exactForest?'#F4D67A':(green?mixColor(accent,'#fff3c3',.31):accent),
    '--danger':light?'#A72E30':'#D97A7A',
    '--danger-border':light?'#A72E30':'#B64A4A',
    '--danger-bg':light?'#B64A4A14':'#B64A4A1A'
  };
  for(const [key,value] of Object.entries(values))root.style.setProperty(key,value);
  root.style.colorScheme=light?'light':'dark';
  localStorage.setItem('lyra-bg-color',page);
  localStorage.setItem('lyra-panel-color',panel);
  localStorage.setItem('lyra-accent-color',accent);
  localStorage.setItem('lyra-panel-linked',linked?'1':'0');
  $('bgColor').value=page;$('panelColor').value=panel;$('accentColor').value=accent;
  $('bgColorLabel').textContent=page.toUpperCase();
  $('panelColorLabel').textContent=panel.toUpperCase();
  $('accentColorLabel').textContent=accent.toUpperCase();
  $('linkPanels').checked=!!linked;
  document.querySelector('meta[name="theme-color"]').content=page;
  refreshThemePresetButtons();
}
function migrateForestThemeOnce(){
  if(localStorage.getItem(FOREST_MIGRATION_KEY)==='1')return;
  // Upgrade-once change only affects theme keys. Never touch IndexedDB, audio,
  // chapter progress, playback speed, subtitle offsets or custom book covers.
  const previous={bg:localStorage.getItem('lyra-bg-color'),panel:localStorage.getItem('lyra-panel-color'),accent:localStorage.getItem('lyra-accent-color'),linked:localStorage.getItem('lyra-panel-linked')};
  if(previous.bg||previous.panel||previous.accent){
    const oldBg=isHex(previous.bg||'')?previous.bg:'#0b1220';
    const oldPanel=isHex(previous.panel||'')?previous.panel:autoPanel(oldBg);
    const oldAccent=isHex(previous.accent||'')?previous.accent:'#f4c678';
    localStorage.setItem(PRE_FOREST_BACKUP_KEY,JSON.stringify({bg:oldBg,panel:oldPanel,accent:oldAccent,linked:previous.linked}));
  }
  localStorage.setItem(FOREST_MIGRATION_KEY,'1');
  state.bgColor=DEFAULT_BG;state.panelColor=DEFAULT_PANEL;state.accentColor=DEFAULT_ACCENT;state.panelLinked=true;state.uiTheme='forest-reading';
  // Persist the new panel now, or start() could reload an old navy panel
  // from v3 localStorage and combine it with the new green page background.
  setTheme(DEFAULT_BG,DEFAULT_PANEL,DEFAULT_ACCENT,{linked:true});
  setUITheme('forest-reading');
}
function updateRestoreOption(){
  $('restorePreviousTheme').hidden=!localStorage.getItem(PRE_FOREST_BACKUP_KEY);
}
function restorePreviousTheme(){
  try{
    const previous=JSON.parse(localStorage.getItem(PRE_FOREST_BACKUP_KEY)||'null');
    if(!previous || !isHex(previous.bg||'') || !isHex(previous.panel||'') || !isHex(previous.accent||''))throw new Error('missing previous theme');
    setArtTheme('');setUITheme('');setTheme(previous.bg,previous.panel,previous.accent,{linked:previous.linked!=='0'});
    toast('已還原升級前的配色，其他設定保持不變');
  }catch{toast('沒有可用的舊配色，仍保留目前主題');}
}
function setBackground(hex){if(isHex(hex)){setArtTheme('');setUITheme('');setTheme(hex,state.panelLinked?autoPanel(hex):state.panelColor,state.accentColor);}}
function setPanelColor(hex){if(isHex(hex)){setArtTheme('');setUITheme('');setTheme(state.bgColor,hex,state.accentColor,{linked:false});}}
function setAccentColor(hex){if(isHex(hex)){setArtTheme('');setUITheme('');setTheme(state.bgColor,state.panelColor,hex);}}
function openDialog(id){const dlg=$(id);if(!dlg.open)dlg.showModal();}
function closeDialog(id){const dlg=$(id);if(dlg.open)dlg.close();}

function updateNetwork(){$('networkBadge').textContent=navigator.onLine?'● 已就绪 · 可离线':'● 离线书库';}
// PineTree v4.3.3 - explicit user-granted Windows iCloud folder access.
// This uses a SEPARATE handle-only IndexedDB; the existing Lyra audiobook database stays untouched.
const SYNC_HANDLE_DB='pinetree-sync-handles-v1';
const SYNC_JSON_NAME='Lyra_Sync.json';
let syncRestoreTask=null;
let syncFolderHandle=null;
let syncFolderReady=false;
let syncLastFileModified=0;
let syncWriteQueue=Promise.resolve();
let syncPauseExportBusy=false;
function syncBridgeMessage(message,kind='auto'){
  const el=$('syncBridgeStatus');if(el)el.textContent=message;
  const indicator=$('syncLiveIndicator');if(!indicator)return;
  const text=String(message||'');
  const level=kind==='auto'?(text.includes('✅')?'success':text.includes('⚠')||text.includes('衝突')?'warning':text.includes('失敗')?'error':'local'):kind;
  indicator.dataset.state=level;
  indicator.textContent=level==='success'?'☁ '+text.replace(/^✅\s*/,'').slice(0,66):level==='warning'?'⚠ '+text.replace(/^⚠️?\s*/,'').slice(0,59):level==='error'?'✕ '+text.slice(0,59):'☁ '+text.slice(0,57);
  indicator.title=text;indicator.setAttribute('aria-label','同步狀態：'+text+'；按此可查看或設定');
}
function syncEvidence(message){const el=$('syncEvidence');if(el)el.textContent=message;}
async function syncHandleStore(operation,value){
  const db=await new Promise((resolve,reject)=>{
    const req=indexedDB.open(SYNC_HANDLE_DB,1);
    req.onupgradeneeded=()=>req.result.createObjectStore('permissions');
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
  try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction('permissions',operation==='get'?'readonly':'readwrite');
    const store=tx.objectStore('permissions');
    const req=operation==='get'?store.get('folder'):store.put(value,'folder');
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
    tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
}
async function getFolderPermission(mode='readwrite',request=false){
  if(!syncFolderHandle)return false;
  try{
    const opts={mode};
    let result=await syncFolderHandle.queryPermission(opts);
    if(result!=='granted'&&request)result=await syncFolderHandle.requestPermission(opts);
    return result==='granted';
  }catch(error){console.warn('同步資料夾權限不可用',error);return false;}
}
async function linkedSyncFile({create=false}={}){
  const handle=await syncFolderHandle.getFileHandle(SYNC_JSON_NAME,{create});
  return handle;
}
async function restoreSyncFolder(){
  if(!('showDirectoryPicker' in window)){
    syncBridgeMessage('iPhone／不支援此 API 的瀏覽器：快速續聽會開啟檔案選擇器；暫停只儲存本機進度。');return;
  }
  try{
    const handle=await syncHandleStore('get');
    if(!handle){syncBridgeMessage('Windows Edge：尚未授權 Audiobooks 資料夾，請按上方連結按鈕。');return;}
    syncFolderHandle=handle;
    const canRead=await getFolderPermission('read');
    const canWrite=await getFolderPermission('readwrite');
    syncFolderReady=canRead&&canWrite;
    if(syncFolderReady){
      try{const f=await (await linkedSyncFile()).getFile();syncLastFileModified=f.lastModified;}catch(_){syncLastFileModified=0;}
      syncFolderReady=false; // After startup DB is ready, merge external JSON first, then unlock safe writes.
      syncBridgeMessage(`已記住「${handle.name}」，具備讀寫權限。請按「快速續聽」先讀入最新 JSON，才會啟用暫停自動覆寫。`);
    }else syncBridgeMessage(`已記住「${handle.name}」，瀏覽器尚未授權讀寫；請再次按「授權資料夾」。`);
  }catch(error){console.warn('無法恢復同步資料夾授權',error);syncBridgeMessage('尚未取得可用的同步資料夾權限。');}
}
// v4.3.5: Restore the previously approved Edge folder safely on every startup.
// Only import after the native Lyra database has opened and the library loaded.
async function activateLinkedSyncAfterStartup(){
  if(!syncFolderHandle || !state.db)return;
  if(!await getFolderPermission('readwrite')){
    syncFolderReady=false;
    syncBridgeMessage(`已記住「${syncFolderHandle.name}」，但讀寫權限待授權。請在 iCloud 同步內重新授權。`,'warning');return;
  }
  try{
    let file=null;
    try{file=await(await linkedSyncFile()).getFile();}
    catch(error){if(error?.name!=='NotFoundError')throw error;}
    if(file && file.size){
      const ok=await importICloudState(file,{autoConfirm:true,quiet:true});
      if(!ok){syncFolderReady=false;syncBridgeMessage('已有 JSON，但自動合併未成功；請按「快速續聽」先匯入。','warning');return;}
      syncLastFileModified=file.lastModified;
      syncEvidence(`自動啟動時讀取 ${file.name} · ${new Date(file.lastModified).toLocaleString()} · ${file.size.toLocaleString()} bytes`);
    }else{syncLastFileModified=0;syncEvidence('已授權資料夾；尚未有同步檔，首次暫停將建立 JSON。');}
    syncFolderReady=true;
    syncBridgeMessage(`✅ 已就緒：暫停自動更新 ${SYNC_JSON_NAME}；快速續聽會先讀入最新檔案。`);
  }catch(error){syncFolderReady=false;syncBridgeMessage('⚠ 自動恢復同步失敗：'+(error?.message||error)+'；請在同步設定中檢查。','warning');}
}
async function connectSyncFolder(){
  if(typeof window.showDirectoryPicker!=='function'){
    syncBridgeMessage('此瀏覽器不支援直接綁定資料夾；請使用手動匯入／匯出。');toast('iPhone Safari 無法自動覆寫 Windows 的 iCloud 路徑');return;
  }
  let handle;
  try{
    // Must be invoked from a direct click for user activation.
    handle=await window.showDirectoryPicker({id:'pinetree-audiobooks-sync',mode:'readwrite'});
  }catch(error){if(error?.name!=='AbortError')toast('無法選擇資料夾：'+(error?.message||error));return;}
  if(handle.name!=='Audiobooks'&&!confirm(`你選的是「${handle.name}」，而非 Audiobooks。\n仍確定這就是要存放 ${SYNC_JSON_NAME} 的資料夾嗎？`))return;
  const previous=syncFolderHandle,prevReady=syncFolderReady;
  syncFolderHandle=handle;syncFolderReady=false;
  try{
    if(!await getFolderPermission('readwrite',true))throw new Error('尚未獲得讀寫權限');
    // Never overwrite a pre-existing remote sync file without importing first.
    let oldFile=null;
    try{oldFile=await (await linkedSyncFile()).getFile();}catch(error){if(error.name!=='NotFoundError')throw error;}
    if(oldFile?.size){
      const accept=confirm(`找到現有 ${SYNC_JSON_NAME}（${new Date(oldFile.lastModified).toLocaleString()}）。\n\n為防止覆蓋其他裝置較新的進度，必須先合併此檔案，才能啟用暫停自動覆寫。現在合併嗎？`);
      if(!accept){syncBridgeMessage('已有同步檔，尚未合併：為保護較新的進度，暫停自動覆寫未啟用。');syncFolderHandle=previous;syncFolderReady=prevReady;return;}
      if(!await importICloudState(oldFile,{autoConfirm:true,quiet:true}))throw new Error('原同步檔未能通過驗證；已停止連結以防覆寫');
      syncLastFileModified=oldFile.lastModified;
    }else syncLastFileModified=0;
    await syncHandleStore('put',handle);
    syncFolderReady=true;
    syncBridgeMessage(`✅ 已授權「${handle.name}」；暫停時自動嘗試覆寫 ${SYNC_JSON_NAME}。`);
    syncEvidence(`已連結「${handle.name}」；${oldFile?'已合併現有檔案，等待暫停寫入。':'尚無同步檔，首次暫停會建立。'}`);
    toast('資料夾連結完成；暫停後會嘗試直接寫入 iCloud Drive',4200);
  }catch(error){syncFolderHandle=previous;syncFolderReady=prevReady;syncBridgeMessage('無法啟用自動寫入：'+(error?.message||error));toast('同步資料夾連結失敗：'+(error?.message||error),6500);}
}
function queuePauseSyncExport(){
  if(state.suppressProgressWrites)return;
  if(!syncFolderHandle){syncBridgeMessage('暫停已保存本機；未連結 Windows Edge 資料夾，沒有寫入 iCloud JSON。','local');return;}
  if(!syncFolderReady){syncBridgeMessage('⚠ 暫停已保存本機；自動同步未啟用，請先授權或匯入最新 JSON。','warning');return;}
  syncWriteQueue=syncWriteQueue.catch(()=>{}).then(async()=>{
    if(!await getFolderPermission('readwrite')){
      syncFolderReady=false;syncBridgeMessage('⚠️ 資料夾寫入權限已失效；暫停時僅保存本機。請重新授權。');return;
    }
    try{
      const fileHandle=await linkedSyncFile({create:true});
      const onDisk=await fileHandle.getFile();
      if(syncLastFileModified&&onDisk.size&&onDisk.lastModified!==syncLastFileModified){
        syncFolderReady=false;
        syncBridgeMessage('⚠️ iCloud 同步檔已被其他裝置更新，停止自動覆寫；請按快速續聽先匯入。');
        toast('同步衝突：外部 JSON 已更新，沒有覆寫較新檔案',6000);return;
      }
      const snapshot=await makeSyncSnapshot();
      // Check again immediately before opening the writer to reduce conflicts.
      const latest=await fileHandle.getFile();
      if(onDisk.lastModified!==latest.lastModified){syncFolderReady=false;syncBridgeMessage('⚠️ 寫入時偵測到外部檔案變更；請先匯入。');return;}
      const writable=await fileHandle.createWritable({keepExistingData:false});
      try{await writable.write(JSON.stringify(snapshot));await writable.close();}
      catch(err){try{await writable.abort();}catch(_){}throw err;}
      const verified=await fileHandle.getFile();
      const diskSnapshot=JSON.parse(await verified.text());
      if(diskSnapshot.format!==SYNC_SCHEMA||diskSnapshot.exportedAt!==snapshot.exportedAt||
         !Array.isArray(diskSnapshot.progress)||diskSnapshot.progress.length!==snapshot.progress.length){
        throw new Error('寫入後驗證失敗：檔案內容與輸出快照不一致');
      }
      syncLastFileModified=verified.lastModified;
      const message=`✅ 已驗證寫入 ${SYNC_JSON_NAME} · ${new Date().toLocaleTimeString()} · ${snapshot.progress.length} 筆進度`;
      syncBridgeMessage(message);
      syncEvidence(`已重新讀取確認：${verified.name} · ${verified.size.toLocaleString()} bytes · 修改時間 ${new Date(verified.lastModified).toLocaleString()} · 最後章節 ${String(snapshot.lastTrackId||'無').split('\u0000').pop()}`);
    }catch(error){syncFolderReady=false;syncBridgeMessage('⚠️ 自動同步失敗：'+(error?.message||error)+'；本機播放記錄仍保留。');console.warn('暫停自動同步失敗',error);}
  });
}
async function verifyAndWriteSyncNow(){
  if(!syncFolderHandle){syncBridgeMessage('⚠ 先授權 Windows Edge 的 Audiobooks 資料夾。','warning');return;}
  if(!syncFolderReady){
    const permitted=await getFolderPermission('readwrite',true);
    if(permitted)await activateLinkedSyncAfterStartup();
  }
  if(!syncFolderReady){toast('尚未具備可寫入權限；請按授權資料夾再試',5000);return;}
  try{await saveProgress();queuePauseSyncExport();await syncWriteQueue;
    const ok=$('syncLiveIndicator').dataset.state==='success';
    toast(ok?'同步檔已寫入並重新讀取驗證':'同步未完成；請查看同步狀態及診斷',5300);
  }catch(err){syncBridgeMessage('立即驗證失敗：'+(err?.message||err),'error');}
}
async function resumeFromLinkedOrPickedFile(){
  // Mobile browsers cannot open a Windows path. Use the native iCloud Files picker.
  if(!syncFolderHandle){$('syncQuickFile').click();return;}
  let canRead=await getFolderPermission('read');
  if(!canRead)canRead=await getFolderPermission('read',true);
  if(!canRead){syncBridgeMessage('同步檔讀取權限失效。請重新授權或手動選擇 JSON。');$('syncQuickFile').click();return;}
  try{
    const f=await (await linkedSyncFile()).getFile();
    if(!await importICloudState(f,{autoConfirm:true,quiet:true}))return;
    syncLastFileModified=f.lastModified;
    syncFolderReady=await getFolderPermission('readwrite');
    syncBridgeMessage(`✅ 快速續聽已先讀取 ${SYNC_JSON_NAME} · ${new Date(f.lastModified).toLocaleString()}`);
    await quickResumeLocal();
  }catch(error){syncBridgeMessage('無法讀取已連結同步檔：'+(error?.message||error));toast('請選擇 iCloud Drive 最新的 Lyra_Sync.json',4500);$('syncQuickFile').click();}
}
async function onQuickSyncFileSelected(file){
  if(!file)return;
  if(await importICloudState(file,{autoConfirm:true,quiet:true})){
    syncBridgeMessage(`✅ 已從「檔案」匯入 ${file.name} · ${new Date(file.lastModified).toLocaleString()}。`);
    await quickResumeLocal();
  }
  $('syncQuickFile').value='';
}

// iCloud Drive bridge: manual state-file export/import. Browsers cannot silently write an iCloud Drive file.
// This is a metadata snapshot, NEVER a remote account login or MP3 upload.
const SYNC_SCHEMA = 'lyra-icloud-drive-state-v1';
const MAX_SYNC_BYTES = 35 * 1024 * 1024;
const MAX_COVER_BYTES = 2 * 1024 * 1024;
function fileAsDataURL(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error||new Error('無法讀取封面'));reader.readAsDataURL(blob);});}
function safeTimestamp(value){const n=Number(value);return Number.isFinite(n)&&n>0&&n<Date.now()+86400000?n:0;}
async function makeSyncSnapshot(){
  await saveProgress();
  const books=await getStore('books');
  const progress=await getStore('progress');
  let coverBytes=0;
  const serialized=[];
  let skipped=0;
  for(const book of books){
    let cover=null;
    if(book.coverBlob instanceof Blob){
      if(book.coverBlob.size<=MAX_COVER_BYTES && coverBytes+book.coverBlob.size<=18*1024*1024){
        cover=await fileAsDataURL(book.coverBlob);
        coverBytes+=book.coverBlob.size;
      } else skipped++;
    }
    serialized.push({id:book.id,title:book.title||book.id,createdAt:book.createdAt||0,updatedAt:book.updatedAt||0,cover});
  }
  const positions=progress.filter(p=>typeof p.id==='string'&&p.id.includes('\u0000')).map(p=>({id:p.id,position:Number(p.position)||0,ended:!!p.ended,updatedAt:Number(p.updatedAt)||0}));
  return {format:SYNC_SCHEMA,exportedAt:new Date().toISOString(),books:serialized,progress:positions,
    deletedBooks:Object.entries(loadDeletedBooks()).map(([id,deletedAt])=>({id,deletedAt})),
    bookmarks:readBookmarks(),
    settingsUpdatedAt:Number(localStorage.getItem(SETTINGS_UPDATED_KEY)||0),
    lastTrackId:localStorage.getItem('lyra-last-id')||'',
    selectedBook:state.selectedBook||'',
    settings:{speed:state.speed,fontSize:state.fontSize,delay:state.delay,
      bg:state.bgColor,panel:state.panelColor,accent:state.accentColor,artTheme:state.artTheme,uiTheme:state.uiTheme,themeMotion:state.themeMotion,fireflyIntensity:state.fireflyIntensity,
      linked:state.panelLinked,lyricsMax:state.lyricsMax,lyricsCentered:state.lyricsCentered,focusMode:state.focusMode,lineSpacing:state.lineSpacing,keepAwake:state.keepAwake,lockScreenMode:state.lockScreenMode,lockScreenSpeed:state.lockScreenSpeed},
    note:'僅書庫名稱、封面、播放進度及介面設定；不包含 MP3/LRC 音訊檔',
    skippedLargeCovers:skipped};
}
async function exportICloudState(){
  const button=$('syncExport');button.disabled=true;
  try{
    const snapshot=await makeSyncSnapshot();
    const data=new Blob([JSON.stringify(snapshot)],{type:'application/json'});
    const url=URL.createObjectURL(data);
    const a=document.createElement('a');a.href=url;a.download='Lyra_Sync.json';document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
    $('syncStatus').textContent=`已產生同步檔 · ${new Date().toLocaleString()} · ${snapshot.books.length} 本書；請在「檔案」App 確認保存到 iCloud Drive。`;
    toast(snapshot.skippedLargeCovers?`同步檔已匯出；${snapshot.skippedLargeCovers} 張過大封面未包含`:'同步檔已匯出；請放到 iCloud Drive');
  }catch(error){console.error('同步匯出失敗',error);toast('匯出失敗：'+(error?.message||error));}
  finally{button.disabled=false;}
}
function validateSyncSnapshot(data){
  if(!data||data.format!==SYNC_SCHEMA||!Array.isArray(data.books)||!Array.isArray(data.progress)||typeof data.settings!=='object'||!data.settings)throw new Error('這不是 Lyra iCloud 同步檔');
  if(data.books.length>10000||data.progress.length>300000)throw new Error('同步檔項目數異常');
  const books=[];const known=new Set();
  for(const entry of data.books){
    if(typeof entry.id!=='string'||entry.id.length>90||!normalizeBook(entry.id)||known.has(entry.id))continue;
    const title=normalizeBook(entry.title)||entry.id;
    const cover=typeof entry.cover==='string'&&entry.cover.length<3*MAX_COVER_BYTES&&/^data:image\/(?:jpeg|png|webp);base64,/i.test(entry.cover)?entry.cover:null;
    books.push({id:entry.id,title,createdAt:safeTimestamp(entry.createdAt)||0,updatedAt:safeTimestamp(entry.updatedAt),cover});known.add(entry.id);
  }
  const positions=[];
  for(const entry of data.progress){
    if(typeof entry.id!=='string'||entry.id.length>400)continue;
    const separator=entry.id.indexOf('\u0000');if(separator<1||!known.has(entry.id.slice(0,separator)))continue;
    const position=Number(entry.position);if(!Number.isFinite(position)||position<0||position>1e8)continue;
    positions.push({id:entry.id,position,ended:!!entry.ended,updatedAt:safeTimestamp(entry.updatedAt)});
  }
  const deletedBooks=Array.isArray(data.deletedBooks)?data.deletedBooks.filter(x=>x&&typeof x.id==='string'&&x.id.length<=90&&safeTimestamp(x.deletedAt)).map(x=>({id:x.id,deletedAt:safeTimestamp(x.deletedAt)})):[];
  const bookmarks=Array.isArray(data.bookmarks)?data.bookmarks.slice(0,2000).filter(x=>x && typeof x.id==='string'&&x.id.length<600&&typeof x.trackId==='string'&&x.trackId.length<450&&Number.isFinite(Number(x.position))&&Number(x.position)>=0&&Number(x.position)<1e8).map(x=>({...x,position:Number(x.position),excerpt:String(x.excerpt||'').slice(0,200),updatedAt:safeTimestamp(x.updatedAt),deletedAt:safeTimestamp(x.deletedAt)})):[];
  return {books,positions,deletedBooks,bookmarks,settings:data.settings,settingsUpdatedAt:safeTimestamp(data.settingsUpdatedAt),selectedBook:data.selectedBook,lastTrackId:data.lastTrackId,exportedAt:data.exportedAt};
}
async function importICloudState(file,{autoConfirm=false,quiet=false}={}){
  if(!file)return false;
  if(file.size>MAX_SYNC_BYTES){toast('同步檔超過 35MB，請檢查檔案');return false;}
  const button=$('syncImport');button.disabled=true;
  try{
    const snapshot=validateSyncSnapshot(JSON.parse(await file.text()));
    if(state.current&&!audio.paused){toast('請先暫停播放再匯入，避免正在播放的進度覆蓋另一台裝置',6200);return false;}
    const summary=`同步檔時間：${String(snapshot.exportedAt||'未知')}\n小說：${snapshot.books.length} 本\n播放記錄：${snapshot.positions.length} 章\n\n只合併較新的紀錄；不會自動刪除本機 MP3/LRC，也不會自動刪除另一台裝置上的小說。\n\n確定匯入？`;
    if(!autoConfirm&&!confirm(summary))return false;
    // Crucial: never call saveProgress() here. That would stamp a stale paused
    // chapter as newer and cause the incoming progress to be silently lost.
    state.suppressProgressWrites=true;
    let changed=0,older=0,skippedDeleted=0,booksChanged=0;
    try{
      const tombstones=loadDeletedBooks();
      for(const t of snapshot.deletedBooks){
        const local=await getStore('books',t.id);
        if(!local)tombstones[t.id]=Math.max(Number(tombstones[t.id])||0,t.deletedAt);
        // Do not silently delete an existing local novel or audio files.
      }
      writeDeletedBooks(tombstones);
      for(const item of snapshot.books){
        const deletedAt=Number(tombstones[item.id])||0;
        if(deletedAt && deletedAt>=item.updatedAt){skippedDeleted++;continue;}
        if(deletedAt && item.updatedAt>deletedAt){delete tombstones[item.id];writeDeletedBooks(tombstones);}
        const old=await getStore('books',item.id);
        const localStamp=safeTimestamp(old?.updatedAt);
        const remoteStamp=safeTimestamp(item.updatedAt);
        if(old && (remoteStamp===0 || localStamp>=remoteStamp))continue;
        let coverBlob=old?.coverBlob||null;
        if(item.cover){try{const response=await fetch(item.cover);const parsed=await response.blob();if(parsed.size<=MAX_COVER_BYTES)coverBlob=parsed;}catch(error){console.warn('略過無法解碼封面',error);}}
        await putStore('books',{...old,id:item.id,title:item.title,createdAt:old?.createdAt||item.createdAt||Date.now(),updatedAt:remoteStamp||Date.now(),coverBlob});
        revokeCover(item.id);booksChanged++;
      }
      for(const item of snapshot.positions){
        if(tombstones[item.id.split('\u0000')[0]])continue;
        const local=await getStore('progress',item.id);
        if(!local || item.updatedAt>safeTimestamp(local.updatedAt)){
          await putStore('progress',item);changed++;
        }else older++;
      }
      // Merge bookmarks by per-item timestamps, including deletion markers.
      if(snapshot.bookmarks?.length){
        const joined=new Map(readBookmarks().map(x=>[x.id,x]));
        for(const item of snapshot.bookmarks){
          const local=joined.get(item.id);
          if(!local || item.updatedAt>safeTimestamp(local.updatedAt))joined.set(item.id,item);
        }
        writeBookmarks([...joined.values()]);
      }
      const cfg=snapshot.settings;
      const localSettingsAt=safeTimestamp(localStorage.getItem(SETTINGS_UPDATED_KEY));
      if(snapshot.settingsUpdatedAt>localSettingsAt || (!snapshot.settingsUpdatedAt && !localSettingsAt)){
        if(Number.isFinite(Number(cfg.speed)))setSpeed(cfg.speed);
        if(Number.isFinite(Number(cfg.fontSize))){state.fontSize=bounded(Number(cfg.fontSize),14,38,21);localStorage.setItem('lyra-font',state.fontSize);document.documentElement.style.setProperty('--font-size',`${state.fontSize}px`);}
        if(Number.isFinite(Number(cfg.delay))){state.delay=bounded(Number(cfg.delay),-20,20,0);localStorage.setItem('lyra-delay',state.delay);renderOffsetLabel();}
        if([cfg.bg,cfg.panel,cfg.accent].every(isHex)){setTheme(cfg.bg,cfg.panel,cfg.accent,{linked:!!cfg.linked});setArtTheme(cfg.artTheme||'');setUITheme(cfg.uiTheme||'');}
        if(typeof cfg.lyricsMax==='boolean')setLyricsMax(cfg.lyricsMax,false);
        if(typeof cfg.lyricsCentered==='boolean')setLyricsCentered(cfg.lyricsCentered,false);
        if(Number.isFinite(Number(cfg.lineSpacing)))setLineSpacing(cfg.lineSpacing,false);
        if(typeof cfg.focusMode==='boolean')setFocusMode(cfg.focusMode,false);
        if(typeof cfg.keepAwake==='boolean')setKeepAwake(cfg.keepAwake,false);
        if(typeof cfg.themeMotion==='boolean')setThemeMotion(cfg.themeMotion,{persist:false});
        if(typeof cfg.fireflyIntensity==='string')setFireflyIntensity(cfg.fireflyIntensity,{persist:false});
        if(cfg.lockScreenMode==='standard'||cfg.lockScreenMode==='lyrics')setLockScreenMode(cfg.lockScreenMode,{persist:false});
        if(['fast','balanced','quiet'].includes(cfg.lockScreenSpeed))setLockScreenSpeed(cfg.lockScreenSpeed,{persist:false});
        if(snapshot.settingsUpdatedAt)localStorage.setItem(SETTINGS_UPDATED_KEY,String(snapshot.settingsUpdatedAt));
      }
      const prefer=typeof snapshot.selectedBook==='string'&&snapshot.books.some(b=>b.id===snapshot.selectedBook)?snapshot.selectedBook:state.selectedBook;
      await refreshLibrary(prefer);
      if(typeof snapshot.lastTrackId==='string'&&state.tracks.some(t=>t.id===snapshot.lastTrackId))localStorage.setItem('lyra-last-id',snapshot.lastTrackId);
      // The currently loaded audio must seek to the merged result, otherwise
      // pagehide/pause could write its previous timestamp back over the import.
      if(state.current){
        const merged=await getStore('progress',state.current.id);
        if(merged && Number.isFinite(audio.duration) && audio.duration>0){
          audio.currentTime=merged.ended?0:Math.max(0,Math.min(audio.duration-0.5,merged.position));
          updateProgressDisplay();updateLyrics(true);
        }
        $('playStatus').textContent='同步完成 · 已重新定位續聽位置';
      }
      $('syncStatus').textContent=`合併完成：新增/更新 ${booksChanged} 本書、${changed} 筆播放位置；保留 ${older} 筆較新本機位置；略過 ${skippedDeleted} 本曾刪除的舊備份小說。`;
      if(!quiet)toast(`iCloud 合併完成：更新 ${changed} 筆進度，舊資料不覆蓋新資料`,6000);
      return true;
    }finally{state.suppressProgressWrites=false;}
  }catch(error){console.error('同步匯入失敗',error);toast('匯入失敗：'+(error?.message||error),6000);return false;}
  finally{button.disabled=false;$('syncFile').value='';}
}


// ------------------------------
// PineTree v3.7.2: calm listening, centered lyrics and local storage tools.
// Offline data remains under the same IndexedDB name; do not clear on upgrades.
// ------------------------------
function setLineSpacing(value,mark=true){
  state.lineSpacing=bounded(Number(value),1.4,2.6,1.85);
  document.documentElement.style.setProperty('--lyric-line-height',String(state.lineSpacing));
  $('lineSpacing').value=String(state.lineSpacing);
  $('lineSpacingLabel').textContent=state.lineSpacing.toFixed(2);
  localStorage.setItem('pinetree-line-spacing',String(state.lineSpacing));
  if(mark)markSettingsChanged();
  requestAnimationFrame(()=>{syncLyricsViewportPadding();updateLyrics(true);});
}
async function releaseWakeLock(){try{if(state.wakeLock)await state.wakeLock.release();}catch(_){}state.wakeLock=null;}
async function requestWakeLock(){
  if(!state.keepAwake||!state.focusMode||document.hidden||state.wakeLock)return;
  if(!navigator.wakeLock?.request){toast('這個 iOS 版本暫不支援網頁螢幕常亮；仍可使用專注模式');return;}
  try{state.wakeLock=await navigator.wakeLock.request('screen');}
  catch(err){console.warn('Screen Wake Lock 不可用',err);toast('螢幕常亮被系統拒絕，可在 iPhone 設定內調整自動鎖定');}
}
function setFocusMode(value,mark=true){
  state.focusMode=!!value;
  document.body.classList.toggle('focus-reading',state.focusMode);
  const btn=$('focusToggle');btn.textContent=state.focusMode?'☘ 退出專注':'☘ 專注';
  btn.setAttribute('aria-pressed',String(state.focusMode));
  localStorage.setItem('pinetree-focus-mode',state.focusMode?'1':'0');
  if(state.focusMode)requestWakeLock();else releaseWakeLock();
  if(mark)markSettingsChanged();
  requestAnimationFrame(()=>updateLyrics(true));
}
function setKeepAwake(value,mark=true){
  state.keepAwake=!!value;$('keepAwake').checked=state.keepAwake;
  localStorage.setItem('pinetree-keep-awake',state.keepAwake?'1':'0');
  if(state.keepAwake)requestWakeLock();else releaseWakeLock();
  if(mark)markSettingsChanged();
}
function updateSleepUI(){
  const label=state.sleepEndChapter?'本章結束後停止':state.sleepDeadline?`剩餘 ${formatTime(Math.ceil((state.sleepDeadline-Date.now())/1000))}`:'定時器未開啟';
  $('sleepStatus').textContent=label;
  $('sleepDetail').textContent=state.sleepDeadline||state.sleepEndChapter?'已啟用：'+label+'。切換 App 或鎖屏後，iOS 可能延遲執行定時停止。':'目前尚未啟用。睡眠定時不會在重新啟動 App 後意外恢復。';
}
function stopSleepTimer(message='已取消睡眠定時'){
  state.sleepDeadline=0;state.sleepEndChapter=false;
  if(state.sleepInterval){clearInterval(state.sleepInterval);state.sleepInterval=null;}
  updateSleepUI();if(message)toast(message);
}
function checkSleepTimer(){
  if(state.sleepDeadline && Date.now()>=state.sleepDeadline){
    // Guard against paused audio being inadvertently restarted by other events.
    audio.pause();saveProgress();stopSleepTimer('定時時間已到，已暫停並保存續聽位置');
  }else if(state.sleepDeadline)updateSleepUI();
}
function chooseSleepTimer(value){
  stopSleepTimer('');
  if(value==='off'){toast('睡眠定時已取消');}
  else if(value==='chapter'){state.sleepEndChapter=true;toast('本章結束後自動停止');}
  else{
    const minutes=Number(value);
    if(![15,30,45,60].includes(minutes))return;
    state.sleepDeadline=Date.now()+minutes*60000;
    state.sleepInterval=setInterval(checkSleepTimer,1000);
    localStorage.setItem('pinetree-last-sleep-choice',String(minutes));
    toast(`已設置 ${minutes} 分鐘睡眠定時`);
  }
  updateSleepUI();closeDialog('sleepDialog');
}
function addBookmark(){
  if(!state.current){toast('請先選擇章節');return;}
  const sec=Math.max(0,Math.floor(audio.currentTime||0));
  const line=state.lineIndex>=0?state.lines[state.lineIndex]?.text||'':'';
  const id=state.current.id+'\u0001'+sec;
  const items=readBookmarks().filter(b=>b.id!==id);
  items.push({id,trackId:state.current.id,book:state.current.book,position:sec,excerpt:line.slice(0,200),updatedAt:Date.now(),deletedAt:0});
  if(writeBookmarks(items))toast(`已收藏 ${formatTime(sec)}${line?' · '+line.slice(0,18):''}`);
}
function removeBookmark(id){
  const items=readBookmarks();const entry=items.find(x=>x.id===id);
  if(!entry)return;
  entry.deletedAt=Date.now();entry.updatedAt=entry.deletedAt;
  if(writeBookmarks(items))renderBookmarks();
}
async function jumpBookmark(b){
  const track=state.tracks.find(t=>t.id===b.trackId);
  if(!track){toast('本機尚無該章節，先從 iCloud 匯入章節再使用書籤');return;}
  closeDialog('bookmarksDialog');
  if(state.current?.id!==track.id)await loadTrack(track,{autoplay:false});
  const position=Math.max(0,Number(b.position)||0);
  const seek=()=>{if(Number.isFinite(audio.duration)&&audio.duration>0){audio.currentTime=Math.min(position,Math.max(0,audio.duration-0.5));updateProgressDisplay();updateLyrics(true);}};
  if(audio.readyState>=1)seek();else audio.addEventListener('loadedmetadata',seek,{once:true});
  toast('已回到收藏位置；點播放開始聆聽');
}
function renderBookmarks(){
  const el=$('bookmarksList');el.replaceChildren();
  const items=readBookmarks().filter(x=>!x.deletedAt).sort((a,b)=>b.updatedAt-a.updatedAt);
  if(!items.length){const empty=document.createElement('p');empty.className='dialog-note';empty.textContent='尚未收藏。播放章節時點「☆ 收藏此句」即可新增。';el.append(empty);return;}
  for(const b of items){
    const card=document.createElement('div');card.className='bookmark-row';
    const jump=document.createElement('button');jump.className='bookmark-jump';jump.type='button';
    const track=state.tracks.find(t=>t.id===b.trackId);
    const title=document.createElement('strong');title.textContent=(track?.name||String(b.trackId).split('\u0000').pop()||'未匯入章節')+' · '+formatTime(b.position);
    const desc=document.createElement('small');desc.textContent=bookTitle(b.book)+' · '+(b.excerpt||'書籤位置');
    jump.append(title,desc);jump.addEventListener('click',()=>jumpBookmark(b));
    const remove=document.createElement('button');remove.type='button';remove.className='tiny-action';remove.textContent='移除';remove.title='刪除這個書籤';remove.addEventListener('click',()=>removeBookmark(b.id));
    card.append(jump,remove);el.append(card);
  }
}
async function quickResume(){
  if(!audio.paused){
    state.skipNextPauseAutoSync=true;
    state.skipNextPauseProgress=true;
    audio.pause();
  }
  // A fresh sync file is imported BEFORE selecting a chapter. Without permission we require a native file selection.
  if(typeof window.showDirectoryPicker==='function' && syncRestoreTask)await syncRestoreTask;
  if(!syncFolderHandle){$('syncQuickFile').click();return;}
  return resumeFromLinkedOrPickedFile();
}
async function quickResumeLocal(){
  const last=localStorage.getItem('lyra-last-id');
  const track=state.tracks.find(t=>t.id===last);
  if(!track){toast('尚無續聽章節；請先匯入 MP3 並選擇章節');return;}
  if(track.book!==state.selectedBook)await selectBook(track.book);
  if(state.current?.id!==track.id)await loadTrack(track,{autoplay:true});
  else await startPlayback();
}
function cleanupCandidates(book,keep){
  const tracks=sortedBookTracks(book);
  const protectedIds=new Set(keep>0?tracks.slice(-keep).map(x=>x.id):[]);
  if(state.current)protectedIds.add(state.current.id);
  return tracks.filter(t=>!protectedIds.has(t.id)&&state.progresses.get(t.id)?.ended&&t.audioPresent!==false);
}
async function previewCleanup(){
  const token=++state.cleanupPreviewToken;
  const el=$('cleanupEstimate');const book=state.selectedBook;
  if(!book){el.textContent='先選擇一本小說';$('cleanupRun').disabled=true;return;}
  const keep=Number($('cleanupKeep').value)||0;
  $('cleanupKeepLabel').textContent=String(keep);
  el.textContent='正在查詢 MP3 副本，請稍候…';$('cleanupRun').disabled=true;
  const entries=cleanupCandidates(book,keep);let count=0,bytes=0;
  for(let i=0;i<entries.length;i++){
    if(await hasAudioKey(entries[i].id)){count++;bytes+=Number(entries[i].bytes)||0;}
    if(token!==state.cleanupPreviewToken)return;
    if(i%60===0)await nextUIFrame();
  }
  if(token!==state.cleanupPreviewToken)return;
  el.textContent=`《${bookTitle(book)}》：可清理已聽完 MP3 ${count} 章，估計釋放 ${displayBytes(bytes)}。保護最後 ${keep} 章和目前正在播放章節。LRC／續聽時間／書籤保留。`;
  $('cleanupRun').disabled=count===0;
  return {count,bytes};
}
async function runCleanup(){
  if(state.cleanupRunning||state.importJob?.running)return;
  const book=state.selectedBook;const keep=Number($('cleanupKeep').value)||0;
  const candidates=cleanupCandidates(book,keep);const confirmed=await previewCleanup();
  if(!confirmed?.count)return;
  if(!confirm(`確定清理《${bookTitle(book)}》的 ${confirmed.count} 章已聽完 MP3 副本？\n估計釋放 ${displayBytes(confirmed.bytes)}。\n\n原始 iCloud MP3 不會刪除，但下次播放這些章節需重新匯入 MP3。`))return;
  state.cleanupRunning=true;for(const id of ['cleanupRun','cleanupPreview','cleanupClose'])$(id).disabled=true;
  $('cleanupProgress').hidden=false;let done=0,bytes=0,failed=0;
  try{
    for(const t of candidates){
      try{if(await hasAudioKey(t.id)){await removeAudioOnly(t);done++;bytes+=(Number(t.bytes)||0);}}
      catch(error){failed++;console.warn('清理失敗',t.name,error);}
      $('cleanupBar').value=candidates.length?Math.round((done+failed)/candidates.length*100):100;
      $('cleanupProgressTitle').textContent=`已處理 ${done+failed} / ${candidates.length} 章`;
      $('cleanupDetail').textContent=`已清理 ${done} 章 · 估計釋放 ${displayBytes(bytes)} · 失敗 ${failed}`;
      if((done+failed)%5===0)await nextUIFrame();
    }
    await refreshLibrary(book);
    toast(`已清理 ${done} 章 MP3；書籤、LRC 與播放記錄仍保留`);
  }finally{state.cleanupRunning=false;for(const id of ['cleanupPreview','cleanupClose'])$(id).disabled=false;await previewCleanup();}
}
function openReleaseNotes(force=false){
  if(force||localStorage.getItem(RELEASE_SEEN_KEY)!=='1'){
    openDialog('releaseDialog');localStorage.setItem(RELEASE_SEEN_KEY,'1');
  }
}

function setupEvents(){
  $('quickResume').addEventListener('click',quickResume);
  $('focusToggle').addEventListener('click',()=>setFocusMode(!state.focusMode));
  $('lineSpacing').addEventListener('input',e=>setLineSpacing(e.target.value));
  $('themeMotion').addEventListener('change',event=>setThemeMotion(event.target.checked));
  $('fireflyIntensity')?.addEventListener('change',event=>setFireflyIntensity(event.target.value));
  $('fireflyTrails')?.addEventListener('change',event=>setFireflyTrails(event.target.checked));
  $('calibrationPicker').addEventListener('click',event=>{const choice=event.target.closest('button.calibration-choice');if(choice)setCalibrationStyle(choice.dataset.calibrationStyle);});
  $('keepAwake').addEventListener('change',e=>setKeepAwake(e.target.checked));
  $('sleepOpen').addEventListener('click',()=>{updateSleepUI();openDialog('sleepDialog');});
  $('lockScreenOpen').addEventListener('click',()=>{refreshLockScreenControls();openDialog('lockScreenDialog');});
  $('lockScreenClose').addEventListener('click',()=>closeDialog('lockScreenDialog'));
  for(const input of document.querySelectorAll('input[name="lockScreenMode"]'))input.addEventListener('change',event=>setLockScreenMode(event.target.value));
  $('iosSingleButtonCompatibility')?.addEventListener('change',e=>setIOSSingleButtonCompatibility(e.target.checked));
  $('copyHeadphoneDiagnostic')?.addEventListener('click',async()=>{const value=headphoneActionLog.join('\n')||'無耳機媒體事件';try{await navigator.clipboard.writeText('PineTree 4.3.9.2 耳機事件診斷\n'+value);toast('耳機事件診斷已複製');}catch(_){toast('無法使用剪貼簿；請直接查看上方診斷文字');}});
  for(const input of document.querySelectorAll('input[name="lockScreenSpeed"]'))input.addEventListener('change',event=>setLockScreenSpeed(event.target.value));
  $('sleepClose').addEventListener('click',()=>closeDialog('sleepDialog'));
  for(const b of document.querySelectorAll('[data-sleep]'))b.addEventListener('click',()=>chooseSleepTimer(b.dataset.sleep));
  $('bookmarkAdd').addEventListener('click',addBookmark);
  $('bookmarkOpen').addEventListener('click',()=>{renderBookmarks();openDialog('bookmarksDialog');});
  $('bookmarkClose').addEventListener('click',()=>closeDialog('bookmarksDialog'));
  $('cleanupOpen').addEventListener('click',()=>{openDialog('cleanupDialog');previewCleanup();});
  $('cleanupKeep').addEventListener('input',()=>previewCleanup());
  $('cleanupPreview').addEventListener('click',previewCleanup);
  $('cleanupRun').addEventListener('click',runCleanup);
  $('cleanupClose').addEventListener('click',()=>closeDialog('cleanupDialog'));
  $('cleanupDialog').addEventListener('cancel',event=>{if(state.cleanupRunning)event.preventDefault();});
  $('releaseOpen').addEventListener('click',()=>openReleaseNotes(true));
  $('releaseClose').addEventListener('click',()=>closeDialog('releaseDialog'));
  $('releaseDismiss').addEventListener('click',()=>closeDialog('releaseDialog'));
  $('createBookForm').addEventListener('submit',createBook);
  $('bookSelect').addEventListener('change',e=>selectBook(e.target.value));
  $('chapterSearch').addEventListener('input',e=>{state.chapterQuery=e.target.value;drawChapterList();});
  $('episodeSelectMode').addEventListener('click',()=>setEpisodeSelectionMode(!state.episodeSelectionMode));
  $('episodeSelectVisible').addEventListener('click',selectVisibleEpisodes);
  $('episodeClearSelection').addEventListener('click',clearEpisodeSelection);
  $('episodeDeleteSelected').addEventListener('click',deleteSelectedEpisodes);
  $('jumpCurrentBtn').addEventListener('click',jumpToCurrent);
  for(const id of ['bookManagerOpen','bookManagerOpenSecondary'])$(id).addEventListener('click',()=>openDialog('bookManager'));
  $('bookManagerClose').addEventListener('click',()=>closeDialog('bookManager'));
  $('themeOpen').addEventListener('click',()=>openDialog('themeDialog'));
  $('cloudOpen').addEventListener('click',()=>openDialog('syncDialog'));
  $('syncOpenSecondary').addEventListener('click',()=>{closeDialog('bookManager');openDialog('syncDialog');});
  $('syncClose').addEventListener('click',()=>closeDialog('syncDialog'));
  $('syncExport').addEventListener('click',exportICloudState);
  $('syncImport').addEventListener('click',()=>$('syncFile').click());
  $('syncFolderConnect').addEventListener('click',connectSyncFolder);
  $('syncWriteNow').addEventListener('click',verifyAndWriteSyncNow);
  $('syncLiveIndicator').addEventListener('click',()=>openDialog('syncDialog'));
  $('syncQuickFile').addEventListener('change',event=>onQuickSyncFileSelected(event.target.files?.[0]));
  $('syncFile').addEventListener('change',event=>importICloudState(event.target.files?.[0]));
  $('themeClose').addEventListener('click',()=>closeDialog('themeDialog'));
  for(const id of ['bookManager','themeDialog','syncDialog','sleepDialog','bookmarksDialog','cleanupDialog','releaseDialog','lockScreenDialog'])$(id).addEventListener('click',e=>{if(e.target===$(id))closeDialog(id);});
  $('mobileTabChapters').addEventListener('click',()=>{if(state.lyricsMax)setLyricsMax(false);setMobileTab('chapters',true);});
  $('mobileTabPlayer').addEventListener('click',()=>setMobileTab('player',true));
  $('importBtn').addEventListener('click',()=>{setImportPickerHint(true);$('filePicker').click();navigator.storage?.persist?.().catch(()=>{});});
  $('folderBtn').addEventListener('click',()=>{setImportPickerHint(true);$('folderPicker').click();navigator.storage?.persist?.().catch(()=>{});});
  $('filePicker').addEventListener('change',event=>importFiles(event.target.files));
  $('folderPicker').addEventListener('change',event=>importFiles(event.target.files));
  for(const id of ['filePicker','folderPicker'])$(id).addEventListener('cancel',()=>setImportPickerHint(false));
  $('cancelImport').addEventListener('click',cancelImport);
  $('closeImport').addEventListener('click',closeImportUI);
  $('downloadImportReport').addEventListener('click',downloadImportReport);
  $('coverBtn').addEventListener('click',()=>$('coverPicker').click());
  $('renameBookBtn').addEventListener('click',renameBook);
  $('lyricsCenterToggle').addEventListener('click',()=>setLyricsCentered(!state.lyricsCentered));
  $('toggleLyricsMax').addEventListener('click',()=>setLyricsMax(!state.lyricsMax));
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.lyricsMax)setLyricsMax(false);});
  $('importDialog').addEventListener('cancel',event=>{if(state.importJob?.running){event.preventDefault();cancelImport();}});
  $('coverPicker').addEventListener('change',event=>setCover(event.target.files?.[0]));
  $('deleteBookBtn').addEventListener('click',deleteBook);
  $('deleteBtn').addEventListener('click',deleteCurrent);
  $('forestDeleteShortcut').addEventListener('click',()=>{if(!$('deleteBtn').disabled)$('deleteBtn').click();});
  $('libraryJumpBtn').addEventListener('click',()=>{if(state.lyricsMax)setLyricsMax(false);setMobileTab('chapters',true);jumpToCurrent();});
  $('playBtn').addEventListener('click',()=>audio.paused?startPlayback():audio.pause());
  $('prevBtn').addEventListener('click',()=>adjacentTrack(-1));$('nextBtn').addEventListener('click',()=>adjacentTrack(1));
  $('backBtn').addEventListener('click',()=>skipSeconds(-15));$('aheadBtn').addEventListener('click',()=>skipSeconds(15));
  $('seekBar').addEventListener('input',()=>{state.seeking=true;const value=Number($('seekBar').value);$('elapsed').textContent=formatTime((audio.duration||0)*value/1000);const pos=Math.max(0,Math.min(100,value/10))+'%';$('seekBar').style.setProperty('--seek-progress',pos);$('seekScene')?.style.setProperty('--seek-progress',pos);});
  $('seekBar').addEventListener('change',()=>{if(Number.isFinite(audio.duration)&&audio.duration>0)audio.currentTime=audio.duration*Number($('seekBar').value)/1000;state.seeking=false;updateProgressDisplay();updateLyrics();saveProgress();});
  $('speedRange').addEventListener('input',event=>{setSpeed(event.target.value);markSettingsChanged();});
  for(const preset of document.querySelectorAll('[data-speed-preset]'))preset.addEventListener('click',()=>{setSpeed(preset.dataset.speedPreset);markSettingsChanged();});
  $('bgColor').addEventListener('input',event=>{setBackground(event.target.value);markSettingsChanged();});
  $('panelColor').addEventListener('input',event=>{setPanelColor(event.target.value);markSettingsChanged();});
  $('accentColor').addEventListener('input',event=>{setAccentColor(event.target.value);markSettingsChanged();});
  $('linkPanels').addEventListener('change',event=>{setArtTheme('');setUITheme('');state.panelLinked=event.target.checked;setTheme(state.bgColor,state.panelLinked?autoPanel(state.bgColor):state.panelColor,state.accentColor,{linked:state.panelLinked});markSettingsChanged();});
  $('resetColor').addEventListener('click',()=>{setArtTheme('');setTheme(DEFAULT_BG,DEFAULT_PANEL,DEFAULT_ACCENT,{linked:true});
  setUITheme('forest-reading');markSettingsChanged();});
  $('restorePreviousTheme').addEventListener('click',()=>{restorePreviousTheme();markSettingsChanged();});
  for(const btn of document.querySelectorAll('.theme-preset'))btn.addEventListener('click',()=>{setTheme(btn.dataset.page,btn.dataset.panel,btn.dataset.accent,{linked:true});setArtTheme(btn.dataset.artTheme||'');setUITheme(btn.dataset.uiTheme||'');markSettingsChanged();});
  $('fontMinus').addEventListener('click',()=>changeFont(-2));$('fontPlus').addEventListener('click',()=>changeFont(2));
  $('offsetMinus').addEventListener('click',()=>changeDelay(-.5));$('offsetPlus').addEventListener('click',()=>changeDelay(.5));
  $('lyricsWindow').addEventListener('click',event=>{const line=event.target.closest('.lyric-line');if(!line||!state.current)return;const i=Number(line.dataset.index);audio.currentTime=Math.max(0,state.lines[i].time+state.delay);state.userScrollUntil=0;updateLyrics(true);saveProgress();});
  const stopFollow=()=>{
    if(!state.lyricsCentered)return;
    state.userScrollUntil=Date.now()+6000;
    clearTimeout(state.followResumeTimer);
    state.followResumeTimer=setTimeout(()=>{
      if(state.lyricsCentered&&Date.now()>=state.userScrollUntil)updateLyrics(true);
    },6100);
  };
  $('lyricsWindow').addEventListener('touchstart',stopFollow,{passive:true});
  $('lyricsWindow').addEventListener('wheel',stopFollow,{passive:true});
  audio.addEventListener('loadedmetadata',()=>{updateProgressDisplay();updateMediaPosition();updateMediaSession();});
  audio.addEventListener('seeked',()=>{updateMediaSession(true);updateMediaPosition(true);});
  audio.addEventListener('timeupdate',()=>{checkSleepTimer();updateProgressDisplay();updateLyrics();updateMediaSession();if(!audio.paused&&Date.now()-state.lastSave>2000){state.lastSave=Date.now();saveProgress();}updateMediaPosition();});
  audio.addEventListener('play',()=>{requestPlaybackAudioSession();setPlayButtonVisual(true);$('playStatus').textContent='正在播放';updateMediaSession();try{if('mediaSession'in navigator)navigator.mediaSession.playbackState='playing';}catch(_){};});
  audio.addEventListener('pause',()=>{setPlayButtonVisual(false);$('playBtn').setAttribute('aria-label','播放');const skipSync=!!state.skipNextPauseAutoSync;state.skipNextPauseAutoSync=false;let commit=Promise.resolve();const skipProgress=!!state.skipNextPauseProgress;state.skipNextPauseProgress=false;if(state.current){$('playStatus').textContent=audio.ended?'本章已结束':'已暂停';if(!skipProgress)commit=saveProgress(audio.ended);}if(!skipSync&&!state.suppressProgressWrites)Promise.resolve(commit).then(queuePauseSyncExport).catch(e=>console.warn('暫停進度提交失敗',e));try{if('mediaSession'in navigator)navigator.mediaSession.playbackState='paused';}catch(_){};});
  audio.addEventListener('ratechange',updateMediaPosition);
  audio.addEventListener('ended',async()=>{if(!state.current)return;await saveProgress(true);if(state.sleepEndChapter){stopSleepTimer('本章播放完成，睡眠定時已停止');return;}const list=sortedBookTracks(state.current.book);const i=list.findIndex(x=>x.id===state.current.id);if(i>=0&&i<list.length-1)await loadTrack(list[i+1],{autoplay:true});else{$('playStatus').textContent='本书已播放完毕';drawChapterList();}});
  audio.addEventListener('error',()=>{if(state.current&&audio.src){$('playStatus').textContent='音频无法播放';toast('MP3 无法播放，请确认音频格式有效');}});
  window.addEventListener('online',updateNetwork);window.addEventListener('offline',updateNetwork);
  document.addEventListener('visibilitychange',()=>{document.body.dataset.pageVisible=document.hidden?'false':'true';if(document.hidden){saveProgress();releaseWakeLock();}else{checkSleepTimer();requestPlaybackAudioSession();requestWakeLock();setupMediaSession();updateMediaSession();updateMediaPosition();refreshLockScreenControls();syncLyricsViewportPadding();updateLyrics(true);}});window.addEventListener('pagehide',()=>saveProgress());window.addEventListener('pageshow',()=>{requestPlaybackAudioSession();setupMediaSession();updateMediaPosition();});
  window.addEventListener('resize',()=>requestAnimationFrame(()=>{syncLyricsViewportPadding();updateLyrics(true);if(window.innerWidth>850&&!document.body.classList.contains('lyrics-maximized'))scrollActiveChapter();}));
  if(typeof ResizeObserver!=='undefined'){
    let lastHeight=0;
    const lyricResizeObserver=new ResizeObserver(()=>{
      const height=$('lyricsWindow').clientHeight;
      if(height===lastHeight)return;
      lastHeight=height;
      requestAnimationFrame(()=>{syncLyricsViewportPadding();updateLyrics(true);});
    });
    lyricResizeObserver.observe($('lyricsWindow'));
  }
}



// v4.0: a presentation-only alternative to the original library layout.
// No second audio element, no new IndexedDB stores, no copy of MP3 or LRC.
function setImmersiveMode(enabled,{persist=true}={}){
  if(enabled && state.lyricsMax)setLyricsMax(false);
  state.immersive=!!enabled;
  document.body.classList.toggle('immersive-active',state.immersive);
  $('immersiveMode').hidden=!state.immersive;
  $('immersiveEnter').setAttribute('aria-pressed',String(state.immersive));
  $('immersiveEnterSecondary').setAttribute('aria-pressed',String(state.immersive));
  if(persist)localStorage.setItem('pinetree-immersive-v4101',state.immersive?'1':'0');
  if(state.immersive){state.immersiveLastLyricKey='';updateImmersiveUI(true);}
  else requestAnimationFrame(()=>{syncLyricsViewportPadding();updateLyrics(true);});
}
function updateImmersiveInfo(){
  const book=state.current?.book||state.selectedBook;
  $('imBookTitle').textContent=book?bookTitle(book):'請先從書庫匯入或選擇小說';
  $('imChapterTitle').textContent=state.current?chapterDisplayName(state.current.name):'在月光與松林之間，聽見故事';
  const ready=!!state.current&&!!state.fileUrl&&!!audio.src;
  for(const id of ['imPlay','imPrev','imNext','imBack','imAhead','imSeek'])$(id).disabled=!ready;
}
function renderImmersiveLyrics(force=false){
  if(!state.immersive&&!force)return;
  const target=$('imLyrics');
  const lines=state.lines||[];
  const ix=lines.length?lyricIndex((Number(audio.currentTime)||0)-state.delay):-1;
  const key=(state.current?.id||'')+':'+ix+':'+lines.length;
  if(!force&&state.immersiveLastLyricKey===key)return;
  state.immersiveLastLyricKey=key;
  target.replaceChildren();
  if(!lines.length){const empty=document.createElement('p');empty.className='im-lyric-empty';empty.textContent=state.current?'此章沒有 LRC 時間軸字幕；音訊仍可正常播放。':'選擇章節後，同步字幕會在這裡顯示。';target.append(empty);return;}
  const n=ix>=0?ix:0;
  const from=Math.max(0,n-2),to=Math.min(lines.length,n+3);
  for(let i=from;i<to;i++){
    const line=lines[i];
    const btn=document.createElement('button');
    btn.type='button';
    btn.className='im-lyric'+(i===ix?' active':i<ix?' previous':' upcoming');
    btn.dataset.index=String(i);
    btn.textContent=line.text;
    btn.title=formatTime(line.time)+' · 點擊跳轉';
    btn.setAttribute('aria-label',`${formatTime(line.time)} ${line.text}`);
    target.append(btn);
  }
}
function updateImmersiveUI(force=false){
  if(!state.immersive&&!force)return;
  updateImmersiveInfo();
  const duration=Number.isFinite(audio.duration)?audio.duration:0;
  const current=Number.isFinite(audio.currentTime)?audio.currentTime:0;
  $('imElapsed').textContent=formatTime(current);
  $('imDuration').textContent=formatTime(duration);
  const percent=duration>0?Math.max(0,Math.min(100,current/duration*100)):0;
  const slider=$('imSeek');
  if(slider.dataset.dragging!=='1')slider.value=String(Math.round(percent*10));
  if(slider.dataset.dragging!=='1'){slider.style.setProperty('--im-percent',percent.toFixed(3)+'%');$('imProgressScene').style.setProperty('--im-percent',percent.toFixed(3)+'%');}
  const playing=!audio.paused&&!audio.ended;
  $('imPlay').dataset.playing=String(playing);
  $('imPlay').setAttribute('aria-label',playing?'暫停':'播放');
  $('imSpeed').value=String(state.speed);
  $('imSpeedLabel').textContent=state.speed.toFixed(2)+'×';
  for(const b of document.querySelectorAll('[data-im-speed]')){
    b.setAttribute('aria-pressed',String(Math.abs(Number(b.dataset.imSpeed)-state.speed)<.026));
  }
  $('imProgressCaption').textContent=playing?'✦ 正在聆聽 · 進度自動儲存':audio.ended?'✧ 本章已聽完':'✧ 暫停中 · 可接著聽';
  renderImmersiveLyrics(force);
}
function setupImmersiveEvents(){
  $('immersiveEnter').addEventListener('click',()=>setImmersiveMode(true));
  $('mobileImmersiveEnter').addEventListener('click',()=>setImmersiveMode(true));
  $('immersiveEnterSecondary').addEventListener('click',()=>setImmersiveMode(true));
  $('imExit').addEventListener('click',()=>setImmersiveMode(false));
  $('imChapters').addEventListener('click',()=>{setImmersiveMode(false);setMobileTab('chapters',true);requestAnimationFrame(jumpToCurrent);});
  $('imText').addEventListener('click',()=>{setImmersiveMode(false);setMobileTab('player',true);});
  $('imTheme').addEventListener('click',()=>openDialog('themeDialog'));
  $('imCloud').addEventListener('click',()=>openDialog('syncDialog'));
  $('imSleep').addEventListener('click',()=>openDialog('sleepDialog'));
  $('imBookmark').addEventListener('click',addBookmark);
  $('imBookmarkList').addEventListener('click',()=>openDialog('bookmarksDialog'));
  $('imPlay').addEventListener('click',()=>audio.paused?startPlayback():audio.pause());
  $('imPrev').addEventListener('click',()=>adjacentTrack(-1));
  $('imNext').addEventListener('click',()=>adjacentTrack(1));
  $('imBack').addEventListener('click',()=>skipSeconds(-15));
  $('imAhead').addEventListener('click',()=>skipSeconds(15));
  $('imSeek').addEventListener('input',event=>{event.target.dataset.dragging='1';const d=audio.duration||0;$('imElapsed').textContent=formatTime(d*Number(event.target.value)/1000);event.target.style.setProperty('--im-percent',(Number(event.target.value)/10)+'%');$('imProgressScene').style.setProperty('--im-percent',(Number(event.target.value)/10)+'%');});
  const commitSeek=event=>{if(Number.isFinite(audio.duration)&&audio.duration>0)audio.currentTime=audio.duration*Number(event.target.value)/1000;event.target.dataset.dragging='0';updateLyrics(true);updateImmersiveUI(true);saveProgress();};
  $('imSeek').addEventListener('change',commitSeek);
  $('imSpeed').addEventListener('input',event=>{setSpeed(event.target.value);markSettingsChanged();updateImmersiveUI();});
  for(const button of document.querySelectorAll('[data-im-speed]'))button.addEventListener('click',()=>{setSpeed(button.dataset.imSpeed);markSettingsChanged();updateImmersiveUI(true);});
  $('imLyrics').addEventListener('click',event=>{const btn=event.target.closest('[data-index]');if(!btn||!state.current)return;const line=state.lines[Number(btn.dataset.index)];if(!line)return;audio.currentTime=Math.max(0,line.time+state.delay);updateLyrics(true);updateImmersiveUI(true);saveProgress();});
  audio.addEventListener('timeupdate',()=>updateImmersiveUI());
  for(const evt of ['play','pause','loadedmetadata','ratechange','ended','seeked'])audio.addEventListener(evt,()=>updateImmersiveUI(true));
  const titleObserver=new MutationObserver(()=>{if(state.immersive){state.immersiveLastLyricKey='';updateImmersiveUI(true);}});
  titleObserver.observe($('currentTitle'),{childList:true,characterData:true,subtree:true});
  titleObserver.observe($('currentBook'),{childList:true,characterData:true,subtree:true});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.immersive&&!document.querySelector('dialog[open]'))setImmersiveMode(false);});
}

async function registerSW(){ /* resource bootstrap owns service worker registration */ }
window.PineTreeBeforeResourceReload=async function(manual){
 if(state.importJob||state.episodeDeleteRunning||state.suppressProgressWrites)return false;
 if(!audio.paused){if(!manual||!confirm('刷新資源需要暫停播放。儲存目前進度後重新載入？'))return false;audio.pause();}
 await saveProgress();return true;
};
async function start(){
  syncRestoreTask=restoreSyncFolder().catch(error=>console.warn("恢復同步資料夾授權失敗",error));
  const oneButton=$('iosSingleButtonCompatibility');if(oneButton)oneButton.checked=state.iosSingleButtonCompatibility;
  setupEvents();setupImmersiveEvents();requestPlaybackAudioSession();setupMediaSession();updateNetwork();installThemeParticles();setThemeMotion(state.themeMotion,{persist:false});setFireflyIntensity(state.fireflyIntensity,{persist:false});setCalibrationStyle(state.calibrationStyle,{persist:false});setFireflyTrails(state.fireflyTrails,{persist:false});setPlayButtonVisual(false);
  setMobileTab(localStorage.getItem('lyra-mobile-tab')==='chapters'?'chapters':'player');
  setImmersiveMode(state.immersive,{persist:false});
  setLineSpacing(state.lineSpacing,false);setKeepAwake(state.keepAwake,false);setFocusMode(state.focusMode,false);setLyricsCentered(state.lyricsCentered,false);updateSleepUI();
  setSpeed(state.speed);
  setLockScreenMode(state.lockScreenMode,{persist:false});
  migrateForestThemeOnce();
  const legacyBg=localStorage.getItem('lyra-bg-color');
  const savedPanel=localStorage.getItem('lyra-panel-color');
  const panel=savedPanel||((legacyBg&&legacyBg.toLowerCase()!==DEFAULT_BG.toLowerCase())?autoPanel(state.bgColor):DEFAULT_PANEL);
  setTheme(state.bgColor,panel,state.accentColor,{linked:state.panelLinked});
  setArtTheme(state.artTheme,false);
  setUITheme(state.uiTheme,false);
  updateRestoreOption();
  setLyricsMax(state.lyricsMax,false);
  document.documentElement.style.setProperty('--font-size',`${state.fontSize}px`);
  renderOffsetLabel();
  registerSW();
  try{
    state.db=await openDatabase();await migrateLegacyBooks();await refreshLibrary();
    await syncRestoreTask;await activateLinkedSyncAfterStartup();
    if(localStorage.getItem(RELEASE_SEEN_KEY)!=='1'){toast('PineTree v4.3.9.4：還原 v4.3.3 鎖屏 LRC 更新節奏、保留耳機事件診斷；書庫完整保留',6500);localStorage.setItem(RELEASE_SEEN_KEY,'1');}
    const interrupted=localStorage.getItem(IMPORT_CHECKPOINT_KEY);
    if(interrupted){try{const p=JSON.parse(interrupted);toast(`上次匯入可能中斷（${p.done||0}/${p.total||'?'} 組）；重新選相同文件可接續並略過已有章節`,8000);}catch{}localStorage.removeItem(IMPORT_CHECKPOINT_KEY);}
    const last=state.tracks.find(x=>x.id===localStorage.getItem('lyra-last-id'));
    if(last){state.selectedBook=last.book;localStorage.setItem('lyra-selected-book',last.book);drawBookGrid();drawChapterList();updateBookControls();await loadTrack(last,{autoplay:false});}
    else if(state.selectedBook){const candidates=sortedBookTracks(state.selectedBook);const savedId=localStorage.getItem('lyra-last-book-track:'+state.selectedBook);const previous=candidates.find(t=>t.id===savedId);if(previous)await loadTrack(previous,{autoplay:false});}
  }catch(error){console.error('数据库无法初始化',error);toast('无法打开离线书库，请允许网站储存数据并退出隐私浏览',6500);}
}

start();
