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

/* ---------- 시뮬레이터 1 · 링 버퍼와 doorbell ---------- */
(function ringSim() {
  const root = document.getElementById('sim-ring');
  if (!root) return;
  const N = 8;
  const ringEl = $(root, '.ring');
  const say = $(root, '.say');
  let s;

  function reset() {
    s = { r: 0, w: 0, d: 0, slots: Array(N).fill(null), read: Array(N).fill(false), n: 0 };
    render('비어 있어요. <b>rptr = wptr</b>이면 CP가 읽을 게 없다는 뜻이에요. 드라이버가 패킷을 써 볼까요?');
  }
  // [a, b) 원형 구간에 i가 들어가나
  const inRange = (a, b, i) => (a <= b ? i >= a && i < b : i >= a || i < b);

  function render(msg) {
    ringEl.textContent = '';
    for (let i = 0; i < N; i++) {
      const cell = el('div', 'slot');
      if (inRange(s.d, s.w, i)) cell.classList.add('written');
      else if (inRange(s.r, s.d, i)) cell.classList.add('visible');
      else if (s.read[i]) cell.classList.add('read');
      const body = el('div');
      body.appendChild(el('div', null, s.slots[i] || '·'));
      const tags = el('div');
      if (i === s.r) tags.appendChild(el('span', 'ptr-r', 'R '));
      if (i === s.d) tags.appendChild(el('span', 'ptr-d', 'D '));
      if (i === s.w) tags.appendChild(el('span', 'ptr-w', 'W'));
      body.appendChild(tags);
      cell.appendChild(body);
      ringEl.appendChild(cell);
    }
    say.innerHTML = msg;
  }

  const act = {
    write() {
      if ((s.w + 1) % N === s.r) {
        return render('<b>꽉 찼어요.</b> 한 칸만 더 쓰면 wptr이 rptr과 같아져 「비었다」와 구별할 수 없어요. 그래서 링은 한 칸을 늘 비워 둬요. CP가 읽어서 rptr이 움직여야 드라이버가 다시 쓸 수 있어요.');
      }
      s.n++;
      const job = Math.ceil(s.n / 2);
      s.slots[s.w] = s.n % 2 ? 'IB\n#' + job : 'FENCE\n' + job;
      s.read[s.w] = false;
      s.w = (s.w + 1) % N;
      render('드라이버가 <b>' + (s.n % 2 ? 'INDIRECT_BUFFER' : 'RELEASE_MEM(fence)') + '</b>을 썼어요. 주황색 칸은 메모리에는 있지만 CP는 아직 몰라요. doorbell을 울려야 해요.');
    },
    bell() {
      if (s.d === s.w) return render('새로 쓴 게 없어요. 초인종을 울려도 CP가 읽을 칸은 늘지 않아요.');
      const k = (s.w - s.d + N) % N;
      s.d = s.w;
      render('<b>딩동.</b> doorbell에 wptr을 적어서 새 칸 ' + k + '개를 알렸어요. 이제 CP가 파란 칸을 읽을 수 있어요.');
    },
    read() {
      if (s.r === s.d) {
        return render(s.r !== s.w
          ? '<b>CP 입장에선 비어 있어요.</b> 드라이버가 써 놓은 칸이 있지만 doorbell을 안 울려서 CP는 몰라요. 써 놓는 것과 알리는 것은 다른 일이에요.'
          : '읽을 게 없어요. CP는 doorbell이 울릴 때까지 쉬어요.');
      }
      const p = s.slots[s.r].replace('\n', ' ');
      s.read[s.r] = true;
      s.r = (s.r + 1) % N;
      render('CP가 <b>' + p + '</b> 칸을 읽고 rptr을 한 칸 옮겼어요. ' +
        (p.startsWith('IB') ? '이제 그 IB로 건너가 안의 PM4를 실행해요.' : 'fence 패킷은 「앞의 일이 끝나면 이 값을 써」라는 예약이에요.'));
    },
    reset,
  };
  root.addEventListener('click', e => {
    const a = e.target.closest('button')?.dataset.act;
    if (a && act[a]) act[a]();
  });
  reset();
})();

/* ---------- 시뮬레이터 2 · clEnqueue부터 fence까지 ---------- */
(function lifeSim() {
  const root = document.getElementById('sim-life');
  if (!root) return;
  const CUS = 4, CAP = 8;
  const lane = k => $(root, '[data-lane="' + k + '"]');
  const say = $(root, '.say');
  const autoBtn = $(root, '[data-act="auto"]');
  const nextBtn = $(root, '[data-act="next"]');
  let s, timer = null;

  const PHASES = ['idle', 'enqueue', 'umd', 'submit', 'doorbell', 'cp-ib', 'cp-regs', 'dispatch', 'run', 'eop', 'host'];

  function params() {
    const gws = Math.max(1, +$(root, '[data-k="gws"]').value || 1);
    const lws = Math.max(1, +$(root, '[data-k="lws"]').value || 1);
    const ws = +$(root, '[data-k="ws"]').value;
    return { gws, lws, ws, wgs: Math.ceil(gws / lws), wpg: Math.ceil(lws / ws) };
  }

  function reset() {
    stopAuto();
    const p = params();
    s = { p, phase: 0, pending: p.wgs, cu: Array.from({ length: CUS }, () => []), done: 0, ticks: 0, wgSeq: 0, fence: 0, err: null };
    if (p.wpg > CAP) s.err = 'workgroup 하나가 wave ' + p.wpg + '개라 CU 하나(장난감 값 ' + CAP + '칸)에 다 못 앉아요. 한 workgroup은 한 CU에 모여야 하거든요. local을 줄여 보세요.';
    render();
  }

  const phase = () => PHASES[s.phase];
  const at = name => s.phase >= PHASES.indexOf(name);

  function launch() {
    // workgroup 단위로, 자리가 남은 CU에 돌아가며 앉힌다
    let placed = 0, tried = 0, c = s.wgSeq % CUS;
    while (s.pending > 0 && tried < CUS) {
      const used = s.cu[c].filter(w => !w.fin).length;
      if (CAP - used >= s.p.wpg) {
        for (let i = 0; i < s.p.wpg; i++) s.cu[c].push({ left: 2 + Math.floor(Math.random() * 3), fin: false });
        s.pending--; placed++; tried = 0; s.wgSeq++;
      } else tried++;
      c = (c + 1) % CUS;
    }
    return placed;
  }

  function runTick() {
    s.ticks++;
    for (const cu of s.cu) {
      for (let i = cu.length - 1; i >= 0; i--) if (cu[i].fin) cu.splice(i, 1);
    }
    let finished = 0;
    for (const cu of s.cu) for (const w of cu) if (--w.left <= 0) { w.fin = true; finished++; s.done++; }
    const placed = launch();
    return { finished, placed };
  }

  const totalWaves = () => s.p.wgs * s.p.wpg;
  const live = () => s.cu.reduce((n, cu) => n + cu.filter(w => !w.fin).length, 0);

  function next() {
    if (s.err) return render();
    const ph = phase();
    if (ph === 'host') return stopAuto();
    if (ph === 'dispatch') {
      launch();
      s.phase++;
    } else if (ph === 'run') {
      const r = runTick();
      s.last = r;
      if (s.pending === 0 && live() === 0) s.phase++;
    } else if (ph === 'eop') {
      s.cu.forEach(cu => cu.length = 0);
      s.fence = 1;
      s.phase++;
    } else s.phase++;
    render();
    if (phase() === 'host') stopAuto();
  }

  function msg() {
    const p = s.p, ph = phase();
    if (s.err) return s.err;
    switch (ph) {
      case 'idle': return 'global ' + p.gws + ', local ' + p.lws + ', wave' + p.ws + '이면 workgroup <b>' + p.wgs + '개</b>, workgroup당 wave <b>' + p.wpg + '개</b>, 모두 <b>' + totalWaves() + ' wave</b>예요. 「다음 박자」로 시작해요.';
      case 'enqueue': return '앱이 <b>clEnqueueNDRangeKernel</b>을 불렀어요. 런타임은 「이 dispatch를 큐 끝에 추가」만 해 둬요. GPU는 아직 아무것도 몰라요.';
      case 'umd': return 'UMD가 IB에 <b>PM4 패킷</b>을 적어요. SET_SH_REG로 커널 주소, 자원(VGPR·SGPR·LDS), workgroup 크기(' + p.lws + '), 인자 포인터를 정하고, <b>DISPATCH_DIRECT x=' + p.wgs + '</b>로 끝내요. 아직 메모리에 적힌 글자일 뿐이에요.';
      case 'submit': return '<b>clFlush</b>(또는 clFinish)가 제출을 일으켜요. KMD가 링에 <b>INDIRECT_BUFFER</b>(IB 주소)와 <b>RELEASE_MEM</b>(끝나면 fence 주소에 1을 써)을 적어요.';
      case 'doorbell': return 'KMD가 <b>doorbell</b>에 새 wptr을 적어요. 여기서 처음으로 GPU가 「일이 왔다」는 걸 알아요.';
      case 'cp-ib': return 'CP(MEC)가 링에서 INDIRECT_BUFFER를 읽고 <b>IB로 건너가요</b>.';
      case 'cp-regs': return 'CP가 SET_SH_REG를 차례로 실행해 <b>compute 레지스터</b>를 채워요. clSetKernelArg로 정해 둔 것들이 이제 하드웨어 레지스터 값이 됐어요.';
      case 'dispatch': return 'CP가 <b>DISPATCH_DIRECT</b>를 만나 디스패처에 「workgroup ' + p.wgs + '개」를 넘겨요. 디스패처는 workgroup을 wave ' + p.wpg + '개로 나눠 자리가 남은 CU에 통째로 앉혀요.';
      case 'run': {
        const r = s.last;
        let t = r ? '박자 ' + s.ticks + ': wave ' + r.finished + '개가 끝나고, workgroup ' + r.placed + '개가 새로 앉았어요. ' : 'wave들이 돌고 있어요. ';
        t += '끝난 wave <b>' + s.done + '/' + totalWaves() + '</b>, 기다리는 workgroup <b>' + s.pending + '</b>개.';
        if (s.pending > 0) t += ' 자리가 나야 다음 workgroup이 들어가요.';
        return t;
      }
      case 'eop': return '마지막 wave까지 끝났어요(박자 ' + s.ticks + '번). 다음 박자에 CP가 <b>RELEASE_MEM</b>을 처리해 fence를 써요.';
      case 'host': return '<b>fence = 1</b>이 메모리에 쓰였어요(필요하면 인터럽트도 올려요). 「fence ≥ 1」을 기다리던 <b>clFinish가 깨어나요</b>. 한 dispatch의 일생이 끝났어요.';
    }
  }

  function render() {
    const p = s.p;
    const L = {};
    ['app', 'ib', 'ring', 'cp', 'cu', 'mem'].forEach(k => { L[k] = lane(k); L[k].textContent = ''; });

    L.app.append(
      chip('clEnqueueNDRangeKernel', at('enqueue') ? 'done' : 'dim'),
      chip('clFlush', at('submit') ? 'done' : 'dim'),
      chip(at('host') ? 'clFinish 깨어남' : 'clFinish: fence ≥ 1 기다림', at('host') ? 'done' : at('submit') ? 'on' : 'dim'));

    const ibOn = at('umd');
    const regsDone = at('dispatch');
    ['SET_SH_REG PGM_LO/HI', 'SET_SH_REG PGM_RSRC1/2', 'SET_SH_REG NUM_THREAD=' + p.lws, 'SET_SH_REG USER_DATA'].forEach(t =>
      L.ib.append(chip(t, !ibOn ? 'dim' : regsDone ? 'done' : phase() === 'cp-regs' ? 'on' : '')));
    L.ib.append(chip('DISPATCH_DIRECT x=' + p.wgs, !ibOn ? 'dim' : at('run') ? 'done' : phase() === 'dispatch' ? 'on' : ''));

    L.ring.append(
      chip('INDIRECT_BUFFER → IB', !at('submit') ? 'dim' : at('cp-ib') ? 'done' : ''),
      chip('RELEASE_MEM fence=1', !at('submit') ? 'dim' : at('host') ? 'done' : phase() === 'eop' ? 'on' : ''),
      chip('doorbell wptr', !at('doorbell') ? 'dim' : at('cp-ib') ? 'done' : 'on'));

    const cpText = {
      idle: '잠듦', enqueue: '잠듦', umd: '잠듦', submit: '잠듦', doorbell: '깨어남',
      'cp-ib': '링 → IB로 점프', 'cp-regs': '레지스터 채우는 중', dispatch: 'dispatch 시작',
      run: s.pending ? 'workgroup 내려보내는 중' : '다음 패킷(RELEASE_MEM) 대기', eop: 'end-of-pipe 기다림 끝', host: 'fence 씀 · 쉼',
    }[phase()];
    L.cp.append(chip(cpText, at('doorbell') && !at('host') ? 'on' : ''));

    const grid = el('div', 'cus');
    s.cu.forEach((cu, i) => {
      const box = el('div', 'cu');
      box.appendChild(el('div', 'cu-name', 'CU' + i + ' · ' + cu.filter(w => !w.fin).length + '/' + CAP));
      const ws = el('div', 'waves');
      cu.forEach(w => ws.appendChild(el('span', 'wave' + (w.fin ? ' fin' : ''))));
      box.appendChild(ws);
      grid.appendChild(box);
    });
    L.cu.append(grid);
    if (at('dispatch')) L.cu.append(chip('기다리는 workgroup ' + s.pending, s.pending ? 'on' : 'done'));

    const mc = el('span', 'memcell' + (s.fence ? ' hit' : ''), 'fence 주소: ' + s.fence);
    L.mem.append(mc);

    say.innerHTML = msg();
    nextBtn.disabled = !!s.err || phase() === 'host';
    autoBtn.disabled = nextBtn.disabled;
  }

  function stopAuto() {
    if (timer) clearInterval(timer);
    timer = null;
    autoBtn.textContent = '자동';
  }
  function toggleAuto() {
    if (timer) return stopAuto();
    autoBtn.textContent = '멈춤';
    timer = setInterval(next, 700);
  }

  root.addEventListener('click', e => {
    const a = e.target.closest('button')?.dataset.act;
    if (a === 'next') { stopAuto(); next(); }
    else if (a === 'auto') toggleAuto();
    else if (a === 'reset') reset();
  });
  root.addEventListener('change', e => { if (e.target.dataset.k) reset(); });
  reset();
})();

/* ---------- 시뮬레이터 3 · barrier와 fence ---------- */
(function fenceSim() {
  const root = document.getElementById('sim-fence');
  if (!root) return;
  const CUS = 4, CAP = 4, A_WAVES = 8, B_WAVES = 8;
  const lane = k => $(root, '[data-lane="' + k + '"]');
  const say = $(root, '.say');
  const logEl = $(root, '.log');
  const autoBtn = $(root, '[data-act="auto"]');
  const tickBtn = $(root, '[data-act="tick"]');
  const barrierBox = $(root, '[data-k="barrier"]');
  let s, timer = null;

  function reset() {
    stopAuto();
    const pk = [{ op: 'DISPATCH A', k: 'A', n: A_WAVES }];
    if (barrierBox.checked) pk.push({ op: 'BARRIER (CS_PARTIAL_FLUSH)', k: 'wait' });
    pk.push({ op: 'DISPATCH B', k: 'B', n: B_WAVES }, { op: 'RELEASE_MEM fence=1', k: 'fence' });
    s = { pk, pc: 0, left: 0, cu: Array.from({ length: CUS }, () => []), aDone: 0, bStarted: 0, race: 0, fenceArmed: false, fence: 0, t: 0, log: [] };
    render('IB에 패킷 ' + pk.length + '개가 있어요. B는 A가 쓴 결과를 읽는 커널이에요. 「한 박자」로 시작해요.');
  }

  const liveOf = k => s.cu.reduce((n, cu) => n + cu.filter(w => w.k === k && !w.fin).length, 0);
  const log = t => s.log.unshift('t' + s.t + '  ' + t);

  function tick() {
    if (s.fence) return;
    s.t++;
    // 1) 끝난 wave 치우고, 도는 wave 한 박자 진행
    for (const cu of s.cu) for (let i = cu.length - 1; i >= 0; i--) if (cu[i].fin) cu.splice(i, 1);
    for (const cu of s.cu) for (const w of cu) {
      if (--w.left <= 0) {
        w.fin = true;
        if (w.k === 'A') { s.aDone++; }
      }
    }
    // 2) CP: 지금 패킷을 처리
    let note = '';
    const cur = s.pk[s.pc];
    if (cur) {
      if (cur.k === 'A' || cur.k === 'B') {
        if (!s.left && !cur.started) { s.left = cur.n; cur.started = true; log('CP: ' + cur.op + ' — wave ' + cur.n + '개 내려보내기 시작'); }
        let c = 0;
        for (let tries = 0; s.left > 0 && tries < CUS * CAP; tries++) {
          const cu = s.cu[c];
          if (cu.filter(w => !w.fin).length < CAP) {
            cu.push({ k: cur.k, left: cur.k === 'A' ? 3 + Math.floor(Math.random() * 3) : 2 + Math.floor(Math.random() * 2), fin: false });
            s.left--;
            if (cur.k === 'B') {
              s.bStarted++;
              if (s.aDone < A_WAVES) { s.race++; }
            }
          }
          c = (c + 1) % CUS;
        }
        if (s.left === 0) {
          s.pc++;
          note = cur.op + '의 wave를 다 내려보냈어요. CP는 <b>끝나길 기다리지 않고</b> 다음 패킷으로 가요.';
          if (cur.k === 'B' && s.race) log('B wave ' + s.race + '개가 A가 덜 끝난 상태에서 출발했어요');
        } else note = cur.op + ': 자리가 없어 wave ' + s.left + '개가 기다려요.';
      } else if (cur.k === 'wait') {
        if (liveOf('A') > 0) note = '<b>BARRIER</b>: A의 wave ' + liveOf('A') + '개가 아직 돌아요. CP가 여기서 멈춰 기다려요.';
        else { s.pc++; note = 'BARRIER 통과: A가 모두 끝났어요. 이제 B를 내려보낼 수 있어요.'; log('CP: barrier 통과'); }
      } else if (cur.k === 'fence') {
        if (!s.fenceArmed) { s.fenceArmed = true; log('CP: RELEASE_MEM 접수 — 앞의 일이 다 끝나면 fence=1'); }
        if (liveOf('A') + liveOf('B') > 0) note = '<b>RELEASE_MEM</b>은 접수됐어요. 앞의 wave ' + (liveOf('A') + liveOf('B')) + '개가 끝나야(end-of-pipe) fence를 써요.';
        else { s.fence = 1; s.pc++; log('fence=1 기록 → clFinish 깨어남'); }
      }
    }
    if (s.fence) {
      note = '<b>fence = 1.</b> clFinish가 깨어났어요. ' + (s.race
        ? '<b>그런데 B의 wave ' + s.race + '개는 A가 끝나기 전에 출발했어요.</b> B가 A의 결과를 덜 쓰인 채로 읽었을 수 있어요. fence는 「전부 끝났다」만 알려 주고, 안의 순서는 지켜 주지 않아요. barrier를 켜고 다시 해 보세요.'
        : 'B는 A가 모두 끝난 뒤에만 출발했어요. 대신 A의 마지막 wave를 기다리는 동안 CU가 놀았던 박자가 있었을 거예요. 안전과 바쁨의 맞교환이에요.');
      stopAuto();
    }
    render(note);
  }

  function render(note) {
    const L = {};
    ['pkts', 'cu', 'out', 'host'].forEach(k => { L[k] = lane(k); L[k].textContent = ''; });
    s.pk.forEach((p, i) => L.pkts.append(chip(p.op, i < s.pc ? 'done' : i === s.pc && s.t ? 'on' : '')));

    const grid = el('div', 'cus');
    s.cu.forEach((cu, i) => {
      const box = el('div', 'cu');
      box.appendChild(el('div', 'cu-name', 'CU' + i));
      const ws = el('div', 'waves');
      cu.forEach(w => ws.appendChild(el('span', 'wave' + (w.k === 'B' ? ' b' : '') + (w.fin ? ' fin' : ''))));
      box.appendChild(ws);
      grid.appendChild(box);
    });
    L.cu.append(grid);

    L.out.append(chip('A가 쓴 칸 ' + s.aDone + '/' + A_WAVES, s.aDone === A_WAVES ? 'done' : s.aDone ? 'on' : ''));
    if (s.bStarted) L.out.append(chip('A가 덜 끝났을 때 출발한 B wave: ' + s.race, s.race ? 'on' : 'done'));
    if (s.race) L.out.lastChild.style.borderColor = 'var(--bad)';

    L.host.append(el('span', 'memcell' + (s.fence ? ' hit' : ''), 'fence 주소: ' + s.fence));
    L.host.append(el('span', 'waiter ' + (s.fence ? 'free' : 'blocked'), s.fence ? 'clFinish: 깨어남' : 'clFinish: fence ≥ 1 기다림'));

    say.innerHTML = note;
    logEl.textContent = s.log.join('\n');
    tickBtn.disabled = autoBtn.disabled = !!s.fence;
  }

  function stopAuto() {
    if (timer) clearInterval(timer);
    timer = null;
    autoBtn.textContent = '자동';
  }
  root.addEventListener('click', e => {
    const a = e.target.closest('button')?.dataset.act;
    if (a === 'tick') { stopAuto(); tick(); }
    else if (a === 'auto') {
      if (timer) stopAuto();
      else { autoBtn.textContent = '멈춤'; timer = setInterval(tick, 650); }
    } else if (a === 'reset') reset();
  });
  barrierBox.addEventListener('change', reset);
  reset();
})();

/* ---------- 확인 퀴즈 ---------- */
(function quiz() {
  const root = document.getElementById('quiz');
  if (!root) return;
  const QS = [
    {
      q: 'clEnqueueNDRangeKernel이 돌아온 직후, GPU의 CP는 이 dispatch를 알고 있을까요?',
      a: ['반드시 알고 있다', '아직 모를 수 있다 — 제출과 doorbell이 있어야 안다', '커널이 이미 끝났다'],
      r: 1,
      why: 'enqueue는 벨트에 상자를 올리는 일이에요. 런타임이 제출하고 KMD가 doorbell을 울려야 CP가 알아요.',
    },
    {
      q: '드라이버가 링에 패킷을 썼는데 doorbell을 안 울렸어요. CP는?',
      a: ['그 패킷을 읽는다', '모른다 — 알린 wptr까지만 읽는다', '링이 꽉 찼다고 판단한다'],
      r: 1,
      why: 'CP는 doorbell로 알려 준 wptr까지만 읽어요. 써 놓는 것과 알리는 것은 다른 일이에요.',
    },
    {
      q: 'workgroup 크기(local size)는 PM4에서 어디에 들어갈까요?',
      a: ['DISPATCH_DIRECT의 x·y·z', 'SET_SH_REG로 쓰는 COMPUTE_NUM_THREAD_X/Y/Z', 'RELEASE_MEM의 값'],
      r: 1,
      why: 'DISPATCH_DIRECT에는 workgroup의 개수가, NUM_THREAD 레지스터에는 workgroup 하나의 크기가 들어가요.',
    },
    {
      q: 'local 256, wave64인 workgroup 하나의 wave 4개는 어디에서 돌까요?',
      a: ['CU 4개에 하나씩 흩어진다', '같은 CU에 모인다', '디스패처가 매번 무작위로 정한다'],
      r: 1,
      why: '한 workgroup은 LDS와 barrier를 같이 써야 해서 한 CU(RDNA의 WGP 모드에선 한 WGP)에 모여요.',
    },
    {
      q: 'fence가 1이 됐다면, 같은 제출 안의 커널 B가 커널 A의 결과를 제대로 읽었다고 말할 수 있을까요?',
      a: ['그렇다 — fence가 순서를 보장한다', '아니다 — 그건 A와 B 사이의 barrier가 정한다', '그렇다 — CP는 dispatch가 끝나야 다음 패킷을 읽는다'],
      r: 1,
      why: 'fence는 「여기까지 전부 끝났다」만 알려 줘요. CP는 dispatch 뒤 기다리지 않고 다음 패킷으로 가니, A와 B 사이 순서는 barrier가 지켜요.',
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
