/* GPU Sim 탐색 지도 — 메인은 전체 지도, 장마다 그 장이 다룬 칸만 색칠한다.
   장을 더할 땐 CHAPTERS에 한 줄, 새 칸이 필요하면 NODES·EDGES에 더한다. */
(() => {
'use strict';

const W = 120, H = 48;
const NODES = [
  { id: 'app',      x: 20,  y: 36,  t: '앱',               s: 'OpenCL API' },
  { id: 'angle',    x: 160, y: 36,  t: 'ANGLE · CL',       s: 'OpenCL → Vulkan' },
  { id: 'vk',       x: 300, y: 36,  t: 'Vulkan API',       s: '기록 · 제출' },
  { id: 'wait',     x: 440, y: 36,  t: '완료 대기',          s: 'clFinish · event' },
  { id: 'clspv',    x: 20,  y: 126, t: 'clspv',            s: 'OpenCL C → SPIR-V' },
  { id: 'compiler', x: 160, y: 126, t: 'UMD 컴파일러',       s: 'SPIR-V → ISA' },
  { id: 'umd',      x: 300, y: 126, t: 'UMD 명령 기록',      s: 'PM4 → IB' },
  { id: 'ib',       x: 160, y: 216, t: 'IB',               s: 'PM4 패킷 묶음' },
  { id: 'kmd',      x: 300, y: 216, t: 'KMD',              s: 'amdgpu · 제출' },
  { id: 'ring',     x: 160, y: 330, t: '링 버퍼',           s: 'rptr · wptr' },
  { id: 'doorbell', x: 300, y: 330, t: 'Doorbell',         s: '새 wptr 알림' },
  { id: 'cp',       x: 230, y: 446, t: 'CP · MEC',         s: '패킷 해석' },
  { id: 'fence',    x: 440, y: 446, t: 'Fence',            s: 'GFX9: RELEASE_MEM' },
  { id: 'disp',     x: 230, y: 536, t: '디스패처',           s: 'workgroup → wave' },
  { id: 'cache',    x: 20,  y: 626, t: '캐시 · 메모리',      s: '가시성 · 동기화' },
  { id: 'cu',       x: 230, y: 626, t: 'CU',               s: 'wave 실행' },
  { id: 'regs',     x: 440, y: 626, t: 'VGPR·SGPR·LDS',    s: 'wave 레지스터 · WG LDS' },
];
const EDGES = [
  ['app', 'angle'], ['angle', 'vk'], ['vk', 'umd'],
  ['angle', 'clspv', 'code'], ['clspv', 'compiler', 'code'],
  ['umd', 'ib'], ['umd', 'kmd'],
  ['kmd', 'ring'], ['kmd', 'doorbell'],
  ['ring', 'ib', 'jump'],
  ['ring', 'cp'], ['doorbell', 'cp'],
  ['cp', 'disp'], ['cp', 'fence'],
  ['disp', 'cu'], ['cu', 'regs'], ['cu', 'cache'],
  ['fence', 'wait', 'back'],
];
const BANDS = [
  { t: '호스트 (CPU)', y: 8,   h: 278 },
  { t: '경계',         y: 300, h: 104 },
  { t: 'GPU',          y: 420, h: 290 },
];

// main = 주로 다룬 칸, touch = 스쳐 간 칸, at = 칸을 누르면 갈 절
const CHAPTERS = [
  {
    id: 'ch01', no: '01', status: 'published', color: 'var(--c1)',
    title: '커맨드가 Queue를 거쳐 CU에 닿기까지', href: 'ch01/',
    main: ['ib', 'kmd', 'ring', 'doorbell', 'cp', 'fence', 'cu'],
    touch: ['app', 'umd', 'wait', 'disp', 'cache', 'regs'],
    at: { app: 's1', umd: 's1', kmd: 's1', ring: 's2', doorbell: 's2', ib: 's3', cp: 's3',
          disp: 's4', cu: 's4', regs: 's4', fence: 's5', wait: 's5', cache: 's5' },
  },
  {
    id: 'ch02', no: '02', status: 'published', color: 'var(--c2)',
    title: 'Queue — 넣기·보내기·알리기는 다른 시점', href: 'ch02/',
    main: ['app', 'angle', 'vk', 'umd', 'kmd'],
    touch: ['wait', 'ib', 'ring', 'doorbell'],
    at: { app: 's1', angle: 's2', vk: 's2', umd: 's2', kmd: 's2', ib: 's2', ring: 's2', doorbell: 's2', wait: 's3' },
  },
];

const NS = 'http://www.w3.org/2000/svg';
const node = id => NODES.find(n => n.id === id);
const mk = (tag, attrs, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};

// 상자 중심에서 (tx, ty) 쪽으로 나가는 선이 테두리와 만나는 점
function exit(n, tx, ty) {
  const cx = n.x + W / 2, cy = n.y + H / 2, dx = tx - cx, dy = ty - cy;
  const t = Math.min(dx ? (W / 2 + 3) / Math.abs(dx) : Infinity, dy ? (H / 2 + 3) / Math.abs(dy) : Infinity);
  return [cx + dx * t, cy + dy * t];
}
const center = n => [n.x + W / 2, n.y + H / 2];

function draw(svg) {
  svg.setAttribute('viewBox', '0 0 580 720');
  svg.setAttribute('class', 'gmap');
  const defs = mk('defs', {}, svg);
  const m = mk('marker', { id: svg.id + '-arw', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
  mk('path', { d: 'M0,0 L10,5 L0,10 z', class: 'gmap-arw' }, m);

  BANDS.forEach(b => {
    mk('rect', { x: 4, y: b.y, width: 572, height: b.h, rx: 14, class: 'gmap-band' }, svg);
    mk('text', { x: 16, y: b.y + 18, class: 'gmap-band-t' }, svg).textContent = b.t;
  });
  // 컴파일러와 명령 기록은 둘 다 Vulkan 드라이버(UMD) 안의 일이라 한 테두리로 묶는다
  mk('rect', { x: 151, y: 118, width: 278, height: 72, rx: 13, class: 'gmap-group' }, svg);
  mk('text', { x: 290, y: 114, class: 'gmap-group-t' }, svg).textContent = 'Vulkan 드라이버';

  // 노드 상자는 y+6에 그려지므로 선도 6 내려 그린다
  EDGES.forEach(([f, t, kind, via]) => {
    const a = node(f), b = node(t);
    const [ax, ay] = via ? exit(a, via[0], via[1]) : exit(a, ...center(b));
    const [bx, by] = via ? exit(b, via[0], via[1]) : exit(b, ...center(a));
    const d = via ? `M${ax},${ay + 6} Q${via[0]},${via[1] + 6} ${bx},${by + 6}` : `M${ax},${ay + 6} L${bx},${by + 6}`;
    mk('path', { d, fill: 'none', class: 'gmap-edge' + (kind ? ' ' + kind : ''), 'marker-end': 'url(#' + svg.id + '-arw)', 'data-f': f, 'data-t': t }, svg);
  });

  const g = {};
  NODES.forEach(n => {
    const a = mk('a', { class: 'gmap-node', 'data-id': n.id, tabindex: 0, role: 'button', 'aria-label': n.t }, svg);
    mk('rect', { x: n.x, y: n.y + 6, width: W, height: H, rx: 10 }, a);
    mk('text', { x: n.x + W / 2, y: n.y + 26, class: 'gmap-t' }, a).textContent = n.t;
    mk('text', { x: n.x + W / 2, y: n.y + 42, class: 'gmap-s' }, a).textContent = n.s;
    g[n.id] = a;
  });
  // 점선 두 개는 뜻을 칸 옆에 적는다
  mk('text', { x: 226, y: 298, class: 'gmap-elabel' }, svg).textContent = 'IB를 따라감';
  mk('text', { x: 506, y: 300, class: 'gmap-elabel' }, svg).textContent = '완료 관찰';
  mk('text', { x: 24, y: 124, class: 'gmap-elabel' }, svg).textContent = 'compile chain';
  mk('text', { x: 286, y: 214, class: 'gmap-elabel' }, svg).textContent = '기록';
  mk('text', { x: 366, y: 214, class: 'gmap-elabel' }, svg).textContent = '제출';
  return g;
}

function paint(g, svg, ch, mode) {
  Object.entries(g).forEach(([id, a]) => {
    a.classList.remove('main', 'touch', 'off', 'empty');
    a.style.removeProperty('--cc');
    if (!ch) return;
    if (ch.main.includes(id)) { a.classList.add('main'); a.style.setProperty('--cc', ch.color); }
    else if (ch.touch.includes(id)) { a.classList.add('touch'); a.style.setProperty('--cc', ch.color); }
    else a.classList.add(mode === 'chapter' ? 'off' : 'off');
  });
  svg.querySelectorAll('.gmap-edge').forEach(l => {
    const on = ch && [...ch.main, ...ch.touch].includes(l.dataset.f) && [...ch.main, ...ch.touch].includes(l.dataset.t);
    l.classList.toggle('lit', !!on);
    if (on) l.style.setProperty('--cc', ch.color); else l.style.removeProperty('--cc');
  });
}

// 메인: 칸마다 처음 「주로」 다룬 공개 장의 색, 아무도 안 다룬 칸은 빈 땅
function paintOverview(g, svg) {
  const pub = CHAPTERS.filter(c => c.status === 'published');
  Object.entries(g).forEach(([id, a]) => {
    a.classList.remove('main', 'touch', 'off', 'empty');
    const m = pub.find(c => c.main.includes(id)), t = pub.find(c => c.touch.includes(id));
    if (m) { a.classList.add('main'); a.style.setProperty('--cc', m.color); }
    else if (t) { a.classList.add('touch'); a.style.setProperty('--cc', t.color); }
    else { a.classList.add('empty'); a.style.removeProperty('--cc'); }
  });
  svg.querySelectorAll('.gmap-edge').forEach(l => { l.classList.remove('lit'); l.style.removeProperty('--cc'); });
}

function renderIndex(root) {
  const svg = mk('svg', { id: 'gmap-index', role: 'img', 'aria-label': 'GPU 탐색 지도' }, root.querySelector('.gmap-wrap'));
  const g = draw(svg);
  const list = root.querySelector('.gmap-chapters');
  const panel = root.querySelector('.gmap-panel');
  const idle = '칸을 누르면 그 칸을 다루는 장이 보여요. 장에 손을 올리면 그 장이 지나간 길만 켜져요.';
  panel.textContent = idle;

  CHAPTERS.forEach(c => {
    const li = document.createElement('li');
    li.className = 'gmap-ch ' + c.status;
    li.style.setProperty('--cc', c.color);
    const head = c.href ? document.createElement('a') : document.createElement('span');
    if (c.href) head.href = c.href;
    head.innerHTML = '<span class="num">' + c.no + '</span>' + c.title;
    li.appendChild(head);
    const d = document.createElement('span');
    d.className = 'desc';
    d.textContent = (c.status === 'planned' ? '예정 · ' : '') + '주로 ' + c.main.map(id => node(id).t).join(', ');
    li.appendChild(d);
    const on = () => paint(g, svg, c, 'index'), off = () => paintOverview(g, svg);
    li.addEventListener('mouseenter', on); li.addEventListener('mouseleave', off);
    li.addEventListener('focusin', on); li.addEventListener('focusout', off);
    list.appendChild(li);
  });

  const pick = id => {
    const n = node(id);
    const hits = CHAPTERS.map(c => ({ c, k: c.main.includes(id) ? '주로' : c.touch.includes(id) ? '스쳐 감' : null })).filter(h => h.k);
    panel.textContent = '';
    const b = document.createElement('b'); b.textContent = n.t; panel.appendChild(b);
    panel.appendChild(document.createTextNode(' — ' + n.s + '. '));
    if (!hits.length) { panel.appendChild(document.createTextNode('아직 어느 장도 다루지 않은 빈 땅이에요.')); return; }
    hits.forEach((h, i) => {
      if (i) panel.appendChild(document.createTextNode(' · '));
      if (h.c.href && h.c.status === 'published') {
        const a = document.createElement('a');
        a.href = h.c.href + (h.c.at[id] ? '#' + h.c.at[id] : '');
        a.textContent = h.c.no + '장';
        panel.appendChild(a);
      } else panel.appendChild(document.createTextNode(h.c.no + '장(예정)'));
      panel.appendChild(document.createTextNode(' ' + h.k));
    });
    Object.values(g).forEach(a => a.classList.toggle('picked', a.dataset.id === id));
  };
  Object.values(g).forEach(a => {
    a.addEventListener('click', () => pick(a.dataset.id));
    a.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(a.dataset.id); } });
  });
  paintOverview(g, svg);
}

function renderChapter(root, chId) {
  const ch = CHAPTERS.find(c => c.id === chId);
  const svg = mk('svg', { id: 'gmap-' + chId, role: 'img', 'aria-label': ch.no + '장이 다루는 곳' }, root.querySelector('.gmap-wrap'));
  const g = draw(svg);
  paint(g, svg, ch, 'chapter');
  Object.values(g).forEach(a => {
    const to = ch.at[a.dataset.id];
    if (!to) { a.removeAttribute('tabindex'); a.removeAttribute('role'); return; }
    const go = () => document.getElementById(to)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    a.addEventListener('click', go);
    a.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

document.querySelectorAll('[data-gmap]').forEach(root => {
  const v = root.dataset.gmap;
  if (v === 'index') renderIndex(root); else renderChapter(root, v);
});
window.GPUMap = { NODES, EDGES, CHAPTERS };
})();
