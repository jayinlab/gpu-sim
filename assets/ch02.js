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
const ST = { Q: 'QUEUED', S: 'SUBMITTED', R: 'RUNNING', C: 'COMPLETE' };

/* ---------- 시뮬레이터 1 · 층마다 대기열 ---------- */
(function layers() {
  const root = document.getElementById('sim-layers');
  if (!root) return;
  const STATIONS = ['OpenCL 큐 · ANGLE 기록', 'Vulkan 큐', 'KMD 스케줄러', '링 · doorbell', 'GPU 실행', '완료'];
  const RUN = 2; // 커널 하나가 GPU에서 도는 박자
  const say = $(root, '.say'), logEl = $(root, '.log'), host = $(root, '.hostline');
  const stEl = $(root, '.stations');
  const autoBox = $(root, '[data-k="auto"]');
  let s, timer = null;

  function reset() {
    stop();
    s = { n: 0, cmds: [], batches: [], nb: 0, t: 0, idle: 0, blocked: false, log: [] };
    render('커널을 넣어 보세요. <b>clEnqueueNDRangeKernel</b>은 곧바로 돌아와요.');
  }
  const log = t => s.log.unshift('t' + s.t + '  ' + t);
  const queued = () => s.cmds.filter(c => c.batch == null);

  function flush(why) {
    const q = queued();
    if (!q.length) return false;
    const b = { id: ++s.nb, cmds: q.map(c => c.id), at: 1, left: 0, cur: 0 };
    q.forEach(c => { c.batch = b.id; c.st = 'S'; });
    s.batches.push(b);
    log(why + ' → vkQueueSubmit 제출 #' + b.id + ' (' + q.map(c => 'k' + c.id).join(', ') + ')');
    s.idle = 0;
    return true;
  }

  function tick() {
    s.t++;
    let note = '';
    // 앞 정거장부터 처리해 한 박자에 한 칸씩만 움직이게
    const gpuBusy = s.batches.some(b => b.at === 4);
    for (const b of [...s.batches].sort((x, y) => y.at - x.at)) {
      if (b.at === 4) {
        const c = s.cmds.find(c => c.id === b.cmds[b.cur]);
        if (c.st !== 'R') { c.st = 'R'; b.left = RUN; }
        if (--b.left <= 0) {
          c.done = true; b.cur++;
          if (b.cur >= b.cmds.length) {
            b.at = 5;
            b.cmds.forEach(id => { s.cmds.find(c => c.id === id).st = 'C'; });
            log('제출 #' + b.id + '의 fence가 써짐 → ' + b.cmds.map(id => 'k' + id).join(', ') + ' COMPLETE');
          } else {
            const n = s.cmds.find(c => c.id === b.cmds[b.cur]);
            n.st = 'R'; b.left = RUN;
          }
        }
      } else if (b.at === 3) {
        if (!gpuBusy && !s.batches.some(o => o.at === 4)) { b.at = 4; const c = s.cmds.find(c => c.id === b.cmds[0]); c.st = 'R'; b.left = RUN; log('CP가 제출 #' + b.id + ' 묶음을 읽고 실행 시작'); }
      } else if (b.at === 2) {
        b.at = 3; log('스케줄러가 제출 #' + b.id + ' 묶음을 링에 쓰고 doorbell');
      } else if (b.at === 1) {
        b.at = 2; log('드라이버가 제출 #' + b.id + ' 묶음을 커널에 넘김 (job)');
      }
    }
    if (queued().length) {
      s.idle++;
      if (autoBox.checked && s.idle >= 3) { flush('런타임이 알아서'); note = '런타임이 기다리다 <b>알아서 제출</b>했어요. 사양이 허락하는 일이지만 언제 할지는 구현 마음이에요.'; }
      else if (!autoBox.checked) note = '시간이 흘러도 <b>QUEUED 명령은 그대로</b>예요. 이 모델에서는 아무도 제출하지 않았으니 GPU가 이 명령을 몰라요.';
    }
    if (s.blocked && s.cmds.every(c => c.st === 'C')) {
      s.blocked = false; stop();
      note = '모든 명령이 COMPLETE가 되어 <b>clFinish가 돌아왔어요</b>. 그동안 호출한 스레드는 막혀 있었어요.';
      log('clFinish 돌아옴');
    }
    render(note || describe());
  }

  function describe() {
    const c = s.cmds;
    if (!c.length) return '아무것도 없어요.';
    const by = k => c.filter(x => x.st === k).length;
    return 'QUEUED ' + by('Q') + ' · SUBMITTED ' + by('S') + ' · RUNNING ' + by('R') + ' · COMPLETE ' + by('C') + (s.blocked ? ' — 호스트는 clFinish에서 기다리는 중이에요.' : '');
  }

  const act = {
    enq() {
      if (s.blocked) return render('호스트 스레드가 clFinish에서 막혀 있어서 지금은 새 명령을 넣을 수 없어요.');
      s.cmds.push({ id: ++s.n, st: 'Q', batch: null });
      log('clEnqueueNDRangeKernel(k' + s.n + ') → 바로 돌아옴');
      render('<b>k' + s.n + '</b>이 OpenCL 큐에 들어갔어요(QUEUED). 호출은 바로 돌아왔고, 이 모델에서 GPU는 아직 이 커널을 몰라요.');
    },
    flush() {
      if (s.blocked) return;
      if (!flush('clFlush')) return render('보낼 QUEUED 명령이 없어요.');
      log('clFlush 돌아옴');
      render('<b>clFlush가 바로 돌아왔어요.</b> 명령들은 SUBMITTED가 됐지만 아직 드라이버·스케줄러·링을 건너는 중이에요. GPU가 이미 시작했다는 뜻은 아니에요. 시간을 흘려 보세요.');
    },
    finish() {
      if (s.blocked) return;
      if (!s.cmds.length || s.cmds.every(c => c.st === 'C')) return render('끝나지 않은 명령이 없어서 clFinish가 바로 돌아와요.');
      flush('clFinish 안의 flush');
      s.blocked = true;
      render('<b>clFinish</b>: 남은 명령을 먼저 제출하고, 모두 끝날 때까지 이 스레드를 막아요. 시간이 저절로 흘러요.');
      timer = setInterval(tick, 550);
    },
    tick() { if (!s.blocked) tick(); },
    reset,
  };

  function stop() { if (timer) clearInterval(timer); timer = null; }

  function render(msg) {
    stEl.textContent = '';
    STATIONS.forEach((name, i) => {
      const box = el('div', 'station');
      box.appendChild(el('div', 'station-name', name));
      const body = el('div', 'station-body');
      if (i === 0) queued().forEach(c => body.appendChild(chip('k' + c.id, 'on')));
      else s.batches.filter(b => b.at === i).forEach(b => {
        const g = el('div', 'batch');
        g.appendChild(el('div', 'batch-name', '제출 #' + b.id));
        b.cmds.forEach(id => {
          const c = s.cmds.find(c => c.id === id);
          g.appendChild(chip('k' + id, c.st === 'C' ? 'done' : c.st === 'R' ? 'run' : ''));
        });
        body.appendChild(g);
      });
      box.appendChild(body);
      stEl.appendChild(box);
    });
    host.textContent = '';
    host.appendChild(el('span', 'waiter ' + (s.blocked ? 'blocked' : 'free'), s.blocked ? '호스트: clFinish에서 막힘' : '호스트: 자유롭게 일하는 중'));
    s.cmds.forEach(c => host.appendChild(chip('k' + c.id + ' ' + ST[c.st], c.st === 'C' ? 'done' : c.st === 'R' ? 'run' : c.st === 'S' ? 'on' : '')));
    say.innerHTML = msg;
    logEl.textContent = s.log.join('\n');
  }

  root.addEventListener('click', e => {
    const a = e.target.closest('button')?.dataset.act;
    if (a && act[a]) act[a]();
  });
  reset();
})();

/* ---------- 시뮬레이터 2 · flush를 잊은 두 큐 ---------- */
(function twoQueues() {
  const root = document.getElementById('sim-two');
  if (!root) return;
  const box = $(root, '.twoq'), say = $(root, '.say');
  let s, timer = null;

  function reset() {
    if (timer) clearInterval(timer);
    timer = null;
    s = { k1: null, k2: null, flushedA: false, waiting: false, t: 0 };
    render('두 큐가 있어요. B의 k2는 A의 k1이 끝나야 시작할 수 있어요. 순서대로 넣고 <b>clFinish(B)</b>를 불러 보세요. clFlush(A)를 부를지 말지에 따라 결과가 달라져요.');
  }

  function step() {
    s.t++;
    const { k1, k2 } = s;
    if (k1 && k1 !== 'Q' && k1 !== 'C') {
      if (k1 === 'S') s.k1 = 'R';
      else if (k1 === 'R') s.k1 = 'C';
    }
    if (k2 === 'S' && s.k1 === 'C') s.k2 = 'R';
    else if (k2 === 'R') s.k2 = 'C';

    if (s.k2 === 'C') {
      clearInterval(timer); timer = null; s.waiting = false;
      return render('k1이 끝나자 k2가 풀려서 돌았고, <b>clFinish(B)가 돌아왔어요.</b> A를 flush해 두었기 때문이에요.');
    }
    if (s.k1 === 'Q' && s.t >= 6) {
      clearInterval(timer); timer = null;
      return render('<b>이 모델에서는 더 진행하지 못해요.</b> k2는 k1의 event를 기다리는데, k1은 아직 큐 A에 QUEUED로 앉아 있어요. 호스트 스레드는 clFinish(B)에서 막혀 있으니 A를 flush할 사람이 없어요. 이 가상의 런타임은 알아서 보내 주지 않으니 계속 기다려요.');
    }
    render(s.k1 === 'Q' ? 'clFinish(B)가 기다리는 중… k2는 SUBMITTED지만 k1의 event가 끝나야 시작할 수 있어요. k1은 어디 있죠?' : 'clFinish(B)가 기다리는 중… k1이 돌고 있어요.');
  }

  const act = {
    a() { if (s.waiting || s.k1) return; s.k1 = 'Q'; render('큐 A에 <b>k1</b>을 넣었어요(QUEUED).'); },
    b() {
      if (s.waiting || s.k2) return;
      if (!s.k1) return render('k2가 기다릴 k1의 event가 아직 없어요. 큐 A에 k1부터 넣어 주세요.');
      s.k2 = 'Q'; render('큐 B에 <b>k2</b>를 넣었어요. 대기 목록에 k1의 event를 걸었어요.');
    },
    flushA() {
      if (s.waiting) return;
      if (s.k1 !== 'Q') return render(s.k1 ? 'k1은 이미 제출됐어요.' : '큐 A가 비어 있어요.');
      s.k1 = 'S'; s.flushedA = true; render('<b>clFlush(A)</b>: k1이 SUBMITTED가 됐어요. 이제 B가 k1을 기다려도 k1은 언젠가 GPU에 닿아요.');
    },
    finishB() {
      if (s.waiting) return;
      if (!s.k2) return render('큐 B가 비어 있어요. k1과 k2를 먼저 넣어 주세요.');
      if (s.k2 === 'C') return render('이미 끝났어요. 「처음부터」로 다시 해 보세요.');
      s.k2 = 'S'; s.waiting = true; s.t = 0;
      render('<b>clFinish(B)</b>: B를 flush해서 k2가 SUBMITTED가 됐고, 호스트 스레드는 k2가 끝날 때까지 막혀요.');
      timer = setInterval(step, 650);
    },
    reset,
  };

  function lane(name, k, deps) {
    const l = el('div', 'qlane');
    l.appendChild(el('div', 'qname', name));
    const body = el('div', 'lane-body');
    if (k) body.appendChild(chip(deps + ' ' + ST[k], k === 'C' ? 'done' : k === 'R' ? 'run' : k === 'S' ? 'on' : ''));
    else body.appendChild(el('span', 'muted', '비어 있음'));
    l.appendChild(body);
    return l;
  }
  function render(msg) {
    box.textContent = '';
    box.appendChild(lane('큐 A', s.k1, 'k1'));
    box.appendChild(lane('큐 B', s.k2, 'k2 (k1 기다림)'));
    const h = el('div', 'qlane');
    h.appendChild(el('div', 'qname', '호스트'));
    const hb = el('div', 'lane-body');
    hb.appendChild(el('span', 'waiter ' + (s.waiting ? 'blocked' : 'free'), s.waiting ? 'clFinish(B)에서 막힘' : '자유'));
    h.appendChild(hb);
    box.appendChild(h);
    say.innerHTML = msg;
  }
  root.addEventListener('click', e => {
    const a = e.target.closest('button')?.dataset.act;
    if (a && act[a]) act[a]();
  });
  reset();
})();

/* ---------- 시뮬레이터 3 · 묶음 크기와 비용 ---------- */
(function batching() {
  const root = document.getElementById('sim-batch');
  if (!root) return;
  const N = 12, ENQ = 1;
  const tl = $(root, '.tl'), say = $(root, '.say');
  const v = k => +$(root, '[data-k="' + k + '"]').value;

  function model(k, sub, run) {
    const host = [], gpu = [];
    let t = 0, gpuFree = 0, subs = 0, firstStart = null, idle = 0;
    for (let i = 0; i < N; i += k) {
      const n = Math.min(k, N - i);
      host.push({ a: t, b: t + n * ENQ, kind: 'enq', label: n + '개 기록' });
      t += n * ENQ;
      host.push({ a: t, b: t + sub, kind: 'sub', label: '제출' });
      t += sub; subs++;
      const start = Math.max(gpuFree, t);
      if (firstStart == null) firstStart = start; else idle += start - gpuFree;
      gpu.push({ a: start, b: start + n * run, kind: 'run', label: n + '개' });
      gpuFree = start + n * run;
    }
    return { host, gpu, end: gpuFree, subs, subTime: subs * sub, firstStart, idle };
  }

  function render() {
    const k = v('k'), sub = v('sub'), run = v('run');
    const m = model(k, sub, run);
    // 같은 비용에서 묶음 크기별 끝나는 때를 비교
    const sizes = [1, 2, 3, 4, 6, 12];
    const ends = sizes.map(x => model(x, sub, run).end);
    const best = Math.min(...ends);
    const span = Math.max(...ends);
    tl.textContent = '';
    const row = (name, segs) => {
      const r = el('div', 'tl-row');
      r.appendChild(el('div', 'tl-name', name));
      const track = el('div', 'tl-track');
      segs.forEach(sg => {
        const d = el('div', 'tl-seg ' + sg.kind, sg.b - sg.a >= span / 14 ? sg.label : '');
        d.style.left = (sg.a / span * 100) + '%';
        d.style.width = ((sg.b - sg.a) / span * 100) + '%';
        d.title = sg.label + ' (' + sg.a + '–' + sg.b + ')';
        track.appendChild(d);
      });
      r.appendChild(track);
      tl.appendChild(r);
    };
    row('호스트', m.host);
    row('GPU', m.gpu);
    const cmp = el('div', 'tl-cmp');
    sizes.forEach((x, i) => {
      const c = chip(x + '개씩 → ' + ends[i], x === k ? 'on' : ends[i] === best ? 'done' : '');
      cmp.appendChild(c);
    });
    tl.appendChild(cmp);
    say.innerHTML = '<b>' + k + '개마다 flush</b>: 제출 ' + m.subs + '번, 호스트가 제출에 쓴 시간 ' + m.subTime +
      ', GPU 첫 시작 ' + m.firstStart + ', 시작 뒤 GPU가 논 시간 ' + m.idle + ', 모두 끝난 때 <b>' + m.end + '</b>. ' +
      (m.end === best ? '이 비용에서는 가장 빨라요.' : '이 비용에서 가장 빠른 건 ' + sizes.filter((x, i) => ends[i] === best).join('·') + '개씩(' + best + ')이에요.') +
      ' 아래 칩은 같은 비용에서 묶음 크기별로 끝나는 때예요.';
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
      q: 'clEnqueueNDRangeKernel이 막 돌아왔어요. 그 명령의 event 상태로 가장 그럴듯한 것은?',
      a: ['CL_QUEUED', 'CL_RUNNING', 'CL_COMPLETE'],
      r: 0,
      why: '처음 상태는 QUEUED예요. 다만 enqueue가 돌아왔을 때 구현이 이미 제출했을 수도 있어요. 여기서는 아직 제출하지 않은 경우를 고른 거예요.',
    },
    {
      q: 'clFlush가 돌아왔어요. 사양이 보장하는 것은?',
      a: ['커널이 끝났다', '앞서 넣은 명령들이 언젠가 디바이스에 제출된다', 'doorbell이 이미 울렸다'],
      r: 1,
      why: 'clFlush는 「언젠가 제출된다」까지만 보장해요. 끝났다거나 GPU가 이미 받았다는 보장은 없어요.',
    },
    {
      q: '큐 B의 커널이 큐 A에 넣은 커널의 event를 기다려요. 앱이 꼭 해야 하는 것은?',
      a: ['아무것도 — 런타임이 알아서 한다', '큐 A를 clFlush하거나 암묵 flush를 하는 호출을 부른다', '큐 B를 두 번 flush한다'],
      r: 1,
      why: '사양은 다른 큐의 event를 기다리게 하려면 그 event를 낸 큐를 flush하라고 해요. 안 하면 구현에 따라 영원히 기다릴 수 있어요.',
    },
    {
      q: 'AMD Vulkan 드라이버(radv 등)에서 dispatch의 PM4가 IB에 적히는 때는?',
      a: ['vkCmdDispatch를 기록할 때', 'vkQueueSubmit을 부를 때', 'CP가 링을 읽을 때'],
      r: 0,
      why: '기록 호출 때 command buffer의 IB에 PM4를 적고, 제출은 이미 적힌 IB를 커널에 넘겨요.',
    },
    {
      q: '커널 12개를 하나 넣을 때마다 flush했어요. 가장 먼저 의심할 비용은?',
      a: ['GPU 커널 시간', '제출마다 드는 호스트 고정비와 GPU의 짧은 빈틈', 'VGPR 부족'],
      r: 1,
      why: '짧은 커널을 하나씩 보내면 제출 고정비가 쌓이고, GPU는 다음 제출을 기다리며 조각조각 놀아요.',
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
