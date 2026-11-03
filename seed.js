'use strict';
// 내 실제 계획·할 일·실행 기록을 넣는다. 비어 있는 DB에만 넣고, 이미 자료가 있으면 아무것도 하지 않는다.
// 이 값은 시작용 초안이다. 실제와 다른 시각·시간이 있으면 화면에서 고치거나 새로 기록한다.
const path = require('node:path');
const { open } = require('./db');
const { createApp } = require('./server');

const file = process.env.PDS_DB || path.join(__dirname, 'data', 'diary.sqlite');
const db = open(file);
if (db.prepare('SELECT COUNT(*) c FROM plans').get().c > 0) { console.log('이미 자료가 있어 건너뜁니다:', file); process.exit(0); }

const req = (method, url, body, headers = {}) => new Promise((resolve, reject) => {
  const http = require('node:http');
  const srv = http.createServer(createApp(db)).listen(0, async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}${url}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json(); srv.close(); r.ok ? resolve(j) : reject(new Error(url + ' ' + JSON.stringify(j)));
    } catch (e) { srv.close(); reject(e); }
  });
});

(async () => {
  const plan = await req('POST', '/api/plans', {
    title: '과제 6 플랜두씨 다이어리 완성', goal: '계획 → 실제로 한 일 → 돌아보기가 이어지는 다이어리를 서버 DB로 만들어 제출한다',
    start_date: '2026-11-02', end_date: '2026-11-08', priority: 1,
    success_criteria: '카드 1~5 통과 기준을 모두 확인하고 시크릿 창에서 열린다', estimated_minutes: 600,
  });
  const T = [
    ['카드 1: 계획 항목 정하고 수정 이력 저장', '2026-11-02', 1, 60, '설계,카드1', 'done'],
    ['카드 2: 할 일 CRUD·검색·거르기·정렬', '2026-11-02', 1, 120, '구현,카드2', 'done'],
    ['카드 3: 실행 기록과 중복 완료 방지', '2026-11-03', 1, 90, '구현,카드3', 'done'],
    ['카드 4: 돌아보기 집계와 근거 기록 이동', '2026-11-04', 2, 90, '구현,카드4', 'open'],
    ['카드 5: 내보내기·XSS·비밀값 점검', '2026-11-05', 2, 60, '점검,카드5', 'open'],
    ['배포하고 새 시크릿 창에서 열어 보기', '2026-11-07', 2, 45, '배포,제출', 'open'],
  ];
  const ids = [];
  for (const [title, due_date, priority, estimated_minutes, tags] of T) {
    ids.push((await req('POST', '/api/tasks', { plan_id: plan.id, title, due_date, priority, estimated_minutes, tags })).id);
  }
  const runs = [
    [0, '2026-11-02T09:30', '2026-11-02T10:40', 70, ''],
    [1, '2026-11-02T11:00', '2026-11-02T13:30', 150, '정렬 기준을 화면에 밝히는 방식과 값이 같을 때의 순서 규칙을 정하느라 막힘'],
    [2, '2026-11-02T14:30', '2026-11-02T16:00', 90, ''],
    [3, '2026-11-02T16:10', '2026-11-02T16:50', 40, '집계 숫자와 근거 목록 개수가 일치하는지 기준(지우지 않은 할 일)이 헷갈림'],
  ];
  for (const [i, s, e, m, why] of runs) {
    await req('POST', `/api/tasks/${ids[i]}/runs`, { started_at: s, ended_at: e, actual_minutes: m, blocked_reason: why }, { 'Idempotency-Key': `seed-run-${ids[i]}-${s}` });
  }
  for (let i = 0; i < T.length; i++) if (T[i][5] === 'done') await req('POST', `/api/tasks/${ids[i]}/complete`, null, { 'Idempotency-Key': `seed-complete-${ids[i]}` });
  // 계획을 한 번 고쳐 수정 이력이 실제로 남게 한다 (예상 시간을 현실에 맞춤)
  await req('PUT', `/api/plans/${plan.id}`, { estimated_minutes: 465 });
  console.log('시작 자료를 넣었습니다:', file);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
