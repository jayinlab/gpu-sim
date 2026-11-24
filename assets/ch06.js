(() => {
'use strict';

const $ = (root, sel) => root.querySelector(sel);
// 숫자 뒤 조사: 끝자리 읽는 소리 기준 (0영 1일 2이 3삼 4사 5오 6육 7칠 8팔 9구)
const eul = n => n + ('013678'.includes(String(n).slice(-1)) ? '을' : '를');
const ro = n => n + ('036'.includes(String(n).slice(-1)) ? '으로' : '로');
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/* ---------- 시뮬레이터 1 · 신호 릴레이 ---------- */
(function relay() {
  const root = document.getElementById('sim-relay');
  if (!root) return;
  const list = $(root, '.relay'), state = $(root, '.relay-state'), say = $(root, '.say');
  const nextBtn = $(root, '[data-act="next"]'), autoBtn = $(root, '[data-act="auto"]');
  let cur = 0, timer = null, steps = [];

  // 실제 함수 순서를 그대로 옮긴다. set = 이 단계 뒤의 상태 (앞 단계 값에 덮어씀)
  function build(pair, lost) {
    const S = [];
    const jobs = pair ? '41·42' : '42';
    const last0 = pair ? 40 : 41;
    S.push({ who: '스케줄러', cls: 'cpu',
      t: 'GPU 스케줄러가 job ' + jobs + '를 링에 써요. 끝에 번호를 쓰는 RELEASE_MEM을 붙이고, 하드웨어 fence에 「끝나면 알려 줘」 콜백을 걸어요. 이때 링의 예비 타이머(0.5초)도 걸려요.',
      code: 'amdgpu_fence_emit · dma_fence_add_callback(drm_sched_job_done_cb) → enable_signaling',
      set: { app: '깨어 있음 (다른 일)', mem: last0, last: last0, sig: '없음', tm: '걸림 (0.5초)' } });
    S.push({ who: '앱 스레드', cls: 'cpu',
      t: 'clFinish(queue)를 불러요. ANGLE은 남은 명령을 제출하고, 가장 오래된 묶음' + (pair ? '(41)' : '') + '의 VkFence부터 기다려요. 제한 시간은 끝없이.',
      code: 'finishInternal → finishResourceUse → vkWaitForFences(…, UINT64_MAX)',
      set: { app: '기다리러 들어감' } });
    S.push({ who: 'Mesa', cls: 'cpu',
      t: 'fence 뒤에 있는 DRM syncobj를 기다리는 ioctl로 내려가요.',
      code: 'vk_common_WaitForFences → DRM_IOCTL_SYNCOBJ_WAIT (WAIT_FOR_SUBMIT | WAIT_ALL)', set: {} });
    S.push({ who: '커널 DRM', cls: 'cpu',
      t: 'syncobj에 든 스케줄러 fence에 깨우기 콜백을 걸고, 앱 스레드를 재워요. 이제 이 스레드는 CPU를 쓰지 않아요.',
      code: 'drm_syncobj_array_wait_timeout · TASK_INTERRUPTIBLE · schedule_timeout',
      set: { app: '잠듦' } });
    if (pair) {
      S.push({ who: 'GPU', cls: 'gpu',
        t: 'job 41의 wave가 다 끝났어요. CP가 RELEASE_MEM을 처리해 캐시를 정리하고 fence 칸에 41을 써요. 쓰기가 확인되자 인터럽트 ①을 보내요.',
        code: 'RELEASE_MEM  EVENT_TYPE(CACHE_FLUSH_AND_INV_TS_EVENT) · INT_SEL(2) · DATA = 41',
        set: { mem: 41 } });
      S.push({ who: 'GPU', cls: 'gpu',
        t: 'CPU가 인터럽트 ①을 처리하기 전에 job 42도 끝났어요. fence 칸이 42로 바뀌고 인터럽트 ②가 나가요.',
        code: 'RELEASE_MEM  DATA = 42 · INT_SEL(2)', set: { mem: 42 } });
    } else {
      S.push({ who: 'GPU', cls: 'gpu',
        t: 'job 42의 wave가 다 끝났어요. CP가 RELEASE_MEM을 처리해 캐시를 정리하고 fence 칸에 42를 써요.' + (lost ? ' 그런데 인터럽트가 CPU에 닿지 않아요.' : ' 쓰기가 확인되자 인터럽트를 보내요.'),
        code: 'RELEASE_MEM  EVENT_TYPE(CACHE_FLUSH_AND_INV_TS_EVENT) · INT_SEL(2) · DATA = 42',
        set: { mem: 42 } });
    }
    if (lost) {
      S.push({ who: '아무도', cls: 'idle',
        t: 'GPU는 끝났고 fence 칸엔 42가 적혀 있지만, 인터럽트가 ' + (pair ? '둘 다 ' : '') + '오지 않아 CPU 쪽엔 그걸 볼 이유가 없어요. 앱 스레드는 계속 자요.',
        code: '(인터럽트 없음)', set: {} });
      S.push({ who: '예비 타이머', cls: 'warn',
        t: '타이머가 걸린 지 0.5초가 되어 울려요. 처리기 대신 같은 함수를 불러요. (이 그림은 그 전에 GPU 일이 끝났다고 둬요.)',
        code: 'amdgpu_fence_fallback → amdgpu_fence_process', set: { tm: '울림' } });
    } else {
      S.push({ who: '인터럽트', cls: 'cpu',
        t: '인터럽트' + (pair ? ' ①' : '') + '이 CPU에 닿아요. 처리기가 실린 me·pipe·queue로 어느 compute 링인지 찾아 처리 함수를 불러요.',
        code: 'gfx_v9_0_eop_irq → amdgpu_fence_process(ring)', set: {} });
    }
    S.push({ who: 'amdgpu', cls: 'cpu',
      t: 'fence 칸을 읽으니 42, 지난번에 본 번호는 ' + last0 + '. last_seq를 42로 올려요. 그다음 예비 타이머를 지우는데, 남은 fence가 없으니 다시 걸지 않아요.' + (lost ? ' (타이머는 방금 울려서 지울 것도 없어요.)' : ''),
      code: 'seq = amdgpu_fence_read() · last_seq ' + last0 + ' → 42 · timer_delete',
      set: { last: 42, tm: lost ? '울림 · 다시 안 걸림' : '지움' } });
    if (lost) S[S.length - 1].warn = '커널 로그: Fence fallback timer expired on ring …';
    const sig = (n, waiter) => {
      S.push({ who: 'amdgpu', cls: 'cpu',
        t: '하드웨어 fence ' + eul(n) + ' 신호해요. 이 호출 안에서 그 fence에 걸린 콜백이 바로 이어서 불려요(아래 ↳ 두 칸).',
        code: 'dma_fence_signal(하드웨어 ' + n + ')', set: { sig: (pair && n === 42 ? '하드웨어·스케줄러 41, 하드웨어 42' : '하드웨어 ' + n) } });
      S.push({ who: '↳ 스케줄러', cls: 'cpu nest',
        t: '하드웨어 fence ' + n + '에 걸어 둔 콜백이 job의 스케줄러 fence(finished)를 신호해요. syncobj가 들고 있던 게 바로 이것이에요.',
        code: 'drm_sched_job_done_cb → drm_sched_fence_finished',
        set: { sig: pair ? (n === 41 ? '하드웨어·스케줄러 41' : '하드웨어·스케줄러 41·42') : '하드웨어·스케줄러 42' } });
      S.push(waiter
        ? { who: '↳↳ 커널 DRM', cls: 'cpu nest',
            t: '스케줄러 fence ' + n + '에 걸어 둔 깨우기 콜백이 불려 앱 스레드를 깨워요. 스레드는 실행 대기열에 들어가고, 처리기는 할 일을 계속해요.',
            code: 'syncobj_wait_fence_func → wake_up_process', set: { app: '깨어남 (실행 대기)' } }
        : { who: '↳↳ (없음)', cls: 'cpu nest',
            t: '스케줄러 fence ' + eul(n) + ' 기다리며 자는 스레드는 없어요. 앱 스레드는 묶음 41을 기다리다 이미 깨워졌거든요.',
            code: '(걸린 깨우기 콜백 없음)', set: {} });
    };
    if (pair) { sig(41, true); sig(42, false); } else sig(42, true);
    if (pair && !lost) {
      S.push({ who: '인터럽트', cls: 'cpu',
        t: '인터럽트 ②가 이제 와요. fence 칸은 여전히 42이고 last_seq도 42라서, 할 일 없이 돌아가요.',
        code: 'amdgpu_fence_process: seq == last_seq → return false', set: {} });
    }
    S.push({ who: '앱 스레드', cls: 'cpu',
      t: 'CPU를 받은 스레드가 루프를 한 번 더 돌며 fence가 신호됐는지 보고 ioctl에서 돌아와요.' + (pair ? ' ANGLE은 다음 묶음 42를 vkGetFenceStatus로 먼저 물어보는데 이미 끝나 있어서 다시 잠들지 않아요.' : ''),
      code: 'dma_fence_is_signaled → 0 · VK_SUCCESS' + (pair ? ' · checkOneCommandBatchLocked(42) → 끝남' : ''),
      set: { app: '깨어 있음' } });
    S.push({ who: 'ANGLE', cls: 'cpu',
      t: '묶음' + (pair ? '들' : '') + '을 끝난 것으로 옮기고, host transfer와 printf 같은 호스트 쪽 뒷일을 해요. 그 번호까지의 event를 CL_COMPLETE로 바꾸고 콜백을 불러요. 이제야 clFinish가 돌아와요.',
      code: 'finishQueueSerialInternal → processQueueSerialUpTo → setEventsWithQueueSerialToState(COMPLETE)',
      set: { app: 'clFinish에서 돌아옴' }, end: true });
    return S;
  }

  function snapshot(upto) {
    const s = {};
    for (let i = 0; i <= upto; i++) Object.assign(s, steps[i].set);
    return s;
  }

  function render() {
    list.textContent = '';
    steps.forEach((st, i) => {
      const li = el('li', st.cls + (i === cur ? ' cur' : i < cur ? ' past' : ' future'));
      li.appendChild(el('span', 'who', st.who));
      const body = el('div', 'rbody');
      body.appendChild(el('div', null, st.t));
      body.appendChild(el('code', null, st.code));
      if (st.warn && i <= cur) body.appendChild(el('div', 'rwarn', st.warn));
      li.appendChild(body);
      list.appendChild(li);
    });
    const s = snapshot(cur);
    state.textContent = '';
    [['앱 스레드', s.app], ['메모리의 fence 칸', String(s.mem)], ['last_seq (amdgpu가 본 번호)', String(s.last)],
     ['신호된 fence', s.sig], ['예비 타이머', s.tm]].forEach(([k, v]) => {
      const d = el('div', 'rs' + (k === '앱 스레드' && v === '잠듦' ? ' sleep' : ''));
      d.appendChild(el('span', 'k', k));
      d.appendChild(el('b', null, v));
      state.appendChild(d);
    });
    const st = steps[cur];
    const pair = $(root, '[data-k="pair"]').checked, lost = $(root, '[data-k="lost"]').checked;
    let msg = (cur + 1) + ' / ' + steps.length + ' — ' + st.who + '. ';
    if (cur === 0) msg += '「다음」을 누르면 앱이 clFinish를 불러요.';
    else if (st.end) msg += lost
      ? 'GPU는 한참 전에 끝났지만 clFinish는 예비 타이머가 울린 뒤에야 돌아왔어요. 인터럽트가 오지 않아서 생긴 차이예요.'
      : pair ? 'fence 칸이 「42까지 끝남」이라는 한 숫자라서, 인터럽트 하나로 두 job을 다 처리했어요.'
             : 'GPU가 한 일은 RELEASE_MEM 한 번이고, 나머지는 CPU가 인터럽트를 받고 나서 한 일이에요.';
    else if (snapshot(cur).app === '잠듦') msg += '앱 스레드는 자고 있어요. 깨울 수 있는 건 fence 콜백뿐이에요.';
    else msg += '';
    say.innerHTML = msg;
    say.classList.toggle('bad', lost && cur >= steps.findIndex(x => x.who === '아무도') && !st.end);
    nextBtn.disabled = cur >= steps.length - 1;
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; autoBtn.textContent = '자동'; } }
  function reset() {
    stop();
    steps = build($(root, '[data-k="pair"]').checked, $(root, '[data-k="lost"]').checked);
    cur = 0;
    render();
  }
  root.addEventListener('change', reset);
  root.addEventListener('click', e => {
    const a = e.target.closest('button')?.dataset.act;
    if (!a) return;
    if (a === 'next') { stop(); if (cur < steps.length - 1) cur++; render(); }
    else if (a === 'reset') reset();
    else if (a === 'auto') {
      if (timer) { stop(); return; }
      if (cur >= steps.length - 1) cur = 0;
      autoBtn.textContent = '멈춤';
      render();
      timer = setInterval(() => { if (cur >= steps.length - 1) { stop(); return; } cur++; render(); }, 1100);
    }
  });
  reset();
})();

/* ---------- 시뮬레이터 2 · event 상태판 ---------- */
(function events() {
  const root = document.getElementById('sim-event');
  if (!root) return;
  const wrap = $(root, '.evwrap'), threads = $(root, '.evthreads'), say = $(root, '.say');
  const KT = 4, WAKE = 1, MAXK = 6; // 커널 4박자, 깨어나는 데 1박자 (지어낸 값)
  const NAME = { 3: 'CL_QUEUED', 2: 'CL_SUBMITTED', 1: 'CL_RUNNING', 0: 'CL_COMPLETE' };
  let S;

  function init() {
    S = { t: 0, serial: 1, pending: [], batches: [], ev: [], gpuFree: 0, cqd: [], cqdDone: 0, polls: 0, lastSubmitted: 0, blocked: null, msg: '', cls: '',
      // Perfetto trace용 기록: 앱 호출(순간), 앱 스레드 대기 구간, ANGLE-CL-CQD 대기 구간
      calls: [], appSpans: [], cqdPushT: {}, cqdSpans: [] };
  }

  // flushInternal: 기록하던 묶음을 넘기고(SUBMITTED) vkQueueSubmit(RUNNING). 비어 있으면 빈 제출
  function flushInternal() {
    const ser = S.serial++;
    const b = { serial: ser, ks: S.pending.slice(), submitT: S.t, start: Math.max(S.t, S.gpuFree) };
    let t = b.start;
    b.ks.forEach(k => { const e = S.ev[k]; e.gs = t; t += KT; e.ge = t; });
    b.end = t;
    S.gpuFree = t;
    S.batches.push(b);
    S.pending = [];
    S.lastSubmitted = ser;
    setUpTo(ser, 2, S.t);
    setUpTo(ser, 1, S.t);
    return b;
  }
  // setEventsWithQueueSerialToState: 번호 이하 event를 그 상태까지, 건너뛴 상태의 시각도 채움
  function setUpTo(ser, st, at) {
    S.ev.forEach(e => {
      if (e.serial > ser) return;
      while (e.st > st) { e.st--; e.ts[e.st] = at; }
    });
  }
  const batchOf = ser => S.batches.find(b => b.serial === ser);
  // 호스트가 번호 ser의 fence를 기다려 돌아오는 시각
  const doneAt = (ser, from) => Math.max(from, batchOf(ser).end + WAKE);

  // ANGLE-CL-CQD 스레드: 받은 번호를 차례로 기다린다
  function runCqd(until) {
    while (S.cqd.length) {
      const ser = S.cqd[0];
      const at = doneAt(ser, S.cqdDone);
      if (at > until) break;
      S.cqd.shift();
      S.cqdSpans.push({ ser, a: Math.max(S.cqdPushT[ser], S.cqdDone), end: batchOf(ser).end, b: at });
      S.cqdDone = at;
      setUpTo(ser, 0, at);
    }
  }
  function advance(to) { runCqd(to); S.t = to; }

  function act(a) {
    S.cls = '';
    S.blocked = null;
    if (a === 'enq') {
      if (S.ev.length >= MAXK) { S.msg = '이 판에선 커널을 ' + MAXK + '개까지 넣어요. 「처음부터」로 다시 해 보세요.'; return; }
      const pre = '';
      const k = S.ev.length;
      S.ev.push({ k, serial: S.serial, st: 3, ts: { 3: S.t }, gs: null, ge: null });
      S.pending.push(k);
      S.calls.push({ t: S.t, n: 'clEnqueueNDRangeKernel (k' + (k + 1) + ')' });
      S.msg = pre + eul('k' + (k + 1)) + ' 넣었어요. event e' + (k + 1) + '은 CL_QUEUED이고, 지금 기록 중인 묶음 #' + S.serial + '에 들어갔어요.';
    } else if (a === 'flush') {
      const b = flushInternal();
      S.calls.push({ t: S.t, n: 'clFlush → vkQueueSubmit #' + b.serial });
      S.cqdPushT[b.serial] = S.t;
      S.cqd.push(b.serial);
      runCqd(S.t);
      S.msg = b.ks.length
        ? 'clFlush — 묶음 ' + eul('#' + b.serial) + ' vkQueueSubmit으로 보냈어요. 그 안의 event는 곧바로 CL_RUNNING이에요. GPU는 ' + b.start + '박자부터 돌아요. ANGLE-CL-CQD 스레드가 ' + eul('#' + b.serial) + ' 받아 기다리기 시작해요.'
        : 'clFlush — 기록된 명령이 없어서 빈 제출(묶음 #' + b.serial + ')을 했어요. ANGLE-CL-CQD 스레드가 이 번호를 기다려요.';
    } else if (a === 'finish' || a === 'wait1') {
      S.msg = '';
      if (a === 'wait1' && !S.ev.length) { S.msg = '기다릴 e1이 없어요. 커널부터 넣어 보세요.'; return; }
      if (a === 'wait1' && S.ev[0].st === 0) { S.msg = 'e1은 이미 CL_COMPLETE예요. 그래도 ANGLE은 큐를 finish하니 남은 명령이 있으면 제출하고 기다려요.'; }
      const t0 = S.t;
      const b = flushInternal();
      const at = doneAt(S.lastSubmitted, S.t);
      advance(at);
      setUpTo(S.lastSubmitted, 0, at);
      const waited = at - t0;
      S.appSpans.push({ n: a === 'finish' ? 'clFinish' : 'clWaitForEvents (e1)', ser: S.lastSubmitted, a: t0, end: batchOf(S.lastSubmitted).end, b: at });
      S.blocked = waited;
      if (a === 'finish') {
        S.msg = 'clFinish — 남은 명령을 묶음 ' + ro('#' + b.serial) + ' 보내고, 앱 스레드가 그 fence를 기다렸어요. ' + waited + '박자 동안 막혔다가 ' + at + '박자에 돌아왔어요. 마지막 커널이 끝나고 깨어나는 데 ' + WAKE + '박자가 더 들었어요.';
      } else {
        const e1 = S.ev[0];
        const extra = at - (e1.ge + WAKE);
        S.msg = (S.msg ? S.msg + ' ' : '') + 'clWaitForEvents(e1) — ANGLE은 e1의 큐를 통째로 finish해요. e1은 GPU에서 ' + e1.ge + '박자에 끝났지만 앱 스레드는 ' + at + '박자에 돌아왔어요' + (extra > 0 ? '. 뒤에 넣은 커널을 기다리느라 ' + extra + '박자를 더 막혔어요.' : '.');
        S.cls = extra > 0 ? 'bad' : '';
      }
    } else if (a === 'poll') {
      S.polls++;
      S.calls.push({ t: S.t, n: 'clGetEventInfo' });
      const done = S.ev.filter(e => e.ge != null && e.ge <= S.t && e.st !== 0).length;
      const orphan = orphans();
      S.msg = 'clGetEventInfo ×' + S.polls + ' — ANGLE은 GPU에 묻지 않고 저장된 상태를 돌려줘요.' +
        (orphan.length ? ' ' + orphan.join('·') + '의 묶음은 GPU에서 다 끝났는데, 그 번호(또는 뒤 번호)를 기다리는 스레드가 없어서 CL_COMPLETE가 되지 않아요.'
         : done ? ' GPU에서 끝난 커널이 ' + done + '개 있지만, 같은 묶음의 마지막 커널이 끝나야 그 묶음의 fence가 와요.'
         : S.ev.some(e => e.st === 3) ? ' 아직 기록 중인 묶음의 event는 누가 보내기 전까지 CL_QUEUED예요.' : '');
      S.cls = orphan.length ? 'bad' : '';
    } else if (a === 'tick') {
      const before = S.ev.map(e => e.st);
      advance(S.t + KT);
      const changed = S.ev.filter((e, i) => e.st !== before[i]).map(e => 'e' + (e.k + 1));
      const idle = !S.batches.length || S.gpuFree <= S.t - KT;
      S.msg = S.t + '박자가 됐어요. ' + (changed.length ? 'ANGLE-CL-CQD 스레드가 깨어나 ' + eul(changed.join('·')) + ' CL_COMPLETE로 바꿨어요.' : idle && S.pending.length && !S.batches.length ? '아직 제출된 묶음이 없어서 GPU는 놀아요.' : '상태는 그대로예요.');
      const orphan = orphans();
      if (orphan.length) { S.msg += ' ' + orphan.join('·') + '의 묶음은 GPU에서 끝났는데 그 fence를 기다리는 스레드가 없어요.'; S.cls = 'bad'; }
      else if (!changed.length) {
        const partial = S.ev.filter(e => e.st > 0 && e.ge != null && e.ge <= S.t && batchOf(e.serial).end > S.t).map(e => 'k' + (e.k + 1));
        if (partial.length) S.msg += ' GPU에서 ' + partial.join('·') + '는 끝났지만, 묶음의 fence는 그 묶음의 마지막 커널이 끝나야 와요.';
      }
    }
  }

  // 묶음은 GPU에서 끝났는데 기다리는 스레드가 없어 COMPLETE가 안 된 event
  function orphans() {
    return S.ev.filter(e => {
      if (e.st === 0) return false;
      const b = batchOf(e.serial);
      return b && b.end + WAKE <= S.t && !S.cqd.some(x => x >= e.serial);
    }).map(e => 'e' + (e.k + 1));
  }

  function fmt(v) { return v == null ? '—' : String(v); }

  function render() {
    // 스레드와 GPU 한 줄씩
    threads.textContent = '';
    const gpuBusy = S.batches.some(b => b.start <= S.t && S.t < b.end);
    const cqdWait = S.cqd.length ? '#' + S.cqd.join(', #') + ' 기다리며 잠듦' : '할 일 없음 (잠듦)';
    [['지금', S.t + '박자'], ['앱 스레드', S.blocked == null ? '깨어 있음' : '방금 ' + S.blocked + '박자 막혔다 돌아옴'], ['ANGLE-CL-CQD', cqdWait],
     ['기록 중인 묶음', '#' + S.serial + (S.pending.length ? ' (' + S.pending.map(k => 'k' + (k + 1)).join('·') + ')' : ' (비어 있음)')],
     ['GPU', gpuBusy ? '일하는 중' : S.gpuFree > S.t ? '일하는 중' : '놀고 있음']].forEach(([k, v]) => {
      const d = el('div', 'rs');
      d.appendChild(el('span', 'k', k));
      d.appendChild(el('b', null, v));
      threads.appendChild(d);
    });

    wrap.textContent = '';
    if (!S.ev.length) { wrap.appendChild(el('p', 'muted', '「커널 넣기」로 시작해요.')); }
    else {
      const t = el('table', 'tbl evtbl');
      t.innerHTML = '<thead><tr><th>event</th><th>묶음</th><th>상태 (ANGLE 값)</th><th>QUEUED</th><th>SUBMIT</th><th>START</th><th>END</th><th>GPU에서 실제</th></tr></thead>';
      const tb = el('tbody');
      S.ev.forEach(e => {
        const tr = el('tr', 's' + e.st);
        const gpu = e.gs == null ? '제출 전' : e.ge <= S.t ? e.gs + '–' + e.ge + ' 끝남' : e.gs <= S.t ? e.gs + '–' + e.ge + ' 도는 중' : e.gs + '부터 예정';
        [ 'e' + (e.k + 1), '#' + e.serial, NAME[e.st], fmt(e.ts[3]), fmt(e.ts[2]), fmt(e.ts[1]), fmt(e.ts[0]), gpu ].forEach((v, i) => {
          const td = el('td', i === 2 ? 'st' : i === 7 ? 'gpu' : null, v);
          tr.appendChild(td);
        });
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      wrap.appendChild(t);
      wrap.appendChild(el('div', 'muted small', 'QUEUED·SUBMIT·START·END는 ANGLE이 적는 프로파일링 값(상태가 바뀐 순간의 호스트 시각)이에요. 마지막 칸은 모델 속 GPU의 실제 시작–끝이에요.'));
    }
    // GPU 시간 막대
    if (S.batches.length) {
      const end = Math.max(S.t, S.gpuFree, ...S.ev.map(e => e.ts[0] || 0)) + 1;
      const tl = el('div', 'evtl');
      const row = (name, segs) => {
        const r = el('div', 'evtl-row');
        r.appendChild(el('span', 'evtl-name', name));
        const tr = el('div', 'evtl-track');
        segs.forEach(sg => {
          const s = el('i', sg.c, sg.t);
          s.style.left = (sg.a / end * 100) + '%';
          s.style.width = Math.max(0.8, (sg.b - sg.a) / end * 100) + '%';
          tr.appendChild(s);
        });
        const now = el('b', 'now');
        now.style.left = (S.t / end * 100) + '%';
        tr.appendChild(now);
        r.appendChild(tr);
        tl.appendChild(r);
      };
      row('GPU', S.ev.filter(e => e.gs != null).map(e => ({ a: e.gs, b: e.ge, c: 'k' + (e.k % 2), t: 'k' + (e.k + 1) })));
      S.ev.forEach(e => {
        if (e.ts[1] == null) return;
        const closed = e.ts[0] != null;
        row('e' + (e.k + 1) + ' START–END', [{ a: e.ts[1], b: closed ? e.ts[0] : Math.max(S.t, e.ts[1] + 0.3), c: closed ? 'pe' : 'pe open', t: closed ? e.ts[1] + '–' + e.ts[0] : e.ts[1] + '–?' }]);
      });
      wrap.appendChild(tl);
    }
    say.textContent = S.msg || '커널을 넣고, 보내고, 기다려 보세요.';
    say.classList.toggle('bad', S.cls === 'bad');
  }

  /* ----- Perfetto 시험판: 지금까지의 판을 Chrome trace(JSON)로 만들어 ui.perfetto.dev로 넘긴다 ----- */
  // 1박자 = 1ms로 놓는다(지어낸 시간). trace는 이 페이지가 만들어 새 탭에 postMessage로만 건넨다.
  function buildTrace() {
    if (!S.ev.length && !S.calls.length) return null;
    const US = 1000, now = S.t, E = [];
    const M = (pid, tid, name, sort) => {
      if (tid == null) {
        E.push({ ph: 'M', pid, name: 'process_name', args: { name } });
        E.push({ ph: 'M', pid, name: 'process_sort_index', args: { sort_index: sort } });
      } else {
        E.push({ ph: 'M', pid, tid, name: 'thread_name', args: { name } });
        E.push({ ph: 'M', pid, tid, name: 'thread_sort_index', args: { sort_index: sort } });
      }
    };
    const X = (pid, tid, name, a, b, args) => E.push({ ph: 'X', pid, tid, name, ts: a * US, dur: Math.max(0, b - a) * US, args: args || {} });
    M(1, null, '호스트 (시뮬레이터가 만든 trace)', 1); M(1, 1, '앱 스레드', 1); M(1, 2, 'ANGLE-CL-CQD', 2);
    M(2, null, 'GPU (모델)', 2); M(2, 1, 'compute 링', 1);
    M(3, null, 'event 프로파일링 값 (ANGLE이 적는 CPU 시각)', 3);
    S.calls.forEach(c => E.push({ ph: 'i', s: 't', pid: 1, tid: 1, name: c.n, ts: c.t * US }));
    S.appSpans.forEach(sp => {
      X(1, 1, sp.n, sp.a, sp.b, { '기다린 묶음': '#' + sp.ser, '막힌 박자': sp.b - sp.a });
      X(1, 1, 'vkWaitForFences (잠듦)', sp.a, Math.max(sp.a, sp.end), { '묶음': '#' + sp.ser });
      X(1, 1, '깨어나 event COMPLETE', Math.max(sp.a, sp.end), sp.b, {});
    });
    S.cqdSpans.forEach(sp => {
      X(1, 2, '묶음 #' + sp.ser + ' 기다림', sp.a, sp.b, {});
      X(1, 2, 'vkWaitForFences (잠듦)', sp.a, Math.max(sp.a, sp.end), {});
      X(1, 2, '깨어나 event COMPLETE', Math.max(sp.a, sp.end), sp.b, {});
    });
    S.cqd.forEach((ser, i) => {
      const a = i === 0 ? Math.max(S.cqdPushT[ser], S.cqdDone) : now;
      if (a < now) X(1, 2, '묶음 #' + ser + ' 기다리는 중', a, now, { '상태': '이 판의 지금 시각까지' });
    });
    S.ev.forEach(e => {
      if (e.gs != null && e.gs < now) X(2, 1, 'k' + (e.k + 1), e.gs, Math.min(e.ge, now), { '묶음': '#' + e.serial, '상태': e.ge <= now ? '끝남' : '도는 중' });
      M(3, 10 + e.k, 'e' + (e.k + 1), 10 + e.k);
      if (e.ts[1] != null) {
        const closed = e.ts[0] != null;
        X(3, 10 + e.k, closed ? 'e' + (e.k + 1) + ' START–END' : 'e' + (e.k + 1) + ' START– (END 아직)', e.ts[1], closed ? e.ts[0] : now,
          { QUEUED: e.ts[3], SUBMIT: e.ts[2], START: e.ts[1], END: closed ? e.ts[0] : '아직', '상태': NAME[e.st] });
      }
    });
    return { traceEvents: E, displayTimeUnit: 'ms' };
  }
  const PF = 'https://ui.perfetto.dev';
  function openPerfetto(trace) {
    const w = window.open(PF); // 클릭 핸들러 안에서 바로 열어야 팝업 차단에 안 걸린다
    if (!w) return false;
    const buffer = new TextEncoder().encode(JSON.stringify(trace)).buffer;
    let n = 0, iv = null;
    const done = () => { clearInterval(iv); window.removeEventListener('message', onMsg); };
    const onMsg = e => {
      if (e.origin !== PF || e.data !== 'PONG') return;
      done();
      w.postMessage({ perfetto: { buffer, title: 'GPU Sim 6장 · 시뮬레이터가 만든 trace', fileName: 'gpu-sim-ch06.json' } }, PF);
    };
    window.addEventListener('message', onMsg);
    iv = setInterval(() => { if (w.closed || ++n > 120) { done(); return; } w.postMessage('PING', PF); }, 250);
    return true;
  }

  root.addEventListener('click', e => {
    const a = e.target.closest('button')?.dataset.act;
    if (!a) return;
    if (a === 'perfetto') {
      const tr = buildTrace();
      S.cls = '';
      if (!tr) S.msg = '아직 보낼 게 없어요. 커널을 넣고 몇 가지 눌러 본 뒤에 열어 보세요.';
      else if (!openPerfetto(tr)) { S.msg = '브라우저가 새 탭을 막았어요. 이 사이트의 팝업을 허용하고 다시 눌러 주세요.'; S.cls = 'bad'; }
      else S.msg = 'ui.perfetto.dev 새 탭으로 지금까지의 판(' + S.t + '박자, 1박자 = 1ms로 놓음)을 보냈어요. trace는 이 브라우저 안에서만 오가요. Perfetto가 「이 출처를 믿나요」를 물으면 Yes를 눌러 주세요.';
      render();
      return;
    }
    if (a === 'reset') { init(); S.msg = ''; }
    else act(a);
    render();
  });
  init();
  render();
})();

/* ---------- 확인 퀴즈 ---------- */
(function quiz() {
  const root = document.getElementById('quiz');
  if (!root) return;
  const QS = [
    {
      q: 'GFX9 compute 링에서 GPU가 「job 42가 끝났다」를 CPU에 알리는 방법은?',
      a: ['RELEASE_MEM이 fence 칸에 42를 쓰고, 쓰기가 확인되면 인터럽트를 보냄', 'CU가 마지막 wave를 끝낼 때 CPU 레지스터에 직접 씀', 'CPU가 1ms마다 GPU에 물어봄'],
      r: 0,
      why: 'amdgpu가 링 끝에 쓴 RELEASE_MEM은 end-of-pipe 이벤트라 앞선 일이 끝나기를 기다렸다가 캐시를 처리하고 번호를 쓰고, INT_SEL(2)로 인터럽트를 보내요. 인터럽트 처리기가 amdgpu_fence_process를 불러요.',
    },
    {
      q: 'fence 칸에 42가 적혀 있고 amdgpu가 지난번에 본 번호(last_seq)는 40이에요. 인터럽트 하나로 amdgpu_fence_process가 불리면?',
      a: ['fence 41만 신호하고, 42는 다음 인터럽트를 기다림', 'fence 41과 42를 둘 다 신호', '아무것도 신호하지 않음'],
      r: 1,
      why: '처리기는 인터럽트와 fence를 하나씩 짝짓지 않아요. 지금 적힌 번호를 읽고 last_seq 다음부터 그 번호까지를 다 신호해요. 번호가 「여기까지 끝났다」는 뜻이라 가능한 일이에요.',
    },
    {
      q: 'ANGLE에서 clFlush가 묶음을 제출하면(submitCommands) 그 안의 event는 어떤 상태가 되나요? 아직 완료 처리는 일어나지 않았다고 할 때.',
      a: ['CL_SUBMITTED — GPU가 받았다는 뜻', 'CL_RUNNING — vkQueueSubmit을 불렀다는 뜻', 'CL_COMPLETE — clFlush가 기다려 줌'],
      r: 1,
      why: 'ANGLE은 vkQueueSubmit 직후(submitCommands) event를 CL_RUNNING으로 바꿔요. GPU가 실제로 시작했는지는 보지 않아요. COMPLETE는 ANGLE-CL-CQD 스레드가 그 번호까지 끝난 걸 확인했을 때예요. 아주 짧은 커널이면 clFlush가 돌아올 즈음 벌써 COMPLETE일 수도 있어요.',
    },
    {
      q: '앱이 커널을 넣고 clFlush도 clFinish도 부르지 않은 채 clGetEventInfo만 반복해요. ANGLE에서는? (다른 명령이 제출을 일으키지 않는다고 할 때)',
      a: ['GPU가 끝나면 곧 CL_COMPLETE가 보임', '계속 CL_QUEUED — 제출도, 기다리는 스레드도 없음', '몇 번 물으면 ANGLE이 알아서 flush함'],
      r: 1,
      why: 'clGetEventInfo는 저장된 상태를 돌려줄 뿐 GPU에 묻지도 제출하지도 않아요. COMPLETE로 바꾸는 건 fence를 기다린 호스트 스레드뿐이에요.',
    },
    {
      q: '2026-11의 ANGLE에서 한 묶음으로 같이 제출된 k1·k2·k3의 CL_PROFILING_COMMAND_START·END는?',
      a: ['묶음의 상태를 바꾸는 처리 중에 event마다 따로 읽은 CPU 시각', '각 커널이 GPU에서 시작하고 끝난 시각', 'END만 GPU 시각이고 START는 CPU 시각'],
      r: 0,
      why: 'CLEventVk::setTimestamp는 상태가 바뀔 때마다 CPU 시계를 읽어요(GPU 타임스탬프 쿼리는 TODO). 한 묶음의 event는 같은 처리 안에서 차례로 RUNNING·COMPLETE가 되며 시각이 적혀요. 값이 가깝다는 보장도 없고(콜백·선점), 커널마다의 GPU 시간을 보여 주지 않아요.',
    },
  ];
  QS.forEach((item, qi) => {
    const box = el('div', 'quiz');
    box.appendChild(el('div', 'q', (qi + 1) + '. ' + item.q));
    const opts = el('div', 'opts');
    item.a.forEach((t, i) => {
      const b = el('button', null, t);
      b.addEventListener('click', () => {
        if (box.classList.contains('answered')) return;
        box.classList.add('answered');
        b.classList.add(i === item.r ? 'right' : 'wrong');
        opts.children[item.r].classList.add('right');
      });
      opts.appendChild(b);
    });
    box.appendChild(opts);
    box.appendChild(el('div', 'why', item.why));
    root.appendChild(box);
  });
})();
})();
