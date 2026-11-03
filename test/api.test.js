'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { open } = require('../db');
const { createApp } = require('../server');

process.env.PDS_TODAY = '2026-11-10';
let srv, base, db;
test.before(async () => {
  db = open(':memory:');
  srv = http.createServer(createApp(db));
  await new Promise((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(() => { srv.closeAllConnections(); srv.close(); });

async function call(method, url, body, headers = {}) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}
const plan = { title: '테스트 계획', start_date: '2026-11-01', end_date: '2026-11-09', priority: 1, success_criteria: '전부 통과', estimated_minutes: 100 };
let P; const tasks = [];

test('C04-07 계획에 기간·우선순위·성공 기준·예상 시간이 저장된다', async () => {
  const r = await call('POST', '/api/plans', plan);
  assert.equal(r.status, 201); P = r.json;
  const g = (await call('GET', '/api/plans/' + P.id)).json.plan;
  assert.deepEqual([g.start_date, g.end_date, g.priority, g.success_criteria, g.estimated_minutes], ['2026-11-01', '2026-11-09', 1, '전부 통과', 100]);
});
test('C08 계획을 고쳐도 처음 계획이 남고 ID는 그대로다', async () => {
  const r = await call('PUT', '/api/plans/' + P.id, { success_criteria: '바뀐 기준', estimated_minutes: 200 });
  assert.equal(r.json.id, P.id);
  const d = (await call('GET', '/api/plans/' + P.id)).json;
  assert.equal(d.revisions.length, 2);
  assert.equal(d.revisions[0].success_criteria, '전부 통과'); assert.equal(d.revisions[0].estimated_minutes, 100);
  assert.equal(d.plan.success_criteria, '바뀐 기준');
  await call('PUT', '/api/plans/' + P.id, {}); // 변경 없음 → 이력 안 늘어남
  assert.equal((await call('GET', '/api/plans/' + P.id)).json.revisions.length, 2);
});
test('잘못된 입력은 400', async () => {
  assert.equal((await call('POST', '/api/plans', { ...plan, end_date: '2026-10-01' })).status, 400);
  assert.equal((await call('POST', '/api/plans', { ...plan, start_date: '2026-02-30' })).status, 400);
  assert.equal((await call('POST', '/api/tasks', { plan_id: P.id, title: '', priority: 2 })).status, 400);
});
test('C09,14-17 할 일 만들기 + 마감일·우선순위·태그·예상 시간', async () => {
  const defs = [
    ['A 문서', '2026-11-05', 2, 30, '문서,공부'], ['B 코드', '2026-11-05', 1, 60, '코드'], ['C 운동', '2026-11-12', 3, 20, '운동'],
    ['D 미정', null, 2, 10, ''], ['E 지난 일', '2026-11-08', 1, 45, '코드,공부'], ['<script>alert(1)</script>', '2026-11-20', 2, 5, '<b>x</b>'],
  ];
  for (const [title, due_date, priority, estimated_minutes, tags] of defs) {
    const r = await call('POST', '/api/tasks', { plan_id: P.id, title, due_date, priority, estimated_minutes, tags });
    assert.equal(r.status, 201); tasks.push(r.json);
  }
  assert.deepEqual([tasks[0].due_date, tasks[0].priority, tasks[0].estimated_minutes, tasks[0].tags], ['2026-11-05', 2, 30, ['공부', '문서']]);
  assert.equal(tasks[5].title, '<script>alert(1)</script>'); // 그대로 저장
});
test('C10 수정 / C13 삭제', async () => {
  const r = await call('PUT', '/api/tasks/' + tasks[3].id, { title: 'D 수정됨', tags: ['x'] });
  assert.equal(r.json.title, 'D 수정됨'); assert.deepEqual(r.json.tags, ['x']);
  const extra = (await call('POST', '/api/tasks', { plan_id: P.id, title: '지울 것', priority: 2, estimated_minutes: 1 })).json;
  assert.equal((await call('DELETE', '/api/tasks/' + extra.id)).status, 200);
  assert.equal((await call('GET', '/api/tasks/' + extra.id)).status, 404);
});
test('C18-20 검색·거르기·정렬(같은 값은 마감일→우선순위→ID)', async () => {
  const first = (r) => r.json.tasks.map((t) => t.title.slice(0, 1));
  assert.deepEqual((await call('GET', '/api/tasks?q=문서')).json.tasks.map((t) => t.title), ['A 문서']);
  assert.equal((await call('GET', '/api/tasks?tag=코드')).json.tasks.length, 2);
  assert.equal((await call('GET', '/api/tasks?priority=1')).json.tasks.length, 2);
  const due = await call('GET', '/api/tasks?sort=due');
  assert.deepEqual(first(due), ['B', 'A', 'E', 'C', '<', 'D']); // 마감 빠른 순, 마감 같으면 우선순위(B=1 < A=2), 마감 없음은 맨 뒤
  assert.match(due.json.sort.label, /마감일 빠른 순/);
  assert.deepEqual(first(await call('GET', '/api/tasks?sort=priority')), ['B', 'E', 'A', '<', 'D', 'C']);
  assert.deepEqual(first(await call('GET', '/api/tasks?sort=due')), first(due)); // 볼 때마다 같다
  assert.equal((await call('GET', '/api/tasks?sort=bogus')).status, 400);
});
test('C11,12 완료/되돌리기, C21,22 연달아 완료해도 한 건', async () => {
  const t = tasks[1];
  const key = 'same-key-0001';
  const [a, b] = await Promise.all([call('POST', `/api/tasks/${t.id}/complete`, null, { 'Idempotency-Key': key }), call('POST', `/api/tasks/${t.id}/complete`, null, { 'Idempotency-Key': key })]);
  assert.deepEqual([a.json.counted, b.json.counted].sort(), [false, true]);
  const c = await call('POST', `/api/tasks/${t.id}/complete`, null, { 'Idempotency-Key': 'other-key-0002' }); // 키가 달라도
  assert.equal(c.json.counted, false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM completions WHERE task_id=?').get(t.id).c, 1);
  assert.equal((await call('GET', '/api/review?plan_id=' + P.id)).json.metrics.done_count, 1);
  // DB 제약: 직접 중복 INSERT는 거부된다
  assert.throws(() => db.prepare("INSERT INTO completions (task_id,completed_at) VALUES (?, 'x')").run(t.id), /UNIQUE/);
  assert.equal((await call('POST', `/api/tasks/${t.id}/reopen`)).json.task.status, 'open');
  assert.equal((await call('GET', '/api/review?plan_id=' + P.id)).json.metrics.done_count, 0);
  assert.equal((await call('POST', `/api/tasks/${t.id}/complete`, null, { 'Idempotency-Key': 'again-key-0003' })).json.counted, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM completions WHERE task_id=? AND reverted_at IS NULL').get(t.id).c, 1);
});
test('C23-27 실행 기록은 따로 저장되고 원래 계획 값을 덮어쓰지 않는다 (서울 시각 → UTC)', async () => {
  const before = (await call('GET', '/api/tasks/' + tasks[0].id)).json;
  const r = await call('POST', `/api/tasks/${tasks[0].id}/runs`, { started_at: '2026-11-02T09:00', ended_at: '2026-11-02T10:30', actual_minutes: 80, blocked_reason: '자료 부족' }, { 'Idempotency-Key': 'run-key-00001' });
  assert.equal(r.status, 201);
  assert.deepEqual([r.json.run.started_at, r.json.run.ended_at, r.json.run.actual_minutes, r.json.run.blocked_reason], ['2026-11-02T00:00:00.000Z', '2026-11-02T01:30:00.000Z', 80, '자료 부족']);
  const after = (await call('GET', '/api/tasks/' + tasks[0].id)).json;
  assert.equal(after.estimated_minutes, before.estimated_minutes); assert.equal(after.due_date, before.due_date);
  const again = await call('POST', `/api/tasks/${tasks[0].id}/runs`, { started_at: '2026-11-02T09:00', ended_at: '2026-11-02T10:30', actual_minutes: 80 }, { 'Idempotency-Key': 'run-key-00001' });
  assert.equal(again.json.created, false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM runs WHERE task_id=?').get(tasks[0].id).c, 1);
  assert.equal((await call('POST', `/api/tasks/${tasks[2].id}/runs`, { started_at: '2026-11-02T10:00', ended_at: '2026-11-02T09:00' })).status, 400);
  const auto = await call('POST', `/api/tasks/${tasks[4].id}/runs`, { started_at: '2026-11-02T10:00', ended_at: '2026-11-02T10:25' });
  assert.equal(auto.json.run.actual_minutes, 25);
});
test('C28-32,83 돌아보기 집계는 근거 기록 목록과 일치', async () => {
  const m = (await call('GET', '/api/review?plan_id=' + P.id)).json;
  const list = (extra) => call('GET', `/api/tasks?${m.drill_query}&${extra}`).then((r) => r.json.tasks);
  assert.equal(m.metrics.plan_count, (await list('status=all')).length); assert.equal(m.metrics.plan_count, 6);
  assert.equal(m.metrics.done_count, (await list('status=done')).length); assert.equal(m.metrics.done_count, 1);
  // 오늘 2026-11-10: A(11-05), E(11-08)가 미완료·지난 마감. B는 완료 상태라 지연으로 세지 않음
  assert.equal(m.metrics.overdue_count, 2); assert.equal((await list('overdue=1')).length, 2);
  assert.equal(m.metrics.blocked_count, 1); assert.equal((await list('blocked=1')).length, 1);
  assert.equal(m.metrics.estimated_minutes, 30 + 60 + 20 + 10 + 45 + 5);
  assert.equal(m.metrics.actual_minutes, 80 + 25);
  assert.equal(m.metrics.diff_minutes, 105 - 170);
  const runs = (await call('GET', `/api/runs?${m.drill_query}`)).json.runs;
  assert.equal(runs.reduce((s, r) => s + r.actual_minutes, 0), m.metrics.actual_minutes);
  await call('DELETE', '/api/tasks/' + tasks[5].id); // 지운 할 일은 집계에서 빠진다
  assert.equal((await call('GET', '/api/review?plan_id=' + P.id)).json.metrics.plan_count, 5);
  const empty = (await call('GET', '/api/review?from=2030-01-01&to=2030-01-02')).json.metrics; // 빈 범위는 모두 0
  assert.deepEqual([empty.plan_count, empty.estimated_minutes, empty.actual_minutes, empty.diff_minutes], [0, 0, 0, 0]);
});
test('C33 고칠 점 한 건이 다음 계획으로 넘어가고 중복되지 않는다', async () => {
  const a = await call('POST', '/api/review/carry', { from_plan_id: P.id, text: '정렬 규칙을 먼저 적고 시작하기' });
  assert.equal(a.status, 201);
  assert.equal(a.json.next_plan.success_criteria, '정렬 규칙을 먼저 적고 시작하기'); assert.equal(a.json.next_plan.carried_from_plan_id, P.id);
  const b = await call('POST', '/api/review/carry', { from_plan_id: P.id, text: '다른 글' });
  assert.equal(b.json.created, false); assert.equal(b.json.next_plan.id, a.json.next_plan.id);
});
test('C34,36 저장·내보내기', async () => {
  assert.equal((await call('POST', '/api/review/snapshots', { plan_id: P.id })).status, 201);
  const r = await fetch(base + '/api/export');
  assert.match(r.headers.get('content-disposition'), /attachment/);
  const j = await r.json();
  assert.equal(j.schema, 'pds-schema-v2');
  for (const k of ['plans', 'plan_revisions', 'tasks', 'task_tags', 'runs', 'completions', 'review_snapshots', 'review_carryovers']) assert.ok(Array.isArray(j.data[k]), k);
  assert.ok(j.data.tasks.find((t) => t.title.startsWith('<script>')));
});
test('C57,82 보안 헤더(CSP)와 첫 화면 공개 안내', async () => {
  const r = await fetch(base + '/');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await r.text(), /지금은 로그인이 없어 링크를 아는 사람은 누구나 볼 수 있습니다\. 남이 봐도 괜찮은 내용만 넣으세요/);
});
test('경로 탈출·없는 주소·메서드', async () => {
  assert.equal((await fetch(base + '/..%2fserver.js')).status, 404);
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.equal((await call('DELETE', '/api/plans/1')).status, 405);
});
