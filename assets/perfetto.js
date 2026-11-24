/* GPU Sim · Perfetto로 열기 (공용)
   시뮬레이터가 만든 trace(Chrome trace JSON)를 ui.perfetto.dev 새 탭에 postMessage로 건넨다.
   방식은 Perfetto 문서 「Deep linking to Perfetto UI」: 새 탭을 열고 'PING' → 'PONG'을 받으면 버퍼를 보낸다.
   trace는 브라우저 안에서만 오가고 서버로 가지 않는다. */
(() => {
'use strict';
const PF = 'https://ui.perfetto.dev';

// 클릭 핸들러 안에서 바로 불러야 팝업 차단에 안 걸린다. 새 탭을 못 열면 false.
function open(trace, title, fileName) {
  const w = window.open(PF);
  if (!w) return false;
  const buffer = new TextEncoder().encode(JSON.stringify(trace)).buffer;
  let n = 0, iv = null;
  const done = () => { clearInterval(iv); window.removeEventListener('message', onMsg); };
  const onMsg = e => {
    if (e.origin !== PF || e.data !== 'PONG') return;
    done();
    w.postMessage({ perfetto: { buffer, title, fileName } }, PF);
  };
  window.addEventListener('message', onMsg);
  iv = setInterval(() => { if (w.closed || ++n > 120) { done(); return; } w.postMessage('PING', PF); }, 250);
  return true;
}

// trace 조립 도우미. 시간 단위는 호출하는 쪽의 「박자」, US = 박자 하나의 마이크로초
function builder(US) {
  const E = [];
  return {
    E,
    proc(pid, name, sort) {
      E.push({ ph: 'M', pid, name: 'process_name', args: { name } });
      E.push({ ph: 'M', pid, name: 'process_sort_index', args: { sort_index: sort } });
    },
    thread(pid, tid, name, sort) {
      E.push({ ph: 'M', pid, tid, name: 'thread_name', args: { name } });
      E.push({ ph: 'M', pid, tid, name: 'thread_sort_index', args: { sort_index: sort } });
    },
    slice(pid, tid, name, a, b, args) { E.push({ ph: 'X', pid, tid, name, ts: a * US, dur: Math.max(0, b - a) * US, args: args || {} }); },
    instant(pid, tid, name, t, args) { E.push({ ph: 'i', s: 't', pid, tid, name, ts: t * US, args: args || {} }); },
    counter(pid, name, t, values) { E.push({ ph: 'C', pid, name, ts: t * US, args: values }); },
    done() { return { traceEvents: E, displayTimeUnit: 'ms' }; },
  };
}

window.GPUSimPerfetto = { open, builder };
})();
