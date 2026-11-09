/* 읽기 노트 실험실 공통: 내 말로 쓰는 칸은 붙여넣기를 막고, AI를 썼다면 답을 붙여 넣은 뒤 내 말로 요약하는 칸을 붙인다.
   각 도구는 이 파일 앞에서 window.LAB_PASTE_OK(붙여넣기를 허용할 id 목록)와 window.LAB_PASTE_OK_RE(허용할 id 규칙)를 정한다.
   원문·제목·쪽수·이름·복사용 칸처럼 학생 생각이 아닌 칸만 허용한다. */
(function(){
  'use strict';
  const OK_IDS = new Set(window.LAB_PASTE_OK || []);
  const OK_RE = window.LAB_PASTE_OK_RE || null;
  const slug = (location.pathname.split('/').filter(Boolean).slice(-1)[0] || 'lab').replace(/\.html?$/,'');
  const KEY = 'rnlab_' + slug + '_aiwrap_v1';

  function isTextField(el){
    if(!el || !el.matches) return false;
    if(el.matches('textarea')) return true;
    if(el.matches('input')){ const t=(el.getAttribute('type')||'text').toLowerCase(); return ['text','search',''].includes(t); }
    return el.isContentEditable === true;
  }
  function pasteAllowed(el){
    if(el.readOnly || el.hasAttribute('readonly')) return true;
    if(el.closest('[data-paste="ok"]')) return true;
    if(el.id && (OK_IDS.has(el.id) || (OK_RE && OK_RE.test(el.id)))) return true;
    return false;
  }

  /* ── 붙여넣기 막기 ── */
  let tipEl = null, tipTimer = null;
  function tip(el){
    if(!tipEl){
      tipEl = document.createElement('div');
      tipEl.className = 'lab-paste-tip'; tipEl.setAttribute('role','status');
      document.body.appendChild(tipEl);
    }
    tipEl.textContent = '이 칸은 붙여넣기가 막혀 있어요. 내 말로 직접 써 주세요.';
    const r = el.getBoundingClientRect();
    tipEl.style.left = Math.max(8, Math.min(r.left, innerWidth - 300)) + 'px';
    tipEl.style.top = Math.max(8, r.top - 44) + 'px';
    tipEl.classList.add('on');
    el.classList.add('lab-shake'); setTimeout(()=>el.classList.remove('lab-shake'), 400);
    clearTimeout(tipTimer); tipTimer = setTimeout(()=>tipEl.classList.remove('on'), 2200);
  }
  function block(e){
    const el = e.target && e.target.closest ? e.target.closest('textarea,input,[contenteditable]') : null;
    if(!el || !isTextField(el) || pasteAllowed(el)) return;
    if(e.type === 'beforeinput' && !/^insertFrom(Paste|Drop|PasteAsQuotation)$/.test(e.inputType || '')) return;
    e.preventDefault(); e.stopPropagation();
    tip(el);
  }
  document.addEventListener('paste', block, true);
  document.addEventListener('drop', block, true);
  document.addEventListener('beforeinput', block, true);

  /* ── AI를 썼다면: 답 붙여넣기 → 내 말로 요약 ── */
  const css = `
.lab-paste-tip{position:fixed;z-index:9999;max-width:300px;background:var(--ink,#1f2933);color:#fff;font-size:14px;line-height:1.4;padding:9px 13px;border-radius:10px;opacity:0;transform:translateY(4px);transition:opacity .15s,transform .15s;pointer-events:none}
.lab-paste-tip.on{opacity:1;transform:none}
.lab-shake{animation:labShake .35s}
@keyframes labShake{20%{transform:translateX(-4px)}40%{transform:translateX(4px)}60%{transform:translateX(-3px)}80%{transform:translateX(3px)}}
@media (prefers-reduced-motion:reduce){.lab-shake{animation:none}}
.lab-ai{margin-top:18px}
.lab-ai summary{cursor:pointer;font-weight:700;font-size:1.05em;list-style:none;display:flex;align-items:center;gap:8px}
.lab-ai summary::-webkit-details-marker{display:none}
.lab-ai summary::after{content:"펼치기";margin-left:auto;font-size:.85em;font-weight:600;color:var(--accent,#2456a4)}
.lab-ai[open] summary::after{content:"접기"}
.lab-ai .lab-ai-lead{color:var(--ink-2,#3e4c59);margin:10px 0 14px}
.lab-ai label{display:block;font-weight:700;margin:14px 0 6px}
.lab-ai label small{font-weight:400;color:var(--ink-2,#3e4c59);margin-left:6px}
.lab-ai textarea{width:100%;box-sizing:border-box;min-height:96px;font:inherit;line-height:1.6;padding:10px 12px;border:1px solid var(--line-2,#cfd6dd);border-radius:10px;background:var(--paper,#fff);color:var(--ink,#1f2933);resize:vertical}
.lab-ai textarea:focus{outline:2px solid var(--accent,#2456a4);outline-offset:1px}
.lab-ai #labAiPaste{background:var(--bg,#f4f6f8)}
.lab-ai .lab-ai-meter{font-size:.92em;color:var(--ink-2,#3e4c59);margin-top:6px;min-height:1.4em}
.lab-ai .lab-ai-meter.warn{color:var(--warn,#a35a00);font-weight:600}
.lab-ai .lab-ai-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
@media print{.lab-paste-tip{display:none}.lab-ai .lab-ai-row{display:none}}
`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function load(){ try{ return JSON.parse(localStorage.getItem(KEY) || '{}'); }catch(e){ return {}; } }
  function save(d){ try{ localStorage.setItem(KEY, JSON.stringify(d)); }catch(e){} }
  // 글자 두 개씩 묶은 조각이 AI 답과 얼마나 겹치는지(띄어쓰기·문장부호 빼고)
  function overlap(mine, ai){
    const norm = t => (t||'').replace(/[\s\p{P}\p{S}]/gu,'');
    const a = norm(mine), b = norm(ai);
    if(a.length < 12 || b.length < 12) return 0;
    const grams = t => { const g = new Set(); for(let i=0;i<t.length-1;i++) g.add(t.slice(i,i+2)); return g; };
    const ga = grams(a), gb = grams(b); let hit = 0;
    ga.forEach(x => { if(gb.has(x)) hit++; });
    return hit / ga.size;
  }

  function mount(){
    const host = document.querySelector('main') || document.body;
    const box = document.createElement('details');
    box.className = 'card lab-ai'; box.id = 'labAi';
    box.innerHTML = `
      <summary>AI를 썼다면</summary>
      <p class="lab-ai-lead">AI에게 물어봤다면 그 답을 첫 칸에 붙여 넣고, 다 읽은 뒤 아래 칸에 내 말로 요약해요. 요약 칸은 붙여넣기가 안 돼요.</p>
      <label for="labAiPaste">AI 답 붙여넣기 <small>붙여넣기 돼요</small></label>
      <textarea id="labAiPaste" data-paste="ok" placeholder="AI가 한 답을 여기에 붙여 넣어요"></textarea>
      <label for="labAiMine">AI 답을 읽고 내 말로 요약 <small>붙여넣기 안 돼요</small></label>
      <textarea id="labAiMine" placeholder="친구에게 설명하듯 내 말로 두세 줄 써요. 책과 다른 점이 있으면 함께 적어요."></textarea>
      <div class="lab-ai-meter" id="labAiMeter" aria-live="polite"></div>
      <div class="lab-ai-row">
        <button class="btn small" type="button" id="labAiCopy">이 부분 글로 복사</button>
        <button class="btn small ghost" type="button" id="labAiClear">비우기</button>
      </div>`;
    host.appendChild(box);
    const pasteEl = box.querySelector('#labAiPaste'), mineEl = box.querySelector('#labAiMine'), meter = box.querySelector('#labAiMeter');
    const d = load();
    pasteEl.value = d.ai || ''; mineEl.value = d.mine || '';
    if(d.ai || d.mine) box.open = true;
    function paint(){
      const n = mineEl.value.trim().length;
      const r = overlap(mineEl.value, pasteEl.value);
      meter.classList.toggle('warn', r >= 0.6);
      if(!n){ meter.textContent = ''; return; }
      meter.textContent = r >= 0.6
        ? `${n}자 · AI 답과 많이 겹쳐요. 문장을 바꿔 내 말로 다시 써 볼까요?`
        : `${n}자 · 내 말로 쓰고 있어요.`;
    }
    function persist(){ save({ai: pasteEl.value, mine: mineEl.value}); paint(); }
    pasteEl.addEventListener('input', persist); mineEl.addEventListener('input', persist);
    paint();
    box.querySelector('#labAiCopy').addEventListener('click', async e=>{
      const text = `[AI 답]\n${pasteEl.value.trim()}\n\n[내 말로 요약]\n${mineEl.value.trim()}`;
      let ok = false;
      try{ await navigator.clipboard.writeText(text); ok = true; }catch(err){}
      e.target.textContent = ok ? '복사했어요' : '복사가 막혔어요. 칸을 길게 눌러 복사해요';
      setTimeout(()=>{ e.target.textContent = '이 부분 글로 복사'; }, 1800);
    });
    box.querySelector('#labAiClear').addEventListener('click', ()=>{
      if(!confirm('AI 답과 내 요약을 지울까요?')) return;
      pasteEl.value = ''; mineEl.value = ''; persist();
    });
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
