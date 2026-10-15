# gpu-sim

GPU를 드라이버 쪽 시선(Queue → PM4 → CP → CU)으로 한 박자씩 넘겨 보는 정적 시뮬레이터 모음.
빌드 도구 없음 — HTML·CSS·JS 파일 그대로 GitHub Pages로 나간다.

- `index.html` — 목차
- `chNN/index.html` — 장마다 글 + 시뮬레이터 + 핵심 정리 + 퀴즈
- `assets/` — 공통 스타일과 장별 스크립트

로컬 미리보기: `python3 -m http.server 8091` 후 `http://localhost:8091/`.

규칙: 회사 자료를 싣지 않는다. 공개 자료(Mesa, Linux amdgpu, AMD ISA 문서)로 확인되는 것만 사실로 쓰고, 단순화는 장 끝에 따로 적는다. push는 재희 확인 뒤에만.
