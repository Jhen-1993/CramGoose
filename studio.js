'use strict';
const $=id=>document.getElementById(id);
let currentNoteId=null, noteFilter='all', textCache=new Map(), renderGeneration=0;
let noteDirty=false, noteTimer, toastTimer, editVersion=0, noteSaveQueue=Promise.resolve();
let consolidatedTimer, consolidatedPending=null, mockDraftTimer;
let consolidatedQueue=Promise.resolve(), consolidatedSaving=false;
let previousProgress=null;
function toast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),3500);}
function displayDate(value){const d=new Date(value);return Number.isNaN(d.getTime())?'':localDate(d);}
function localDate(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function isReviewDay(date){const d=daysBetween(date,STATE.config.examDate);return !!STATE.config.examDate && d>0 && d<=STATE.config.reviewDays;}
function remainingStudyDays(date){if(!STATE.config.examDate)return 1;return Math.max(1,daysBetween(date,STATE.config.examDate)-Math.max(0,STATE.config.reviewDays||0));}
function goosePace(days){
  if(days!==null&&days<0)return {cycle:.9,sweat:0,mode:'rest',label:'考試已結束，休息一下'};
  if(days!==null&&days<=3)return {cycle:.28,sweat:3,mode:'sprint',label:days===0?'今天考試，鵝鵝幫你加油！':'最後衝刺！記得也要休息'};
  if(days!==null&&days<=7)return {cycle:.38,sweat:2,mode:'hustle',label:'考前一週，一起加把勁'};
  if(days!==null&&days<=14)return {cycle:.5,sweat:1,mode:'run',label:'逐漸加速，穩穩複習'};
  return {cycle:.76,sweat:0,mode:'jog',label:'照自己的步調，慢慢累積'};
}
function renderCountdown(){
  const subjects=STATE.config.subjects.filter(s=>subjectTotal(s)>0);
  $('countdownBar').style.display=subjects.length?'block':'none';
  const percent=subjects.length?Math.round(subjects.reduce((sum,s)=>sum+Math.min(1,Math.max(0,subjectCompleted(s)/subjectTotal(s))),0)/subjects.length*100):0;
  $('cdText').textContent=`學習完成度 ${percent}%`;
  const remaining=STATE.config.examDate?daysBetween(todayStr(),STATE.config.examDate):null;
  const pace=goosePace(remaining), goose=$('progressGoose');
  goose.style.setProperty('--run-cycle',pace.cycle+'s');
  goose.dataset.pace=pace.mode;goose.dataset.sweat=String(pace.sweat);
  goose.setAttribute('aria-label',`溫書鵝：${pace.label}`);
  if($('goosePaceLabel'))$('goosePaceLabel').textContent=pace.label+' · 位置＝完成度，步頻＝考試倒數';
  $('cdDays').textContent=remaining===null?'尚未設定考試日期':remaining<0?'本次考試已結束':remaining===0?'今天是考試日':`距離考試 ${remaining} 天`;
  $('cdFill').style.width=percent+'%';
  $('studyProgress').setAttribute('aria-valuenow',percent);
  // Keep the mascot's entire body inside the track at both ends.
  $('progressGoose').style.left=`calc(var(--goose-half, 34px) + (100% - 2 * var(--goose-half, 34px)) * ${percent/100})`;
  if(previousProgress!==null && percent>previousProgress){$('progressGoose').classList.add('running');setTimeout(()=>$('progressGoose').classList.remove('running'),1600);}
  previousProgress=percent;
  $('progressCourses').innerHTML=subjects.map(s=>`<span>${escapeHtml(s.name)} · ${Math.round(Math.min(1,Math.max(0,subjectCompleted(s)/subjectTotal(s)))*100)}%</span>`).join('');
  const complete=subjects.length>0&&subjects.every(s=>subjectCompleted(s)>=subjectTotal(s));
  window.updateGooseEnding?.(goose,{complete,examEnded:remaining!==null&&remaining<0});
  if(complete||remaining!==null&&remaining<0){
    const label=complete?'全部完成，讓溫書鵝替你歡呼！':'考試結束了，辛苦了！';
    if($('goosePaceLabel'))$('goosePaceLabel').textContent=label;
  }
}
const legacyBuildProgress=buildProgressRows;
buildProgressRows=function(container,date){
  legacyBuildProgress(container,date);
  // Add the chapters completed on this date so historical entries can be undone.
  for(const subject of STATE.config.subjects){
    const completed=(subject.chapters||[]).filter(c=>c.done && c.doneDate===date);
    if(!completed.length)continue;
    const group=document.createElement('div');group.className='chapter-check-list';
    group.innerHTML=completed.map(c=>`<label class="chapter-check"><input type="checkbox" data-chk-sid="${escapeHtml(subject.id)}" data-chk-cid="${escapeHtml(c.id)}" checked>${escapeHtml(subject.name)} · ${escapeHtml(c.name)}（當日完成）</label>`).join('');
    container.append(group);
  }
};
saveProgressForm=async function(container,date){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date>todayStr()){toast('請選擇今天或過去的日期。');return false;}
  for(const input of container.querySelectorAll('input[data-sid]')){
    const value=Number(input.value), subject=STATE.config.subjects.find(s=>s.id===input.dataset.sid);
    const other=Object.entries(STATE.dailyLog).filter(([day])=>day!==date).reduce((sum,[,record])=>sum+(Number(record[input.dataset.sid])||0),0);
    if(!Number.isFinite(value)||value<0||(subject && value+other>subjectTotal(subject))){toast('完成量須為非負數，累計不能超過該科目總量。');input.focus();return false;}
  }
  const before=structuredClone(STATE);
  for(const input of container.querySelectorAll('input[data-sid]')){STATE.dailyLog[date]||={};STATE.dailyLog[date][input.dataset.sid]=Number(input.value)||0;}
  for(const input of container.querySelectorAll('input[data-chk-sid]')){
    const c=STATE.config.subjects.find(s=>s.id===input.dataset.chkSid)?.chapters?.find(c=>c.id===input.dataset.chkCid);
    if(!c)continue;
    if(input.checked){c.done=true;c.doneDate=date;}else if(c.doneDate===date){c.done=false;c.doneDate=null;}
  }
  if(!await saveState()){STATE=before;return false;}
  renderCountdown();return true;
};
function updateStats(){
  $('noteTotal').innerHTML=`${STATE.notesList.filter(n=>!n.deletedAt).length} <small>篇</small>`;
  $('subjectTotal').innerHTML=`${STATE.config.subjects.length} <small>科</small>`;
  $('digestTotal').innerHTML=`${Object.values(STATE.consolidated).filter(Boolean).length} <small>份</small>`;
}
function subjectOptions(allowNone=false){return (allowNone?'<option value="">未分類</option>':'')+STATE.config.subjects.map(s=>`<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');}
function populateFilters(){const selected=$('filterSubject').value;$('filterSubject').innerHTML='<option value="">所有科目</option><option value="__none__">未分類</option>'+subjectOptions();$('filterSubject').value=selected;}
async function noteText(id){if(!textCache.has(id)){const r=await window.storage.get('note-text:'+id);textCache.set(id,r?.value||'');}return textCache.get(id);}
renderNotes=async function(){
  const generation=++renderGeneration;
  updateStats();populateFilters();
  const query=$('noteSearch').value.trim().toLocaleLowerCase(), subject=$('filterSubject').value,tag=$('filterTag').value.trim().toLocaleLowerCase();
  let records=STATE.notesList.filter(n=>noteFilter==='trash'?!!n.deletedAt:!n.deletedAt && (noteFilter!=='starred'||n.favorite));
  if(subject)records=records.filter(n=>subject==='__none__'?!STATE.config.subjects.some(s=>s.id===n.subjectId):n.subjectId===subject);
  if(tag)records=records.filter(n=>(n.tags||[]).some(t=>t.toLocaleLowerCase().includes(tag)));
  try{
    const items=await Promise.all(records.map(async note=>({note,text:await noteText(note.id)})));
    if(generation!==renderGeneration)return;
    let filtered=items.filter(({note,text})=>!query||[note.title||note.filename,text,...(note.tags||[])].join('\n').toLocaleLowerCase().includes(query));
    const sort=$('sortNotes').value;
    filtered.sort((a,b)=>sort==='title'?(a.note.title||a.note.filename).localeCompare(b.note.title||b.note.filename,'zh-Hant'):String(sort==='created'?b.note.uploadedAt:b.note.updatedAt||b.note.uploadedAt).localeCompare(String(sort==='created'?a.note.uploadedAt:a.note.updatedAt||a.note.uploadedAt)));
    $('visibleCount').textContent=filtered.length;
    $('notesList').innerHTML=filtered.length?filtered.map(({note:n,text})=>{
      const subject=STATE.config.subjects.find(s=>s.id===n.subjectId),chapter=subject?.chapters?.find(c=>c.id===n.chapterId);
      return `<button class="note-tile ${n.id===currentNoteId?'selected':''}" data-open-note="${escapeHtml(n.id)}"><div class="note-tile-top"><span class="subject-tag">${escapeHtml(subject?.name||'未分類')}${chapter?' · '+escapeHtml(chapter.name):''}</span><span>${n.favorite?'★':'▤'}</span></div><h3>${escapeHtml(n.title||n.filename||'無標題筆記')}</h3><p>${escapeHtml(text.replace(/[#*|]/g,'').slice(0,110)||'留下一個新的想法…')}</p>${n.tags?.length?`<div class="tile-tags">${n.tags.map(t=>'#'+escapeHtml(t)).join(' ')}</div>`:''}<div class="note-tile-bottom"><span>${escapeHtml(displayDate(n.updatedAt||n.uploadedAt||''))}</span><span>${text.length.toLocaleString()} 字</span></div></button>`;
    }).join(''):`<div class="empty">${query||tag||subject?'找不到符合條件的筆記。<br>試試不同的關鍵字或篩選條件。':noteFilter==='trash'?'垃圾桶是空的。':noteFilter==='starred'?'還沒有收藏的筆記。<br>打開筆記後，按一下星星。':'書房還是空的。<br>新增一篇筆記，或匯入你的教材。'}</div>`;
    $('notesList').querySelectorAll('[data-open-note]').forEach(b=>b.onclick=()=>openNote(b.dataset.openNote));
  }catch(error){$('notesList').textContent='筆記讀取失敗，請重新整理。';showStorageError();}
};
function editorChapters(selected=''){
  const chapters=STATE.config.subjects.find(s=>s.id===$('editorSubject').value)?.chapters||[];
  $('editorChapter').innerHTML='<option value="">不指定章節</option>'+chapters.map(c=>`<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
  $('editorChapter').value=selected;
}
function updateEditorCount(){const text=$('editorBody').value;$('editorWordCount').textContent=text.length.toLocaleString()+' 字';if(!$('notePreview').hidden)$('notePreview').innerHTML=mdToHtml(text);}
function markNoteDirty(){noteDirty=true;editVersion++;$('editorStatus').textContent='尚未儲存…';updateEditorCount();clearTimeout(noteTimer);noteTimer=setTimeout(saveCurrentNote,550);}
async function saveCurrentNote(){
  clearTimeout(noteTimer);
  if(!noteDirty||!currentNoteId){await noteSaveQueue;return !noteDirty;}
  const id=currentNoteId, version=editVersion, body=$('editorBody').value;
  const changes={title:$('editorTitle').value.trim()||'無標題筆記',subjectId:$('editorSubject').value||null,chapterId:$('editorChapter').value||null,tags:[...new Set($('editorTags').value.split(/[,，]/).map(t=>t.trim()).filter(Boolean))].slice(0,30),updatedAt:new Date().toISOString(),chars:body.length};
  $('editorStatus').textContent='儲存中…';
  const task=noteSaveQueue.then(async()=>{
    const index=STATE.notesList.findIndex(n=>n.id===id);if(index<0)return false;
    const previous=STATE.notesList[index];STATE.notesList[index]={...previous,...changes};
    try{
      await window.storage.batch({'planner-state':JSON.stringify(STATE),['note-text:'+id]:body});
      textCache.set(id,body);hideStorageError();
      if(currentNoteId===id && editVersion===version){noteDirty=false;$('editorStatus').textContent='✓ 已儲存於此瀏覽器';}
      renderNotes();return true;
    }catch(error){STATE.notesList[index]=previous;showStorageError();if(currentNoteId===id)$('editorStatus').textContent='儲存失敗，請先保留內容';return false;}
  });
  noteSaveQueue=task.catch(()=>false);return task;
}
async function openNote(id){
  if(!await saveCurrentNote())return;
  const note=STATE.notesList.find(n=>n.id===id);if(!note)return;
  let text;try{text=await noteText(id);}catch{toast('讀取筆記失敗。');return;}
  currentNoteId=id;noteDirty=false;editVersion++;
  $('editorEmpty').hidden=true;$('editorContent').hidden=false;
  $('editorTitle').value=note.title||note.filename||'';
  $('editorSubject').innerHTML=subjectOptions(true);$('editorSubject').value=note.subjectId||'';editorChapters(note.chapterId||'');
  $('editorTags').value=(note.tags||[]).join(', ');$('editorBody').value=text;
  $('favoriteNoteBtn').textContent=note.favorite?'★':'☆';$('favoriteNoteBtn').setAttribute('aria-pressed',!!note.favorite);
  $('editorStatus').textContent=note.deletedAt?'已移至垃圾桶':'✓ 已儲存於此瀏覽器';
  for(const name of ['editorTitle','editorSubject','editorChapter','editorTags','editorBody','favoriteNoteBtn','trashNoteBtn','addNoteSubject'])$(name).disabled=!!note.deletedAt;
  document.querySelectorAll('[data-format]').forEach(b=>b.disabled=!!note.deletedAt);
  $('trashActions').hidden=!note.deletedAt;
  $('notePreview').hidden=true;$('editorBody').hidden=false;$('previewNoteBtn').textContent='閱讀預覽';
  updateEditorCount();renderNotes();
  if(window.innerWidth<601)$('editorPane').scrollIntoView({behavior:'smooth',block:'start'});
}
function closeEditor(){currentNoteId=null;noteDirty=false;editVersion++;$('editorEmpty').hidden=false;$('editorContent').hidden=true;}
async function newNote(){
  if(!await saveCurrentNote())return;
  const id=uid(), now=new Date().toISOString();
  const note={id,subjectId:$('filterSubject').value && $('filterSubject').value!=='__none__'?$('filterSubject').value:null,chapterId:null,filename:'文字筆記.md',title:'無標題筆記',uploadedAt:now,updatedAt:now,chars:0,tags:[],favorite:false};
  STATE.notesList.push(note);
  try{await window.storage.batch({'planner-state':JSON.stringify(STATE),['note-text:'+id]:''});}catch{STATE.notesList.pop();showStorageError();return;}
  noteFilter='all';setFilterButtons();$('noteSearch').value='';$('filterTag').value='';
  switchTab('notes');await openNote(id);$('editorTitle').focus();$('editorTitle').select();
}
function setFilterButtons(){document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('selected',b.dataset.filter===noteFilter));}
async function changeNote(update,permanent=false){
  if(!await saveCurrentNote())return;
  const note=STATE.notesList.find(n=>n.id===currentNoteId);if(!note)return;
  const previous=STATE.notesList;
  STATE.notesList=permanent?previous.filter(n=>n.id!==note.id):previous.map(n=>n.id===note.id?{...n,...update}:n);
  try{await window.storage.batch({'planner-state':JSON.stringify(STATE)},permanent?['note-text:'+note.id]:[]);}catch{STATE.notesList=previous;showStorageError();return;}
  if(permanent){textCache.delete(note.id);closeEditor();}else await openNote(note.id);
  renderNotes();
}
function switchTab(tab){document.querySelector(`nav.tabs button[data-tab="${tab}"]`)?.click();}
function askDialog({title,message,input=false,placeholder='',confirm='確定',danger=false}){
  return new Promise(resolve=>{
    const d=document.createElement('dialog');d.innerHTML='<form method="dialog"><h3></h3><p></p><label hidden>輸入內容<input type="text" maxlength="120"></label><div class="dialog-actions"><button class="btn secondary" value="cancel">取消</button><button class="btn" value="ok"></button></div></form>';
    d.querySelector('h3').textContent=title;d.querySelector('p').textContent=message;
    const field=d.querySelector('input');field.placeholder=placeholder;field.parentElement.hidden=!input;
    const ok=d.querySelector('[value=ok]');ok.textContent=confirm;if(danger)ok.classList.add('danger');
    d.addEventListener('close',()=>{const value=d.returnValue==='ok'?(input?field.value:true):null;d.remove();resolve(value);},{once:true});
    document.body.append(d);d.showModal();if(input)field.focus();
  });
}
async function addSubject(){
  if(!await saveCurrentNote())return;
  const name=await askDialog({title:'新增學習科目',message:'先建立分類，讀書總量與章節可以稍後再設定。',input:true,placeholder:'例如：英文、流行病學',confirm:'新增科目'});
  if(!name?.trim())return;
  const subject={id:uid(),name:name.trim(),unit:'章',total:0,chapters:[]};STATE.config.subjects.push(subject);
  if(!await saveState()){STATE.config.subjects.pop();return;}
  refreshAllSelects();renderSubjectRows();populateFilters();updateStats();
  if(currentNoteId){$('editorSubject').innerHTML=subjectOptions(true);$('editorSubject').value=subject.id;editorChapters();markNoteDirty();await saveCurrentNote();}
  toast('科目已建立。');
}
const originalPersistConsolidated=persistConsolidatedText;
persistConsolidatedText=async function(subjectId,text){
  const oldText=STATE.consolidated[subjectId],oldVersions=structuredClone(STATE.consolidatedVersions||{});
  STATE.consolidatedVersions||={};
  const previous=STATE.consolidated[subjectId];
  if(previous && previous!==text){STATE.consolidatedVersions[subjectId]||=[];STATE.consolidatedVersions[subjectId].unshift({at:new Date().toISOString(),text:previous});STATE.consolidatedVersions[subjectId]=STATE.consolidatedVersions[subjectId].slice(0,10);}
  try{await originalPersistConsolidated(subjectId,text);}catch(error){STATE.consolidated[subjectId]=oldText||'';STATE.consolidatedVersions=oldVersions;throw error;}
  renderVersions();updateStats();
};
function renderVersions(){const id=$('consolidateSubjectSelect').value;const versions=STATE.consolidatedVersions?.[id]||[];$('consolidatedVersions').innerHTML=versions.map((v,i)=>`<p class="muted">${escapeHtml(new Date(v.at).toLocaleString('zh-TW'))} · ${v.text.length.toLocaleString()} 字 <button class="btn secondary" data-version="${i}">還原此版本</button></p>`).join('')||'<p class="muted">修改後會保留先前版本，最多 10 份。</p>';$('consolidatedVersions').querySelectorAll('[data-version]').forEach(b=>b.onclick=async()=>{if(!await askDialog({title:'還原統整版本',message:'目前內容也會保留為上一個版本。',confirm:'還原'}))return;const text=versions[Number(b.dataset.version)].text;await persistConsolidatedText(id,text);$('consolidateOutput').value=text;updateWordCount();toast('已還原統整版本。');});}
async function saveConsolidatedDraft(){
  clearTimeout(consolidatedTimer);if(!consolidatedPending){await consolidatedQueue;return !consolidatedPending;}
  const pending=consolidatedPending;consolidatedPending=null;consolidatedSaving=true;
  const task=consolidatedQueue.then(async()=>{
    try{await persistConsolidatedText(pending.id,pending.text);$('consolidatedSaved').textContent=' ✓ 已儲存';return true;}
    catch{consolidatedPending||=pending;$('consolidatedSaved').textContent=' 儲存失敗';showStorageError();return false;}
    finally{consolidatedSaving=false;}
  });
  consolidatedQueue=task.catch(()=>false);return task;
}
async function makeBackup(){
  if(!await saveCurrentNote() || !await saveConsolidatedDraft())throw new Error('還有內容未成功儲存，請先處理儲存問題。');
  const notes={};for(const n of STATE.notesList){const r=await window.storage.get('note-text:'+n.id);if(!r)throw new Error('筆記「'+(n.title||n.filename)+'」的文字資料遺失，請先檢查。');notes[n.id]=r.value;}
  return {format:'CramGoose',version:2,exportedAt:new Date().toISOString(),state:structuredClone(STATE),notes};
}
function downloadBackup(data){triggerDownload(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),`CramGoose-備份-${todayStr()}.json`);}
function validateBackup(data){
  const fail=()=>{throw new Error('不是有效的溫書鵝備份，原資料未變動。');};
  const plain=o=>o!==null && typeof o==='object'&&!Array.isArray(o);
  const id=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
  const string=v=>typeof v==='string';
  const s=data?.state;
  if(data?.format!=='CramGoose'||![1,2].includes(data.version)||!plain(s)||!plain(s.config)||!plain(data.notes))fail();
  if(!Array.isArray(s.config.subjects)||!Array.isArray(s.notesList)||!Array.isArray(s.examSources)||!Array.isArray(s.mockHistory)||!plain(s.dailyLog)||!plain(s.consolidated))fail();
  if(!string(s.config.examDate)||s.config.examDate&&!/^\d{4}-\d{2}-\d{2}$/.test(s.config.examDate)||!Number.isFinite(s.config.reviewDays)||s.config.reviewDays<0)fail();
  const subjects=new Set(),notes=new Set();
  for(const a of s.config.subjects){if(!plain(a)||!id(a.id)||subjects.has(a.id)||!string(a.name)||!string(a.unit)||!Number.isFinite(a.total)||a.total<0||!Array.isArray(a.chapters||[]))fail();subjects.add(a.id);const chapters=new Set();for(const c of a.chapters||[]){if(!plain(c)||!id(c.id)||chapters.has(c.id)||!string(c.name)||c.amount!=null&&(!Number.isFinite(c.amount)||c.amount<=0))fail();chapters.add(c.id);}}
  for(const n of s.notesList){if(!plain(n)||!id(n.id)||notes.has(n.id)||!string(n.filename)||n.title!=null&&!string(n.title)||!string(data.notes[n.id])||n.tags!=null&&(!Array.isArray(n.tags)||!n.tags.every(string)))fail();notes.add(n.id);if(n.subjectId!=null&&!id(n.subjectId)||n.chapterId!=null&&!id(n.chapterId))fail();}
  if(Object.keys(data.notes).some(k=>!notes.has(k)))fail();
  for(const [date,log] of Object.entries(s.dailyLog)){if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!plain(log)||Object.entries(log).some(([k,v])=>!id(k)||!Number.isFinite(v)||v<0))fail();}
  if(Object.entries(s.consolidated).some(([k,v])=>!id(k)||!string(v)))fail();
  for(const e of s.examSources){if(!plain(e)||!id(e.id)||!id(e.subjectId)||!string(e.content)||!string(e.title))fail();}
  for(const m of s.mockHistory){if(!plain(m)||!id(m.id)||!string(m.date)||!Array.isArray(m.subjectIds)||!m.subjectIds.every(id)||m.questions!=null&&(!Array.isArray(m.questions)||m.questions.some(q=>!plain(q)||!string(q.q)||!string(q.answer))))fail();}
  if(s.consolidatedVersions!=null){if(!plain(s.consolidatedVersions))fail();for(const [key,versions] of Object.entries(s.consolidatedVersions)){if(!id(key)||!Array.isArray(versions)||versions.some(v=>!plain(v)||!string(v.text)||!string(v.at)))fail();}}
  // Explicit allowlist excludes accidental credentials and unrecognized state fields.
  return {format:'CramGoose',version:2,state:{config:s.config,dailyLog:s.dailyLog,notesList:s.notesList,consolidated:s.consolidated,examSources:s.examSources,mockHistory:s.mockHistory,consolidatedVersions:s.consolidatedVersions||{}},notes:data.notes};
}
async function replaceLibrary(data,keepRecovery=true){
  const valid=validateBackup(data), before=keepRecovery?await makeBackup():null;
  const keys=(await window.storage.list('note-text:')).keys;
  const entries={'planner-state':JSON.stringify(valid.state)};
  for(const [id,text] of Object.entries(valid.notes))entries['note-text:'+id]=text;
  if(before)entries['recovery-backup']=JSON.stringify(before);
  await window.storage.batch(entries,[...keys,'mock-draft']);
  stopMockTimer();currentMockQuestions=[];currentMockSession=null;$('mockQuestions').innerHTML='';
  STATE=valid.state;textCache.clear();closeEditor();refreshUI();
}
function refreshUI(){
  $('examDate').value=STATE.config.examDate||'';$('reviewDays').value=STATE.config.reviewDays??7;
  renderSubjectRows();refreshAllSelects();populateFilters();renderNotes();renderCountdown();renderExamSources();renderMock();renderConsolidateSelect();renderVersions();
}
async function resetStudy(kind){
  if($('consolidateBtn').disabled||$('genMockBtn').disabled||mockGrading||$('pdfInput').disabled){toast('請等目前處理完成，再重置資料。');return;}
  const descriptions={progress:'清除所有日期的完成量與章節完成勾選。科目、章節名稱、考試日期、筆記和考古資料都會保留。',dates:'清除考試日期，複習天數回到 7 天。所有筆記、科目與完成進度都會保留。',all:'清空讀書計畫、筆記、垃圾桶、統整版本、考古資料與模擬考歷史。AI 連線設定保留。請輸入「清空」確認。'};
  const confirmed=await askDialog({title:kind==='all'?'清空學習資料':'重新開始，筆記留下',message:descriptions[kind],confirm:kind==='all'?'清空資料':'確認重置',input:kind==='all',danger:true});
  if(kind==='all'?confirmed!=='清空':!confirmed)return;
  try{
    const backup=await makeBackup();downloadBackup(backup);
    const data=structuredClone(backup);
    if(kind==='all'){data.state={config:{examDate:'',reviewDays:7,subjects:[]},dailyLog:{},notesList:[],consolidated:{},mockHistory:[],examSources:[],consolidatedVersions:{}};data.notes={};}
    else if(kind==='dates'){data.state.config.examDate='';data.state.config.reviewDays=7;}
    else{data.state.dailyLog={};for(const s of data.state.config.subjects)for(const c of s.chapters||[]){c.done=false;c.doneDate=null;}}
    await replaceLibrary(data);toast('已重置，並下載重置前備份。可在備份頁復原上次操作。');
  }catch(error){toast(error.message);showStorageError();}
}
async function persistMockDraft(){
  if(!currentMockSession || currentMockSession.completed)return;
  collectMockAnswers();
  try{await window.storage.set('mock-draft',JSON.stringify({questions:currentMockQuestions,session:currentMockSession}));}catch{showStorageError();}
}
const oldRenderMockQuestions=renderMockQuestions;
renderMockQuestions=function(){
  oldRenderMockQuestions();
  document.querySelectorAll('[data-answer]').forEach(el=>{
    el.value=currentMockQuestions.find(q=>q.id===el.dataset.answer)?.answer||'';
    el.disabled=!!(currentMockSession?.mode==='exam'&&currentMockSession.submitted);
    el.addEventListener('input',()=>{clearTimeout(mockDraftTimer);mockDraftTimer=setTimeout(persistMockDraft,400);});
  });
  if(currentMockSession?.mode==='exam'&&!currentMockSession.submitted) startMockTimer();
  persistMockDraft();
};
renderMock=function(){
  updateMockModeNote();
  $('mockHistory').innerHTML=STATE.mockHistory.length?STATE.mockHistory.slice().reverse().map(m=>`<details class="mock-review"><summary>${escapeHtml(m.date)} · ${m.mode==='exam'?'考試':'練習'} · ${escapeHtml(String(m.score??'—'))}/10</summary><p>${escapeHtml(m.feedback||'')}</p>${m.questions?.map((q,i)=>`<h4>Q${i+1} ${escapeHtml(q.q)}</h4><pre>${escapeHtml(q.answer||'未作答')}</pre><p>得分 ${escapeHtml(String(q.score??'—'))}/10 · ${escapeHtml(q.feedback||'')}</p>`).join('')||'<p class="muted">舊版紀錄沒有保存題目與作答。</p>'}</details>`).join(''):'<div class="empty">尚無模擬考紀錄。</div>';
};
// The original application initializes asynchronously. Overrides above are ready
// before that initialization resumes; event handlers below start after storage.
window.studioReady=window.appReady.then(async()=>{
  await window.storage.ready;
  $('navMount').append(document.querySelector('nav.tabs'));
  const closeMenu=()=>{document.querySelector('.sidebar').classList.remove('nav-open');$('menuToggle').setAttribute('aria-expanded','false');$('menuToggle').setAttribute('aria-label','開啟導覽選單');$('menuToggle').firstElementChild.textContent='☰';};
  $('menuToggle').onclick=()=>{const open=$('menuToggle').getAttribute('aria-expanded')!=='true';document.querySelector('.sidebar').classList.toggle('nav-open',open);$('menuToggle').setAttribute('aria-expanded',String(open));$('menuToggle').setAttribute('aria-label',open?'關閉導覽選單':'開啟導覽選單');$('menuToggle').firstElementChild.textContent=open?'×':'☰';};
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('menuToggle').getAttribute('aria-expanded')==='true'){closeMenu();$('menuToggle').focus();}});
  window.addEventListener('resize',()=>{if(window.innerWidth>850)closeMenu();});
  document.body.dataset.view='notes';
  document.querySelectorAll('nav.tabs button').forEach(b=>b.addEventListener('click',()=>{
    closeMenu();
    document.body.dataset.view=b.dataset.tab;$('pageLabel').textContent=b.textContent.trim().slice(1).trim();
    saveCurrentNote();saveConsolidatedDraft();if(b.dataset.tab==='consolidate')renderVersions();
    updateStats();
  }));
   for(const id of ['newNoteBtn','heroNewNote','emptyNewNote'])$(id).onclick=newNote;
   $('heroPlan').onclick=()=>switchTab('daily');$('backupShortcut').onclick=()=>switchTab('backup');
  document.querySelector('.brand').onclick=e=>{e.preventDefault();switchTab('notes');};
  $('showImportBtn').onclick=()=>{refreshAllSelects();$('importPanel').open=!$('importPanel').open;};
  for(const id of ['noteSearch','filterTag'])$(id).oninput=renderNotes;
  for(const id of ['filterSubject','sortNotes'])$(id).onchange=renderNotes;
  document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{noteFilter=b.dataset.filter;setFilterButtons();renderNotes();});
  for(const id of ['editorTitle','editorBody','editorTags'])$(id).oninput=markNoteDirty;
  $('editorSubject').onchange=()=>{editorChapters();markNoteDirty();};$('editorChapter').onchange=markNoteDirty;
  $('addNoteSubject').onclick=addSubject;
  $('favoriteNoteBtn').onclick=async()=>{const n=STATE.notesList.find(n=>n.id===currentNoteId);if(n)await changeNote({favorite:!n.favorite});};
  $('trashNoteBtn').onclick=async()=>{await changeNote({deletedAt:new Date().toISOString()});toast('已移至垃圾桶，可隨時還原。');};
  $('restoreNoteBtn').onclick=async()=>{await changeNote({deletedAt:null});noteFilter='all';setFilterButtons();renderNotes();toast('筆記已還原。');};
  $('deleteForeverBtn').onclick=async()=>{if(await askDialog({title:'永久刪除這篇筆記？',message:'這個動作無法從垃圾桶復原，已有的外部備份不受影響。',confirm:'永久刪除',danger:true})){await changeNote({},true);toast('筆記已永久刪除。');}};
  $('downloadNoteBtn').onclick=async()=>{if(!await saveCurrentNote())return;const n=STATE.notesList.find(n=>n.id===currentNoteId);if(n)triggerDownload(new Blob([$('editorBody').value],{type:'text/markdown;charset=utf-8'}),(n.title||n.filename||'筆記').replace(/[\\/:*?"<>|]/g,'_')+'.md');};
  $('previewNoteBtn').onclick=()=>{const preview=$('notePreview').hidden;$('notePreview').hidden=!preview;$('editorBody').hidden=preview;$('previewNoteBtn').textContent=preview?'繼續編輯':'閱讀預覽';updateEditorCount();};
  document.querySelectorAll('[data-format]').forEach(b=>b.onclick=()=>{
    const body=$('editorBody');if(body.disabled)return;$('notePreview').hidden=true;body.hidden=false;$('previewNoteBtn').textContent='閱讀預覽';
    const start=body.selectionStart,end=body.selectionEnd,selected=body.value.slice(start,end),f=b.dataset.format;
    const text=f==='bold'?'**'+(selected||'重點')+'**':(start>0&&body.value[start-1]!=='\n'?'\n':'')+(f==='heading'?'## ':f==='todo'?'- [ ] ':'- ')+(selected||(f==='heading'?'小標題':'重點'));
    body.setRangeText(text,start,end,'end');body.focus();markNoteDirty();
  });
  $('consolidateOutput').addEventListener('input',()=>{const id=$('consolidateSubjectSelect').value;if(!id)return;consolidatedPending={id,text:$('consolidateOutput').value};$('consolidatedSaved').textContent=' 尚未儲存…';clearTimeout(consolidatedTimer);consolidatedTimer=setTimeout(saveConsolidatedDraft,1100);});
  $('saveConsolidatedBtn').onclick=async()=>{const id=$('consolidateSubjectSelect').value;if(!id){toast('請先建立科目。');return;}consolidatedPending={id,text:$('consolidateOutput').value};await saveConsolidatedDraft();};
  $('consolidateSubjectSelect').addEventListener('change',()=>{saveConsolidatedDraft();renderVersions();});
  $('exportBackupBtn').onclick=async()=>{try{downloadBackup(await makeBackup());$('backupStatus').textContent='備份已下載。請保留在你能找到的位置。';}catch(e){$('backupStatus').textContent=e.message;}};
  $('importBackupInput').onchange=async e=>{
    const file=e.target.files[0];if(!file)return;
    try{if(file.size>60*1024*1024)throw new Error('備份檔超過 60 MB，請先檢查檔案。');const data=validateBackup(JSON.parse(await file.text()));
      if(!await askDialog({title:'還原備份資料',message:`此備份有 ${data.state.notesList.length} 篇筆記、${data.state.config.subjects.length} 個科目。將取代目前學習資料；還原前會下載現有備份。`,confirm:'備份目前資料並還原'}))return;
      downloadBackup(await makeBackup());await replaceLibrary(data);$('backupStatus').textContent='還原完成。AI 連線設定未變動。';toast('備份還原完成。');
    }catch(error){$('backupStatus').textContent='還原失敗：'+error.message;}finally{e.target.value='';}
  };
  const recovery=document.createElement('button');recovery.className='btn secondary';recovery.textContent='復原上一次重置／還原';recovery.style.marginTop='20px';$('backupStatus').after(recovery);
  recovery.onclick=async()=>{try{const saved=await window.storage.get('recovery-backup');if(!saved){toast('目前沒有可復原的操作。');return;}const data=validateBackup(JSON.parse(saved.value));if(!await askDialog({title:'復原前一次資料',message:`將還原 ${data.state.notesList.length} 篇筆記與當時的計畫。現有資料也會保留為下一次復原點。`,confirm:'復原'}))return;await replaceLibrary(data);toast('已復原前一次資料。');}catch(e){toast(e.message);}};
  $('resetMount').innerHTML='<div class="section-heading"><div><div class="eyebrow">開啟新一輪溫書</div><h2>重新開始，筆記留下</h2></div></div><div class="reset-grid"><div class="card"><h3>重置完成進度</h3><p>清除每日完成量與章節勾選，保留筆記、科目、章節與考試日期。適合重新複習同一份教材。</p><button class="btn secondary" data-reset="progress">重置完成進度</button></div><div class="card"><h3>重設考試日期</h3><p>移除考試日期，複習天數回到 7 天。所有筆記、科目與已完成進度保留。</p><button class="btn secondary" data-reset="dates">重設日期</button></div></div><details class="card"><summary>進階：清空學習資料</summary><p class="muted">包含筆記與測驗資料。系統會先下載備份，也保留上一次重置的復原點。AI 連線設定保留。</p><button class="btn danger" data-reset="all">清空全部學習資料</button></details>';
  document.querySelectorAll('[data-reset]').forEach(b=>b.onclick=()=>resetStudy(b.dataset.reset));
  $('retrySaveBtn').addEventListener('click',async()=>{await saveCurrentNote();await saveConsolidatedDraft();});
  $('saveSetupBtn').addEventListener('click',()=>{setTimeout(()=>{populateFilters();updateStats();renderNotes();},20);});
  // Reject invalid setup before the original save listener can mutate the plan.
  $('saveSetupBtn').addEventListener('click',e=>{const n=Number($('reviewDays').value);if(!Number.isInteger(n)||n<0||n>365||STATE.config.subjects.some(s=>!Number.isFinite(s.total)||s.total<0)){e.stopImmediatePropagation();toast('請確認複習天數為 0–365 的整數，科目總量不得為負數。');}},true);
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();saveCurrentNote();saveConsolidatedDraft();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();switchTab('notes');$('noteSearch').focus();}});
  window.addEventListener('beforeunload',e=>{if(noteDirty||consolidatedPending||consolidatedSaving){e.preventDefault();e.returnValue='';}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){saveCurrentNote();saveConsolidatedDraft();persistMockDraft();}});
  refreshUI();
  const draft=await window.storage.get('mock-draft');
  if(draft){try{const d=JSON.parse(draft.value);if(Array.isArray(d.questions)&&d.session){currentMockQuestions=d.questions;currentMockSession=d.session;renderMockQuestions();$('mockStatus').textContent='已恢復上次作答草稿。';}}catch{toast('作答草稿無法讀取，其他資料不受影響。');}}
  const wanted=location.hash.slice(1);if(['daily','setup','notes','backup','consolidate','examsources','mock'].includes(wanted))switchTab(wanted);
}).catch(error=>{
  showStorageError();$('storageErrorBanner').firstChild.textContent='無法開啟本機資料庫，請先保留原資料，換用一般瀏覽模式或重新開啟。';
  console.error(error);
});
