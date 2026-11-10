/* PineTree Lyra 3.3 · stable resumable imports and safe iCloud merges.
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
  loadingToken:0, seeking:false, lastSave:0, userScrollUntil:0, toastTimer:null,
  fontSize:bounded(storedNumber('lyra-font',21),14,38,21),
  delay:bounded(storedNumber('lyra-delay',0),-20,20,0),
  speed:bounded(storedNumber('lyra-speed',1),.5,3,1),
  bgColor:/^#[0-9a-fA-F]{6}$/.test(localStorage.getItem('lyra-bg-color')||'') ? localStorage.getItem('lyra-bg-color') : DEFAULT_BG,
  lyricsMax:localStorage.getItem('lyra-lyrics-max')==='1',
  panelLinked:localStorage.getItem('lyra-panel-linked')!=='0',
  panelColor:/^#[0-9a-fA-F]{6}$/.test(localStorage.getItem('lyra-panel-color')||'') ? localStorage.getItem('lyra-panel-color') : DEFAULT_PANEL,
  accentColor:/^#[0-9a-fA-F]{6}$/.test(localStorage.getItem('lyra-accent-color')||'') ? localStorage.getItem('lyra-accent-color') : DEFAULT_ACCENT,
  chapterQuery:'', mobileTab:'player', listDrawBook:null, listDrawQuery:'',
  importJob:null, suppressProgressWrites:false, importReport:[],
};
const normalizeBook = value => (value || '').trim().normalize('NFC').replace(/\u0000/g,'').slice(0,90);
const stem = name => name.replace(/^.*[\\/]/,'').replace(/\.(mp3|lrc)$/i,'').normalize('NFC').trim().toLocaleLowerCase();
const readableStem = name => name.replace(/^.*[\\/]/,'').replace(/\.(mp3|lrc)$/i,'').trim();
const trackId = (book, name) => `${book}\u0000${stem(name)}`;
const DELETED_BOOKS_KEY='pinetree-deleted-books-v33';
const IMPORT_CHECKPOINT_KEY='pinetree-import-checkpoint-v33';
const SETTINGS_UPDATED_KEY='pinetree-settings-updated-v33';
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
function putTrackAndAudio(meta,file){return new Promise((resolve,reject)=>{const tx=state.db.transaction(['tracks','audio'],'readwrite');tx.objectStore('tracks').put(meta);if(file)tx.objectStore('audio').put({id:meta.id,blob:file});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
function deleteTrackData(id){return new Promise((resolve,reject)=>{const tx=state.db.transaction(['tracks','audio','progress'],'readwrite');for(const store of ['tracks','audio','progress'])tx.objectStore(store).delete(id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
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
function setLyricsMax(value, persist=true){
  state.lyricsMax=!!value;
  document.body.classList.toggle('lyrics-maximized',state.lyricsMax);
  const btn=$('toggleLyricsMax');
  btn.textContent=state.lyricsMax?'⇲ 返回':'⛶ 最大化';
  btn.setAttribute('aria-pressed',String(state.lyricsMax));
  btn.title=state.lyricsMax?'退出字幕最大化':'字幕最大化';
  if(persist){localStorage.setItem('lyra-lyrics-max',state.lyricsMax?'1':'0');markSettingsChanged();}
  requestAnimationFrame(()=>updateLyrics(true));
}
async function refreshLibrary(preferred){const [books,tracks,progress]=await Promise.all([getStore('books'),getStore('tracks'),getStore('progress')]);state.books=books.sort((a,b)=>COLLATOR.compare(a.title||a.id,b.title||b.id));state.tracks=tracks;state.progresses=new Map(progress.map(x=>[x.id,x]));const want=preferred!==undefined?preferred:(state.selectedBook||localStorage.getItem('lyra-selected-book'));state.selectedBook=state.books.some(b=>b.id===want)?want:(state.books[0]?.id||null);if(state.selectedBook)localStorage.setItem('lyra-selected-book',state.selectedBook);else localStorage.removeItem('lyra-selected-book');if(state.current&&!state.tracks.some(t=>t.id===state.current.id))clearCurrent('请选择章节开始播放');drawBookGrid();drawChapterList();updateBookControls();updateStoryArt();updateBookBrand();}
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
function drawChapterList(){
  const list=$('chapterList');
  const keepScroll=state.listDrawBook===state.selectedBook&&state.listDrawQuery===state.chapterQuery;
  const previousScroll=keepScroll?list.scrollTop:0;
  list.replaceChildren();
  state.listDrawBook=state.selectedBook;state.listDrawQuery=state.chapterQuery;
  const all=state.selectedBook?sortedBookTracks(state.selectedBook):[];
  const query=state.chapterQuery.toLocaleLowerCase().trim();
  const tracks=query?all.filter((t,i)=>t.name.toLocaleLowerCase().includes(query)||String(i+1).includes(query)):all;
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
    const btn=document.createElement('button');btn.type='button';btn.className='chapter-item'+(state.current?.id===t.id?' active':'');btn.title=t.name;btn.dataset.trackId=t.id;
    const num=document.createElement('span');num.className='chapter-no';num.textContent=String(indices.get(t.id)).padStart(3,'0');
    const info=document.createElement('span');info.className='chapter-info';
    const name=document.createElement('span');name.className='chapter-title';name.textContent=t.name;
    const sub=document.createElement('span');sub.className='chapter-subtitle';
    const p=state.progresses.get(t.id);
    sub.textContent=(t.hasLrc?'LRC 同步字幕':'仅 MP3')+(p?.ended?' · 已听完':p?.position>1?` · 续听 ${formatTime(p.position)}`:'');
    const sym=document.createElement('span');sym.className='note-icon';sym.textContent=state.current?.id===t.id?'▶':t.hasLrc?'♫':'♪';
    info.append(name,sub);btn.append(num,info,sym);
    btn.addEventListener('click',()=>loadTrack(t,{autoplay:true}));fragment.append(btn);
  });
  list.append(fragment);
  list.scrollTop=previousScroll;
}
function scrollActiveChapter(){
  const node=Array.from($('chapterList').children).find(el=>el.dataset.trackId===state.current?.id);
  if(node)node.scrollIntoView({behavior:'instant',block:'nearest'});
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
  $('importCounters').textContent=`新增 ${job.added} · 更新 ${job.updated} · 略過 ${job.skipped} · 失敗 ${job.failed}`;
  $('importElapsed').textContent=`已耗時 ${Math.floor((Date.now()-job.startedAt)/1000)} 秒`;
  if(job.total){localStorage.setItem(IMPORT_CHECKPOINT_KEY,JSON.stringify({book:job.book,done:job.done,total:job.total,startedAt:job.startedAt}));}
}
function closeImportUI(){if(state.importJob?.running)return;closeDialog('importDialog');}
function cancelImport(){const job=state.importJob;if(!job||!job.running)return;job.cancelled=true;$('cancelImport').disabled=true;reportImportStatus(job,'正在安全停止…','完成當前檔案寫入後停止，已成功匯入的章節不會消失。');}
function importReportText(job){
  return [
    `PineTree v3.3 匯入報告 · ${new Date().toLocaleString()}`,
    `小說：${bookTitle(job.book)} · 狀態：${job.cancelled?'使用者取消':'完成'}`,
    `檔案：${job.fileCount} · 章節組：${job.total}`,
    `新增：${job.added}；更新：${job.updated}；已存在略過：${job.skipped}；孤立字幕：${job.orphans}；跳過 Read：${job.excludedRead}；失敗：${job.failed}`,
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
  const job={book,running:true,cancelled:false,total:0,done:0,added:0,updated:0,skipped:0,failed:0,orphans:0,excludedRead:0,report:[],startedAt:Date.now(),fileCount:fileList?.length||0};
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
      if(/\.mp3$/i.test(file.name))group.mp3=file;else group.lrc=file;
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
          const hasStoredAudio=signatureMatches?!!(await getStore('audio',group.id)) :false;
          const sameAudio=signatureMatches&&hasStoredAudio;
          let writeAudio=!!group.mp3&&(!old||force||!sameAudio);
          let updateMeta=!old||writeAudio||lyricsChanged;
          if(!updateMeta){job.skipped++;processed++;}
          else{
            const meta={...old,id:group.id,book:group.book,name:group.name,
              hasLrc:freshLrc!==null?!!freshLrc:!!old?.hasLrc,
              lrcText:freshLrc!==null?freshLrc:(old?.lrcText||''),
              bytes:writeAudio?group.mp3.size:(old?.bytes||0),
              mp3Signature:writeAudio?signature:(old?.mp3Signature||null),
              updatedAt:Date.now()};
            if(writeAudio)await putTrackAndAudio(meta,group.mp3);
            else await putStore('tracks',meta);
            if(old)job.updated++;else job.added++;
            if(state.current?.id===group.id){state.current=meta;displayLyrics(meta.lrcText);}
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
function displayLyrics(lrc){state.lines=parseLRC(lrc);state.lineIndex=-1;const container=$('lyricsWindow');container.replaceChildren();if(!state.lines.length){$('lrcState').textContent='· 无时间轴';displayPlaceholder('还没有同步文字','导入同名 .lrc 文件即可同步显示');return;}$('lrcState').textContent=`· ${state.lines.length} 行`;const frag=document.createDocumentFragment();state.lines.forEach((line,i)=>{const element=document.createElement('div');element.className='lyric-line';element.dataset.index=i;element.textContent=line.text;element.title=`${formatTime(line.time)} · 点击跳转`;frag.append(element);});container.append(frag);container.scrollTop=0;updateLyrics(true);}
function lyricIndex(time){let low=0,high=state.lines.length-1,result=-1;while(low<=high){const mid=(low+high)>>1;if(state.lines[mid].time<=time){result=mid;low=mid+1;}else high=mid-1;}return result;}
function updateLyrics(force=false){if(!state.lines.length)return;const idx=lyricIndex((Number(audio.currentTime)||0)-state.delay);if(idx===state.lineIndex&&!force)return;const lines=$('lyricsWindow').children;if(state.lineIndex>=0&&lines[state.lineIndex])lines[state.lineIndex].classList.remove('active');state.lineIndex=idx;if(idx>=0&&lines[idx]){const el=lines[idx];el.classList.add('active');if(Date.now()>=state.userScrollUntil){const win=$('lyricsWindow');win.scrollTo({top:Math.max(0,el.offsetTop-win.offsetTop-win.clientHeight*.42),behavior:force?'instant':'smooth'});}}}
async function saveProgress(ended=false){if(!state.db||!state.current||state.suppressProgressWrites)return;const id=state.current.id;const done=ended||audio.ended;const record={id,position:done?(Number(audio.duration)||0):(Number(audio.currentTime)||0),ended:done,updatedAt:Date.now()};state.progresses.set(id,record);try{await putStore('progress',record);}catch(error){console.warn('进度保存失败：',error);}}
function releaseAudio(){audio.pause();audio.removeAttribute('src');audio.load();if(state.fileUrl)URL.revokeObjectURL(state.fileUrl);state.fileUrl=null;}
function updateStoryArt(){const cover=$('currentCover'),fallback=$('storyArtFallback');const book=getBook(state.current?.book||state.selectedBook);const title=book?bookTitle(book.id):'选择一本小说';$('storyBookName').textContent=title;$('storyBookName').title=title;$('storyBookName').classList.toggle('long-title',title.length>15);const url=coverUrl(book);if(url){cover.src=url;cover.hidden=false;fallback.hidden=true;}else{cover.hidden=true;cover.removeAttribute('src');fallback.hidden=false;}}
function updateMediaSession(){if(!('mediaSession' in navigator)||!state.current)return;const book=getBook(state.current.book);const url=coverUrl(book);try{navigator.mediaSession.metadata=new MediaMetadata({title:state.current.name,artist:'PineTree 有聲書',album:bookTitle(state.current.book),artwork:url?[{src:url,type:'image/jpeg'}]:[{src:new URL('./icon-512.png?v=321',location.href).href,sizes:'512x512',type:'image/png'}]});}catch(error){console.warn('锁屏媒体信息无法更新',error);}}
function updateMediaPosition(){if(!('mediaSession' in navigator)||!navigator.mediaSession.setPositionState)return;if(!Number.isFinite(audio.duration)||audio.duration<=0)return;try{navigator.mediaSession.setPositionState({duration:audio.duration,playbackRate:audio.playbackRate,position:Math.max(0,Math.min(audio.duration,audio.currentTime))});}catch(_) {}}
function setupMediaSession(){if(!('mediaSession' in navigator))return;const handlers={play:()=>startPlayback(),pause:()=>audio.pause(),previoustrack:()=>adjacentTrack(-1),nexttrack:()=>adjacentTrack(1),seekbackward:({seekOffset}={})=>skipSeconds(-(seekOffset||15)),seekforward:({seekOffset}={})=>skipSeconds(seekOffset||15),seekto:({seekTime})=>{if(Number.isFinite(seekTime))audio.currentTime=seekTime;}};for(const [action,fn]of Object.entries(handlers))try{navigator.mediaSession.setActionHandler(action,fn);}catch(_) {}}
function clearCurrent(message='请选择章节'){++state.loadingToken;state.current=null;releaseAudio();state.lines=[];state.lineIndex=-1;localStorage.removeItem('lyra-last-id');$('currentBook').textContent=state.selectedBook?bookTitle(state.selectedBook):'READY TO LISTEN';$('currentTitle').textContent=message;$('chapterHint').textContent='从章节目录选择一章';$('playBtn').disabled=true;$('seekBar').disabled=true;$('deleteBtn').disabled=true;$('playBtn').textContent='▶';$('playStatus').textContent='未选章节';$('lrcState').textContent='· 暂无字幕';$('elapsed').textContent='00:00';$('duration').textContent='00:00';displayPlaceholder(message,'MP3 和 LRC 将保存在本机书库');updateStoryArt();updateBookBrand();drawChapterList();}
async function loadTrack(track,{autoplay=false,restart=false}={}){if(!track)return;const token=++state.loadingToken;if(state.current&&state.current.id!==track.id&&!audio.ended)await saveProgress();if(token!==state.loadingToken)return;releaseAudio();state.current=track;localStorage.setItem('lyra-last-id',track.id);localStorage.setItem('lyra-last-book-track:'+track.book,track.id);$('currentBook').textContent=bookTitle(track.book);$('currentTitle').textContent=track.name;$('chapterHint').textContent='自动保存续听进度 · 点击字幕可跳转';$('deleteBtn').disabled=false;$('playBtn').disabled=true;$('seekBar').disabled=true;$('playStatus').textContent='读取音频中…';displayLyrics(track.lrcText||'');updateStoryArt();updateBookBrand();drawChapterList();if(window.matchMedia('(max-width:850px)').matches)setMobileTab('player',true);else requestAnimationFrame(scrollActiveChapter);
  try{const [stored,progress]=await Promise.all([getStore('audio',track.id),getStore('progress',track.id)]);if(token!==state.loadingToken)return;if(!stored?.blob)throw new Error('本章 MP3 缺失，请重新导入');const resumeAt=restart||progress?.ended?0:Math.max(0,Number(progress?.position)||0);state.fileUrl=URL.createObjectURL(stored.blob);audio.src=state.fileUrl;audio.defaultPlaybackRate=state.speed;audio.playbackRate=state.speed;audio.load();$('playBtn').disabled=false;$('seekBar').disabled=false;updateMediaSession();let restored=false;const resume=()=>{if(token!==state.loadingToken||restored)return;const d=audio.duration;if(Number.isFinite(d)&&d>0){if(resumeAt>0&&resumeAt<d-1){try{audio.currentTime=resumeAt;}catch(_) {}}restored=true;updateProgressDisplay();updateLyrics(true);updateMediaPosition();}};if(audio.readyState>=1)resume();else{audio.addEventListener('loadedmetadata',resume,{once:true});audio.addEventListener('canplay',resume,{once:true});}$('playStatus').textContent=progress?.ended?'已听完 · 从头开始':resumeAt>1?`续听 ${formatTime(resumeAt)}`:'准备播放';if(autoplay)await startPlayback();}catch(error){if(token!==state.loadingToken)return;console.error(error);$('playBtn').disabled=true;$('seekBar').disabled=true;$('playStatus').textContent='音频读取失败';toast(`播放失败：${error.message||error}`);}}
async function startPlayback(){if(!state.current){toast('请先选择小说章节');return;}if(!audio.src){await loadTrack(state.current,{autoplay:false});}try{await audio.play();$('playStatus').textContent='正在播放';}catch(error){console.warn('系统阻止自动播放',error);$('playStatus').textContent='点击播放键继续';toast('iPhone 可能需要手动按播放；后台切章受 iOS 限制');}}
function skipSeconds(n){if(!state.current||!Number.isFinite(audio.duration))return;audio.currentTime=Math.max(0,Math.min(audio.duration,audio.currentTime+n));updateProgressDisplay();updateLyrics();saveProgress();}
function adjacentTrack(delta){const list=state.current?sortedBookTracks(state.current.book):[];const i=list.findIndex(t=>t.id===state.current?.id);if(i<0||!list[i+delta]){toast(delta>0?'这已是本书最后一章':'这已是本书第一章');return;}return loadTrack(list[i+delta],{autoplay:true});}
function updateProgressDisplay(){const cur=Number(audio.currentTime)||0,d=Number(audio.duration)||0;$('elapsed').textContent=formatTime(cur);$('duration').textContent=formatTime(d);if(!state.seeking)$('seekBar').value=d>0?String(Math.min(1000,Math.round(cur/d*1000))):'0';}
async function deleteCurrent(){if(!state.current)return;const track=state.current;if(!confirm(`只删除当前章节？\n\n${track.name}\n\n播放器内的 MP3/LRC 与续听记录会删除，「文件」App 原件不受影响。`))return;clearCurrent('这一章已删除');await deleteTrackData(track.id);if(localStorage.getItem('lyra-last-book-track:'+track.book)===track.id)localStorage.removeItem('lyra-last-book-track:'+track.book);await refreshLibrary(track.book);toast('章节已删除');}
function changeFont(delta){state.fontSize=bounded(state.fontSize+delta,14,38,21);document.documentElement.style.setProperty('--font-size',`${state.fontSize}px`);localStorage.setItem('lyra-font',state.fontSize);markSettingsChanged();updateLyrics(true);}
function changeDelay(delta){state.delay=bounded(Math.round((state.delay+delta)*2)/2,-20,20,0);localStorage.setItem('lyra-delay',state.delay);markSettingsChanged();$('offsetLabel').textContent=`${state.delay>0?'+':''}${state.delay.toFixed(1)}s`;updateLyrics(true);}
function setSpeed(value){state.speed=Math.round(bounded(Number(value),.5,3,1)*20)/20;audio.defaultPlaybackRate=state.speed;audio.playbackRate=state.speed;localStorage.setItem('lyra-speed',state.speed);$('speedRange').value=state.speed;$('speedLabel').textContent=`${state.speed.toFixed(2)}×`;updateMediaPosition();}
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
  for(const button of document.querySelectorAll('.theme-preset')){
    const active=[['page',page],['panel',panel],['accent',accent]].every(([key,value])=>button.dataset[key]?.toLowerCase()===value.toLowerCase());
    button.setAttribute('aria-pressed',String(active));
  }
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
  state.bgColor=DEFAULT_BG;state.panelColor=DEFAULT_PANEL;state.accentColor=DEFAULT_ACCENT;state.panelLinked=true;
  // Persist the new panel now, or start() could reload an old navy panel
  // from v3 localStorage and combine it with the new green page background.
  setTheme(DEFAULT_BG,DEFAULT_PANEL,DEFAULT_ACCENT,{linked:true});
}
function updateRestoreOption(){
  $('restorePreviousTheme').hidden=!localStorage.getItem(PRE_FOREST_BACKUP_KEY);
}
function restorePreviousTheme(){
  try{
    const previous=JSON.parse(localStorage.getItem(PRE_FOREST_BACKUP_KEY)||'null');
    if(!previous || !isHex(previous.bg||'') || !isHex(previous.panel||'') || !isHex(previous.accent||''))throw new Error('missing previous theme');
    setTheme(previous.bg,previous.panel,previous.accent,{linked:previous.linked!=='0'});
    toast('已還原升級前的配色，其他設定保持不變');
  }catch{toast('沒有可用的舊配色，仍保留目前主題');}
}
function setBackground(hex){if(isHex(hex))setTheme(hex,state.panelLinked?autoPanel(hex):state.panelColor,state.accentColor);}
function setPanelColor(hex){if(isHex(hex))setTheme(state.bgColor,hex,state.accentColor,{linked:false});}
function setAccentColor(hex){if(isHex(hex))setTheme(state.bgColor,state.panelColor,hex);}
function openDialog(id){const dlg=$(id);if(!dlg.open)dlg.showModal();}
function closeDialog(id){const dlg=$(id);if(dlg.open)dlg.close();}

function updateNetwork(){$('networkBadge').textContent=navigator.onLine?'● 已就绪 · 可离线':'● 离线书库';}
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
    settingsUpdatedAt:Number(localStorage.getItem(SETTINGS_UPDATED_KEY)||0),
    lastTrackId:localStorage.getItem('lyra-last-id')||'',
    selectedBook:state.selectedBook||'',
    settings:{speed:state.speed,fontSize:state.fontSize,delay:state.delay,
      bg:state.bgColor,panel:state.panelColor,accent:state.accentColor,
      linked:state.panelLinked,lyricsMax:state.lyricsMax},
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
  return {books,positions,deletedBooks,settings:data.settings,settingsUpdatedAt:safeTimestamp(data.settingsUpdatedAt),selectedBook:data.selectedBook,lastTrackId:data.lastTrackId,exportedAt:data.exportedAt};
}
async function importICloudState(file){
  if(!file)return;
  if(file.size>MAX_SYNC_BYTES){toast('同步檔超過 35MB，請檢查檔案');return;}
  const button=$('syncImport');button.disabled=true;
  try{
    const snapshot=validateSyncSnapshot(JSON.parse(await file.text()));
    if(state.current&&!audio.paused){toast('請先暫停播放再匯入，避免正在播放的進度覆蓋另一台裝置',6200);return;}
    const summary=`同步檔時間：${String(snapshot.exportedAt||'未知')}\n小說：${snapshot.books.length} 本\n播放記錄：${snapshot.positions.length} 章\n\n只合併較新的紀錄；不會自動刪除本機 MP3/LRC，也不會自動刪除另一台裝置上的小說。\n\n確定匯入？`;
    if(!confirm(summary))return;
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
      const cfg=snapshot.settings;
      const localSettingsAt=safeTimestamp(localStorage.getItem(SETTINGS_UPDATED_KEY));
      if(snapshot.settingsUpdatedAt>localSettingsAt || (!snapshot.settingsUpdatedAt && !localSettingsAt)){
        if(Number.isFinite(Number(cfg.speed)))setSpeed(cfg.speed);
        if(Number.isFinite(Number(cfg.fontSize))){state.fontSize=bounded(Number(cfg.fontSize),14,38,21);localStorage.setItem('lyra-font',state.fontSize);document.documentElement.style.setProperty('--font-size',`${state.fontSize}px`);}
        if(Number.isFinite(Number(cfg.delay))){state.delay=bounded(Number(cfg.delay),-20,20,0);localStorage.setItem('lyra-delay',state.delay);$('offsetLabel').textContent=`${state.delay>0?'+':''}${state.delay.toFixed(1)}s`;}
        if([cfg.bg,cfg.panel,cfg.accent].every(isHex))setTheme(cfg.bg,cfg.panel,cfg.accent,{linked:!!cfg.linked});
        if(typeof cfg.lyricsMax==='boolean')setLyricsMax(cfg.lyricsMax,false);
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
      toast(`iCloud 合併完成：更新 ${changed} 筆進度，舊資料不覆蓋新資料`,6000);
    }finally{state.suppressProgressWrites=false;}
  }catch(error){console.error('同步匯入失敗',error);toast('匯入失敗：'+(error?.message||error),6000);}
  finally{button.disabled=false;$('syncFile').value='';}
}

function setupEvents(){
  $('createBookForm').addEventListener('submit',createBook);
  $('bookSelect').addEventListener('change',e=>selectBook(e.target.value));
  $('chapterSearch').addEventListener('input',e=>{state.chapterQuery=e.target.value;drawChapterList();});
  $('jumpCurrentBtn').addEventListener('click',jumpToCurrent);
  for(const id of ['bookManagerOpen','bookManagerOpenSecondary'])$(id).addEventListener('click',()=>openDialog('bookManager'));
  $('bookManagerClose').addEventListener('click',()=>closeDialog('bookManager'));
  $('themeOpen').addEventListener('click',()=>openDialog('themeDialog'));
  $('cloudOpen').addEventListener('click',()=>openDialog('syncDialog'));
  $('syncOpenSecondary').addEventListener('click',()=>{closeDialog('bookManager');openDialog('syncDialog');});
  $('syncClose').addEventListener('click',()=>closeDialog('syncDialog'));
  $('syncExport').addEventListener('click',exportICloudState);
  $('syncImport').addEventListener('click',()=>$('syncFile').click());
  $('syncFile').addEventListener('change',event=>importICloudState(event.target.files?.[0]));
  $('themeClose').addEventListener('click',()=>closeDialog('themeDialog'));
  for(const id of ['bookManager','themeDialog','syncDialog'])$(id).addEventListener('click',e=>{if(e.target===$(id))closeDialog(id);});
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
  $('toggleLyricsMax').addEventListener('click',()=>setLyricsMax(!state.lyricsMax));
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.lyricsMax)setLyricsMax(false);});
  $('importDialog').addEventListener('cancel',event=>{if(state.importJob?.running){event.preventDefault();cancelImport();}});
  $('coverPicker').addEventListener('change',event=>setCover(event.target.files?.[0]));
  $('deleteBookBtn').addEventListener('click',deleteBook);
  $('deleteBtn').addEventListener('click',deleteCurrent);
  $('libraryJumpBtn').addEventListener('click',()=>{if(state.lyricsMax)setLyricsMax(false);setMobileTab('chapters',true);jumpToCurrent();});
  $('playBtn').addEventListener('click',()=>audio.paused?startPlayback():audio.pause());
  $('prevBtn').addEventListener('click',()=>adjacentTrack(-1));$('nextBtn').addEventListener('click',()=>adjacentTrack(1));
  $('backBtn').addEventListener('click',()=>skipSeconds(-15));$('aheadBtn').addEventListener('click',()=>skipSeconds(15));
  $('seekBar').addEventListener('input',()=>{state.seeking=true;$('elapsed').textContent=formatTime((audio.duration||0)*Number($('seekBar').value)/1000);});
  $('seekBar').addEventListener('change',()=>{if(Number.isFinite(audio.duration)&&audio.duration>0)audio.currentTime=audio.duration*Number($('seekBar').value)/1000;state.seeking=false;updateProgressDisplay();updateLyrics();saveProgress();});
  $('speedRange').addEventListener('input',event=>{setSpeed(event.target.value);markSettingsChanged();});
  $('bgColor').addEventListener('input',event=>{setBackground(event.target.value);markSettingsChanged();});
  $('panelColor').addEventListener('input',event=>{setPanelColor(event.target.value);markSettingsChanged();});
  $('accentColor').addEventListener('input',event=>{setAccentColor(event.target.value);markSettingsChanged();});
  $('linkPanels').addEventListener('change',event=>{state.panelLinked=event.target.checked;setTheme(state.bgColor,state.panelLinked?autoPanel(state.bgColor):state.panelColor,state.accentColor,{linked:state.panelLinked});markSettingsChanged();});
  $('resetColor').addEventListener('click',()=>{setTheme(DEFAULT_BG,DEFAULT_PANEL,DEFAULT_ACCENT,{linked:true});markSettingsChanged();});
  $('restorePreviousTheme').addEventListener('click',()=>{restorePreviousTheme();markSettingsChanged();});
  for(const btn of document.querySelectorAll('.theme-preset'))btn.addEventListener('click',()=>{setTheme(btn.dataset.page,btn.dataset.panel,btn.dataset.accent,{linked:true});markSettingsChanged();});
  $('fontMinus').addEventListener('click',()=>changeFont(-2));$('fontPlus').addEventListener('click',()=>changeFont(2));
  $('offsetMinus').addEventListener('click',()=>changeDelay(-.5));$('offsetPlus').addEventListener('click',()=>changeDelay(.5));
  $('lyricsWindow').addEventListener('click',event=>{const line=event.target.closest('.lyric-line');if(!line||!state.current)return;const i=Number(line.dataset.index);audio.currentTime=Math.max(0,state.lines[i].time+state.delay);state.userScrollUntil=0;updateLyrics(true);saveProgress();});
  const stopFollow=()=>{state.userScrollUntil=Date.now()+6000;};$('lyricsWindow').addEventListener('touchstart',stopFollow,{passive:true});$('lyricsWindow').addEventListener('wheel',stopFollow,{passive:true});
  audio.addEventListener('loadedmetadata',()=>{updateProgressDisplay();updateMediaPosition();});
  audio.addEventListener('timeupdate',()=>{updateProgressDisplay();updateLyrics();if(!audio.paused&&Date.now()-state.lastSave>2000){state.lastSave=Date.now();saveProgress();}updateMediaPosition();});
  audio.addEventListener('play',()=>{$('playBtn').textContent='Ⅱ';$('playBtn').setAttribute('aria-label','暂停');$('playStatus').textContent='正在播放';if('mediaSession'in navigator)navigator.mediaSession.playbackState='playing';});
  audio.addEventListener('pause',()=>{$('playBtn').textContent='▶';$('playBtn').setAttribute('aria-label','播放');if(state.current){$('playStatus').textContent=audio.ended?'本章已结束':'已暂停';saveProgress(audio.ended);}if('mediaSession'in navigator)navigator.mediaSession.playbackState='paused';});
  audio.addEventListener('ratechange',updateMediaPosition);
  audio.addEventListener('ended',async()=>{if(!state.current)return;await saveProgress(true);const list=sortedBookTracks(state.current.book);const i=list.findIndex(x=>x.id===state.current.id);if(i>=0&&i<list.length-1)await loadTrack(list[i+1],{autoplay:true});else{$('playStatus').textContent='本书已播放完毕';drawChapterList();}});
  audio.addEventListener('error',()=>{if(state.current&&audio.src){$('playStatus').textContent='音频无法播放';toast('MP3 无法播放，请确认音频格式有效');}});
  window.addEventListener('online',updateNetwork);window.addEventListener('offline',updateNetwork);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)saveProgress();});window.addEventListener('pagehide',()=>saveProgress());
}

async function registerSW(){if(!('serviceWorker'in navigator)||!isSecureContext)return;try{navigator.serviceWorker.addEventListener('controllerchange',()=>toast('PineTree 版本已更新；關閉再開啟 App 可使用最新版',5000));await navigator.serviceWorker.register('./sw.js',{scope:'./'});}catch(error){console.warn('离线缓存不可用：',error);}}
async function start(){
  setupEvents();setupMediaSession();updateNetwork();
  setMobileTab(localStorage.getItem('lyra-mobile-tab')==='chapters'?'chapters':'player');
  setSpeed(state.speed);
  migrateForestThemeOnce();
  const legacyBg=localStorage.getItem('lyra-bg-color');
  const savedPanel=localStorage.getItem('lyra-panel-color');
  const panel=savedPanel||((legacyBg&&legacyBg.toLowerCase()!==DEFAULT_BG.toLowerCase())?autoPanel(state.bgColor):DEFAULT_PANEL);
  setTheme(state.bgColor,panel,state.accentColor,{linked:state.panelLinked});
  updateRestoreOption();
  setLyricsMax(state.lyricsMax,false);
  document.documentElement.style.setProperty('--font-size',`${state.fontSize}px`);
  $('offsetLabel').textContent=`${state.delay>0?'+':''}${state.delay.toFixed(1)}s`;
  registerSW();
  try{
    state.db=await openDatabase();await migrateLegacyBooks();await refreshLibrary();
    const interrupted=localStorage.getItem(IMPORT_CHECKPOINT_KEY);
    if(interrupted){try{const p=JSON.parse(interrupted);toast(`上次匯入可能中斷（${p.done||0}/${p.total||'?'} 組）；重新選相同文件可接續並略過已有章節`,8000);}catch{}localStorage.removeItem(IMPORT_CHECKPOINT_KEY);}
    const last=state.tracks.find(x=>x.id===localStorage.getItem('lyra-last-id'));
    if(last){state.selectedBook=last.book;localStorage.setItem('lyra-selected-book',last.book);drawBookGrid();drawChapterList();updateBookControls();await loadTrack(last,{autoplay:false});}
    else if(state.selectedBook){const candidates=sortedBookTracks(state.selectedBook);const savedId=localStorage.getItem('lyra-last-book-track:'+state.selectedBook);const previous=candidates.find(t=>t.id===savedId);if(previous)await loadTrack(previous,{autoplay:false});}
  }catch(error){console.error('数据库无法初始化',error);toast('无法打开离线书库，请允许网站储存数据并退出隐私浏览',6500);}
}

start();
