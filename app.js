if (typeof pdfjsLib !== 'undefined') pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ---------- Local storage shim ----------
// This standalone (GitHub / self-hosted) build has no server-side storage,
// so we back window.storage with the browser's localStorage instead.
// All data stays only on this device/browser.
// IndexedDB storage and legacy migration are provided by storage.js.

// ---------- Personal AI Relay (BYOK) ----------
// The browser stores only a Worker URL and optional access password. Provider
// API keys live only as encrypted Cloudflare Worker Secrets.
const RELAY_STORAGE_KEY = 'sg:ai-relay-v1';
const LEGACY_API_KEY_STORAGE_KEY = 'sg:anthropic-api-key';

function normalizeRelayUrl(value){
  const raw = String(value||'').trim();
  if(!raw) return '';
  let url;
  try{ url = new URL(raw); }catch(e){ throw new Error('AI Relay 網址格式不正確'); }
  if(url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('AI Relay 網址必須以 https:// 開頭');
  return url.href.replace(/\/+$/, '');
}
function getRelayConfig(){
  try{
    const stored = JSON.parse(localStorage.getItem(RELAY_STORAGE_KEY)||'{}');
    return {
      provider: stored.provider === 'anthropic' ? 'anthropic' : 'openai',
      url: stored.url ? normalizeRelayUrl(stored.url) : '',
      token: typeof stored.token === 'string' ? stored.token : ''
    };
  }catch(e){ return {provider:'openai', url:'', token:''}; }
}
function setRelayConfig(config){
  localStorage.setItem(RELAY_STORAGE_KEY, JSON.stringify({
    provider: config.provider === 'anthropic' ? 'anthropic' : 'openai',
    url: normalizeRelayUrl(config.url),
    token: String(config.token||'')
  }));
}
function clearRelayConfig(){ localStorage.removeItem(RELAY_STORAGE_KEY); }
function providerLabel(provider){ return provider === 'anthropic' ? 'Claude／Anthropic' : 'GPT／OpenAI'; }
function relayHeaders(config){
  const headers = {'Content-Type':'application/json'};
  if(config.token) headers.Authorization = 'Bearer ' + config.token;
  return headers;
}
async function relayRequest(path, payload, suppliedConfig){
  const config = suppliedConfig || getRelayConfig();
  if(!config.url) throw new Error('尚未設定個人 AI Relay，請到「設定」頁連接。');
  const response = await fetch(config.url + path, {
    method: payload ? 'POST' : 'GET',
    headers: payload ? relayHeaders(config) : (config.token ? {Authorization:'Bearer ' + config.token} : {}),
    body: payload ? JSON.stringify(payload) : undefined
  });
  let data = {};
  try{ data = await response.json(); }catch(e){}
  if(!response.ok) throw new Error((data && data.error) || ('Relay 連線失敗（HTTP ' + response.status + '）'));
  return data;
}
async function testRelayConfig(config){
  if(!config.token) throw new Error('請填入你在 Worker 設定的 Relay 存取密碼。');
  const data = await relayRequest('/health', null, config);
  if(!data || !data.ok) throw new Error('這不是可用的 CramGoose AI Relay。');
  if(data.configured === false) throw new Error('Worker 已連通，但尚未設定模型或 API Key。');
  return data;
}
function updateRelayStatus(){
  const config = getRelayConfig();
  const status = document.getElementById('relaySaved');
  if(config.url){
    status.textContent = '已儲存 ' + providerLabel(config.provider) + ' Relay（僅存在此瀏覽器）';
  }else{
    status.textContent = '尚未設定；不使用 AI 功能可略過。';
  }
}

let STATE = {
  config: { examDate:"", reviewDays:7, subjects:[] },
  dailyLog: {}, // { date: { subjectId: amount } }
  notesList: [], // { id, subjectId, filename, uploadedAt, chars }
  consolidated: {}, // subjectId -> text
  mockHistory: [], // { id, date, subjectIds, score, feedback, mode }
  examSources: [] // { id, subjectId, type: guidance|paper|teacher, title, content, createdAt }
};

function todayStr(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function uid(){ return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)+Math.random().toString(36).slice(2); }

async function loadState(){
  try{
    const r = await window.storage.get('planner-state');
    if(r && r.value){ STATE = JSON.parse(r.value); }
  }catch(e){ showStorageError(); throw new Error('資料讀取失敗，請保留舊資料並重新開啟。'); }
  // 向下相容舊版資料：只補齊新欄位，不會覆寫原本的讀書計畫、筆記或模擬考紀錄。
  if(!STATE || typeof STATE !== 'object') STATE = {};
  if(!STATE.config || typeof STATE.config !== 'object') STATE.config = { examDate:"", reviewDays:7, subjects:[] };
  if(!Array.isArray(STATE.config.subjects)) STATE.config.subjects = [];
  if(!STATE.dailyLog || typeof STATE.dailyLog !== 'object') STATE.dailyLog = {};
  if(!Array.isArray(STATE.notesList)) STATE.notesList = [];
  if(!STATE.consolidated || typeof STATE.consolidated !== 'object') STATE.consolidated = {};
  if(!Array.isArray(STATE.mockHistory)) STATE.mockHistory = [];
  if(!Array.isArray(STATE.examSources)) STATE.examSources = [];
}

function showStorageError(){
  document.getElementById('storageErrorBanner').style.display = 'block';
}
function hideStorageError(){
  document.getElementById('storageErrorBanner').style.display = 'none';
}
async function safeStorageSet(key, value, shared=false, retries=2){
  let lastErr;
  for(let i=0;i<=retries;i++){
    try{
      const r = await window.storage.set(key, value, shared);
      if(!r) throw new Error('empty result from storage.set');
      return r;
    }catch(e){
      lastErr = e;
      console.error(`storage set failed (attempt ${i+1}/${retries+1}) for key "${key}":`, e);
      if(i<retries) await new Promise(res=>setTimeout(res, 500*(i+1)));
    }
  }
  throw lastErr;
}
let lastSaveFn = null;
async function saveState(){
  lastSaveFn = saveState;
  try{
    await safeStorageSet('planner-state', JSON.stringify(STATE));
    hideStorageError();
    return true;
  }catch(e){
    showStorageError();
    return false;
  }
}
document.getElementById('retrySaveBtn').addEventListener('click', async ()=>{
  if(lastSaveFn) await lastSaveFn();
});

// ---------- Tabs ----------
document.querySelectorAll('nav.tabs button').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('nav.tabs button').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('section.panel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-'+btn.dataset.tab).classList.add('active');
    if(btn.dataset.tab==='daily') renderDaily();
    if(btn.dataset.tab==='notes') renderNotes();
    if(btn.dataset.tab==='examsources') renderExamSources();
    if(btn.dataset.tab==='consolidate') renderConsolidateSelect();
    if(btn.dataset.tab==='mock') renderMock();
  });
});

// ---------- Setup ----------
function renderSubjectRows(){
  const wrap = document.getElementById('subjectRows');
  const openState = {};
  wrap.querySelectorAll('details').forEach((d,idx)=>{ openState[idx] = d.open; });
  wrap.innerHTML = '';
  STATE.config.subjects.forEach((s,i)=>{
    if(!s.chapters) s.chapters = [];
    const total = subjectTotal(s);
    const isOpen = openState[i]!==undefined ? openState[i] : s.chapters.length<=6;
    const box = document.createElement('div');
    box.className='subject-card';
    box.innerHTML = `
      <div class="subject-row">
        <input type="text" placeholder="科目名稱" value="${escapeHtml(s.name||'')}" data-field="name" data-idx="${i}">
        <input type="text" placeholder="單位（章/頁/小時）" value="${escapeHtml(s.unit||'')}" data-field="unit" data-idx="${i}" style="max-width:110px">
        ${s.chapters.length===0
          ? `<input type="number" placeholder="總量" value="${s.total||''}" data-field="total" data-idx="${i}" style="max-width:90px">`
          : `<span class="muted" style="min-width:100px; text-align:right">共 ${total} ${escapeHtml(s.unit||'')}</span>`}
        <button class="btn danger" data-del="${i}" style="padding:6px 10px">刪除科目</button>
      </div>
      <details class="chapters-box" ${isOpen?'open':''}>
        <summary>
          章節清單
          ${s.chapters.length ? `<span class="pill ${s.chapters.every(c=>c.done)?'ok':'warn'}">${s.chapters.filter(c=>c.done).length}/${s.chapters.length} 已完成</span>` : '<span class="muted">尚未新增</span>'}
        </summary>
        <div class="quick-add-row" style="display:flex; gap:8px; align-items:center; margin-bottom:10px">
          <input type="number" min="1" placeholder="章數，例如 27" style="max-width:90px" data-quickcount="${i}">
          <button class="btn secondary" data-quickgen="${i}" style="padding:4px 10px">產生章節</button>
          <button class="btn secondary" data-addchapter="${i}" style="padding:4px 10px">+ 單獨新增</button>
        </div>
        <div class="chapter-rows">
          ${s.chapters.map((c,ci)=>`
            <div class="chapter-row">
              <input type="checkbox" ${c.done?'checked':''} title="已完成" data-cfield="done" data-idx="${i}" data-cidx="${ci}">
              <input type="text" placeholder="章節名稱" value="${escapeHtml(c.name||'')}" data-cfield="name" data-idx="${i}" data-cidx="${ci}">
              <button class="btn danger" data-delchapter="${i}" data-cidx="${ci}">×</button>
            </div>
          `).join('') || '<div class="muted" style="padding:4px 0">尚未新增章節，將以上方「總量」數字排程。</div>'}
        </div>
      </details>
    `;
    wrap.appendChild(box);
  });
  wrap.querySelectorAll('input[data-field]').forEach(inp=>{
    inp.addEventListener('input', e=>{
      const idx = +e.target.dataset.idx, field = e.target.dataset.field;
      STATE.config.subjects[idx][field] = field==='total' ? Number(e.target.value) : e.target.value;
    });
  });
  wrap.querySelectorAll('input[data-cfield]').forEach(inp=>{
    const evt = inp.type==='checkbox' ? 'change' : 'input';
    inp.addEventListener(evt, e=>{
      const idx = +e.target.dataset.idx, cidx = +e.target.dataset.cidx, field = e.target.dataset.cfield;
      const chapter = STATE.config.subjects[idx].chapters[cidx];
      if(field==='amount') chapter.amount = Number(e.target.value)||1;
      else if(field==='done'){
        chapter.done = e.target.checked; chapter.doneDate = e.target.checked ? todayStr() : null;
        renderSubjectRows();
        return;
      }
      else chapter.name = e.target.value;
    });
  });
  wrap.querySelectorAll('[data-del]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const removed=STATE.config.subjects[+b.dataset.del];
      if(!confirm('移除科目「'+(removed.name||'未命名')+'」？其筆記會保留，可在筆記書房重新分類。')) return;
      STATE.config.subjects.splice(+b.dataset.del,1);
      renderSubjectRows();
    });
  });
  wrap.querySelectorAll('[data-addchapter]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const idx = +b.dataset.addchapter;
      STATE.config.subjects[idx].chapters.push({id:uid(), name:'', amount:1, done:false, doneDate:null});
      renderSubjectRows();
    });
  });
  wrap.querySelectorAll('[data-quickgen]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const idx = +b.dataset.quickgen;
      const countInput = wrap.querySelector(`input[data-quickcount="${idx}"]`);
      const count = Number(countInput.value)||0;
      if(count<=0) return;
      if(count>500){alert('一次最多建立 500 個章節。');return;}
      const subj = STATE.config.subjects[idx];
      const startAt = subj.chapters.length;
      for(let n=1;n<=count;n++){
        subj.chapters.push({id:uid(), name:`第${startAt+n}章`, amount:1, done:false, doneDate:null});
      }
      renderSubjectRows();
    });
  });
  wrap.querySelectorAll('[data-delchapter]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const idx = +b.dataset.delchapter, cidx = +b.dataset.cidx;
      STATE.config.subjects[idx].chapters.splice(cidx,1);
      renderSubjectRows();
    });
  });
}
document.getElementById('addSubjectBtn').addEventListener('click', ()=>{
  STATE.config.subjects.push({id:uid(), name:'', unit:'章', total:0, chapters:[]});
  renderSubjectRows();
});
document.getElementById('saveSetupBtn').addEventListener('click', async ()=>{
  STATE.config.examDate = document.getElementById('examDate').value;
  STATE.config.reviewDays = Number(document.getElementById('reviewDays').value)||0;
  STATE.config.subjects.forEach(s=>{
    if(s.chapters) s.chapters = s.chapters.filter(c=>c.name && c.name.trim());
  });
  STATE.config.subjects = STATE.config.subjects.filter(s=> s.name && s.name.trim());
  if(!await saveState()) return;
  document.getElementById('setupSaved').textContent = '已儲存 ✓ '+new Date().toLocaleTimeString('zh-TW');
  renderSubjectRows();
  renderCountdown();
  refreshAllSelects();
});

function escapeHtml(str){
  return String(str??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- Scheduling core ----------
function daysBetween(a,b){ // a,b = 'YYYY-MM-DD', returns b-a in days
  const A = new Date(a+'T00:00:00'), B = new Date(b+'T00:00:00');
  return Math.round((B-A)/86400000);
}
function chapterMode(s){ return !!(s.chapters && s.chapters.length>0); }
function subjectTotal(s){
  return chapterMode(s) ? s.chapters.reduce((a,c)=>a+(c.amount||1),0) : (s.total||0);
}
function completedAmount(subjectId){ // legacy numeric-mode log
  let sum = 0;
  for(const date in STATE.dailyLog){
    const v = STATE.dailyLog[date][subjectId];
    if(v) sum += v;
  }
  return sum;
}
function subjectCompleted(s){
  return chapterMode(s) ? s.chapters.filter(c=>c.done).reduce((a,c)=>a+(c.amount||1),0) : completedAmount(s.id);
}
function suggestChapters(s, targetAmount){
  const undone = s.chapters.filter(c=>!c.done);
  if(undone.length===0 || targetAmount<=0) return [];
  let acc=0, picked=[];
  for(const c of undone){
    picked.push(c);
    acc += (c.amount||1);
    if(acc>=targetAmount) break;
  }
  return picked;
}
function isReviewDay(dateStr){
  const cfg = STATE.config;
  if(!cfg.examDate) return false;
  const toExam = daysBetween(dateStr, cfg.examDate);
  return toExam >= 0 && toExam < cfg.reviewDays;
}
function remainingStudyDays(fromDate){
  const cfg = STATE.config;
  if(!cfg.examDate) return 1;
  const reviewStart = new Date(cfg.examDate+'T00:00:00');
  reviewStart.setDate(reviewStart.getDate() - cfg.reviewDays);
  const reviewStartStr = reviewStart.toISOString().slice(0,10);
  const d = daysBetween(fromDate, reviewStartStr);
  return Math.max(d, 1);
}
function plannedFor(dateStr){
  const cfg = STATE.config;
  const remDays = remainingStudyDays(dateStr);
  return cfg.subjects.map(s=>{
    const total = subjectTotal(s);
    const done = subjectCompleted(s);
    const remaining = Math.max(total - done, 0);
    const planned = remaining>0 ? Math.ceil(remaining/remDays) : 0;
    const cMode = chapterMode(s);
    const suggested = cMode ? suggestChapters(s, planned) : [];
    return {...s, total, done, remaining, planned, chapterMode:cMode, suggested};
  });
}

// ---------- Countdown bar ----------
function renderCountdown(){
  const cfg = STATE.config;
  const bar = document.getElementById('countdownBar');
  if(!cfg.examDate || cfg.subjects.length===0){ bar.style.display='none'; return; }
  bar.style.display='block';
  const today = todayStr();
  const totalDays = Math.max(daysBetween(today, cfg.examDate),0);
  const totalPlanned = cfg.subjects.reduce((a,s)=>a+subjectTotal(s),0);
  const totalDone = cfg.subjects.reduce((a,s)=>a+subjectCompleted(s),0);
  const pct = totalPlanned>0 ? Math.min(100, Math.round(totalDone/totalPlanned*100)) : 0;
  document.getElementById('cdText').textContent = `整體進度 ${pct}%（${totalDone}/${totalPlanned}）`;
  document.getElementById('cdDays').textContent = `距離考試 ${totalDays} 天`;
  document.getElementById('cdFill').style.width = pct+'%';
  // review segment position
  const reviewWidthPct = totalDays>0 ? Math.min(100, cfg.reviewDays/ (totalDays+cfg.reviewDays) * 100) : 0;
  const rev = document.getElementById('cdReview');
  rev.style.right = '0%'; rev.style.width = reviewWidthPct+'%';
}

// ---------- Daily panel ----------
function renderDaily(){
  const card = document.getElementById('dailyCard');
  const cfg = STATE.config;
  if(!cfg.examDate || cfg.subjects.length===0){
    card.innerHTML = `<div class="empty">請先到「設定」頁填寫考試日期與科目。</div>`;
    document.getElementById('forecast').innerHTML='';
    document.getElementById('backfillRows').innerHTML = '<div class="empty">請先到「設定」頁新增科目。</div>';
    document.getElementById('historyLog').innerHTML = '';
    return;
  }
  const today = todayStr();
  document.getElementById('todayLabel').textContent = today;
  if(today >= cfg.examDate){ card.innerHTML='<h3>這次計畫已到考試日</h3><p class="muted">可以複習筆記，或到「計畫與設定」重設日期與完成進度，開始下一輪溫書。</p>'; renderBackfill(); renderHistoryLog(); document.getElementById('forecast').textContent=''; return; }
  if(isReviewDay(today)){
    const consolidatedSubjects = Object.keys(STATE.consolidated).filter(id=>STATE.consolidated[id]);
    card.innerHTML = `
      <h3>📖 今天是總複習日</h3>
      <p class="muted">不排新進度，建議複習已統整的筆記，或到「模擬考」頁自我測驗。</p>
      ${consolidatedSubjects.length ? '<p>已完成統整筆記的科目：'+consolidatedSubjects.map(id=>{
        const s = cfg.subjects.find(x=>x.id===id); return s? escapeHtml(s.name):'';
      }).join('、')+'</p>' : '<p class="muted">目前尚無統整筆記，建議先到「總複習」頁面產生。</p>'}
    `;
  } else {
    card.innerHTML = `<h3>今日建議進度</h3><div id="taskRows"></div>
      <button class="btn" id="saveTodayBtn" style="margin-top:10px">儲存完成量</button>
      <span id="todaySaved" class="muted" style="margin-left:10px"></span>`;
    const rows = document.getElementById('taskRows');
    buildProgressRows(rows, today);
    document.getElementById('saveTodayBtn').addEventListener('click', async ()=>{
      if(!await saveProgressForm(rows, today)) return;
      document.getElementById('todaySaved').textContent = '已儲存，明日進度將自動重新計算 ✓';
      renderCountdown();
      renderDaily();
      document.getElementById('todaySaved').textContent='已儲存，後續進度已更新 ✓';
    });
  }
  // 7 day forecast (projection assuming plan completed exactly)
  const fc = document.getElementById('forecast');
  let html = '<table><tr><th>日期</th><th>類型</th><th>建議內容</th></tr>';
  const projCompleted = {}; // simulate
  cfg.subjects.forEach(s=> projCompleted[s.id] = subjectCompleted(s));
  for(let i=0;i<7;i++){
    const d = new Date(); d.setDate(d.getDate()+i);
    const ds = localDate(d);
    if(ds >= cfg.examDate){ html += `<tr><td>${ds}</td><td>考試／已結束</td><td>—</td></tr>`; continue; }
    if(isReviewDay(ds)){
      html += `<tr><td>${ds}</td><td><span class="pill warn">總複習</span></td><td class="muted">複習統整筆記／模擬考</td></tr>`;
    } else {
      const remDays = remainingStudyDays(ds);
      const parts = cfg.subjects.map(s=>{
        const total = subjectTotal(s);
        const remaining = Math.max(total - projCompleted[s.id],0);
        const planned = remaining>0? Math.ceil(remaining/remDays):0;
        projCompleted[s.id] += planned;
        return planned>0 ? `${escapeHtml(s.name)} ${planned}${escapeHtml(s.unit)}` : null;
      }).filter(Boolean);
      html += `<tr><td>${ds}</td><td><span class="pill ok">讀書日</span></td><td>${parts.join('、')||'—'}</td></tr>`;
    }
  }
  html += '</table>';
  fc.innerHTML = html;

  renderBackfill();
  renderHistoryLog();
}

// ---------- Shared progress form (used by today + backfill) ----------
function buildProgressRows(containerEl, date){
  const tasks = plannedFor(date);
  const legacyLog = STATE.dailyLog[date] || {};
  containerEl.innerHTML = tasks.map(t=>{
    const statusPill = t.planned===0 ? '<span class="pill ok">已完成</span>' : '';
    const header = `<div class="task-row">
      <div class="name">${escapeHtml(t.name)} ${statusPill}</div>
      <div class="target">建議 ${t.planned} ${escapeHtml(t.unit)}（剩 ${t.remaining}）</div>
      ${t.chapterMode ? '' : `<input type="number" min="0" data-sid="${t.id}" placeholder="完成量" value="${legacyLog[t.id]!==undefined?legacyLog[t.id]:''}">`}
    </div>`;
    if(!t.chapterMode) return header;
    const undoneChapters = (t.chapters||[]).filter(c=>!c.done);
    if(undoneChapters.length===0) return header;
    const suggestedIds = new Set(t.suggested.map(c=>c.id));
    const checklist = `<div class="chapter-check-list">` + undoneChapters.map(c=>{
      const isSuggested = suggestedIds.has(c.id);
      return `<label class="chapter-check ${isSuggested?'suggested':''}">
        <input type="checkbox" data-chk-sid="${t.id}" data-chk-cid="${c.id}">
        ${escapeHtml(c.name)}
        ${isSuggested?'<span class="pill warn">建議</span>':''}
      </label>`;
    }).join('') + `</div>`;
    return header + checklist;
  }).join('');
}
async function saveProgressForm(containerEl, date){
  const cfg = STATE.config;
  const numericInputs = containerEl.querySelectorAll('input[data-sid]');
  if(numericInputs.length){
    if(!STATE.dailyLog[date]) STATE.dailyLog[date] = {};
    numericInputs.forEach(inp=>{
      STATE.dailyLog[date][inp.dataset.sid] = Number(inp.value)||0;
    });
  }
  containerEl.querySelectorAll('input[data-chk-sid]:checked').forEach(chk=>{
    const subj = cfg.subjects.find(s=>s.id===chk.dataset.chkSid);
    if(!subj) return;
    const chapter = (subj.chapters||[]).find(c=>c.id===chk.dataset.chkCid);
    if(chapter){ chapter.done = true; chapter.doneDate = date; }
  });
  if(!await saveState()) return false;
  return true;
}

// ---------- Backfill / history ----------
function renderBackfill(){
  const dateInput = document.getElementById('backfillDate');
  if(!dateInput.value) dateInput.value = todayStr();
  const cfg = STATE.config;
  const wrap = document.getElementById('backfillRows');
  if(cfg.subjects.length===0){ wrap.innerHTML = '<div class="empty">請先到「設定」頁新增科目。</div>'; return; }
  buildProgressRows(wrap, dateInput.value);
}
document.getElementById('backfillDate').addEventListener('change', renderBackfill);
document.getElementById('saveBackfillBtn').addEventListener('click', async ()=>{
  const date = document.getElementById('backfillDate').value;
  if(!date) return;
  const wrap = document.getElementById('backfillRows');
  if(!await saveProgressForm(wrap, date)) return;
  document.getElementById('backfillSaved').textContent = '已儲存 ✓ 後續進度已自動重新計算';
  renderDaily();
  renderCountdown();
});

function buildHistoryByDate(){
  const map = {};
  for(const date in STATE.dailyLog){
    for(const sid in STATE.dailyLog[date]){
      const s = STATE.config.subjects.find(x=>x.id===sid);
      if(!s || chapterMode(s)) continue;
      const amt = STATE.dailyLog[date][sid];
      if(!amt) continue;
      (map[date] = map[date]||[]).push(`${escapeHtml(s.name)} ${amt}${escapeHtml(s.unit)}`);
    }
  }
  STATE.config.subjects.forEach(s=>{
    if(!chapterMode(s)) return;
    (s.chapters||[]).forEach(c=>{
      if(c.done && c.doneDate){
        (map[c.doneDate] = map[c.doneDate]||[]).push(`${escapeHtml(s.name)}：${escapeHtml(c.name)}`);
      }
    });
  });
  return map;
}

function renderHistoryLog(){
  const wrap = document.getElementById('historyLog');
  const map = buildHistoryByDate();
  const dates = Object.keys(map).sort().reverse();
  if(dates.length===0){ wrap.innerHTML = '<div class="empty">尚無任何紀錄。</div>'; return; }
  wrap.innerHTML = '<table><tr><th>日期</th><th>完成內容</th><th></th></tr>' + dates.map(date=>{
    return `<tr>
      <td>${date}</td>
      <td>${map[date].join('、')}</td>
      <td style="white-space:nowrap">
        <button class="btn secondary" style="padding:4px 10px" data-edit="${date}">編輯</button>
        <button class="btn danger" style="padding:4px 10px" data-deldate="${date}">刪除</button>
      </td>
    </tr>`;
  }).join('') + '</table>';
  wrap.querySelectorAll('[data-edit]').forEach(b=>{
    b.addEventListener('click', ()=>{
      document.getElementById('backfillDate').value = b.dataset.edit;
      renderBackfill();
      document.getElementById('backfillDate').scrollIntoView({behavior:'smooth', block:'center'});
    });
  });
  wrap.querySelectorAll('[data-deldate]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      const date = b.dataset.deldate;
      if(!confirm('刪除 '+date+' 的完成紀錄？筆記不會受到影響。')) return;
      delete STATE.dailyLog[date];
      STATE.config.subjects.forEach(s=>{
        (s.chapters||[]).forEach(c=>{
          if(c.doneDate===date){ c.done=false; c.doneDate=null; }
        });
      });
      if(!await saveState()) return false;
      renderDaily();
    });
  });
}

// ---------- Notes panel ----------
function refreshAllSelects(){
  const opts = STATE.config.subjects.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  ['noteSubjectSelect','consolidateSubjectSelect','examSourceSubjectSelect'].forEach(id=>{
    const el = document.getElementById(id);
    const cur = el.value;
    el.innerHTML = opts || '<option value="">請先新增科目</option>';
    if(cur && STATE.config.subjects.some(s=>s.id===cur)) el.value = cur;
  });
  refreshNoteChapterSelect();
  const checkWrap = document.getElementById('mockSubjectChecks');
  checkWrap.innerHTML = STATE.config.subjects.map(s=>
    `<label><input type="checkbox" value="${s.id}" checked> ${escapeHtml(s.name)}</label>`
  ).join('') || '<span class="muted">請先新增科目</span>';
}
function refreshNoteChapterSelect(){
  const subjectId = document.getElementById('noteSubjectSelect').value;
  const chapterSelect = document.getElementById('noteChapterSelect');
  const subj = STATE.config.subjects.find(s=>s.id===subjectId);
  const chapters = (subj && subj.chapters) ? subj.chapters : [];
  chapterSelect.innerHTML = '<option value="">— 不指定章節 —</option>' +
    chapters.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}
document.getElementById('noteSubjectSelect').addEventListener('change', refreshNoteChapterSelect);

// ---------- OCR helpers (for scanned PDFs / photographed notes) ----------
async function ocrImageViaAI(base64, mediaType){
  const data = await relayRequest('/study', {
    prompt: '請將這張筆記或考古資料圖片中所有可辨識文字忠實轉錄成純文字，包含圖片、表格、圖表、公式與手寫標註中的文字。保留標題、條列與段落結構。數學公式、希臘字母、上下標、積分、根號、集合、箭頭與其他符號必須原樣保留；無法排版的公式請用清楚的線性 Unicode 表示，絕不可自行計算、改寫或補充。不要摘要、不要加入自己的解讀或補充。若有無法辨識的字或符號，請只在該處標記【無法辨識】。只輸出轉錄後的文字內容。',
    maxTokens: 6000,
    image: {data:base64, mediaType:mediaType}
  });
  if(!data || typeof data.text !== 'string') throw new Error('AI 未傳回可用的辨識文字');
  return data.text;
}
function fileToBase64(file){
  return new Promise((resolve,reject)=>{
    const r = new FileReader();
    r.onload = ()=> resolve(r.result.split(',')[1]);
    r.onerror = ()=> reject(new Error('讀取檔案失敗'));
    r.readAsDataURL(file);
  });
}

// 不完全依賴 MIME type：部分瀏覽器對 .docx、.pptx、.md 或下載後 PDF 回報空字串。
function getFileKind(file){
  const name = (file.name||'').toLowerCase();
  const type = file.type||'';
  if(type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if(type.startsWith('image/')) return 'image';
  if(name.endsWith('.docx') || type==='application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if(name.endsWith('.pptx') || type==='application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx';
  if(name.endsWith('.txt') || name.endsWith('.md') || type==='text/plain' || type==='text/markdown') return 'text';
  return null;
}
function decodeXmlEntities(text){
  return text.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
}
async function docxToText(file){
  if(typeof mammoth === 'undefined') throw new Error('Word 解析元件未載入，請確認網路連線後重新整理。');
  const result = await mammoth.extractRawText({arrayBuffer:await file.arrayBuffer()});
  const text = (result && result.value) ? result.value : '';
  if(!text.trim()) throw new Error('讀不到 Word 文字內容；若文件主要是圖片，請轉成圖片或 PDF 後上傳。');
  return text;
}
async function pptxToText(file){
  if(typeof JSZip === 'undefined') throw new Error('PowerPoint 解析元件未載入，請確認網路連線後重新整理。');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slides = Object.keys(zip.files).filter(path=>/^ppt\/slides\/slide\d+\.xml$/.test(path)).sort((a,b)=>{
    const aNumber = Number(a.match(/slide(\d+)\.xml/)[1]);
    const bNumber = Number(b.match(/slide(\d+)\.xml/)[1]);
    return aNumber-bNumber;
  });
  if(!slides.length) throw new Error('讀不到投影片內容；舊版 .ppt 請先另存為 .pptx。');
  let text = '';
  for(let index=0;index<slides.length;index++){
    const xml = await zip.files[slides[index]].async('string');
    const items = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(match=>decodeXmlEntities(match[1]));
    text += `\n【第${index+1}頁投影片】\n${items.join(' ')}\n`;
  }
  if(!text.replace(/【第\d+頁投影片】/g,'').trim()) throw new Error('投影片沒有可讀取的文字；若主要是圖片，請另存成圖片或 PDF 後上傳。');
  return text;
}
async function ocrPdfPage(page){
  const viewport = page.getViewport({scale:1.5});
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width; canvas.height = viewport.height;
  await page.render({canvasContext: canvas.getContext('2d'), viewport}).promise;
  const base64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
  return ocrImageViaAI(base64, 'image/jpeg');
}
function pdfPageContainsImage(operatorList){
  const ops = pdfjsLib.OPS || {};
  const imageOps = [
    ops.paintImageXObject, ops.paintImageXObjectRepeat, ops.paintJpegXObject,
    ops.paintSolidColorImageMask, ops.paintImageMaskXObject
  ].filter(value=>typeof value==='number');
  return imageOps.some(op=>operatorList.fnArray.includes(op));
}
async function ocrPdfViaVision(pdf, onProgress){
  let text = '';
  for(let pageNumber=1; pageNumber<=pdf.numPages; pageNumber++){
    if(onProgress) onProgress(pageNumber, pdf.numPages);
    const page = await pdf.getPage(pageNumber);
    const pageText = await ocrPdfPage(page);
    text += `\n【第${pageNumber}頁 · AI 視覺辨識】\n${pageText}\n`;
  }
  return text;
}

// 共用 PDF 讀取程序：逐頁檢查文字層與內嵌圖片，混合型 PDF 也不會漏掉圖片頁的文字。
async function extractPdfText(file, onProgress){
  if(typeof pdfjsLib==='undefined') throw new Error('PDF 元件尚未載入，請連線後重新整理。');
  pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({
    data: buffer,
    cMapUrl: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/",
    cMapPacked: true
  }).promise;
  let extractedText = '';
  for(let pageNumber=1; pageNumber<=pdf.numPages; pageNumber++){
    if(onProgress) onProgress(pageNumber, pdf.numPages, false);
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const nativeText = content.items.map(item=>item.str).join(' ').trim();
    const meaningfulChars = nativeText.replace(/\s/g,'').length;
    let containsImage = false;
    try{ containsImage = pdfPageContainsImage(await page.getOperatorList()); }catch(e){}
    // 圖片頁即使同時有少量文字層，也要以整頁視覺辨識補齊圖片內的文字與手寫註記。
    if((meaningfulChars<20 || containsImage) && getRelayConfig().url){
      if(onProgress) onProgress(pageNumber, pdf.numPages, true);
      const visionText = await ocrPdfPage(page);
      extractedText += `\n【第${pageNumber}頁${containsImage ? ' · 文字／圖片混合辨識' : ' · AI 視覺辨識'}】\n`;
      if(nativeText) extractedText += `【可擷取文字】\n${nativeText}\n`;
      extractedText += `【視覺辨識文字】\n${visionText}\n`;
    }else{
      extractedText += `\n【第${pageNumber}頁】\n${nativeText}\n`;
      if(meaningfulChars<20 || containsImage) extractedText += '【待辨識：本頁可能含圖片或掃描文字，請設定 AI Relay 後重新匯入並核對原稿。】\n';
    }
  }
  return extractedText;
}

document.getElementById('pdfInput').addEventListener('change', async (e)=>{
  const subjectId = document.getElementById('noteSubjectSelect').value;
  const chapterId = document.getElementById('noteChapterSelect').value || null;
  if(!subjectId){ document.getElementById('uploadStatus').textContent = '請先選擇科目'; return; }
  const files = Array.from(e.target.files);
  e.target.disabled = true;
  const statusEl = document.getElementById('uploadStatus');
  let uploadedCount = 0;
  const failures = [];
  for(const file of files){
    statusEl.textContent = `處理中：${file.name} ...`;
    try{
      let text = '';
      const kind = getFileKind(file);
      if(kind === 'pdf'){
        text = await extractPdfText(file, (page,total,usingOcr)=>{
          statusEl.textContent = usingOcr
            ? `AI 辨識「${file.name}」第 ${page}/${total} 頁的圖片／掃描內容...`
            : `讀取「${file.name}」第 ${page}/${total} 頁...`;
        });
      } else if(kind === 'image'){
        statusEl.textContent = `AI 辨識圖片「${file.name}」中...`;
        const base64 = await fileToBase64(file);
        text = await ocrImageViaAI(base64, file.type);
      } else if(kind === 'docx'){
        statusEl.textContent = `讀取 Word 文件「${file.name}」中...`;
        text = await docxToText(file);
      } else if(kind === 'pptx'){
        statusEl.textContent = `讀取 PowerPoint「${file.name}」中...`;
        text = await pptxToText(file);
      } else if(kind === 'text'){
        statusEl.textContent = `讀取文字檔「${file.name}」中...`;
        text = await file.text();
      } else {
        statusEl.textContent = `不支援的檔案類型：${file.name}`;
        failures.push(`${file.name}：不支援的檔案類型`);
        continue;
      }
      if(!text.trim()) throw new Error('檔案沒有可用的文字。');
      if(!text.trim()) throw new Error('檔案沒有可用的文字。');
      const id = uid();
      STATE.notesList.push({id,subjectId,chapterId,filename:file.name,uploadedAt:new Date().toISOString(),chars:text.length});
      try{
        await window.storage.batch({'planner-state':JSON.stringify(STATE),['note-text:'+id]:text});
      }catch(error){STATE.notesList.pop();showStorageError();throw error;}
      uploadedCount++;
    }catch(err){
      console.error(err);
      failures.push(`${file.name}：${err.message||'可能為加密檔、格式不支援，或尚未設定 AI Relay'}`);
    }
  }
  if(uploadedCount && failures.length){
    statusEl.textContent = `已上傳 ${uploadedCount} 份筆記；另有 ${failures.length} 份失敗：${failures.join('；')}`;
  }else if(uploadedCount){
    statusEl.textContent = `上傳完成 ✓（共 ${uploadedCount} 份）`;
  }else{
    statusEl.textContent = `沒有任何筆記成功上傳：${failures.join('；')||'請重新選擇檔案後再試'}`;
  }
  renderNotes();
  e.target.value = '';
  e.target.disabled = false;
});

function renderNotes(){
  const wrap = document.getElementById('notesList');
  if(STATE.notesList.length===0){ wrap.innerHTML = '<div class="empty">尚未上傳任何筆記。</div>'; return; }
  wrap.innerHTML = STATE.notesList.map(n=>{
    const s = STATE.config.subjects.find(x=>x.id===n.subjectId);
    const chapter = (s && s.chapters) ? s.chapters.find(c=>c.id===n.chapterId) : null;
    const tag = [s?escapeHtml(s.name):'未分類', chapter?escapeHtml(chapter.name):null].filter(Boolean).join(' · ');
    return `<div class="note-item">
      <span>${escapeHtml(n.filename)} <small>（${tag} · 約 ${n.chars} 字）</small></span>
      <button class="btn danger" style="padding:4px 10px" data-delnote="${n.id}">刪除</button>
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-delnote]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      const id = b.dataset.delnote;
      STATE.notesList = STATE.notesList.filter(n=>n.id!==id);
      try{ await window.storage.delete('note-text:'+id); }catch(e){}
      if(!await saveState()) return false;
      renderNotes();
    });
  });
}

// ---------- AI Relay helper ----------
function sanitizeForPrompt(text){
  if(!text) return '';
  const source = String(text).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g,'');
  let output = '';
  for(let i=0;i<source.length;i++){
    const code = source.charCodeAt(i);
    if(code>=0xD800 && code<=0xDBFF){
      const next = source.charCodeAt(i+1);
      if(next>=0xDC00 && next<=0xDFFF){ output += source[i]+source[i+1]; i++; }
    } else if(code<0xDC00 || code>0xDFFF){
      output += source[i];
    }
  }
  return output;
}
async function callAI(prompt, maxTokens){
  const data = await relayRequest('/study', {
    prompt: sanitizeForPrompt(prompt),
    maxTokens: maxTokens || 1000
  });
  if(!data || typeof data.text !== 'string') throw new Error('AI 未傳回可用文字');
  return data.text;
}
function stripJsonFence(text){
  return text.replace(/```json|```/g,'').trim();
}

// ---------- Consolidate ----------
function renderConsolidateSelect(){
  const sel = document.getElementById('consolidateSubjectSelect');
  const subjectId = sel.value;
  document.getElementById('consolidateOutput').value = STATE.consolidated[subjectId] || '';
  updateWordCount();
  renderConsolidationLimitNotice(subjectId);
}
document.getElementById('consolidateSubjectSelect').addEventListener('change', renderConsolidateSelect);
document.getElementById('consolidateOutput').addEventListener('input', updateWordCount);
function updateWordCount(){
  const text = document.getElementById('consolidateOutput').value;
  const n = text.length;
  document.getElementById('consolidateWordCount').textContent = n>0 ? `內容約 ${n.toLocaleString()} 字` : '';
  const summary = document.getElementById('consolidateSummary');
  if(n>0){
    summary.innerHTML = `<strong>統整筆記可在下方查看與修改。</strong><span class="muted">約 ${n.toLocaleString()} 字。可再次下載 PDF 或 Word；重新整合會覆寫此科目的舊版本。</span>`;
  } else {
    summary.innerHTML = '<strong>尚未建立整合筆記。</strong><span class="muted">選擇科目後按「AI 統整筆記」。請先確認內容，再匯出複習資料。</span>';
  }
}

// Relay 的單次 prompt 上限為 24,000 字元；大量筆記先切塊，再以兩階段摘要統整。
const CONSOLIDATION_LIMITS = Object.freeze({
  maxSourceChars: 108000,
  maxTotalSourceChars: 216000,
  chunkChars: 9000,
  maxChunks: 12,
  maxStages: 2,
  digestChars: 17000
});

function getConsolidationPlan(notes){
  const totalChars = notes.reduce((sum,n)=>sum + Math.max(0, Number(n.chars)||0), 0);
  const includedChars = Math.min(totalChars, CONSOLIDATION_LIMITS.maxTotalSourceChars);
  const estimatedChunks = Math.max(1, Math.ceil(includedChars/CONSOLIDATION_LIMITS.chunkChars));
  const estimatedStages = Math.max(1, Math.ceil(estimatedChunks/CONSOLIDATION_LIMITS.maxChunks));
  return {totalChars, includedChars, estimatedChunks, estimatedStages, exceedsStage:totalChars>CONSOLIDATION_LIMITS.maxSourceChars, exceedsTotal:totalChars>CONSOLIDATION_LIMITS.maxTotalSourceChars};
}

function renderConsolidationLimitNotice(subjectId){
  const notice = document.getElementById('consolidationLimitNotice');
  const notes = STATE.notesList.filter(n=>n.subjectId===subjectId && !n.deletedAt);
  if(!notes.length){ notice.hidden = true; return; }
  const plan = getConsolidationPlan(notes);
  if(!plan.exceedsStage){ notice.hidden = true; return; }
  notice.hidden = false;
  if(plan.exceedsTotal){
    notice.innerHTML = `<strong>資料量上限提醒：</strong>此科目約 ${plan.totalChars.toLocaleString()} 字，超過一次最多 ${CONSOLIDATION_LIMITS.maxTotalSourceChars.toLocaleString()} 字的安全處理量。系統會自動進行 ${CONSOLIDATION_LIMITS.maxStages} 階段整合，但僅納入依上傳順序的前 ${CONSOLIDATION_LIMITS.maxTotalSourceChars.toLocaleString()} 字；其餘內容會在 PDF 中註明未納入。建議分成不同科目、或先分批統整。`;
  } else {
    notice.innerHTML = `<strong>大量筆記提醒：</strong>此科目約 ${plan.totalChars.toLocaleString()} 字，系統會自動分成 ${plan.estimatedStages} 個階段處理（每階段最多 ${CONSOLIDATION_LIMITS.maxSourceChars.toLocaleString()} 字），再把中繼摘要統整為一份最終 PDF。所有目前上傳內容都會納入，不需手動拆成兩次。`;
  }
}

function splitAtBoundaries(text, limit){
  const source = String(text||'').trim();
  if(!source) return [];
  const chunks = [];
  let rest = source;
  while(rest.length>limit){
    let cut = rest.lastIndexOf('\n\n', limit);
    if(cut<Math.floor(limit*0.55)) cut = rest.lastIndexOf('\n', limit);
    if(cut<Math.floor(limit*0.55)) cut = rest.lastIndexOf('。', limit);
    if(cut<Math.floor(limit*0.55)) cut = limit;
    chunks.push(rest.slice(0,cut).trim());
    rest = rest.slice(cut).trim();
  }
  if(rest) chunks.push(rest);
  return chunks;
}

function takeLeadingText(text, limit){
  const source = String(text||'').trim();
  if(source.length<=limit) return {head:source, tail:''};
  let cut = source.lastIndexOf('\n\n', limit);
  if(cut<Math.floor(limit*0.55)) cut = source.lastIndexOf('\n', limit);
  if(cut<Math.floor(limit*0.55)) cut = source.lastIndexOf('。', limit);
  if(cut<Math.floor(limit*0.55)) cut = limit;
  return {head:source.slice(0,cut).trim(), tail:source.slice(cut).trim()};
}

async function collectConsolidationSources(notes, statusEl){
  const parts = [];
  let keptChars = 0, omittedFiles = 0, unreadableFiles = 0;
  for(let i=0;i<notes.length;i++){
    statusEl.textContent = `正在讀取筆記（${i+1}/${notes.length}）...`;
    try{
      const r = await window.storage.get('note-text:'+notes[i].id);
      const raw = (r && r.value) ? String(r.value).trim() : '';
      if(!raw){ unreadableFiles++; continue; }
      const remaining = CONSOLIDATION_LIMITS.maxTotalSourceChars-keptChars;
      if(remaining<=0){ omittedFiles++; continue; }
      const kept = raw.slice(0, remaining);
      if(kept.length<raw.length) omittedFiles++;
      keptChars += kept.length;
      parts.push({filename:notes[i].filename, text:kept});
    }catch(e){ unreadableFiles++; }
  }
  return {parts, keptChars, omittedFiles, unreadableFiles};
}

function makeConsolidationChunks(parts){
  const chunks = [];
  let current = '';
  for(const part of parts){
    let remaining = String(part.text||'').trim();
    while(remaining){
      const label = `【${part.filename}】\n`;
      const separator = current ? '\n\n' : '';
      let capacity = CONSOLIDATION_LIMITS.chunkChars-current.length-separator.length-label.length;
      if(capacity<500 && current){ chunks.push(current); current = ''; continue; }
      capacity = Math.max(500, capacity);
      const slice = takeLeadingText(remaining, capacity);
      current += separator + label + slice.head;
      remaining = slice.tail;
      if(current.length>=CONSOLIDATION_LIMITS.chunkChars-250){ chunks.push(current); current = ''; }
    }
  }
  if(current) chunks.push(current);
  return chunks;
}

async function reduceStudyDigest(digest, subjectName, statusEl, statusPrefix=''){
  let merged = digest;
  let pass = 0;
  while(merged.length>CONSOLIDATION_LIMITS.digestChars && pass<3){
    pass++;
    const blocks = splitAtBoundaries(merged, CONSOLIDATION_LIMITS.chunkChars);
    const reduced = [];
    for(let i=0;i<blocks.length;i++){
      statusEl.textContent = `${statusPrefix}正在壓縮第 ${pass} 輪整理稿（${i+1}/${blocks.length} 批）...`;
      const prompt = `請將以下「${subjectName}」的整理稿再壓縮，保留所有可考的定義、公式、數學符號、比較、流程與易錯點；公式與符號不可改寫，不得補充外部知識。用繁體中文條列，只輸出內容。\n\n${blocks[i]}`;
      reduced.push(await callAI(prompt, 900));
    }
    merged = reduced.join('\n\n');
  }
  if(merged.length>CONSOLIDATION_LIMITS.digestChars) throw new Error('中繼摘要仍超過安全長度，請將該科目再拆成較小的主題後分別統整。');
  return merged;
}

async function makeStudyDigest(chunks, subjectName, statusEl, stageLabel=''){
  const digests = [];
  for(let i=0;i<chunks.length;i++){
    statusEl.textContent = `${stageLabel}正在整理原始筆記（${i+1}/${chunks.length} 批）...`;
    const prompt = `你是備考讀書助理。請把以下「${subjectName}」的原始筆記壓縮成忠實、可供後續統整的重點資料。保留定義、公式、數學符號、比較、流程、易錯點與出處標籤；刪除明顯重複與無意義文字。數學公式、希臘字母、上下標、積分、根號、集合、箭頭與其他符號必須維持原樣，絕不可自行計算、改寫或補充。不可添加筆記中沒有的知識。請用繁體中文條列，只輸出整理後內容。\n\n${chunks[i]}`;
    digests.push(await callAI(prompt, 900));
  }
  return await reduceStudyDigest(digests.join('\n\n'), subjectName, statusEl, stageLabel);
}

function groupChunksIntoStages(chunks){
  const stages = [];
  for(let i=0;i<chunks.length;i+=CONSOLIDATION_LIMITS.maxChunks) stages.push(chunks.slice(i, i+CONSOLIDATION_LIMITS.maxChunks));
  return stages;
}

async function makeHierarchicalStudyDigest(stages, subjectName, statusEl){
  const stageDigests = [];
  for(let i=0;i<stages.length;i++) stageDigests.push(await makeStudyDigest(stages[i], subjectName, statusEl, `第 ${i+1}/${stages.length} 階段：`));
  return stageDigests.length===1 ? stageDigests[0] : await reduceStudyDigest(stageDigests.join('\n\n'), subjectName, statusEl, '正在合併中繼摘要：');
}

async function persistConsolidatedText(subjectId, text){
  STATE.consolidated[subjectId] = text;
  if(!await saveState()) throw new Error('儲存失敗，請先複製畫面中的內容。');
}

function setConsolidationBusy(isBusy){
  ['consolidateBtn','annotateBtn','exportPdfBtn','exportWordBtn','consolidateSubjectSelect','consolidateOutput','saveConsolidatedBtn'].forEach(id=>{
    const button = document.getElementById(id);
    if(button) button.disabled = isBusy;
  });
}

// 拆成幾個小節分別請 AI 生成；前面的批次摘要可避免大量上傳時遺漏後段資料。
const CONSOLIDATE_SECTIONS = [
  {title:'核心概念', instruction:'條列此科目的核心概念，每項附簡短定義，盡量涵蓋筆記中出現的所有重要概念，不要遺漏。'},
  {title:'重要公式／模型／方法', instruction:'條列筆記中出現的重要公式、模型、檢定方法或流程（如適用），並簡述使用時機。若此科目沒有公式類內容可以略過此節。'},
  {title:'常見誤解與考試易錯點', instruction:'條列容易混淆、誤解或考試常考錯的地方，並簡短說明正確觀念。'},
  {title:'概念關聯與比較', instruction:'用 markdown 表格整理容易混淆或需要比較的概念（例如不同方法、名詞的差異），沒有適合比較的內容就列出概念之間的關聯脈絡。'}
];
document.getElementById('consolidateBtn').addEventListener('click', async ()=>{
  const subjectId = document.getElementById('consolidateSubjectSelect').value;
  if(!subjectId){ alert('請先設定科目'); return; }
  const notes = STATE.notesList.filter(n=>n.subjectId===subjectId && !n.deletedAt);
  if(notes.length===0){ document.getElementById('consolidateStatus').textContent = '此科目尚未上傳任何筆記。'; return; }
  const statusEl = document.getElementById('consolidateStatus');
  const subj = STATE.config.subjects.find(s=>s.id===subjectId);
  const outputEl = document.getElementById('consolidateOutput');
  setConsolidationBusy(true);
  try{
    const source = await collectConsolidationSources(notes, statusEl);
    if(source.parts.length===0) throw new Error('讀不到可用的筆記文字，請確認上傳是否完成。');
    const allStages = groupChunksIntoStages(makeConsolidationChunks(source.parts));
    const skippedStages = Math.max(0, allStages.length-CONSOLIDATION_LIMITS.maxStages);
    const stages = allStages.slice(0, CONSOLIDATION_LIMITS.maxStages);
    if(!stages.length) throw new Error('沒有可用的筆記內容可統整。');
    const studyDigest = await makeHierarchicalStudyDigest(stages, subj.name, statusEl);
    let fullDoc = `# ${subj.name}｜最終複習筆記\n`;
    if(source.omittedFiles || source.unreadableFiles || skippedStages || stages.length>1){
      fullDoc += `\n> 整合範圍提示：本次讀取 ${source.parts.length}/${notes.length} 份筆記、約 ${source.keptChars.toLocaleString()} 字。` +
        `${stages.length>1 ? `系統已自動分成 ${stages.length} 個階段整理，再合併為本份筆記。` : ''}` +
        `${source.omittedFiles ? `另有 ${source.omittedFiles} 份超出本次 ${CONSOLIDATION_LIMITS.maxTotalSourceChars.toLocaleString()} 字上限，未完整納入。` : ''}` +
        `${source.unreadableFiles ? `另有 ${source.unreadableFiles} 份讀取失敗或沒有文字。` : ''}` +
        `${skippedStages ? `另有 ${skippedStages} 個階段超過本次處理上限，未納入。` : ''}`;
    }
    outputEl.value = fullDoc;
    updateWordCount();
    for(let i=0;i<CONSOLIDATE_SECTIONS.length;i++){
      const sec = CONSOLIDATE_SECTIONS[i];
      statusEl.textContent = `AI 統整中（${i+1}/${CONSOLIDATE_SECTIONS.length}）：${sec.title}...`;
      const prompt = `你是備考讀書助理。以下是「${subj.name}」科目的整理後原始資料（可能來自多份筆記，內容或有重複）：\n\n${studyDigest}\n\n請針對「${sec.title}」這個部分統整內容：${sec.instruction}\n保留資料中所有重要數學公式與符號，不得自行計算、改寫或補充。使用繁體中文，用 markdown 條列或表格呈現，不要重複輸出小節標題本身，只輸出內容，不要有其他說明文字。若資料中完全沒有相關內容，請只回覆「（筆記中無相關內容）」。`;
      const result = await callAI(prompt, 1400);
      fullDoc += `\n\n## ${sec.title}\n${result.trim()}`;
      outputEl.value = fullDoc;
      updateWordCount();
    }
    await persistConsolidatedText(subjectId, fullDoc);
    statusEl.textContent = `已統整並儲存 ${source.parts.length}/${notes.length} 份筆記。請先檢查內容，再選擇下載格式。`;
  }catch(e){
    console.error(e);
    statusEl.textContent = 'AI 統整或 PDF 建立失敗：' + (e.message||'請稍後再試。') + '。';
  }finally{
    setConsolidationBusy(false);
  }
});

// ---------- 依考古資料標示重點 ----------
function splitDocSections(md){
  return md.split(/\n(?=## )/);
}
document.getElementById('annotateBtn').addEventListener('click', async ()=>{
  const subjectId = document.getElementById('consolidateSubjectSelect').value;
  if(!subjectId){ alert('請先選擇科目'); return; }
  const statusEl = document.getElementById('consolidateStatus');
  const outputEl = document.getElementById('consolidateOutput');
  const currentDoc = outputEl.value.trim();
  if(!currentDoc){ statusEl.textContent = '請先產生（或貼上）統整筆記內容，再進行標示。'; return; }
  const sources = getExamSources([subjectId]);
  if(sources.length===0){
    statusEl.textContent = '這個科目還沒有考古資料或考情指引，請先到「模擬考」頁的考古資料區塊加入，再回來標示重點。';
    return;
  }
  const examText = sources.map(s=>`【${sourceMeta(s.type).label}：${s.title}】\n${s.content}`).join('\n\n').slice(0, 8000);
  const sections = splitDocSections(currentDoc);
  let newDoc = '';
  setConsolidationBusy(true);
  try{
    for(let i=0;i<sections.length;i++){
      statusEl.textContent = `AI 標示重點中（${i+1}/${sections.length}）...`;
      const prompt = `你是備考讀書助理。以下是學生複習筆記中的一段內容：\n\n${sections[i]}\n\n以下是這個科目的考古題、老師題目或考情指引（僅供參考出題重點與範圍，不要照抄內容）：\n\n${examText}\n\n請找出筆記中與這些資料相關的條列項目，在該行結尾加上簡短標記，例如「🔥常考」或「📋指引重點」；沒有相關的部分請完全維持原樣，不要更動文字、不要增刪內容、不要改寫措辭，只在相關處插入標記。只輸出加上標記後的完整段落，不要有其他說明文字。`;
      const result = await callAI(prompt, 1400);
      newDoc += (newDoc?'\n':'') + result.trim();
      outputEl.value = newDoc + (i<sections.length-1 ? '\n'+sections.slice(i+1).join('\n') : '');
      updateWordCount();
    }
    outputEl.value = newDoc;
    updateWordCount();
    await persistConsolidatedText(subjectId, newDoc);
    statusEl.textContent = '重點標示已儲存。可在下方檢查、修改與下載。';
  }catch(e){
    console.error(e);
    statusEl.textContent = '標示失敗：' + (e.message||'請稍後再試。');
  }finally{
    setConsolidationBusy(false);
  }
});

// ---------- Markdown -> HTML（供 Word／PDF 匯出使用） ----------
function inlineMd(s){
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}
function mdToHtml(md){
  const lines = (md||'').split('\n');
  let html = '', inUl=false, inOl=false, inTable=false, tableRows=[];
  function closeLists(){ if(inUl){html+='</ul>'; inUl=false;} if(inOl){html+='</ol>'; inOl=false;} }
  function flushTable(){
    if(tableRows.length){
      html += '<table>' + tableRows.map((row,i)=>
        '<tr>' + row.map(c=>`<${i===0?'th':'td'}>${c}</${i===0?'th':'td'}>`).join('') + '</tr>'
      ).join('') + '</table>';
    }
    tableRows = []; inTable = false;
  }
  for(const raw of lines){
    const line = raw.trim();
    if(!line){ closeLists(); if(inTable) flushTable(); continue; }
    if(/^\|.*\|$/.test(line)){
      const cells = line.split('|').slice(1,-1).map(c=>c.trim());
      if(cells.every(c=>/^:?-+:?$/.test(c))) continue;
      if(!inTable){ closeLists(); inTable = true; }
      tableRows.push(cells.map(c=>inlineMd(c)));
      continue;
    } else if(inTable){ flushTable(); }
    let m;
    if((m=line.match(/^### (.*)/))){ closeLists(); html+=`<h3>${inlineMd(m[1])}</h3>`; continue; }
    if((m=line.match(/^## (.*)/))){ closeLists(); html+=`<h2>${inlineMd(m[1])}</h2>`; continue; }
    if((m=line.match(/^# (.*)/))){ closeLists(); html+=`<h1>${inlineMd(m[1])}</h1>`; continue; }
    if((m=line.match(/^[-*] (.*)/))){
      if(!inUl){ closeLists(); html+='<ul>'; inUl=true; }
      html+=`<li>${inlineMd(m[1])}</li>`; continue;
    }
    if((m=line.match(/^\d+\.\s(.*)/))){
      if(!inOl){ closeLists(); html+='<ol>'; inOl=true; }
      html+=`<li>${inlineMd(m[1])}</li>`; continue;
    }
    closeLists();
    html += `<p>${inlineMd(line)}</p>`;
  }
  closeLists(); if(inTable) flushTable();
  return html;
}
function exportFilenameBase(){
  const subjectId = document.getElementById('consolidateSubjectSelect').value;
  const subj = STATE.config.subjects.find(s=>s.id===subjectId);
  return (subj?subj.name:'統整筆記').replace(/[\\/:*?"<>|]/g,'');
}

function triggerDownload(blob, filename){
  if(navigator.msSaveOrOpenBlob){ navigator.msSaveOrOpenBlob(blob, filename); return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ a.remove(); URL.revokeObjectURL(url); }, 1500);
}

function makePdfRenderRoot(text){
  const root = document.createElement('div');
  root.className = 'export-render-root';
  root.setAttribute('aria-hidden','true');
  root.innerHTML = `<article class="pdf-page">${mdToHtml(text)}</article>`;
  document.body.appendChild(root);
  return root;
}

async function downloadPdf(text, filename){
  if(!text.trim()) throw new Error('目前沒有內容可以匯出。');
  if(typeof window.html2pdf !== 'function') throw new Error('PDF 匯出元件未載入，請確認網路連線後重新整理。');
  const root = makePdfRenderRoot(text);
  try{
    // 等待中文字型與數學字型就緒，再擷取畫面，避免 PDF 出現方塊或字型替換。
    if(document.fonts && document.fonts.ready) await document.fonts.ready;
    await window.html2pdf().set({
      margin: [8, 8, 10, 8],
      filename,
      image: {type:'jpeg', quality:0.96},
      html2canvas: {scale:1.5, useCORS:true, backgroundColor:'#ffffff'},
      jsPDF: {unit:'mm', format:'a4', orientation:'portrait'},
      pagebreak: {mode:['css','legacy']}
    }).from(root).save();
  }finally{
    root.remove();
  }
}

document.getElementById('exportWordBtn').addEventListener('click', ()=>{
  const text = document.getElementById('consolidateOutput').value;
  if(!text.trim()){ alert('目前沒有內容可以匯出'); return; }
  try{
    const bodyHtml = mdToHtml(text);
    const doc = `<!DOCTYPE html><html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head><meta charset="utf-8"><title>統整筆記</title>
<style>
  body{font-family:'Microsoft JhengHei','Noto Sans TC',sans-serif; font-size:14px; line-height:1.8;}
  h1{font-size:22px; border-bottom:2px solid #333; padding-bottom:6px;}
  h2{font-size:17px; margin-top:22px; color:#2a4a6b;}
  h3{font-size:15px; margin-top:14px;}
  table{border-collapse:collapse; width:100%; margin:10px 0;}
  td,th{border:1px solid #999; padding:6px 8px; font-size:13px;}
  th{background:#eee;}
  li{margin-bottom:4px;}
</style></head>
<body>${bodyHtml}</body></html>`;
    triggerDownload(new Blob(['\ufeff'+doc], {type:'application/msword;charset=utf-8'}), `${exportFilenameBase()}-統整筆記.doc`);
    document.getElementById('consolidateStatus').textContent = '已下載 Word 檔。';
  }catch(e){
    console.error(e);
    document.getElementById('consolidateStatus').textContent = 'Word 匯出失敗：' + (e.message||'請稍後再試。');
  }
});
document.getElementById('exportPdfBtn').addEventListener('click', async ()=>{
  const text = document.getElementById('consolidateOutput').value;
  if(!text.trim()){ alert('目前沒有內容可以匯出'); return; }
  const statusEl = document.getElementById('consolidateStatus');
  setConsolidationBusy(true);
  statusEl.textContent = '正在建立 PDF...';
  try{
    await downloadPdf(text, `${exportFilenameBase()}-統整筆記.pdf`);
    statusEl.textContent = '已下載 PDF。';
  }catch(e){
    console.error(e);
    statusEl.textContent = 'PDF 匯出失敗：' + (e.message||'請確認網路連線後重新整理。');
  }finally{
    setConsolidationBusy(false);
  }
});

// ---------- 考古資料、考情指引與模擬考 ----------
let currentMockQuestions = [];
let currentMockSession = null;
let mockTimerHandle = null;
let mockGrading = false;

const EXAM_SOURCE_META = {
  guidance: { label:'考情指引', className:'guidance' },
  paper: { label:'歷屆試題／回憶題', className:'paper' },
  teacher: { label:'老師提供題目', className:'teacher' }
};

function sourceMeta(type){ return EXAM_SOURCE_META[type] || EXAM_SOURCE_META.guidance; }
function getExamSources(subjectIds){
  return STATE.examSources.filter(source=>subjectIds.includes(source.subjectId));
}

// 顯示所有考古資料；老師的文字提醒會有獨立「考情指引」標示，避免被誤認為試題。
function renderExamSources(){
  const wrap = document.getElementById('examSourceList');
  if(STATE.examSources.length===0){
    wrap.innerHTML = '<div class="exam-source-empty">尚未加入考古資料或考情指引。</div>';
    return;
  }
  wrap.innerHTML = STATE.examSources.slice().reverse().map(source=>{
    const meta = sourceMeta(source.type);
    const subject = STATE.config.subjects.find(s=>s.id===source.subjectId);
    const preview = String(source.content||'').slice(0,220) + (String(source.content||'').length>220 ? '…' : '');
    return `<div class="exam-source-item ${meta.className}">
      <div class="exam-source-copy">
        <div><span class="source-badge ${meta.className}">${meta.label}</span><span class="exam-source-title">${escapeHtml(source.title||meta.label)}</span></div>
        <div class="exam-source-meta">${escapeHtml(subject ? subject.name : '未指定科目')} · ${escapeHtml(source.createdAt||'')}</div>
        <div class="exam-source-preview">${escapeHtml(preview)}</div>
      </div>
      <button class="btn danger" style="padding:4px 10px" data-del-exam-source="${source.id}">刪除</button>
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-del-exam-source]').forEach(button=>{
    button.addEventListener('click', async ()=>{
      const source = STATE.examSources.find(item=>item.id===button.dataset.delExamSource);
      if(!source || !confirm(`確定刪除「${source.title||sourceMeta(source.type).label}」嗎？`)) return;
      STATE.examSources = STATE.examSources.filter(item=>item.id!==source.id);
      if(!await saveState()) return false;
      renderExamSources();
    });
  });
}

document.getElementById('saveExamSourceBtn').addEventListener('click', async ()=>{
  const subjectId = document.getElementById('examSourceSubjectSelect').value;
  const type = document.getElementById('examSourceType').value;
  const title = document.getElementById('examSourceTitle').value.trim();
  const content = document.getElementById('examSourceContent').value.trim();
  const status = document.getElementById('examSourceSaved');
  if(!subjectId){ status.textContent = '請先選擇科目。'; return; }
  if(!content){ status.textContent = '請輸入文字內容。'; return; }
  if(content.length>12000){ status.textContent = '內容請控制在 12,000 字以內。'; return; }
  STATE.examSources.push({
    id: uid(), subjectId, type: EXAM_SOURCE_META[type] ? type : 'guidance',
    title: title || sourceMeta(type).label, content, createdAt: todayStr()
  });
  if(!await saveState()) return false;
  document.getElementById('examSourceTitle').value = '';
  document.getElementById('examSourceContent').value = '';
  status.textContent = type==='guidance' ? '考情指引已加入；它會作為出題方向，不會被當成題目。' : '考古資料已加入。';
  renderExamSources();
});

// PDF 匯入只保存可用文字，不保存原檔；因此仍符合這個靜態網站的本機儲存模式。
document.getElementById('examSourcePdfInput').addEventListener('change', async event=>{
  const subjectId = document.getElementById('examSourceSubjectSelect').value;
  const type = document.getElementById('examSourceType').value;
  const titleInput = document.getElementById('examSourceTitle');
  const status = document.getElementById('examSourceImportStatus');
  const files = Array.from(event.target.files||[]);
  if(!subjectId){ status.textContent = '請先選擇科目，再匯入 PDF。'; event.target.value=''; return; }
  if(files.length===0) return;
  let added = 0;
  const failures = [];
  for(let index=0; index<files.length; index++){
    const file = files[index];
    if(file.type!=='application/pdf' && !/\.pdf$/i.test(file.name)){
      failures.push(`${file.name} 不是 PDF`);
      continue;
    }
    try{
      status.textContent = `正在擷取「${file.name}」的文字...`;
      const text = await extractPdfText(file, (page,total,usingOcr)=>{
        status.textContent = usingOcr
          ? `掃描辨識「${file.name}」第 ${page}/${total} 頁...`
          : `讀取「${file.name}」第 ${page}/${total} 頁...`;
      });
      const cleanText = String(text||'').trim();
      if(cleanText.replace(/\s/g,'').length<20) throw new Error('未擷取到足夠文字；請確認 PDF 不是加密檔或影像過於模糊。');
      const filenameTitle = file.name.replace(/\.pdf$/i,'');
      const title = titleInput.value.trim()
        ? (files.length===1 ? titleInput.value.trim() : `${titleInput.value.trim()} · ${filenameTitle}`)
        : filenameTitle;
      const cappedText = cleanText.slice(0,120000);
      STATE.examSources.push({
        id:uid(), subjectId, type:EXAM_SOURCE_META[type] ? type : 'paper', title,
        content:cappedText, createdAt:todayStr(), importedFrom:file.name
      });
      added++;
      if(cleanText.length>cappedText.length) failures.push(`${file.name} 超過儲存上限，僅保留前 120,000 字`);
    }catch(error){
      console.error(error);
      failures.push(`${file.name}：${error.message||'讀取失敗'}`);
    }
  }
  if(added){
    if(!await saveState()) return false;
    renderExamSources();
    titleInput.value = '';
  }
  status.textContent = added
    ? `已匯入 ${added} 份 PDF。${failures.length ? ' 另外：'+failures.join('；') : ''}`
    : `匯入失敗：${failures.join('；')||'未讀取到檔案。'}`;
  event.target.value = '';
});

function updateMockModeNote(){
  const isExam = document.getElementById('mockMode').value==='exam';
  const duration = Math.max(1, Math.min(300, Number(document.getElementById('mockDuration').value)||30));
  document.getElementById('mockDuration').disabled = !isExam;
  document.getElementById('mockModeNote').textContent = isExam
    ? `考試模式會在題目顯示後開始 ${duration} 分鐘倒數；時間到會自動交卷，再統一評分。`
    : '練習模式不計時；完成後可直接請 AI 評分與檢討。';
}
document.getElementById('mockMode').addEventListener('change', updateMockModeNote);
document.getElementById('mockDuration').addEventListener('input', updateMockModeNote);

function renderMock(){
  updateMockModeNote();
  const wrap = document.getElementById('mockHistory');
  if(STATE.mockHistory.length===0){ wrap.innerHTML = '<div class="empty">尚無模擬考紀錄。</div>'; return; }
  wrap.innerHTML = '<table><tr><th>日期</th><th>模式</th><th>科目</th><th>平均分數</th></tr>' +
    STATE.mockHistory.slice().reverse().map(m=>{
      const names = (m.subjectIds||[]).map(id=>{const s=STATE.config.subjects.find(x=>x.id===id); return s?s.name:'';}).filter(Boolean).join('、');
      const mode = m.mode==='exam' ? '考試模式' : '練習模式';
      return `<tr><td>${escapeHtml(m.date||'')}</td><td>${mode}</td><td>${escapeHtml(names)}</td><td>${escapeHtml(String(m.score??''))}</td></tr>`;
    }).join('') + '</table>';
}

function formatClock(totalSeconds){
  const minutes = Math.floor(totalSeconds/60);
  const seconds = totalSeconds%60;
  return `${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
}
function stopMockTimer(keepVisible=false){
  if(mockTimerHandle){ clearInterval(mockTimerHandle); mockTimerHandle=null; }
  const timer = document.getElementById('mockTimer');
  if(!keepVisible) timer.hidden = true;
  timer.classList.remove('warning');
}
function updateMockTimer(){
  if(!currentMockSession || currentMockSession.mode!=='exam') return;
  const timer = document.getElementById('mockTimer');
  const remaining = Math.max(0, Math.ceil((currentMockSession.deadlineAt-Date.now())/1000));
  timer.hidden = false;
  timer.textContent = `剩餘 ${formatClock(remaining)}`;
  timer.classList.toggle('warning', remaining<=300 && remaining>0);
  if(remaining===0){
    stopMockTimer(true);
    timer.textContent = '時間到，自動交卷';
    gradeCurrentMock(true);
  }
}
function startMockTimer(){
  if(!currentMockSession || currentMockSession.mode!=='exam' || currentMockSession.submitted) return;
  if(mockTimerHandle) clearInterval(mockTimerHandle);
  currentMockSession.startedAt ||= Date.now();
  currentMockSession.deadlineAt ||= currentMockSession.startedAt + currentMockSession.durationMin*60*1000;
  updateMockTimer();
  mockTimerHandle = setInterval(updateMockTimer, 1000);
}

document.getElementById('genMockBtn').addEventListener('click', async ()=>{
  const checks = Array.from(document.querySelectorAll('#mockSubjectChecks input:checked')).map(c=>c.value);
  if(checks.length===0){ alert('請至少選擇一個科目'); return; }
  const count = Math.max(1, Math.min(30, Number(document.getElementById('mockCount').value)||5));
  const mode = document.getElementById('mockMode').value==='exam' ? 'exam' : 'practice';
  const durationMin = Math.max(1, Math.min(300, Number(document.getElementById('mockDuration').value)||30));
  const useGuidance = document.getElementById('mockUseGuidance').checked;
  if(currentMockQuestions.length && !currentMockSession?.completed && !confirm('產生新測驗會取代目前的作答草稿，確定繼續？')) return;
  document.getElementById('mockStatus').textContent = '正在準備出題材料...';
  let studyContext = '';
  for(const sid of checks){
    const s = STATE.config.subjects.find(x=>x.id===sid);
    if(!s) continue;
    if(STATE.consolidated[sid]){
      studyContext += `\n\n【${s.name} 統整筆記】\n${STATE.consolidated[sid]}`;
    } else {
      const notes = STATE.notesList.filter(n=>n.subjectId===sid && !n.deletedAt);
      for(const n of notes.slice(0,2)){
        try{ const r = await window.storage.get('note-text:'+n.id); studyContext += `\n\n【${s.name} - ${n.filename}】\n${(r?r.value:'').slice(0,3000)}`; }catch(e){}
      }
    }
  }
  const sources = getExamSources(checks);
  const guidanceSources = useGuidance ? sources.filter(source=>source.type==='guidance') : [];
  const questionSources = sources.filter(source=>source.type==='paper' || source.type==='teacher');
  const guidanceContext = guidanceSources.map(source=>`【${sourceMeta(source.type).label}：${source.title}】\n${source.content}`).join('\n\n').slice(0,6000);
  const questionContext = questionSources.map(source=>`【${sourceMeta(source.type).label}：${source.title}】\n${source.content}`).join('\n\n').slice(0,6000);
  studyContext = studyContext.slice(0,9000);
  if(!studyContext && !guidanceContext && !questionContext){
    document.getElementById('mockStatus').textContent = '尚無可用的筆記、考古題或考情指引；請先加入至少一項資料。';
    return;
  }
  const modeInstruction = mode==='exam'
    ? '這是正式考試模式：題幹要完整、自足，不要提供提示、答案或解題步驟。'
    : '這是練習模式：題幹仍須完整，但可涵蓋循序漸進的概念與應用。';
  const prompt = `你是備考出題老師。請根據以下材料，出 ${count} 題考試等級的申論／概念題（不要選擇題），涵蓋核心概念、批判思考與應用。${modeInstruction}

【複習資料】
${studyContext || '（未提供）'}

【考情指引：這些不是題目，也不是答案；只能用來調整出題範圍與比重，不可把指引原句改寫成題目】
${guidanceContext || '（未提供或此次未選用）'}

【歷屆／老師題目參考：只用於掌握範圍與題型，不要大段照抄原題】
${questionContext || '（未提供）'}

請只輸出 JSON 陣列，格式為 [{"q":"題目內容"}, ...]，不要有其他文字或 markdown 標記。`;
  try{
    document.getElementById('genMockBtn').disabled=true;
    const result = await callAI(prompt, 1400);
    const parsed = JSON.parse(stripJsonFence(result));
    if(!Array.isArray(parsed)) throw new Error('AI 回傳的題目格式不正確。');
    stopMockTimer();
    currentMockQuestions = parsed.filter(item=>item && String(item.q||'').trim()).slice(0,count)
      .map(item=>({id:uid(), q:String(item.q).trim(), answer:'', subjectIds:checks}));
    if(currentMockQuestions.length===0) throw new Error('AI 沒有產生可用題目。');
    currentMockSession = {
      mode, durationMin, subjectIds:checks, sourceIds:sources.map(source=>source.id),
      gradingContext: (`【複習資料】\n${studyContext}\n\n【考情指引】\n${guidanceContext}\n\n【題目參考】\n${questionContext}`).slice(0,15000)
    };
    renderMockQuestions();
    document.getElementById('mockStatus').textContent = mode==='exam' ? '題目已就緒，倒數已開始。' : '出題完成 ✓';
  }catch(e){
    console.error(e);
    document.getElementById('mockStatus').textContent = '出題失敗：' + (e.message||'請稍後再試。');
  }finally{ document.getElementById('genMockBtn').disabled=false; }
});

function renderMockQuestions(){
  stopMockTimer();
  mockGrading = false;
  const card = document.getElementById('mockQuestionsCard');
  const wrap = document.getElementById('mockQuestions');
  const isExam = currentMockSession && currentMockSession.mode==='exam';
  card.style.display = 'block';
  document.getElementById('mockSessionMeta').textContent = isExam
    ? `正式考試模式 · ${currentMockQuestions.length} 題 · ${currentMockSession.durationMin} 分鐘`
    : `練習模式 · ${currentMockQuestions.length} 題 · 不限時`;
  document.getElementById('mockSubmitHint').textContent = isExam ? '交卷後才會顯示評分與回饋。' : '完成作答後再統一評分。';
  document.getElementById('gradeMockBtn').disabled = false;
  wrap.innerHTML = currentMockQuestions.map((q,i)=>`
    <div class="q-block" data-qid="${q.id}">
      <div><strong>Q${i+1}.</strong> ${escapeHtml(q.q)}</div>
      <textarea placeholder="輸入你的作答..." data-answer="${q.id}"></textarea>
    </div>
  `).join('');
  document.getElementById('gradeStatus').textContent = '';
  // The studio wrapper restores answers before restarting the clock.
}

function collectMockAnswers(){
  document.querySelectorAll('[data-answer]').forEach(textarea=>{
    const question = currentMockQuestions.find(item=>item.id===textarea.dataset.answer);
    if(question) question.answer = textarea.value;
  });
}

async function gradeCurrentMock(autoSubmitted=false){
  if(mockGrading || currentMockQuestions.length===0) return;
  mockGrading = true;
  collectMockAnswers();
  if(currentMockSession) currentMockSession.submitted=true;
  if(currentMockSession?.mode==='exam') document.querySelectorAll('[data-answer]').forEach(el=>el.disabled=true);
  await persistMockDraft();
  stopMockTimer(true);
  const isExam = currentMockSession && currentMockSession.mode==='exam';
  const timer = document.getElementById('mockTimer');
  if(isExam){
    timer.hidden = false;
    timer.textContent = autoSubmitted ? '時間到，已交卷' : '已交卷';
    timer.classList.remove('warning');
  }
  const gradeButton = document.getElementById('gradeMockBtn');
  gradeButton.disabled = true;
  document.getElementById('gradeStatus').textContent = 'AI 評分中...';
  const qaText = currentMockQuestions.map((q,i)=>`Q${i+1}: ${q.q}\n作答: ${q.answer||'（未作答）'}`).join('\n\n');
  const prompt = `你是備考評分老師。請以題意及下列參考資料批改作答。考情指引只代表常考方向，不可把它當成題目或唯一標準答案。每題給 0-10 分並附一句具體回饋（繁體中文）。

【參考資料】
${(currentMockSession?.gradingContext||'（未提供）').slice(0,12000)}

【題目與作答】
${qaText}

只輸出 JSON：{"items":[{"score":數字,"feedback":"一句話回饋"},...],"overall":數字,"summary":"一句總評"}，不要其他文字。`;
  try{
    const result = await callAI(prompt, 1400);
    const parsed = JSON.parse(stripJsonFence(result));
    if(!Array.isArray(parsed.items) || parsed.items.length!==currentMockQuestions.length || parsed.items.some(i=>!Number.isFinite(Number(i.score)) || Number(i.score)<0 || Number(i.score)>10)) throw new Error('AI 回傳的評分不完整或分數超出範圍，請重試。');
    parsed.overall=Math.round(parsed.items.reduce((sum,i)=>sum+Number(i.score),0)/parsed.items.length*10)/10;
    parsed.items.forEach((item,index)=>{
      const block = document.querySelectorAll('.q-block')[index];
      if(block){
        const scoreEl = document.createElement('div');
        const score = Number.isFinite(Number(item.score)) ? item.score : '—';
        scoreEl.innerHTML = `<span class="score">${escapeHtml(String(score))}/10</span><div class="muted">${escapeHtml(item.feedback||'')}</div>`;
        block.appendChild(scoreEl);
      }
    });
    document.getElementById('gradeStatus').textContent = `總評：${parsed.summary||''}（總分 ${parsed.overall??'—'}/10）`;
    STATE.mockHistory.push({
      id:uid(), date:todayStr(), subjectIds:currentMockSession?.subjectIds || [], score:parsed.overall,
      feedback:parsed.summary||'', mode:currentMockSession?.mode || 'practice', durationMin:currentMockSession?.durationMin || null,
      sourceIds:currentMockSession?.sourceIds || [],
      questions:currentMockQuestions.map((q,i)=>({...q,score:Number(parsed.items[i].score),feedback:String(parsed.items[i].feedback||'')}))
    });
    if(!await saveState()){STATE.mockHistory.pop();throw new Error('評分結果儲存失敗，請重試。');}
    await window.storage.delete('mock-draft');
    currentMockSession.completed=true;
    renderMock();
  }catch(e){
    console.error(e);
    document.getElementById('gradeStatus').textContent = '評分失敗：' + (e.message||'請稍後再試。');
    gradeButton.disabled = false;
  }finally{
    mockGrading = false;
  }
}
document.getElementById('gradeMockBtn').addEventListener('click', ()=>gradeCurrentMock(false));

// ---------- Init ----------
document.getElementById('saveRelayBtn').addEventListener('click', async ()=>{
  const status = document.getElementById('relaySaved');
  const candidate = {
    provider: document.getElementById('relayProviderSelect').value,
    url: document.getElementById('relayUrlInput').value,
    token: document.getElementById('relayTokenInput').value
  };
  try{
    candidate.url = normalizeRelayUrl(candidate.url);
    status.textContent = '正在測試 Relay...';
    const health = await testRelayConfig(candidate);
    candidate.provider = health.provider === 'anthropic' ? 'anthropic' : 'openai';
    setRelayConfig(candidate);
    document.getElementById('relayProviderSelect').value = candidate.provider;
    status.textContent = '已連接 ' + providerLabel(candidate.provider) + ' Relay ✓（僅存在此瀏覽器）';
  }catch(e){
    status.textContent = '連線失敗：' + (e.message || '請檢查網址、密碼與 Cloudflare 設定。');
  }
});
document.getElementById('clearRelayBtn').addEventListener('click', ()=>{
  clearRelayConfig();
  document.getElementById('relayUrlInput').value = '';
  document.getElementById('relayTokenInput').value = '';
  updateRelayStatus();
});
document.getElementById('clearLegacyKeyBtn').addEventListener('click', ()=>{
  localStorage.removeItem(LEGACY_API_KEY_STORAGE_KEY);
  document.getElementById('clearLegacyKeyBtn').style.display = 'none';
  document.getElementById('relaySaved').textContent = '舊版瀏覽器 API Key 已清除。';
});

window.appReady = (async function init(){
  await loadState();
  document.getElementById('examDate').value = STATE.config.examDate || '';
  document.getElementById('reviewDays').value = STATE.config.reviewDays ?? 7;
  const relay = getRelayConfig();
  document.getElementById('relayProviderSelect').value = relay.provider;
  document.getElementById('relayUrlInput').value = relay.url;
  document.getElementById('relayTokenInput').value = relay.token;
  if(localStorage.getItem(LEGACY_API_KEY_STORAGE_KEY)){
    document.getElementById('clearLegacyKeyBtn').style.display = 'inline-block';
  }
  updateRelayStatus();
  if(STATE.config.subjects.length===0){
    // Empty state is intentional; no sample records are added.
  }
  renderSubjectRows();
  refreshAllSelects();
  renderCountdown();
  document.getElementById('todayLabel').textContent = todayStr();
})();
