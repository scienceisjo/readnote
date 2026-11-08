/* 읽기 노트 — 학생·선생님 화면이 같이 쓰는 부분
   서버: Supabase A (표는 막혀 있고 rn_* 함수로만 드나듦, setup.sql 참고) */
(function () {
  'use strict';

  const CFG = {
    url: 'https://vbvtnmnodeoocbbjauap.supabase.co',
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZidnRubW5vZGVvb2NiYmphdWFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0OTQ0OTYsImV4cCI6MjA5NTA3MDQ5Nn0.dvuRrt3qw2Tya_QwGbcXrmGPdfDgI4xmgyH8UjU73Nc'
  };

  // 서버가 돌려주는 오류 이름 → 화면에 보일 말
  const MSG = {
    no_room: '이 참여코드로 된 방이 없어요. 코드를 다시 확인해 주세요.',
    name_mismatch: '이 학번은 다른 이름으로 이미 들어와 있어요. 이름을 확인하고, 그래도 안 되면 선생님께 말씀해 주세요.',
    bad_no: '학번을 적어 주세요.',
    bad_name: '이름을 적어 주세요(20자 안).',
    closed: '이 방은 마감됐어요. 지금은 기록을 고칠 수 없어요.',
    room_full: '이 방에 들어올 수 있는 인원이 다 찼어요. 선생님께 말씀해 주세요.',
    no_reader: '들어온 기록을 찾지 못했어요. 다시 들어와 주세요.',
    too_long: '한 칸에 적은 글이 너무 길어요. 조금 줄여 주세요.',
    bad_slot: '저장할 칸을 찾지 못했어요. 선생님이 부분 목록을 바꿨을 수 있으니 새로고침해 주세요.',
    bad_data: '저장할 내용이 이상해요.',
    wrong_pass: '선생님 비밀번호가 맞지 않아요.',
    locked: '비밀번호를 여러 번 틀려서 이 방이 10분 동안 잠겼어요. 잠시 뒤 다시 해 주세요.',
    short_pass: '비밀번호는 6자 이상으로 정해 주세요.',
    bad_title: '책이나 글 제목을 적어 주세요.',
    bad_chapters: '읽을 부분 목록을 확인해 주세요. 한 줄에 하나씩, 60개까지예요.',
    chapter_in_use: '학생 기록이 있는 부분은 목록에서 뺄 수 없어요. 이름만 고쳐 주세요.',
    dup_no: '같은 학번이 이미 있어요.',
    code_fail: '참여코드를 만들지 못했어요. 한 번 더 눌러 주세요.',
    not_installed: '서버 준비가 아직 안 됐어요. 선생님이 설치 SQL 을 한 번 실행해야 해요.',
    network: '인터넷 연결을 확인해 주세요. 적은 글은 이 기기에 남아 있어요.',
    server: '서버에서 문제가 생겼어요. 잠시 뒤 다시 해 주세요.'
  };

  class RNError extends Error {
    constructor(code, detail) { super(MSG[code] || MSG.server); this.code = code; this.detail = detail; }
  }

  async function rpc(fn, args, opts) {
    let res;
    try {
      res = await fetch(`${CFG.url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        keepalive: !!(opts && opts.keepalive),
        headers: {
          apikey: CFG.key,
          Authorization: 'Bearer ' + CFG.key,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(args || {})
      });
    } catch (e) {
      throw new RNError('network', e.message);
    }
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
    if (!res.ok) {
      const m = String((body && (body.message || body.hint)) || text || res.status).trim();
      if (res.status === 404 || (body && body.code === 'PGRST202')) throw new RNError('not_installed', m);
      throw new RNError(MSG[m] ? m : 'server', m);
    }
    // 선생님 함수는 비밀번호 오류를 {"error": "..."} 로 돌려준다
    if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.error === 'string') {
      throw new RNError(MSG[body.error] ? body.error : 'server', body.error);
    }
    return body;
  }

  // ---------- 작은 도구 ----------
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  function chapterId() {
    const a = 'abcdefghijkmnpqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
    return s;
  }

  // 글자 수(공백 뺀)
  const len = s => String(s == null ? '' : s).replace(/\s/g, '').length;
  const arr = v => Array.isArray(v) ? v : [];
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};

  // 말머리를 눌러 놓고 빈자리를 안 채운 질문은 질문으로 치지 않는다
  const STUB = /「\s*」|^\s*와\(과\)|만약\s+가\s/;
  const realQ = q => len(q) > 0 && !STUB.test(String(q));

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const now = new Date();
    const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return '오늘 ' + hm;
    return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  }

  // 참여코드 보정: 한글 자판 상태로 친 글자를 영문으로 되돌리고, 전각·공백·하이픈을 정리
  const JAMO = {
    'ㄱ': 'R', 'ㄲ': 'R', 'ㄴ': 'S', 'ㄷ': 'E', 'ㄸ': 'E', 'ㄹ': 'F', 'ㅁ': 'A', 'ㅂ': 'Q', 'ㅃ': 'Q', 'ㅅ': 'T', 'ㅆ': 'T',
    'ㅇ': 'D', 'ㅈ': 'W', 'ㅉ': 'W', 'ㅊ': 'C', 'ㅋ': 'Z', 'ㅌ': 'X', 'ㅍ': 'V', 'ㅎ': 'G',
    'ㅏ': 'K', 'ㅐ': 'O', 'ㅑ': 'I', 'ㅒ': 'O', 'ㅓ': 'J', 'ㅔ': 'P', 'ㅕ': 'U', 'ㅖ': 'P', 'ㅗ': 'H', 'ㅘ': 'HK', 'ㅙ': 'HO',
    'ㅚ': 'HL', 'ㅛ': 'Y', 'ㅜ': 'N', 'ㅝ': 'NJ', 'ㅞ': 'NP', 'ㅟ': 'NL', 'ㅠ': 'B', 'ㅡ': 'M', 'ㅢ': 'ML', 'ㅣ': 'L',
    'ㄳ': 'RT', 'ㄵ': 'SW', 'ㄶ': 'SG', 'ㄺ': 'FR', 'ㄻ': 'FA', 'ㄼ': 'FQ', 'ㄽ': 'FT', 'ㄾ': 'FX', 'ㄿ': 'FV', 'ㅀ': 'FG', 'ㅄ': 'QT'
  };
  const LEAD = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  const VOW = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
  const TAIL = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
  function normCode(s) {
    let out = '';
    for (const ch of String(s || '')) {
      const c = ch.charCodeAt(0);
      if (c >= 0xAC00 && c <= 0xD7A3) {
        const n = c - 0xAC00;
        out += JAMO[LEAD[Math.floor(n / 588)]] + JAMO[VOW[Math.floor((n % 588) / 28)]] + (JAMO[TAIL[n % 28]] || '');
      } else if (JAMO[ch]) out += JAMO[ch];
      else if (c >= 0xFF01 && c <= 0xFF5E) out += String.fromCharCode(c - 0xFEE0);
      else out += ch;
    }
    return out.replace(/[\s\-_.·]/g, '').toUpperCase();
  }

  async function copyText(text, fallbackEl) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      if (fallbackEl) { fallbackEl.value = text; fallbackEl.hidden = false; fallbackEl.focus(); fallbackEl.select(); }
      try { return document.execCommand('copy'); } catch (e2) { return false; }
    }
  }

  function toast(msg, ms) {
    let t = $('#rn-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'rn-toast';
      t.setAttribute('role', 'status');
      t.setAttribute('aria-live', 'polite');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('on'), ms || 2600);
  }

  // 질문이 막힐 때 꺼내 쓰는 말머리 (c = 커서를 둘 자리)
  const STARTERS = [
    { k: '뜻', t: '「」는 무슨 뜻일까?', c: 1 },
    { k: '정말?', t: '정말 그럴까? 그렇게 말할 근거는 무엇일까?', c: 99 },
    { k: '견주기', t: '와(과) 무엇이 같고 무엇이 다를까?', c: 0 },
    { k: '왜', t: '왜 그렇게 됐을까?', c: 0 },
    { k: '만약', t: '만약 가 바뀌면 어떻게 될까?', c: 3 },
    { k: '우리 곁에서', t: '우리 생활에서는 어디서 볼 수 있을까?', c: 0 },
    { k: '눈에 띈 것', t: '여기서 눈에 띄는 것은 무엇이고, 왜 그럴까?', c: 99 }
  ];

  const slotOf = chId => 'ch:' + chId;

  // AI 에 붙여 넣을 부탁문 — 답이 아니라 질문을 받도록
  function promptCheck(room, chName, data) {
    const qs = arr(data.questions).filter(realQ);
    return [
      `나는 중학생이고 『${room.title}』${room.author ? `(${room.author})` : ''}의 「${chName}」 부분을 읽었어.`,
      '아래는 내가 내 말로 쓴 요약과, 읽으면서 생긴 질문이야.',
      '',
      '[내 요약]',
      String(data.summary || '').trim(),
      '',
      '[내 질문]',
      qs.length ? qs.map(q => '- ' + q.trim()).join('\n') : '- (아직 없음)',
      '',
      '부탁:',
      '1. 정답이나 요약을 대신 써 주지 마.',
      '2. 내 요약에서 빠졌거나 애매해 보이는 곳을 짚는 질문을 3개만 해 줘. 중학생이 알아듣는 말로.',
      '3. 책 내용을 정확히 모르면 지어내지 말고 "책에서 다시 확인해 봐"라고 해 줘.',
      '4. 내 질문 가운데 하나를 골라, 답 대신 답을 찾아갈 실마리 하나만 줘.'
    ].join('\n');
  }

  function promptTidy(room, record) {
    return [
      `아래는 내가 『${room.title}』${room.author ? `(${room.author})` : ''}를 읽으면서 직접 쓴 기록이야.`,
      '',
      '부탁: 내가 쓴 말을 그대로 살려서 보기 좋게 정리만 해 줘.',
      '- 새로운 내용이나 설명을 보태지 마.',
      '- 내 문장을 고쳐 쓰지 말고, 순서와 묶음만 정리해.',
      '- 비어 있는 칸은 [비어 있음]이라고 표시해.',
      '- 마지막에, 내 질문 가운데 아직 답을 못 찾은 것만 따로 모아 줘.',
      '',
      '[내 기록]',
      record
    ].join('\n');
  }

  // 기록 칸 상태 (학생·선생님 화면이 같은 기준을 쓰도록 여기 한 곳에)
  function slotState(slot, e) {
    if (!e) return '';
    const d = obj(e.data);
    if (slot === 'before') return len(d.question) >= 5 ? 'on' : (len(d.question) || len(d.concept_now) ? 'half' : '');
    if (slot === 'after') return (len(d.answer) >= 10 && len(d.one_line) >= 5) ? 'on' : ((len(d.answer) || len(d.one_line) || len(d.new_q) || len(d.concept_after)) ? 'half' : '');
    if (e.done && len(d.summary) >= 10) return 'on';
    const q = obj(d.quote), st = obj(d.stuck);
    return (len(d.summary) || arr(d.questions).some(realQ) || len(q.text) || st.on || len(st.where)) ? 'half' : '';
  }
  const isStuck = d => { const st = obj(obj(d).stuck); return !!st.on || len(st.where) > 0; };

  window.RN = { CFG, MSG, RNError, rpc, esc, $, $$, store, chapterId, len, arr, obj, realQ, fmtTime, normCode, copyText, toast, STARTERS, slotOf, promptCheck, promptTidy, slotState, isStuck };
})();
