(() => {
'use strict';

const $ = (root, sel) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const chip = (text, state) => el('span', 'chip' + (state ? ' ' + state : ''), text);
// workgroup마다 색: 번호로 색상만 돌리고 밝기는 CSS 변수로 테마에 맞춘다
const hue = id => (id * 47) % 360;

/* ---------- 시뮬레이터 1 · workgroup이 CU에 깔리기까지 ---------- */
(function spread() {
  const root = document.getElementById('sim-spread');
  if (!root) return;
  const GPUS = { toy: { se: 2, cu: 2 }, big: { se: 4, cu: 16 } };
  const BASE = 4; // workgroup 하나가 도는 박자
  const ses = $(root, '.ses'), bars = $(root, '.util-bars'), say = $(root, '.say'), logEl = $(root, '.log');
  const v = k => $(root, '[data-k="' + k + '"]');
  let s, timer = null;

  // 걸리는 시간: 다르게 켜면 번호로 정해지는 3~7박자(다시 돌려도 같은 값)
  const dur = id => v('vary').checked ? 3 + ((id * 2654435761) >>> 0) % 5 : BASE;

  function reset() {
    stop();
    const g = GPUS[v('gpu').value], k = +v('k').value, n = +v('n').value;
    const half = v('mask').value === 'half';
    const cus = [];
    for (let e = 0; e < g.se; e++)
      for (let c = 0; c < g.cu; c++)
        cus.push({ se: e, c, on: !half || c < Math.ceil(g.cu / 2), slots: Array(k).fill(null) });
    s = { g, k, n, cus, next: 0, rr: 0, t: 0, running: [], done: 0, order: [], util: [], log: [] };
    const on = cus.filter(c => c.on).length;
    const rounds = Math.ceil(n / (on * k));
    s.rounds = rounds;
    render('workgroup <b>' + n + '</b>개, 켜진 CU <b>' + on + '</b>개 × CU당 <b>' + k + '</b>개 = 한 판에 <b>' + on * k + '</b>자리. 같은 시간이면 <b>' + rounds + '판</b>이 걸릴 거예요. 「흘려 보기」를 눌러 보세요.');
  }
  const log = t => s.log.unshift('t' + s.t + '  ' + t);

  // 디스패처: SE를 차례로 돌며, 그 SE에서 빈자리가 가장 많은 켜진 CU에 하나씩
  function place() {
    let placed = 0, tries = 0;
    while (s.next < s.n && tries < s.g.se) {
      const e = s.rr % s.g.se;
      const cand = s.cus.filter(c => c.se === e && c.on && c.slots.includes(null));
      if (!cand.length) { s.rr++; tries++; continue; }
      cand.sort((a, b) => b.slots.filter(x => x === null).length - a.slots.filter(x => x === null).length);
      const cu = cand[0], i = cu.slots.indexOf(null), id = s.next++;
      const w = { id, left: dur(id), cu, i };
      cu.slots[i] = w; s.running.push(w);
      s.rr++; tries = 0; placed++;
    }
    return placed;
  }

  function tick() {
    if (s.done >= s.n) return;
    s.t++;
    // 돌던 것 한 박자 진행, 끝난 자리는 비움
    const fin = [];
    s.running.forEach(w => { if (--w.left <= 0) fin.push(w); });
    fin.forEach(w => { w.cu.slots[w.i] = null; s.done++; s.order.push(w.id); });
    s.running = s.running.filter(w => w.left > 0);
    if (fin.length) log('끝남 wg ' + fin.map(w => w.id).join(', '));
    const p = place();
    if (p) log('디스패처가 ' + p + '개 깔음 (다음 번호 ' + s.next + ')');
    const total = s.cus.filter(c => c.on).length * s.k;
    if (s.done < s.n) s.util.push(s.running.length / total);
    if (s.done >= s.n) {
      stop();
      const avg = s.util.reduce((a, b) => a + b, 0) / s.util.length;
      const last = s.util[s.util.length - 1];
      log('모두 끝남');
      return render('<b>' + (s.t - 1) + '박자</b>에 모두 끝났어요. 평균 사용률 <b>' + Math.round(avg * 100) + '%</b>, 마지막 박자엔 <b>' + Math.round(last * 100) + '%</b>만 일했어요.' +
        (avg < 0.85 ? ' 놀던 자리가 꼬리예요. workgroup 수를 자리 수(' + total + ')의 배수 근처로 바꿔 보세요.' : ' 자리를 거의 꽉 채웠어요.') +
        ' 끝난 순서 앞 열: ' + s.order.slice(0, 10).join(', ') + '…');
    }
    render(s.t === 1 ? '처음 박자에 디스패처가 자리 수만큼 한꺼번에 깔았어요. 남은 workgroup은 <b>자리가 날 때까지</b> 기다려요.' :
      '돌고 있는 workgroup ' + s.running.length + ' · 기다리는 ' + (s.n - s.next) + ' · 끝난 ' + s.done);
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }

  function render(msg) {
    ses.textContent = '';
    ses.classList.toggle('many', s.g.cu > 4);
    for (let e = 0; e < s.g.se; e++) {
      const box = el('div', 'se');
      box.appendChild(el('div', 'se-name', 'SE ' + e));
      const grid = el('div', 'cugrid');
      s.cus.filter(c => c.se === e).forEach(c => {
        const cu = el('div', 'cu3' + (c.on ? '' : ' off'));
        cu.title = 'SE' + e + ' CU' + c.c + (c.on ? '' : ' (이 큐에서 사용 제외)');
        c.slots.forEach(w => {
          const sl = el('div', 'wg' + (w ? ' on' : ''));
          if (w) { sl.style.setProperty('--h', hue(w.id)); sl.title = 'workgroup ' + w.id; if (s.g.cu <= 4) sl.textContent = w.id; }
          cu.appendChild(sl);
        });
        grid.appendChild(cu);
      });
      box.appendChild(grid);
      ses.appendChild(box);
    }
    const q = el('div', 'waitq');
    q.appendChild(el('span', 'muted', '기다리는 workgroup ' + (s.n - s.next) + '개 · 끝난 ' + s.done + '/' + s.n));
    ses.appendChild(q);
    bars.textContent = '';
    s.util.forEach((u, i) => {
      const b = el('i', u < 0.5 ? 'low' : '');
      b.style.height = Math.max(4, u * 100) + '%';
      b.title = 't' + (i + 1) + ' ' + Math.round(u * 100) + '%';
      bars.appendChild(b);
    });
    say.innerHTML = msg;
    logEl.textContent = s.log.join('\n');
  }

  const act = {
    play() { if (timer) return stop(); if (s.done >= s.n) reset(); tick(); timer = setInterval(tick, s.g.cu > 4 ? 260 : 450); },
    tick() { stop(); tick(); },
    reset,
  };
  root.addEventListener('click', e => {
    const a = e.target.closest('button')?.dataset.act;
    if (a && act[a]) act[a]();
  });
  root.addEventListener('change', reset);
  reset();
})();

/* ---------- 시뮬레이터 2 · wave가 깨어날 때의 레지스터 ---------- */
(function wake() {
  const root = document.getElementById('sim-wake');
  if (!root) return;
  const pkt = $(root, '.pkt'), pick = $(root, '.wavepick'), regs = $(root, '.regs'), grid = $(root, '.vgrid'), say = $(root, '.say');
  const v = k => +$(root, '[data-k="' + k + '"]').value;
  const ARG = 0x7f00a000; // 예시 인자 주소
  const hex = (x, n) => '0x' + (x >>> 0).toString(16).padStart(n || 8, '0');
  let wv = 0, lane = null;

  function render() {
    const lws = v('lws'), ws = v('ws'), wg = v('wg');
    const nw = lws / ws;
    if (wv >= nw) wv = 0;
    pkt.textContent = '';
    [['DISPATCH_DIRECT', 'x = 8 (workgroup 8개)'], ['COMPUTE_NUM_THREAD_X', String(lws)], ['RSRC2.USER_SGPR', '2'], ['RSRC2.TGID_X_EN', '1'], ['RSRC2.TIDIG_COMP_CNT', '0 (x만)']]
      .forEach(([k, x]) => pkt.appendChild(chip(k + ' = ' + x)));

    pick.textContent = '';
    pick.appendChild(el('span', 'muted', 'workgroup ' + wg + '의 wave ' + nw + '개: '));
    for (let i = 0; i < nw; i++) {
      const b = el('button', i === wv ? 'primary' : '', 'wave ' + i);
      b.dataset.wave = i;
      pick.appendChild(b);
    }

    regs.textContent = '';
    const t = el('table', 'tbl regtbl');
    t.innerHTML = '<thead><tr><th>레지스터</th><th>값</th><th>누가 넣었나</th></tr></thead>';
    const tb = el('tbody');
    [['s0', hex(ARG), 'CP가 COMPUTE_USER_DATA_0을 복사 (인자 주소 아래 32비트, 예시)'],
     ['s1', hex(0, 8), 'CP가 COMPUTE_USER_DATA_1을 복사 (인자 주소 위 32비트, 예시)'],
     ['s2', String(wg), 'ADC가 넣은 workgroup 번호 x (TGID_X_EN)'],
     ['v0', '레인마다 다름 ↓', 'SPI가 넣은 local id x']].forEach(r => {
      const tr = el('tr');
      r.forEach((c, i) => { const td = el('td', i < 2 ? 'mono' : '', c); tr.appendChild(td); });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    regs.appendChild(t);

    grid.textContent = '';
    grid.style.setProperty('--cols', ws === 64 ? 16 : 8);
    for (let l = 0; l < ws; l++) {
      const lid = wv * ws + l;
      const c = el('button', 'lanecell' + (l === lane ? ' sel' : ''), String(lid));
      c.dataset.lane = l;
      c.title = '레인 ' + l + ' · v0 = ' + lid;
      grid.appendChild(c);
    }

    if (lane == null || lane >= ws) {
      lane = null;
      say.innerHTML = '지금 보는 것: workgroup <b>' + wg + '</b> · wave <b>' + wv + '</b>. 같은 workgroup의 wave는 <b>s2가 모두 ' + wg + '</b>이고, v0만 ' + (wv * ws) + '부터 ' + (wv * ws + ws - 1) + '까지예요. 레인 하나를 눌러 보세요.';
    } else {
      const lid = wv * ws + lane, gid = wg * lws + lid;
      say.innerHTML = '레인 ' + lane + ': <code>get_global_id(0)</code> = s2 × local size + v0 = ' + wg + ' × ' + lws + ' + ' + lid + ' = <b>' + gid + '</b>. 기계어로는 <code>s_mul_i32 s3, s2, ' + lws + '</code> 다음 <code>v_add_nc_u32 v1, s3, v0</code> 로 할 수 있어요(RDNA 이름, 32비트 예시 — 컴파일러는 shift 등을 고를 수도 있어요). 원소가 4바이트라면 이 레인이 읽을 주소는 인자에서 꺼낸 버퍼 주소 + ' + gid + ' × 4예요.';
    }
  }

  root.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.wave != null) { wv = +b.dataset.wave; lane = null; }
    else if (b.dataset.lane != null) lane = +b.dataset.lane;
    render();
  });
  root.addEventListener('change', () => { wv = 0; lane = null; render(); });
  render();
})();

/* ---------- 확인 퀴즈 ---------- */
(function quiz() {
  const root = document.getElementById('quiz');
  if (!root) return;
  const QS = [
    {
      q: 'vkCmdDispatch(100, 1, 1)의 100은 디스패처에게 무슨 뜻일까요?',
      a: ['work-item 100개', 'workgroup 100개', 'wave 100개'],
      r: 1,
      why: 'groupCount는 workgroup 수예요. workgroup의 축마다 크기는 셰이더의 local size 설정으로 따로 정해지고, radv가 COMPUTE_NUM_THREAD_X/Y/Z에 적어요.',
    },
    {
      q: '시뮬레이터 1의 고정 시간 모델에서, CU 64개·CU당 한 자리인 GPU에 workgroup 65개를 보냈어요. 걸리는 시간은 64개일 때의 약 몇 배일까요?',
      a: ['약 1.02배', '약 2배', '약 65배'],
      r: 1,
      why: '65번째 하나 때문에 한 판이 더 필요해요. 두 번째 판엔 CU 하나만 일하는 꼬리가 생겨요. 실제 GPU에서 꼭 두 배가 되는 건 아니에요.',
    },
    {
      q: '켜진 CU 64개에 workgroup 128개를 보내요. 커널의 VGPR 사용을 줄여 CU당 동시 workgroup이 1에서 2로 늘었어요. 시뮬레이터 1의 판 수는?',
      a: ['그대로 2판', '2판에서 1판', '2판에서 4판'],
      r: 1,
      why: '⌈128 ÷ 64⌉ = 2판이 ⌈128 ÷ 128⌉ = 1판이 돼요. 올림 때문에 늘 절반이 되진 않아요(workgroup 8개면 둘 다 1판). 실제로는 한 CU에 같이 앉은 workgroup끼리 ALU와 메모리를 나눠 써서 판 하나가 길어질 수 있어요.',
    },
    {
      q: '같은 workgroup의 wave 넷이 깨어났어요. 넷이 서로 다른 값을 받는 레지스터는?',
      a: ['workgroup 번호 SGPR', 'user SGPR(드라이버가 준 값)', 'v0(local id)'],
      r: 2,
      why: '이 예시에서 보여 준 세 종류 중에선 v0만 wave마다, 레인마다 달라요. 보여 주지 않은 SGPR 중엔 wave마다 다른 것(scratch offset 등)도 있어요.',
    },
    {
      q: 'workgroup 7이 workgroup 3이 쓴 플래그를 돌며 기다리는 커널이에요. 무엇이 문제일까요?',
      a: ['아무 문제 없다 — 번호 순서대로 실행된다', 'workgroup 사이의 순서·동시 실행은 보장되지 않아 멈출 수 있다', 'barrier()를 넣으면 해결된다'],
      r: 1,
      why: '자리가 모자라면 3이 7보다 늦게 앉을 수 있어요. 플래그를 atomic으로 써도 진행은 보장되지 않고, barrier()는 같은 workgroup 안에서만 기다려요. 순서가 필요하면 dispatch를 나누고 API에서 의존성을 걸어요.',
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
