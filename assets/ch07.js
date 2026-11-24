(() => {
'use strict';

const $ = (root, sel) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/* ---------- 시뮬레이터 1 · clCreateBuffer 한 번의 길 ---------- */
(function path() {
  const root = document.getElementById('sim-path');
  if (!root) return;
  const list = $(root, '.relay'), state = $(root, '.relay-state'), say = $(root, '.say'), mtwrap = $(root, '.mtwrap');
  const nextBtn = $(root, '[data-act="next"]'), autoBtn = $(root, '[data-act="auto"]');

  // radv 외장 GPU의 memory type (radv_physical_device_init_mem_types, TMZ·device-coherent 뺌)
  const TYPES = [
    { p: ['DL'],             dom: 'VRAM', fl: ['NO_CPU_ACCESS'] },
    { p: ['DL'],             dom: 'VRAM', fl: ['NO_CPU_ACCESS', '32BIT'], b32: true },
    { p: ['HV', 'HC'],       dom: 'GTT',  fl: ['GTT_WC', 'CPU_ACCESS'] },
    { p: ['DL', 'HV', 'HC'], dom: 'VRAM', fl: ['CPU_ACCESS'], vis: true },
    { p: ['DL', 'HV', 'HC'], dom: 'VRAM', fl: ['CPU_ACCESS', '32BIT'], vis: true, b32: true },
    { p: ['HV', 'HC', 'HCa'], dom: 'GTT', fl: ['CPU_ACCESS'] },
    { p: ['HV', 'HC', 'HCa'], dom: 'GTT', fl: ['CPU_ACCESS', '32BIT'], b32: true },
  ];
  const FULL = { DL: 'DEVICE_LOCAL', HV: 'HOST_VISIBLE', HC: 'HOST_COHERENT', HCa: 'HOST_CACHED' };
  const props = t => t.p.map(x => FULL[x]).join(' | ');
  const where = t => t.dom === 'GTT' ? (t.fl.includes('GTT_WC') ? 'GTT (write-combined)' : 'GTT (CPU 캐시 됨)') : (t.vis ? '보이는 VRAM' : 'VRAM');

  // 고른 타입 → 커널 요청 (radv_amdgpu_winsys_bo_create)
  function request(ti) {
    const t = TYPES[ti];
    const doms = t.dom === 'VRAM' ? ['VRAM', 'GTT'] : ['GTT'];
    const fl = [];
    if (t.fl.includes('CPU_ACCESS')) fl.push('CPU_ACCESS_REQUIRED');
    if (t.fl.includes('NO_CPU_ACCESS')) fl.push('NO_CPU_ACCESS');
    if (t.dom === 'VRAM' || t.fl.includes('GTT_WC')) fl.push('CPU_GTT_USWC');
    fl.push('EXPLICIT_SYNC', 'VM_ALWAYS_VALID');
    return { doms, fl };
  }

  let cur = 0, timer = null, steps = [];

  function build(mode) {
    const S = [];
    const isVk = mode === 'vk';
    const req = ['HV'], pref = mode === 'alloc' ? ['HC', 'HCa'] : [];
    const allowedBits = TYPES.map(t => !t.b32);
    // VMA: 0번부터, 「꼭」 없으면 건너뜀, 「되도록」 빠진 비트마다 1점, 0점이면 멈춤
    const cost = TYPES.map((t, i) => !allowedBits[i] ? null : req.some(r => !t.p.includes(r)) ? 'x' : pref.filter(p => !t.p.includes(p)).length);
    let pick = -1;
    if (isVk) pick = TYPES.findIndex((t, i) => allowedBits[i] && t.p.includes('DL'));
    else {
      let best = Infinity;
      for (let i = 0; i < TYPES.length; i++) {
        const c = cost[i];
        if (c === null || c === 'x') continue;
        if (c < best) { best = c; pick = i; if (c === 0) break; }
      }
    }
    const T = TYPES[pick];
    const R = request(pick);
    const flagName = { none: 'CL_MEM_READ_WRITE', copy: 'CL_MEM_READ_WRITE | CL_MEM_COPY_HOST_PTR', alloc: 'CL_MEM_READ_WRITE | CL_MEM_ALLOC_HOST_PTR' }[mode];

    if (isVk) {
      S.push({ who: 'Vulkan 앱', t: '비교용이에요. Vulkan 앱이 버퍼를 만들고 메모리 요구사항을 물어요. 그다음 DEVICE_LOCAL을 가진 첫 타입을 골라 할당한다고 해 볼게요(흔한 고르기 방식이지만 앱마다 달라요).',
        code: 'vkCreateBuffer → vkGetBufferMemoryRequirements', set: { want: 'DEVICE_LOCAL을 가진 첫 타입' }, hl: {} });
      S.push({ who: 'radv', t: '보통 버퍼의 memoryTypeBits에서는 32비트 타입(1·4·6번)이 빠져요. 남은 건 0·2·3·5번이에요.',
        code: 'radv_get_buffer_memory_requirements: memoryTypeBits &= ~memory_types_32bit', set: {}, hl: { bits: true } });
      S.push({ who: 'Vulkan 앱', t: '남은 타입 중 DEVICE_LOCAL을 가진 첫 타입은 0번이에요. 그걸로 할당해요.',
        code: 'vkAllocateMemory(memoryTypeIndex = 0)', set: { type: '0번 · ' + props(T) }, hl: { bits: true, pick } });
    } else {
      S.push({ who: '앱', t: 'clCreateBuffer를 불러요. 플래그는 ' + flagName + '예요.' + (mode === 'copy' ? ' 호스트 데이터를 넘겨 처음 내용을 채워 달라고 해요.' : ''),
        code: 'clCreateBuffer(ctx, ' + flagName + ', 4 MiB, ' + (mode === 'copy' ? 'host_ptr' : 'NULL') + ', &err)', set: {}, hl: {} });
      S.push({ who: 'ANGLE', t: 'CL 플래그를 Vulkan 메모리 속성으로 바꾸고, 「꼭」과 「되도록」으로 나눠요. HOST_VISIBLE은 늘 「꼭」이에요. 블로킹 읽기·쓰기를 매핑과 memcpy로 하니까요.' + (pref.length ? ' ALLOC_HOST_PTR이라 COHERENT·CACHED가 「되도록」에 들어가요.' : ' 「되도록」은 비어 있어요.') + ' DEVICE_LOCAL은 어디에도 없어요.',
        code: 'GetMemoryPropertyFlags → BufferHelper::init: required = HOST_VISIBLE, preferred = ' + (pref.length ? 'HOST_COHERENT | HOST_CACHED' : '0'),
        set: { want: '꼭 HOST_VISIBLE · 되도록 ' + (pref.length ? 'COHERENT | CACHED' : '없음') }, hl: {} });
      S.push({ who: 'radv', t: '보통 버퍼의 memoryTypeBits에서는 32비트 타입(1·4·6번)이 빠져요. VMA가 볼 수 있는 건 0·2·3·5번이에요.',
        code: 'radv_get_buffer_memory_requirements: memoryTypeBits &= ~memory_types_32bit', set: {}, hl: { bits: true } });
      S.push({ who: 'VMA', t: '0번부터 점수를 매겨요. 0번은 HOST_VISIBLE이 없어 건너뛰어요. ' + (pref.length ? '2번과 3번은 CACHED가 없어 1점이고, 5번이 0점이라 거기서 멈춰요.' : '2번은 「되도록」이 비어 있으니 0점이라 바로 멈춰요. 3번(보이는 VRAM)까지 가지 않아요.'),
        code: 'vmaFindMemoryTypeIndexForBufferInfo → FindMemoryTypeIndex: 점수 = 빠진 「되도록」 비트 수 → ' + pick + '번',
        set: { type: pick + '번 · ' + props(T) }, hl: { bits: true, cost: true, pick } });
      S.push({ who: 'ANGLE', t: '실제로 할당할 때 한 번 더 골라요. 이번엔 「VMA가 고른 타입의 속성을 다 가진 첫 타입」인데, 그게 같은 ' + pick + '번이에요.',
        code: 'AllocateBufferMemory → FindCompatibleMemory(' + props(T) + ') → ' + pick + '번 → vkAllocateMemory',
        set: {}, hl: { bits: true, pick } });
    }
    S.push({ who: 'radv', t: pick + '번에 짝지어 둔 domain과 플래그를 꺼내요. 다른 프로세스와 나누지 않는 메모리라 NO_INTERPROCESS_SHARING | PREFER_LOCAL_BO도 더해요.',
      code: 'radv_alloc_memory: domain = ' + T.dom + ', flags = ' + T.fl.join(' | ') + ' | NO_INTERPROCESS_SHARING | PREFER_LOCAL_BO',
      set: { radv: T.dom + ' · ' + T.fl.join(' | ') }, hl: { pick } });
    S.push({ who: 'radv winsys', t: 'GPU 가상 주소 범위부터 잡고(8장), 커널에 보낼 요청을 만들어요. ' + (T.dom === 'VRAM' ? 'VRAM이라 GTT도 같이 넣어요(gtt_spill, 기본 켜짐). ' : 'domain이 GTT라 요청 도메인도 GTT 하나예요. ') + '플래그는 ' + R.fl.join(', ') + '예요.',
      code: 'ac_drm_va_range_alloc → ac_drm_bo_alloc: preferred_heap = ' + R.doms.join(' | ') + ', flags = ' + R.fl.join(' | '),
      set: { req: R.doms.join(' | ') + ' · ' + R.fl.join(' | ') }, hl: { pick } });
    const allowed = R.doms.length === 1 && R.doms[0] === 'VRAM' ? ['VRAM', 'GTT'] : R.doms;
    S.push({ who: 'amdgpu', t: 'GEM_CREATE ioctl이 플래그를 검사하고 VRAM_CLEARED를 켜요. BO를 만들며 preferred = 요청 그대로, allowed = ' + allowed.join(' | ') + '로 기억해요' + (R.doms.length > 1 ? '(VRAM 하나뿐인 요청이 아니라 GTT를 더할 일은 없어요).' : '.'),
      code: 'amdgpu_gem_create_ioctl → amdgpu_gem_object_create → amdgpu_bo_create',
      set: { pa: R.doms.join(' | ') + ' / ' + allowed.join(' | ') }, hl: {} });
    const places = R.doms.map(d => d === 'VRAM' ? 'VRAM' + (R.fl.includes('CPU_ACCESS_REQUIRED') ? '(보이는 VRAM까지)' : '(TOPDOWN, 끝에서부터)') : 'GTT');
    S.push({ who: 'amdgpu', t: '자리 후보 목록을 만들어요: ' + places.join(' → ') + '.' + (T.dom === 'GTT' && R.fl.includes('CPU_ACCESS_REQUIRED') ? ' CPU_ACCESS_REQUIRED는 VRAM 후보의 범위를 줄이는 데만 쓰여서, GTT 하나뿐인 여기선 할 일이 없어요.' : ''),
      code: 'amdgpu_bo_placement_from_domain(' + R.doms.join(' | ') + ')', set: {}, hl: {} });
    const placed = R.doms[0];
    S.push({ who: 'TTM', t: '첫 바퀴(밀어내지 않고)에서 후보를 순서대로 봐요. 이 그림에선 자리가 남아 있다고 두니 첫 후보 ' + placed + '에 놓여요.',
      code: 'ttm_bo_init_reserved → ttm_bo_validate → ttm_bo_alloc_resource(force_space = false)', set: { at: placed }, hl: {} });
    if (placed === 'VRAM') {
      S.push({ who: 'amdgpu', t: 'VRAM에 놓였으니 아직 안 지워진 구간에 복사 엔진의 0으로 지우기 작업을 맡겨요(이미 지워진 구간은 건너뛰어요). 새 fence가 생기면 BO의 dma_resv에 걸고, 이 BO를 처음 쓰는 GPU 일은 그걸 기다려요. 그다음 CPU_ACCESS_REQUIRED가 있었다면 힌트로 보고 지워요.',
        code: 'amdgpu_ttm_clear_buffer → dma_resv_add_fence(KERNEL) · trace: amdgpu_bo_move(-1 → 2), amdgpu_bo_create(type=2)', set: { at: 'VRAM (새 지우기 fence가 있으면 대기)' }, hl: {} });
    } else {
      S.push({ who: 'amdgpu', t: 'GTT에 놓였으니 VRAM 지우기는 없어요. CPU_ACCESS_REQUIRED는 이제 힌트로 보고 지워요. 핸들을 만들어 돌려줘요.',
        code: 'trace: amdgpu_bo_move(-1 → 1), amdgpu_bo_create(type=1) · drm_gem_handle_create', set: {}, hl: {} });
    }
    if (isVk) {
      S.push({ who: 'Vulkan 앱', t: '이 버퍼는 VRAM에 있어요. CPU로 내용을 쓰려면 스테이징 버퍼를 거쳐 복사해야 해요(0번은 HOST_VISIBLE이 아니니까요).',
        code: 'vkBindBufferMemory', set: {}, hl: { pick }, end: true });
    } else {
      S.push({ who: 'ANGLE', t: 'HOST_VISIBLE 메모리라 바로 CPU에 매핑해 둬요.' + (mode === 'copy' ? ' COPY_HOST_PTR이라 그 매핑으로 호스트 데이터를 memcpy해서 처음 내용을 채워요.' : '') + ' 버퍼 내용은 시스템 RAM에 있어서, 커널의 읽기가 GPU 캐시에서 끝나지 않으면 PCIe를 건너가요.',
        code: 'BufferHelper::init → map' + (mode === 'copy' ? ' · CLBufferVk::create → copyFrom → memcpy' : ''), set: {}, hl: { pick }, end: true });
    }
    S.meta = { pick, cost, isVk };
    return S;
  }

  function snapshot(upto) {
    const s = { want: '—', type: '—', radv: '—', req: '—', pa: '—', at: '—' };
    for (let i = 0; i <= upto; i++) Object.assign(s, steps[i].set);
    return s;
  }

  function renderTypes(hl) {
    mtwrap.textContent = '';
    const t = el('table', 'tbl mttbl');
    t.innerHTML = '<thead><tr><th>#</th><th>속성</th><th>radv</th><th>점수</th></tr></thead>';
    const tb = el('tbody');
    const { cost, isVk } = steps.meta;
    TYPES.forEach((ty, i) => {
      const tr = el('tr');
      if (hl.bits && ty.b32) tr.className = 'out';
      if (hl.pick === i) tr.className = 'pick';
      const c = !hl.cost || isVk ? '' : cost[i] === null ? '—' : cost[i] === 'x' ? '꼭 없음' : cost[i] + '점';
      [String(i), ty.p.join(' '), ty.dom + (ty.vis ? ' 보임' : '') + (ty.b32 ? ' · 32bit' : '') + (ty.fl.includes('GTT_WC') ? ' · WC' : ''), c].forEach(v => tr.appendChild(el('td', null, v)));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    mtwrap.appendChild(t);
    mtwrap.appendChild(el('div', 'muted small', 'DL = DEVICE_LOCAL, HV = HOST_VISIBLE, HC = HOST_COHERENT, HCa = HOST_CACHED. 흐린 줄은 보통 버퍼가 못 쓰는 32비트 타입이에요.'));
  }

  function render() {
    list.textContent = '';
    steps.forEach((st, i) => {
      const li = el('li', (i === cur ? 'cur' : i < cur ? 'past' : 'future'));
      li.appendChild(el('span', 'who', st.who));
      const body = el('div', 'rbody');
      body.appendChild(el('div', null, st.t));
      body.appendChild(el('code', null, st.code));
      li.appendChild(body);
      list.appendChild(li);
    });
    renderTypes(steps[cur].hl);
    const s = snapshot(cur);
    state.textContent = '';
    [['청한 것', s.want], ['고른 memory type', s.type], ['radv domain · 플래그', s.radv], ['GEM_CREATE 요청', s.req], ['preferred / allowed', s.pa], ['놓인 곳', s.at]].forEach(([k, v]) => {
      const d = el('div', 'rs' + (k === '놓인 곳' && v !== '—' ? ' got' : ''));
      d.appendChild(el('span', 'k', k));
      d.appendChild(el('b', null, v));
      state.appendChild(d);
    });
    const st = steps[cur], m = steps.meta, T = TYPES[m.pick];
    let msg = (cur + 1) + ' / ' + steps.length + ' — ' + st.who + '. ';
    if (cur === 0) msg += '「다음」을 누르면 한 층씩 내려가요.';
    else if (st.end) msg += m.isVk
      ? '같은 radv인데 DEVICE_LOCAL 타입을 고르면 VRAM|GTT로 청해져 VRAM에 놓여요. 차이는 맨 위에서 무엇을 청했느냐예요.'
      : '결과는 ' + where(T) + '예요. 외장 GPU인데도 VRAM이 아니에요. ANGLE이 DEVICE_LOCAL을 청하지 않고, radv 순서에서 GTT 타입이 보이는 VRAM보다 앞에 있어서예요.';
    say.textContent = msg;
    nextBtn.disabled = cur >= steps.length - 1;
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; autoBtn.textContent = '자동'; } }
  function reset() {
    stop();
    steps = build(root.querySelector('input[name="pflag"]:checked').value);
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
      timer = setInterval(() => { if (cur >= steps.length - 1) { stop(); return; } cur++; render(); }, 1300);
    }
  });
  reset();
})();

/* ---------- 시뮬레이터 2 · VRAM이 찼을 때 ---------- */
(function full() {
  const root = document.getElementById('sim-full');
  if (!root) return;
  const mem = $(root, '.mem'), log = $(root, '.ttmlog'), say = $(root, '.say');
  const CAP = { VRAM: 8, GTT: 8 };
  const TTMNO = { SYSTEM: 0, GTT: 1, VRAM: 2 };        // TTM_PL_SYSTEM·TT·VRAM
  const DOMBIT = { GTT: 2, VRAM: 4 };                  // AMDGPU_GEM_DOMAIN_GTT·VRAM
  const NAME = { vg: 'VRAM | GTT', v: 'VRAM', g: 'GTT' };
  let S;

  function init() {
    S = { t: 0, n: 0, bos: [], lines: [], msg: '', cls: '', calls: [], tr: [], counts: [] };
    snapCount(0);
  }
  const used = w => S.bos.filter(b => b.at === w).reduce((a, b) => a + b.size, 0);
  const free = w => CAP[w] - used(w);
  const bits = doms => doms.reduce((a, d) => a + DOMBIT[d], 0);
  function snapCount(t) { S.counts.push({ t, VRAM: used('VRAM'), GTT: used('GTT'), SYSTEM: used('SYSTEM') }); }

  // TTM 두 바퀴 (ttm_bo_mem_space → ttm_bo_alloc_resource). 성공하면 놓인 곳, 실패하면 null
  function place(bo, doms, t0) {
    const L = S.lines;
    for (const d of doms) {
      if (free(d) >= bo.size) { L.push('첫 바퀴: ' + d + '에 빈 칸 ' + free(d) + ' → 놓음'); return d; }
      L.push('첫 바퀴: ' + d + '에 빈 칸 ' + free(d) + ' — 모자라서 다음 후보로');
    }
    L.push('첫 바퀴 실패 → 둘째 바퀴(밀어내서라도)');
    let dt = 0.15;
    for (const d of doms) {
      if (CAP[d] < bo.size) { L.push('둘째 바퀴: ' + d + ' 전체가 ' + CAP[d] + '칸이라 밀어내도 안 돼요 → 다음 후보로'); continue; }
      while (free(d) < bo.size) {
        const v = S.bos.filter(b => b.at === d).sort((a, b) => a.born - b.born)[0];
        const to = d === 'VRAM' ? (free('GTT') >= v.size ? 'GTT' : 'SYSTEM') : 'SYSTEM';
        L.push('둘째 바퀴: ' + v.id + '(' + v.size + '칸)를 ' + d + '에서 ' + to + '로 밀어냄');
        S.tr.push({ k: 'move', t: t0 + dt, name: 'amdgpu_bo_move', args: { bo: v.id, from: TTMNO[d], to: TTMNO[to], '뜻': d + ' → ' + to + ' (밀어내기)', size: v.size + '칸' } });
        v.at = to; v.moved = (v.moved || 0) + 1;
        snapCount(t0 + dt);
        dt += 0.1;
      }
      L.push('둘째 바퀴: ' + d + '에 자리 생김 → 놓음');
      return d;
    }
    L.push('둘째 바퀴도 실패');
    return null;
  }

  function create(kind) {
    const size = +$(root, '[data-k="size"]').value;
    const t0 = S.t;
    S.lines = [];
    S.cls = '';
    const reqDoms = kind === 'vg' ? ['VRAM', 'GTT'] : kind === 'v' ? ['VRAM'] : ['GTT'];
    let doms = reqDoms.slice();
    const id = 'B' + (S.n + 1);
    const bo = { id, size, born: S.n, req: NAME[kind] };
    S.lines.push(id + ' 요청: ' + doms.join(' | ') + ', ' + size + '칸. preferred = ' + doms.join(' | ') + ', allowed = ' + (kind === 'v' ? 'VRAM | GTT (VRAM 하나뿐이라 GTT를 더함)' : doms.join(' | ')));
    // amdgpu_bo_validate_size: GTT가 있으면 GTT 전체, 없으면 VRAM 전체보다 작아야 함
    const sizeOk = ds => { const m = ds.includes('GTT') ? 'GTT' : 'VRAM'; const ok = size < CAP[m]; S.lines.push('크기 검사: ' + size + '칸 < ' + m + ' 전체 ' + CAP[m] + '칸? ' + (ok ? '통과' : '거절 (두 바퀴까지 가지 않음)')); return ok; };
    let at = sizeOk(doms) ? place(bo, doms, t0) : null;
    if (!at && kind === 'v') {
      S.lines.push('ioctl 다시 시도: VRAM 하나뿐인 요청에 GTT를 더해서');
      doms = ['VRAM', 'GTT'];
      at = sizeOk(doms) ? place(bo, doms, t0 + 0.4) : null;
    }
    const res = at ? at : '실패';
    S.calls.push({ t: t0, name: 'GEM_CREATE ' + id + ' (' + NAME[kind] + ', ' + size + '칸)', args: { '요청 도메인': NAME[kind], '크기': size + '칸', '결과': res, '다시 시도': doms.length !== reqDoms.length ? '예 (GTT를 더함)' : '아니요' } });
    if (!at) {
      S.lines.push('ioctl이 실패를 돌려줘요');
      S.msg = id + ' — ' + size + '칸은 자리를 받지 못했어요. 크기 검사는 전체 크기보다 작아야 통과라서, VRAM ' + CAP.VRAM + '칸·GTT ' + CAP.GTT + '칸인 이 모델에선 ioctl이 GTT를 더해 다시 해 봐도 거절돼요.';
      S.cls = 'bad';
      S.n++;
      S.t = t0 + 1;
      return;
    }
    bo.at = at;
    S.bos.push(bo);
    S.n++;
    S.tr.push({ k: 'move', t: t0 + 0.6, name: 'amdgpu_bo_move', args: { bo: id, from: -1, to: TTMNO[at], '뜻': '처음 자리 (' + at + ')' } });
    snapCount(t0 + 0.6);
    if (at === 'VRAM') S.tr.push({ k: 'clear', t: t0 + 0.7, t1: t0 + 1.0, name: id + ' 0으로 지우기', args: { bo: id } });
    S.tr.push({ k: 'create', t: t0 + 0.8, name: 'amdgpu_bo_create', args: { bo: id, type: TTMNO[at], preferred: bits(doms), allowed: bits(kind === 'v' && doms.length === 1 ? ['VRAM', 'GTT'] : doms), '뜻': 'type ' + TTMNO[at] + ' = ' + at } });
    const evicted = S.lines.filter(l => l.includes('밀어냄')).length;
    if (kind === 'g') S.msg = id + ' — GTT 하나만 청해서 GTT에 놓였어요. ANGLE의 OpenCL 버퍼가 이 모양이에요(시뮬레이터 1).';
    else if (at === 'VRAM' && !evicted) S.msg = id + ' — VRAM에 빈 칸이 있어 첫 바퀴에 놓였어요. VRAM이라 복사 엔진이 0으로 지워요(이 모델은 늘 지울 게 있다고 둬요).';
    else if (at === 'VRAM') { S.msg = id + ' — 첫 바퀴는 실패했고, 둘째 바퀴에서 ' + evicted + '개를 밀어내 VRAM에 들어갔어요. 밀려난 BO는 이제 원하는 곳(VRAM) 밖에 있어요.'; S.cls = 'bad'; }
    else S.msg = id + ' — VRAM이 차 있어서 첫 바퀴에서 다음 후보인 GTT에 놓였어요. 아무도 밀려나지 않았어요. 대신 이 BO는 원하는 곳(VRAM) 밖에서 태어났어요.';
    S.t = t0 + 1;
  }

  function render() {
    mem.textContent = '';
    ['VRAM', 'GTT'].forEach(w => {
      const row = el('div', 'memrow');
      row.appendChild(el('span', 'memname', w + ' ' + used(w) + '/' + CAP[w]));
      const bar = el('div', 'membar');
      S.bos.filter(b => b.at === w).sort((a, b) => a.born - b.born).forEach(b => {
        const c = el('i', 'bo' + (b.moved ? ' moved' : '') + (b.req === 'GTT' ? ' g' : ''), b.id);
        c.style.gridColumn = 'span ' + b.size;
        c.title = b.id + ' · ' + b.size + '칸 · 요청 ' + b.req;
        bar.appendChild(c);
      });
      row.appendChild(bar);
      mem.appendChild(row);
    });
    const sysb = S.bos.filter(b => b.at === 'SYSTEM');
    const row = el('div', 'memrow');
    row.appendChild(el('span', 'memname', 'SYSTEM'));
    const chips = el('div', 'memchips');
    if (!sysb.length) chips.appendChild(el('span', 'muted small', '밀려난 BO 없음'));
    sysb.forEach(b => chips.appendChild(el('i', 'bo moved', b.id + ' · ' + b.size + '칸')));
    row.appendChild(chips);
    mem.appendChild(row);
    log.textContent = '';
    S.lines.forEach(l => log.appendChild(el('li', l.includes('밀어냄') ? 'ev' : l.includes('실패') ? 'fail' : null, l)));
    say.textContent = S.msg || '크기를 고르고 BO를 만들어 보세요. 진한 테두리는 밀려난 적 있는 BO예요.';
    say.classList.toggle('bad', S.cls === 'bad');
  }

  function buildTrace() {
    if (!S.calls.length) return null;
    const P = window.GPUSimPerfetto.builder(1000);
    P.proc(1, '앱 (시뮬레이터가 만든 trace)', 1); P.thread(1, 1, 'GEM_CREATE ioctl', 1);
    P.proc(2, 'amdgpu (모델)', 2); P.thread(2, 1, 'tracepoint (이름만 실제)', 1); P.thread(2, 2, '복사 엔진', 2);
    P.proc(3, '메모리 (칸 수)', 3);
    S.calls.forEach(c => P.slice(1, 1, c.name, c.t, c.t + 1, c.args));
    S.tr.forEach(e => {
      if (e.k === 'clear') P.slice(2, 2, e.name, e.t, e.t1, e.args);
      else P.instant(2, 1, e.name, e.t, e.args);
    });
    S.counts.forEach(c => { P.counter(3, 'VRAM', c.t, { '칸': c.VRAM }); P.counter(3, 'GTT', c.t, { '칸': c.GTT }); P.counter(3, 'SYSTEM', c.t, { '칸': c.SYSTEM }); });
    P.counter(3, 'VRAM', S.t, { '칸': used('VRAM') }); P.counter(3, 'GTT', S.t, { '칸': used('GTT') }); P.counter(3, 'SYSTEM', S.t, { '칸': used('SYSTEM') });
    return P.done();
  }

  root.addEventListener('click', e => {
    const a = e.target.closest('button')?.dataset.act;
    if (!a) return;
    if (a === 'reset') init();
    else if (a === 'perfetto') {
      const tr = buildTrace();
      S.cls = '';
      if (!tr) S.msg = '아직 보낼 게 없어요. BO를 몇 개 만든 뒤에 열어 보세요.';
      else if (!window.GPUSimPerfetto.open(tr, 'GPU Sim 7장 · 시뮬레이터가 만든 trace', 'gpu-sim-ch07.json')) { S.msg = '브라우저가 새 탭을 막았어요. 이 사이트의 팝업을 허용하고 다시 눌러 주세요.'; S.cls = 'bad'; }
      else S.msg = 'ui.perfetto.dev 새 탭으로 지금까지의 판(' + S.t + 'ms, 한 번 누를 때마다 1ms로 놓음)을 보냈어요. trace는 이 브라우저 안에서만 오가요. Perfetto가 「이 출처를 믿나요」를 물으면 Yes를 눌러 주세요.';
    } else create(a);
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
      q: '2026-11의 ANGLE에서 평범한 clCreateBuffer(플래그 없음)가 Vulkan에 꼭(required) 청하는 메모리 속성은?',
      a: ['DEVICE_LOCAL', 'HOST_VISIBLE', 'HOST_VISIBLE | HOST_CACHED'],
      r: 1,
      why: 'GetMemoryPropertyFlags는 늘 HOST_VISIBLE을 넣고, BufferHelper::init은 그중 HOST_VISIBLE만 「꼭」으로 둬요. 블로킹 읽기·쓰기를 매핑과 memcpy로 하는 설계라서예요. DEVICE_LOCAL은 청하지 않아요.',
    },
    {
      q: 'radv 외장 GPU의 타입 순서가 0 VRAM, 2 GTT(write-combined), 3 보이는 VRAM, 5 GTT(cached)일 때, 「꼭 HOST_VISIBLE, 되도록 없음」으로 VMA가 고르는 타입은?',
      a: ['0번', '2번', '3번'],
      r: 1,
      why: 'VMA는 0번부터 보며 「꼭」이 없는 0번을 건너뛰고, 「되도록」이 비었으니 처음 만난 2번이 0점이라 거기서 멈춰요. 3번 보이는 VRAM은 그 뒤에 있어요.',
    },
    {
      q: 'radv가 DEVICE_LOCAL(0번) 메모리를 커널에 청할 때 요청 도메인은? (기본 설정)',
      a: ['VRAM', 'VRAM | GTT', 'GTT'],
      r: 1,
      why: 'radv는 VRAM domain이면 GTT도 같이 넣어요(gtt_spill, 기본 켜짐). amdgpu는 처음엔 VRAM을 고르지만, VRAM이 차면 밀어내지 않고 GTT에 놓을 수 있게 돼요. RADV_PERFTEST=nogttspill로 끌 수 있어요.',
    },
    {
      q: '새 BO가 각 메모리의 전체 크기보다 작고, VRAM은 꽉 찼지만 GTT에는 충분한 자리가 있을 때, VRAM | GTT로 청한 새 BO는 어떻게 되나요?',
      a: ['VRAM의 오래된 BO를 GTT로 밀어내고 VRAM에 들어감', '첫 바퀴에서 다음 후보인 GTT에 놓이고, 아무도 밀려나지 않음', 'ioctl이 실패함'],
      r: 1,
      why: 'TTM의 첫 바퀴는 밀어내지 않고 후보를 순서대로 봐요. VRAM에 자리가 없으면 GTT에 놓아요. 밀어내기는 첫 바퀴가 모두 실패했을 때 도는 둘째 바퀴에서만 일어나요.',
    },
    {
      q: '진짜 기계에서 새 BO 하나가 VRAM에 놓일 때 찍히는 amdgpu tracepoint의 순서는?',
      a: ['amdgpu_bo_create → amdgpu_bo_move', 'amdgpu_bo_move(from=-1, to=2) → amdgpu_bo_create(type=2)', 'amdgpu_bo_create만 찍힘'],
      r: 1,
      why: '처음 자리를 받을 때도 TTM의 move 콜백이 불려 amdgpu_bo_move_notify가 from=-1로 찍혀요. amdgpu_bo_create는 자리를 받고 필요한 지우기 작업을 제출한 뒤 amdgpu_bo_create 끝에서 찍혀요.',
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
