(() => {
'use strict';

const $ = (root, sel) => root.querySelector(sel);
// 숫자 뒤 조사: 끝자리 읽는 소리에 받침이 있으면 앞의 것 (0영 1일 3삼 6육 7칠 8팔)
const jo = (n, a, b) => n + ('013678'.includes(String(n).slice(-1)) ? a : b);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/* ---------- 시뮬레이터 1 · 같은 주소, 두 CU ---------- */
(function coh() {
  const root = document.getElementById('sim-coh');
  if (!root) return;
  const say = $(root, '.say'), logEl = $(root, '.log');
  const box = k => $(root, '[data-box="' + k + '"]');
  let s;

  // 정해 둔 장면: 옛값이 남는 곳을 차례로 보여 준다
  const SCENE = [
    ['read', 1, 'CU 1이 x를 읽어요. L1에도 L2에도 없어서 메모리까지 가고, 오는 길에 L2와 CU 1의 L1에 한 벌씩 남아요.'],
    ['write', 0, 'CU 0이 x에 새 값을 써요. 자기 L1과 L2는 새 값이 됐지만, CU 1의 L1은 이 일을 몰라요.'],
    ['read', 1, 'CU 1이 다시 읽어요. 자기 L1에 x가 있으니 L2까지 가지 않고 그 값을 써요. <b>옛값</b>이에요.'],
    ['inv', 1, 'CU 1이 자기 L1을 무효화해요. 이 무효화는 acquire 구현의 일부예요.'],
    ['read', 1, '이제 L1에 없으니 L2까지 가서 새 값을 받아요. GPU 안에서는 둘이 같은 값을 봐요.'],
    ['host', 0, '호스트가 메모리를 읽어요. 새 값은 아직 L2에만 있어서 호스트는 <b>옛값</b>을 봐요.'],
    ['wb', 0, 'L2의 새 값을 메모리로 내보내요(writeback). fence 패킷이 이 일을 같이 해요(4절).'],
    ['host', 0, '이제 호스트도 새 값을 봐요. 장면 끝이에요. 버튼으로 다른 순서도 해 보세요.'],
  ];

  function reset() {
    s = { mem: 0, l2: null, dirty: false, l1: [null, null], last: 0, host: null, step: 0, log: [] };
    render('주소 x의 값은 메모리에 0 하나뿐이에요. 「장면 한 걸음」을 눌러 보세요.');
  }
  const log = t => s.log.unshift(t);

  const ops = {
    read(c) {
      let how;
      if (s.l1[c] != null) how = 'L1 적중';
      else {
        if (s.l2 == null) { s.l2 = s.mem; s.dirty = false; how = 'L1·L2 없음 → 메모리'; }
        else how = 'L1 없음 → L2';
        s.l1[c] = s.l2;
      }
      const v = s.l1[c], stale = v !== s.last;
      log('CU ' + c + ' 읽기 = ' + v + ' (' + how + ')' + (stale ? '  ← 옛값' : ''));
      return 'CU ' + jo(c, '이', '가') + ' 읽은 값 <b>' + v + '</b> (' + how + ')' + (stale ? ' — 가장 최근에 쓴 값은 ' + jo(s.last, '이라', '라') + ' <b>옛값</b>이에요.' : '.');
    },
    write(c) {
      const v = ++s.last;
      s.l1[c] = v; s.l2 = v; s.dirty = true;
      log('CU ' + c + ' 쓰기 x = ' + v);
      const other = s.l1[1 - c];
      return 'CU ' + jo(c, '이', '가') + ' x = <b>' + v + '</b>' + (('013678'.includes(String(v).slice(-1))) ? '을' : '를') + ' 써요. 자기 L1과 L2가 새 값이 돼요.' +
        (other != null && other !== v ? ' CU ' + (1 - c) + '의 L1엔 여전히 ' + jo(other, '이', '가') + ' 있어요.' : '');
    },
    inv(c) {
      const had = s.l1[c];
      s.l1[c] = null;
      log('CU ' + c + ' L1 무효화');
      return 'CU ' + c + '의 L1을 비웠어요' + (had != null ? '(' + had + ' 버림)' : '(원래 비어 있었어요)') + '. 다음 읽기는 L2까지 가요.';
    },
    wb() {
      if (s.l2 == null || !s.dirty) { log('L2 내보내기 — 보낼 것 없음'); return 'L2에 메모리와 다른 값이 없어서 내보낼 게 없어요.'; }
      s.mem = s.l2; s.dirty = false;
      log('L2 → 메모리 내보내기 (x = ' + s.mem + ')');
      return 'L2의 x = <b>' + s.mem + '</b>' + ('013678'.includes(String(s.mem).slice(-1)) ? '을' : '를') + ' 메모리로 내보냈어요. 이제 GPU 밖에서도 이 값을 봐요.';
    },
    host() {
      s.host = s.mem;
      const stale = s.mem !== s.last;
      log('호스트 읽기 = ' + s.mem + (stale ? '  ← 옛값' : ''));
      return '호스트가 메모리에서 읽은 값 <b>' + s.mem + '</b>' + (stale ? ' — 새 값 ' + jo(s.last, '은', '는') + ' 아직 L2에만 있어서 <b>옛값</b>이에요.' : '.');
    },
  };

  function paint(k, v, state, label) {
    const b = box(k);
    b.className = 'cbox' + (b.classList.contains('wide') ? ' wide' : '') + (b.classList.contains('host') ? ' host' : '') + (state ? ' ' + state : '');
    $(b, '.cval').textContent = v == null ? '—' : 'x = ' + v;
    $(b, '.cstate').textContent = label;
  }

  function render(msg) {
    [0, 1].forEach(c => {
      const v = s.l1[c];
      paint('l1-' + c, v, v == null ? 'empty' : v === s.last ? 'fresh' : 'stale', v == null ? '비어 있음' : v === s.last ? '최신' : '옛값');
    });
    paint('l2', s.l2, s.l2 == null ? 'empty' : s.l2 !== s.last ? 'stale' : s.dirty ? 'dirty' : 'fresh',
      s.l2 == null ? '비어 있음' : s.l2 !== s.last ? '옛값' : s.dirty ? '최신 · 메모리엔 아직' : '최신 · 메모리와 같음');
    paint('mem', s.mem, s.mem === s.last ? 'fresh' : 'stale', s.mem === s.last ? '최신' : '옛값');
    paint('host', s.host, s.host == null ? 'empty' : s.host === s.last ? 'fresh' : 'stale',
      s.host == null ? '아직 안 읽음' : s.host === s.last ? '마지막으로 읽은 값 · 최신' : '마지막으로 읽은 값 · 옛값');
    const stepBtn = $(root, '[data-act="step"]');
    stepBtn.textContent = s.step < SCENE.length ? '장면 한 걸음 (' + (s.step + 1) + '/' + SCENE.length + ')' : '장면 끝 · 처음부터';
    say.innerHTML = msg;
    logEl.textContent = s.log.join('\n');
  }

  root.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const a = b.dataset.act, c = +(b.dataset.c || 0);
    if (a === 'reset') return reset();
    if (a === 'step') {
      if (s.step >= SCENE.length) return reset();
      const [op, cc, text] = SCENE[s.step++];
      const res = ops[op](cc);
      return render(text + '<br>' + res);
    }
    if (ops[a]) render(ops[a](c));
  });
  reset();
})();

/* ---------- 시뮬레이터 2 · 깃발 신호 ---------- */
(function flag() {
  const root = document.getElementById('sim-flag');
  if (!root) return;
  const say = $(root, '.say'), logEl = $(root, '.log');
  const pList = $(root, '[data-who="p"] ol'), cList = $(root, '[data-who="c"] ol');
  const mFly = $(root, '[data-m="fly"]'), mL2 = $(root, '[data-m="l2"]'), mL1 = $(root, '[data-m="l1"]');
  const on = k => $(root, '[data-k="' + k + '"]').checked;
  const LAT = { data: 5, flag: 1 }; // L2 채널마다 다른 박자 (지어낸 값)
  const HANG = 10; // 깃발이 L2에 닿은 뒤 이만큼 더 돌면 「멈췄다」로 본다
  let s, timer = null;

  const P = [
    { op: 'st', a: 'data', v: 42, t: 'global_store_dword v[data], 42' },
    { op: 'wait', t: 's_waitcnt vmcnt(0)', note: 'release', k: 'rel' },
    { op: 'st', a: 'flag', v: 1, t: 'global_store_dword v[flag], 1' },
    { op: 'end', t: 's_endpgm' },
  ];
  const C = [
    { op: 'spin', t: 'loop: global_load_dword v1, v[flag]', glc: true, note: 's_waitcnt vmcnt(0) 뒤 0이면 loop로' },
    { op: 'inv', t: 'buffer_wbinvl1_vol', note: 'acquire', k: 'acq' },
    { op: 'ld', t: 'global_load_dword v2, v[data]' },
    { op: 'end', t: 's_endpgm' },
  ];

  function reset() {
    stop();
    s = {
      t: 0, pc: 0, cc: 0, fly: [],
      l2: { data: 0, flag: 0 }, l1: { data: 0, flag: null },
      spins: 0, flagLandAt: null, result: null, done: false, log: [],
      rel: on('rel'), glc: on('glc'), acq: on('acq'),
    };
    // 꺼진 줄은 건너뛴다
    skip();
    render('출발점: L2엔 data = 0, flag = 0. 소비자의 L1엔 <b>예전에 읽어 둔 data = 0</b>이 남아 있어요. 「흘려 보기」를 눌러 보세요.');
  }
  function skip() {
    while (P[s.pc] && P[s.pc].k && !s[P[s.pc].k]) s.pc++;
    while (C[s.cc] && C[s.cc].k && !s[C[s.cc].k]) s.cc++;
  }
  const log = t => s.log.unshift('t' + s.t + '  ' + t);

  function tick() {
    if (s.done) return;
    s.t++;
    const notes = [];
    // 1) 오던 쓰기가 L2에 닿음
    s.fly = s.fly.filter(w => {
      if (w.at > s.t) return true;
      s.l2[w.a] = w.v;
      if (w.a === 'flag') s.flagLandAt = s.t;
      log('L2 도착: ' + w.a + ' = ' + w.v);
      notes.push(w.a + ' = ' + jo(w.v, '이', '가') + ' L2에 닿았어요');
      return false;
    });
    // 2) 생산자 한 줄
    const p = P[s.pc];
    if (p && p.op === 'st') {
      s.fly.push({ a: p.a, v: p.v, at: s.t + LAT[p.a] });
      log('생산자: ' + p.a + ' = ' + p.v + ' 보냄 (' + LAT[p.a] + '박자 뒤 L2)');
      s.pc++;
    } else if (p && p.op === 'wait') {
      if (s.fly.length) { log('생산자: 앞의 쓰기가 끝나기를 기다림'); s.pstall = true; }
      else { log('생산자: 앞의 쓰기 다 끝남 → 다음 줄'); s.pc++; s.pstall = false; }
    }
    // 3) 소비자 한 줄
    const c = C[s.cc];
    if (c && c.op === 'spin') {
      let v, how;
      if (s.glc) { v = s.l2.flag; how = 'L2에서 (glc)'; }
      else if (s.l1.flag != null) { v = s.l1.flag; how = 'L1 적중'; }
      else { s.l1.flag = s.l2.flag; v = s.l1.flag; how = 'L1 없음 → L2, L1에 남김'; }
      log('소비자: flag 읽기 = ' + v + ' (' + how + ')');
      if (v) s.cc++;
      else {
        s.spins++;
        if (s.flagLandAt != null && s.t - s.flagLandAt >= HANG) {
          s.done = true; s.result = 'hang';
        }
      }
    } else if (c && c.op === 'inv') {
      s.l1 = { data: null, flag: null };
      log('소비자: L1 무효화');
      s.cc++;
    } else if (c && c.op === 'ld') {
      let how;
      if (s.l1.data != null) how = 'L1 적중';
      else { s.l1.data = s.l2.data; how = 'L1 없음 → L2'; }
      s.result = s.l1.data;
      log('소비자: data 읽기 = ' + s.result + ' (' + how + ')');
      s.cc++;
      s.readHow = how;
      s.done = true;
    }
    skip();
    if (s.done) { stop(); return render(verdict()); }
    render((notes.length ? notes.join(' · ') + '. ' : '') + status());
  }

  function status() {
    if (C[s.cc] && C[s.cc].op === 'spin') return '소비자는 flag가 1이 되길 돌며 기다려요(' + s.spins + '번째).' + (s.pstall ? ' 생산자는 data가 L2에 닿기를 기다려요.' : '');
    if (C[s.cc] && C[s.cc].op === 'inv') return '소비자가 flag = 1을 봤어요. 다음은 L1 무효화예요.';
    return '소비자가 flag = 1을 봤어요. 이제 data를 읽어요.';
  }

  function verdict() {
    if (s.result === 'hang') {
      return '<b>멈췄어요.</b> flag는 t' + s.flagLandAt + '에 L2에서 1이 됐는데, 소비자는 L1에 남은 0만 ' + s.spins + '번 읽었어요. glc를 켜면 깃발 읽기가 L1을 건너뛰어요.';
    }
    if (s.result === 42) {
      return '<b>42</b>를 읽었어요(t' + s.t + '). 기다리기 덕에 flag는 data 뒤에 L2에 닿았고, 무효화 덕에 data를 L2에서 새로 받았어요. 이제 스위치 하나를 꺼 보세요.';
    }
    if (s.readHow === 'L1 적중') {
      return '<b>0</b>을 읽었어요. 틀렸어요. flag는 제대로 봤지만 data를 L1의 옛값에서 꺼냈어요. 무효화(acquire)가 빠졌어요.' +
        (s.rel ? '' : ' 기다리기(release)도 빠져서, 무효화를 켜도 아직 오는 중인 data를 L2에서 읽었을 거예요.');
    }
    return '<b>0</b>을 읽었어요. 틀렸어요. flag가 data보다 먼저 L2에 닿았고, 소비자가 읽은 순간 42는 아직 오는 중이었어요. 기다리기(release)가 빠졌어요.';
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }

  function lines(list, prog, pc, who) {
    list.textContent = '';
    prog.forEach((ln, i) => {
      const off = ln.k && !s[ln.k];
      let text = ln.t;
      if (ln.op === 'spin') text += s.glc ? ' glc' : '';
      const li = el('li', (off ? 'off' : '') + (i === pc && !s.done ? ' cur' : '') + (i < pc ? ' past' : ''));
      li.appendChild(el('code', null, off ? '— (꺼짐) ' + ln.t : text));
      if (ln.note && !off) li.appendChild(el('span', 'tag', ln.note));
      if (who === 'p' && i === pc && ln.op === 'wait' && s.pstall) li.appendChild(el('span', 'tag warn', '기다리는 중'));
      list.appendChild(li);
    });
  }

  function cell(name, v, cls) {
    const d = el('div', 'memcell' + (cls ? ' ' + cls : ''));
    d.textContent = name + ' = ' + (v == null ? '—' : v);
    return d;
  }

  function render(msg) {
    lines(pList, P, s.pc, 'p');
    lines(cList, C, s.cc, 'c');
    mFly.textContent = '';
    if (!s.fly.length) mFly.appendChild(el('span', 'muted', '없음'));
    s.fly.forEach(w => mFly.appendChild(cell(w.a, w.v + ' · ' + (w.at - s.t) + '박자 남음', 'fly')));
    mL2.textContent = '';
    mL2.appendChild(cell('data', s.l2.data, s.l2.data === 42 ? 'hit' : ''));
    mL2.appendChild(cell('flag', s.l2.flag, s.l2.flag ? 'hit' : ''));
    mL1.textContent = '';
    mL1.appendChild(cell('data', s.l1.data, s.l1.data === 0 ? 'old' : s.l1.data === 42 ? 'hit' : ''));
    mL1.appendChild(cell('flag', s.l1.flag, s.l1.flag === 0 && !s.glc ? 'old' : ''));
    say.innerHTML = msg;
    say.classList.toggle('bad', s.done && s.result !== 42);
    say.classList.toggle('good', s.done && s.result === 42);
    logEl.textContent = s.log.join('\n');
  }

  const act = {
    play() { if (timer) return stop(); if (s.done) reset(); tick(); timer = setInterval(tick, 520); },
    tick() { stop(); if (s.done) reset(); else tick(); },
    reset,
  };
  root.addEventListener('click', e => {
    const a = e.target.closest('button')?.dataset.act;
    if (a && act[a]) act[a]();
  });
  root.addEventListener('change', reset);
  reset();
})();

/* ---------- 확인 퀴즈 ---------- */
(function quiz() {
  const root = document.getElementById('quiz');
  if (!root) return;
  const QS = [
    {
      q: 'GFX9의 벡터 메모리 접근에서, CU 0과 CU 1에 앉은 두 workgroup이 같은 주소를 볼 때 둘이 처음 함께 쓰는 캐시 층은?',
      a: ['vector L1', 'L2', '메모리까지 가야 한다'],
      r: 1,
      why: 'GFX9의 vector L1은 CU마다 하나라서, 서로 다른 CU는 L2에서 처음 만나요(RDNA라면 같은 shader array의 CU끼리는 GL1에서 먼저 만나요).',
    },
    {
      q: 'CU 0이 x를 쓰고 s_waitcnt vmcnt(0)로 쓰기가 끝나기를 기다렸어요. CU 1은 예전에 x를 읽어 L1에 갖고 있어요. CU 1이 지금 x를 읽으면?',
      a: ['새 값 — CU 0이 기다렸으니까', '옛값일 수 있다 — CU 1의 L1에 옛값이 남아 있을 수 있다', '항상 오류가 난다'],
      r: 1,
      why: '쓰는 쪽의 기다리기는 자기 쓰기가 L2에 닿게 할 뿐, 남의 L1을 건드리지 못해요. 보통의 캐시 읽기라면 옛값을 받을 수 있어서, 읽는 쪽이 buffer_wbinvl1_vol로 무효화하거나 glc로 L1을 건너뛰어 읽어요.',
    },
    {
      q: '시뮬레이터 2에서 생산자의 s_waitcnt vmcnt(0)만 껐어요. 무엇이 잘못되나요?',
      a: ['flag가 data보다 먼저 L2에 닿아, 소비자가 아직 오지 않은 data를 읽는다', '소비자가 영원히 돈다', '아무 문제 없다'],
      r: 0,
      why: '이 모델에선 L2 채널이 달라 두 쓰기가 다른 CU에게 뒤바뀐 순서로 보여요. 실제 하드웨어에서 늘 이렇게 되는 건 아니지만, 그럴 수 있어서 release가 기다리기 한 줄로 「앞의 쓰기가 다 끝난 뒤에 깃발을 올린다」를 지켜요.',
    },
    {
      q: '이 장의 GFX9 모델에서 dispatch A가 버퍼에 쓰고 dispatch B가 읽어요. B 쪽 CU의 벡터 L1에 A 이전의 값이 남아 있다면, 그 옛값을 치우는 동작은?',
      a: ['B 쪽 CU의 벡터 L1(L0) 무효화', 'CPU 캐시 비우기', '아무것도 — 같은 GPU니까'],
      r: 0,
      why: 'CU끼리는 L2를 같이 쓰니, B가 L1의 옛값을 피하면 돼요. 드라이버는 이런 경우 CS_PARTIAL_FLUSH로 A를 기다리고 ACQUIRE_MEM으로 L1을 무효화해요. Vulkan이 약속하는 건 의존성이고, 실제 패킷과 대상 캐시는 세대·접근 종류·드라이버마다 달라요.',
    },
    {
      q: 'amdgpu가 GFX9 링에 쓰는 fence의 RELEASE_MEM 패킷이 숫자를 쓰는 것 말고 함께 요청하는 일은?',
      a: ['L2를 메모리로 내보내기(TC_WB_ACTION)', 'CPU의 캐시를 무효화하기', '다음 dispatch를 시작하기'],
      r: 0,
      why: 'gfx_v9_0_ring_emit_fence가 RELEASE_MEM에 TC_WB_ACTION 비트를 같이 실어요. 다만 이건 구현의 모습이고, Vulkan 앱이 호스트에서 결과를 읽으려면 device 쓰기 → HOST_READ 의존성, 완료 대기, non-coherent 매핑이면 vkInvalidateMappedMemoryRanges까지 따로 챙겨야 해요.',
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
