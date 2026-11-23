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
const up = (n, g) => Math.ceil(n / g) * g;

// GFX9 wave64 (Mesa ac_gpu_info.c)
const VGPR_FILE = 256, VGPR_GRAN = 4, MAX_WAVES = 10, SIMDS = 4, LDS_CU = 65536;
const wavesByVgpr = alloc => Math.min(MAX_WAVES, Math.floor(VGPR_FILE / alloc));

function kvTable(rows) {
  const t = el('table', 'tbl kvt');
  const tb = el('tbody');
  rows.forEach(([k, v, cls]) => {
    const tr = el('tr', cls || '');
    tr.appendChild(el('th', null, k));
    const td = el('td');
    td.innerHTML = v;
    tr.appendChild(td);
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  return t;
}

/* ---------- 시뮬레이터 1 · 살아 있는 값 세기 ---------- */
(function live() {
  const root = document.getElementById('sim-live');
  if (!root) return;
  const list = $(root, '.livelist'), kv = $(root, '.kv'), say = $(root, '.say');
  const N = 8, LAT = 30; // 읽기 30박자 뒤 도착 (지어낸 값)
  const W = { i: 1, a: 2, acc: 4, r: 1, o: 2 };
  for (let k = 0; k < N; k++) W['x' + k] = 4;

  // 미리 띄울 읽기 d개로 명령 순서를 만든다
  function program(d) {
    const P = [];
    P.push({ t: 's_load_dwordx4 ×8  w[0..7]', note: 'SGPR', def: [], use: [] });
    P.push({ t: 'v_i ← 그룹 번호 × 크기 + v0', def: ['i'], use: [] });
    P.push({ t: 'v_a ← x + i × 128', def: ['a'], use: ['i'] });
    const ld = k => P.push({ t: 'global_load_dwordx4 v_x' + k + ', v_a + ' + (16 * k), def: ['x' + k], use: ['a'], load: k });
    for (let k = 0; k < Math.min(d, N); k++) ld(k);
    for (let k = 0; k < N; k++) {
      P.push({ t: 's_waitcnt  (x' + k + ' 도착까지)', def: [], use: [], wait: k });
      P.push(k === 0
        ? { t: 'v_mul acc ← x0 × w0', def: ['acc'], use: ['x0'] }
        : { t: 'v_fma acc ← x' + k + ' × w' + k + ' + acc', def: [], use: ['x' + k, 'acc'] });
      if (k + d < N) ld(k + d);
    }
    P.push({ t: 'v_add r ← acc.x + acc.y + acc.z + acc.w', def: ['r'], use: ['acc'] });
    P.push({ t: 'v_o ← out + i × 4', def: ['o'], use: ['i'] });
    P.push({ t: 'global_store_dword v_o, v_r', def: [], use: ['o', 'r'] });
    P.push({ t: 's_endpgm', def: [], use: [] });
    return P;
  }

  function analyze(d) {
    const P = program(d);
    const def = {}, last = {};
    P.forEach((ln, L) => {
      ln.def.forEach(v => { if (def[v] == null) def[v] = L; });
      ln.use.forEach(v => { last[v] = L; });
    });
    // 줄이 끝난 뒤에도 쓰일 값만 센다
    P.forEach((ln, L) => {
      ln.live = Object.keys(def).filter(v => def[v] <= L && last[v] > L);
      ln.n = ln.live.reduce((s, v) => s + W[v], 0);
    });
    const peak = Math.max(...P.map(l => l.n));
    // 한 wave 혼자 돌 때의 박자
    let t = 0, stall = 0;
    const arrive = {};
    P.forEach(ln => {
      if (ln.wait != null) { const s = Math.max(0, arrive[ln.wait] - t); stall += s; t += s; ln.stall = s; return; }
      t += 1;
      if (ln.load != null) arrive[ln.load] = t + LAT;
    });
    return { P, peak, t, stall };
  }

  function render() {
    const d = +$(root, '[data-k="d"]').value, base = +$(root, '[data-k="base"]').value;
    const A = analyze(d);
    list.textContent = '';
    const MAXBAR = 36;
    let peakShown = false;
    A.P.forEach(ln => {
      const li = el('li', ln.wait != null ? 'wait' : '');
      const isPeak = ln.n === A.peak && !peakShown;
      if (isPeak) { li.classList.add('peak'); peakShown = true; }
      const c = el('code', null, ln.t);
      li.appendChild(c);
      if (ln.note) li.appendChild(el('span', 'tag', ln.note));
      if (ln.stall) li.appendChild(el('span', 'tag warn', ln.stall + '박자 기다림'));
      const bar = el('span', 'lbar');
      const fill = el('i');
      fill.style.width = Math.min(100, ln.n / MAXBAR * 100) + '%';
      bar.appendChild(fill);
      li.appendChild(bar);
      li.appendChild(el('span', 'lnum', ln.n ? String(ln.n) : ''));
      li.title = ln.live.length ? '붙잡은 값: ' + ln.live.join(', ') : '붙잡은 값 없음';
      list.appendChild(li);
    });

    // 네 가지 d를 한 표로 견준다
    const rows = [1, 2, 4, 8].map(dd => {
      const a = dd === d ? A : analyze(dd);
      const total = a.peak + base, alloc = up(total, VGPR_GRAN);
      return { dd, peak: a.peak, total, alloc, w: wavesByVgpr(alloc), t: a.t, stall: a.stall };
    });
    const cur = rows.find(r => r.dd === d);
    kv.textContent = '';
    const t = el('table', 'tbl cmp');
    t.innerHTML = '<thead><tr><th>미리 띄울 읽기</th><th>VGPR 최대 압박 (이 부분 + 다른 값)</th><th>할당 (4칸 단위)</th><th>RSRC1.VGPRS</th><th>SIMD당 wave</th><th>wave 하나의 박자 (기다림)</th></tr></thead>';
    const tb = el('tbody');
    rows.forEach(r => {
      const tr = el('tr', r.dd === d ? 'on' : '');
      tr.innerHTML = '<td>' + r.dd + '</td><td>' + r.peak + (base ? ' + ' + base + ' = ' + r.total : '') + '</td><td>' + r.alloc +
        '</td><td>' + ((r.alloc - 1) >> 2) + '</td><td>' + r.w + '</td><td>' + r.t + ' (' + r.stall + ')</td>';
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    kv.appendChild(t);

    const one = rows[0], all = rows[3];
    say.innerHTML = '읽기를 <b>' + d + '개</b> 띄우면 이 부분의 VGPR은 최대 <b>' + cur.peak + '</b>칸이에요(굵은 줄). ' +
      (base ? '이 구간 내내 살아 있는 다른 ' + base + '칸을 더해 ' + cur.total + '칸, ' : '') +
      '4칸 단위로 올려 ' + cur.alloc + '칸을 잡으니 SIMD 하나에 wave가 <b>' + cur.w + '개</b>까지 올라가요(이 모델의 셈). ' +
      'wave 하나는 ' + cur.t + '박자 걸리고 그중 ' + cur.stall + '박자를 기다려요. ' +
      '1개와 8개를 견주면 기다림은 ' + one.stall + ' → ' + all.stall + '박자로 줄고, SIMD당 wave는 ' + one.w + ' → ' + all.w + '개로 ' + (all.w < one.w ? '줄어요.' : '그대로예요. 다른 부분을 올려 보세요.');
  }

  root.addEventListener('change', render);
  render();
})();

/* ---------- 시뮬레이터 2 · 천장과 스필 ---------- */
(function cap() {
  const root = document.getElementById('sim-cap');
  if (!root) return;
  const vfile = $(root, '.vfile'), legend = $(root, '.vlegend'), kv = $(root, '.kv'), say = $(root, '.say');
  const CELLS = VGPR_FILE / VGPR_GRAN; // 한 칸 = VGPR 4개

  // ACO calc_min_waves · get_addr_regs_from_waves · max_suitable_waves 를 GFX9 wave64로 옮김
  function calc(L, need, lds) {
    const wpw = Math.ceil(L / 64);
    const minW = Math.ceil(wpw / SIMDS);
    const ceil = Math.min(VGPR_FILE, Math.floor(VGPR_FILE / minW / VGPR_GRAN) * VGPR_GRAN);
    const used = Math.min(need, ceil), spill = Math.max(0, need - ceil);
    const alloc = Math.max(VGPR_GRAN, up(used, VGPR_GRAN));
    const wV = wavesByVgpr(alloc);
    const byV = Math.floor(wV * SIMDS / wpw);
    const byL = lds ? Math.floor(LDS_CU / lds) : Infinity;
    const by16 = wpw > 1 ? 16 : Infinity;
    const nwg = Math.min(byV, byL, by16);
    const w = Math.ceil(nwg * wpw / SIMDS);
    let why;
    if (w < wV) why = nwg === byL ? 'LDS' : nwg === by16 ? 'wg16' : 'unit';
    else why = wV === MAX_WAVES && Math.floor(VGPR_FILE / alloc) > MAX_WAVES ? 'max' : 'vgpr';
    return { wpw, minW, ceil, used, spill, alloc, wV, nwg, w, why, byL };
  }

  function render() {
    const L = +$(root, '[data-k="L"]').value, need = +$(root, '[data-k="need"]').value, lds = +$(root, '[data-k="lds"]').value;
    const r = calc(L, need, lds);
    const per = r.alloc / VGPR_GRAN;

    vfile.textContent = '';
    for (let c = 0; c < CELLS; c++) {
      const wi = Math.floor(c / per);
      const i = el('i', wi < r.w ? 'w' + (wi % 2) : '');
      if (wi < r.w && c % per === 0) i.dataset.n = 'w' + wi;
      vfile.appendChild(i);
    }
    legend.textContent = '';
    legend.appendChild(el('span', null, '색칸 = 이 SIMD에 올라간 wave ' + r.w + '개 × ' + r.alloc + '칸 = ' + (r.w * r.alloc) + ' / 256'));
    if (r.spill) {
      const sp = el('span', 'spillbox');
      sp.appendChild(el('b', null, 'scratch(메모리)로 '));
      for (let c = 0; c < Math.ceil(r.spill / VGPR_GRAN); c++) sp.appendChild(el('i'));
      sp.appendChild(el('span', null, ' ' + r.spill + '칸 (wave마다)'));
      legend.appendChild(sp);
    }

    kv.textContent = '';
    kv.appendChild(kvTable([
      ['workgroup의 wave', L + ' ÷ 64 → <b>' + r.wpw + '</b>개'],
      ['SIMD마다 최소 wave', r.wpw + ' ÷ SIMD 4 (올림) → <b>' + r.minW + '</b>개'],
      ['VGPR 천장', '256 ÷ ' + r.minW + ' → <b>' + r.ceil + '</b>칸'],
      ['쓰는 VGPR', '원함 ' + need + ' → <b>' + r.used + '</b>' + (r.spill ? ' · 스필 <b>' + r.spill + '</b>' : ''), r.spill ? 'bad' : ''],
      ['RSRC1.VGPRS', '(' + r.alloc + ' − 1) ÷ 4 = <b>' + ((r.alloc - 1) >> 2) + '</b>'],
      ['RSRC2.SCRATCH_EN', '<b>' + (r.spill ? 1 : 0) + '</b>', r.spill ? 'bad' : ''],
      ['CU당 workgroup', '<b>' + r.nwg + '</b>개' + (lds ? ' (LDS로는 ' + r.byL + '개까지)' : '')],
      ['CU 전체에 올라가는 wave', '<b>' + (r.nwg * r.wpw) + '</b>개'],
      ['SIMD당 최대 wave (ACO 환산)', '<b>' + r.w + '</b>개 — 모든 SIMD가 이만큼 찬다는 뜻은 아니에요'],
    ]));

    const whyText = {
      vgpr: 'wave 수를 막는 건 VGPR이에요. ⌊256 ÷ ' + r.alloc + '⌋ = ' + r.wV + '.',
      max: 'VGPR은 넉넉해서 GFX9의 SIMD당 최대 10개에 걸려요.',
      LDS: 'VGPR로는 SIMD당 ' + r.wV + '개지만 LDS가 workgroup을 CU당 ' + r.byL + '개로 막아요.',
      wg16: 'VGPR로는 SIMD당 ' + r.wV + '개지만, wave가 둘 이상인 workgroup은 CU당 16개까지라(ACO가 적어 둔 하드웨어 한도) 거기 걸려요.',
      unit: 'VGPR로는 SIMD당 ' + r.wV + '개 자리가 있지만, workgroup은 wave ' + r.wpw + '개를 통째로 앉혀야 해서 ' + r.nwg + '개(wave ' + (r.nwg * r.wpw) + '개)만 들어가요.',
    }[r.why];
    say.innerHTML = (r.spill
      ? 'local size ' + jo(L, '이면', '면') + ' wave ' + r.wpw + '개가 한 CU에 같이 앉아야 해서 천장이 ' + r.ceil + '칸이에요. 커널은 ' + need + '칸을 원하니 <b>' + r.spill + '칸이 스필</b>돼요. '
      : '천장 ' + r.ceil + '칸 안에 ' + need + '칸이 들어가서 스필은 없어요. ') + whyText;
    say.classList.toggle('bad', !!r.spill);
  }

  root.addEventListener('change', render);
  render();
})();

/* ---------- 확인 퀴즈 ---------- */
(function quiz() {
  const root = document.getElementById('quiz');
  if (!root) return;
  const QS = [
    {
      q: 'ANGLE의 OpenCL 경로에서 OpenCL C 소스가 SPIR-V가 되는 때는?',
      a: ['clBuildProgram — clspv가 번역', 'clEnqueueNDRangeKernel — 드라이버가 번역', 'clCreateBuffer — 인자를 알게 될 때'],
      r: 0,
      why: 'ANGLE은 clBuildProgram에서 clspv를 불러 SPIR-V를 만들고, 같은 빌드 끝에 VkShaderModule을 만들어요. ISA로 바꾸는 두 번째 번역은 enqueue 때 그 설정의 파이프라인이 캐시에 없어서 새로 만들 때예요.',
    },
    {
      q: 'ANGLE이 컴퓨트 파이프라인(곧 ISA)을 clBuildProgram이 아니라 enqueue 때 만드는 가장 큰 이유는?',
      a: ['OpenCL은 local size를 enqueue 때 정할 수 있는데, Vulkan은 파이프라인을 만들 때 알아야 해서', 'SPIR-V가 아직 검증되지 않아서', 'GPU 메모리가 enqueue 때 할당돼서'],
      r: 0,
      why: 'clspv는 workgroup 크기를 specialization constant로 비워 두고(모든 커널에 reqd_work_group_size가 있으면 박아 두고), ANGLE은 enqueue 때 실제 local size·global offset 등을 채워 파이프라인을 얻어요.',
    },
    {
      q: 'clspv 기본 설정에서 kernel void foo(global int* a, float f, global float* b, uint c)의 f와 c는?',
      a: ['각자 push constant', '한 구조체로 묶여 storage buffer 하나 (set 0, binding 2)', 'VGPR에 바로 들어감'],
      r: 1,
      why: '기본은 POD 인자를 한 구조체로 묶어 storage buffer 하나로 넘겨요. -pod-ubo나 -pod-pushconstant, -cluster-pod-kernel-args=0으로 바꿀 수 있어요.',
    },
    {
      q: 'GFX9 wave64에서 local size 1024인 커널의 wave 하나가 쓸 수 있는 VGPR 천장은?',
      a: ['256칸', '128칸', '64칸'],
      r: 2,
      why: 'wave 16개가 한 CU(SIMD 4개)에 같이 앉아야 하니 SIMD마다 4개 → 256 ÷ 4 = 64칸. 더 필요하면 ACO가 스필이나 재계산으로 압박을 줄이고, scratch를 쓰게 되면 RSRC2.SCRATCH_EN이 켜져요(시뮬레이터 2는 넘친 VGPR을 모두 scratch로 보낸다고 가정해요).',
    },
    {
      q: '다른 제약이 없을 때(GFX9 wave64) 컴파일러가 VGPR 사용량을 48칸에서 80칸으로 늘렸어요. SIMD당 wave는?',
      a: ['5개 → 3개', '10개 그대로', '5개 → 4개'],
      r: 0,
      why: '⌊256 ÷ 48⌋ = 5, ⌊256 ÷ 80⌋ = 3. 읽기를 앞당겨 wave 하나의 기다림을 줄이는 대신 같이 올라갈 wave를 내주는 거래예요. 어느 쪽이 빠른지는 남은 wave가 기다림을 얼마나 메우느냐에 달려요.',
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
