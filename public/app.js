'use strict';
// 모든 글자는 textContent/속성으로만 넣는다 (innerHTML 사용 안 함) → 스크립트 모양 글자도 그대로 보인다.
const $app = document.getElementById('app');
const PRI = { 1: '높음', 2: '보통', 3: '낮음' };

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function toast(msg, bad) {
  const box = document.getElementById('toast');
  const d = h('div', { class: bad ? 'bad' : '' }, msg);
  box.append(d);
  setTimeout(() => d.remove(), 4500);
}

async function api(method, url, body, headers) {
  const res = await fetch(url, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 본문 없음 */ }
  if (!res.ok) throw new Error((data && data.error) || `요청이 실패했습니다 (${res.status})`);
  return data;
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

// ---------- 서식 ----------
const fmtMin = (m) => {
  if (m === null || m === undefined) return '-';
  const sign = m < 0 ? '-' : '', a = Math.abs(m);
  const hh = Math.floor(a / 60), mm = a % 60;
  const long = hh ? `${hh}시간${mm ? ' ' + mm + '분' : ''}` : `${mm}분`;
  return `${sign}${a}분` + (a >= 60 ? ` (${sign}${long})` : '');
};
const seoulFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtTime = (iso) => (iso ? seoulFmt.format(new Date(iso)) : '-');
const seoulLocalInput = (d = new Date()) => seoulFmt.format(d).replace(' ', 'T');
const link = (href, text, cls) => h('a', { href, class: cls }, text);

function parseHash() {
  const raw = location.hash.slice(1) || '/';
  const [path, qs] = raw.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(qs || '')), parts: path.split('/').filter(Boolean) };
}
const setQuery = (path, q) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== '' && v !== undefined && v !== null) p.set(k, v);
  const s = p.toString();
  location.hash = '#' + path + (s ? '?' + s : '');
};

function field(label, input) { return h('label', {}, label, input); }
function select(name, options, value) {
  return h('select', { name }, options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t)));
}
const priOptions = [[1, '1 높음'], [2, '2 보통'], [3, '3 낮음']];
const formData = (form) => Object.fromEntries(new FormData(form).entries());

// ---------- 라우터 ----------
const views = {};
async function render() {
  const { parts, query } = parseHash();
  const name = parts[0] || 'home';
  document.querySelectorAll('nav a[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === (name === 'plan' ? 'home' : name)));
  $app.replaceChildren(h('p', { class: 'muted' }, '불러오는 중…'));
  const view = views[name];
  try {
    const node = view ? await view(parts, query) : h('p', {}, '없는 화면입니다. ', link('#/', '처음으로'));
    $app.replaceChildren(node);
  } catch (e) {
    $app.replaceChildren(h('p', { class: 'err' }, '화면을 불러오지 못했습니다: ' + e.message), h('button', { onclick: render }, '다시 시도'));
  }
}
window.addEventListener('hashchange', render);

// ---------- 계획 ----------
function planFormFields(p = {}) {
  const today = new Date().toISOString().slice(0, 10);
  return [
    field('계획 이름', h('input', { name: 'title', required: true, maxlength: 200, value: p.title || '' })),
    field('시작일', h('input', { name: 'start_date', type: 'date', required: true, value: p.start_date || today })),
    field('종료일', h('input', { name: 'end_date', type: 'date', required: true, value: p.end_date || today })),
    field('우선순위', select('priority', priOptions, p.priority || 2)),
    field('예상 시간(분)', h('input', { name: 'estimated_minutes', type: 'number', min: 0, required: true, value: p.estimated_minutes ?? 60 })),
    h('label', { class: 'wide' }, '성공 기준', h('input', { name: 'success_criteria', required: true, maxlength: 1000, value: p.success_criteria || '' })),
    h('label', { class: 'wide' }, '목표(선택)', h('input', { name: 'goal', maxlength: 2000, value: p.goal || '' })),
  ];
}

views.home = async () => {
  const { plans } = await api('GET', '/api/plans');
  const form = h('form', { class: 'grid', onsubmit: guard(async (e) => {
    e.preventDefault();
    const p = await api('POST', '/api/plans', formData(form));
    toast('계획을 저장했습니다');
    location.hash = '#/plan/' + p.id;
  }) }, planFormFields(), h('button', { type: 'submit' }, '계획 만들기'));
  return h('div', {},
    h('h2', {}, '내 계획'),
    plans.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['ID', '계획', '기간', '우선순위', '성공 기준', '예상 시간', '할 일', '수정 횟수'].map((t) => h('th', {}, t)))),
      h('tbody', {}, plans.map((p) => h('tr', {},
        h('td', {}, 'PLAN-' + p.id), h('td', {}, link('#/plan/' + p.id, p.title), p.carried_from_plan_id ? h('div', { class: 'small muted' }, `PLAN-${p.carried_from_plan_id} 돌아보기에서 넘어옴`) : null),
        h('td', {}, `${p.start_date} ~ ${p.end_date}`), h('td', {}, PRI[p.priority]), h('td', {}, p.success_criteria),
        h('td', {}, fmtMin(p.estimated_minutes)), h('td', {}, link(`#/tasks?plan_id=${p.id}`, p.task_count + '개')), h('td', {}, p.revision_count - 1 + '번')))))) : h('p', { class: 'muted' }, '아직 계획이 없습니다. 아래에서 만들어 보세요.'),
    h('h2', {}, '새 계획'), h('div', { class: 'card' }, form));
};

views.plan = async (parts) => {
  const id = Number(parts[1]);
  const { plan, revisions, carryover } = await api('GET', '/api/plans/' + id);
  const form = h('form', { class: 'grid', onsubmit: guard(async (e) => {
    e.preventDefault();
    await api('PUT', '/api/plans/' + id, formData(form));
    toast('고쳤습니다. 이전 내용은 아래 수정 이력에 남아 있습니다');
    render();
  }) }, planFormFields(plan), h('button', { type: 'submit' }, '계획 고치기'));
  const fields = [['title', '이름'], ['start_date', '시작일'], ['end_date', '종료일'], ['priority', '우선순위'], ['success_criteria', '성공 기준'], ['estimated_minutes', '예상 시간']];
  const show = (k, v) => (k === 'priority' ? PRI[v] : k === 'estimated_minutes' ? fmtMin(v) : v);
  return h('div', {},
    h('p', {}, link('#/', '← 계획 목록')),
    h('h2', {}, `PLAN-${plan.id} · ${plan.title}`),
    h('div', { class: 'card' },
      h('div', {}, `기간: ${plan.start_date} ~ ${plan.end_date} · 우선순위: ${PRI[plan.priority]} · 예상 시간: ${fmtMin(plan.estimated_minutes)}`),
      h('div', {}, '성공 기준: ', plan.success_criteria),
      plan.goal ? h('div', {}, '목표: ', plan.goal) : null,
      plan.carried_text ? h('div', { class: 'muted' }, `PLAN-${plan.carried_from_plan_id}의 돌아보기에서 넘어온 고칠 점: `, plan.carried_text) : null,
      carryover ? h('div', {}, '이 계획의 돌아보기에서 넘긴 다음 계획: ', link('#/plan/' + carryover.to_plan_id, 'PLAN-' + carryover.to_plan_id), ' — ', carryover.text) : null,
      h('div', { class: 'row mt' }, link(`#/tasks?plan_id=${id}`, `할 일 ${plan.task_count}개 보기`), ' · ', link(`#/review?plan_id=${id}`, '이 계획 돌아보기'))),
    h('h3', {}, '수정 이력 (고치기 전 내용도 그대로 남습니다)'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['버전', '저장 시각(서울)', ...fields.map((f) => f[1]), '변경'].map((t) => h('th', {}, t)))),
      h('tbody', {}, revisions.map((r, i) => h('tr', {},
        h('td', {}, i === 0 ? '1 (처음 계획)' : String(r.rev_no)), h('td', {}, fmtTime(r.created_at)),
        fields.map(([k]) => h('td', { class: i > 0 && revisions[i - 1][k] !== r[k] ? 'changed' : '' }, show(k, r[k]))),
        h('td', {}, r.change_note)))))),
    h('h3', {}, '계획 고치기'), h('div', { class: 'card' }, form));
};

// ---------- 할 일 ----------
const pendingKeys = new Map(); // 같은 완료 의도는 같은 요청 키를 쓴다
const keyFor = (kind, id) => { const k = kind + id; if (!pendingKeys.has(k)) pendingKeys.set(k, `k-${crypto.randomUUID()}`); return pendingKeys.get(k); };

views.tasks = async (parts, q) => {
  const [{ plans }, meta] = await Promise.all([api('GET', '/api/plans'), api('GET', '/api/meta')]);
  const params = new URLSearchParams();
  for (const k of ['plan_id', 'q', 'status', 'priority', 'tag', 'overdue', 'blocked', 'due_from', 'due_to', 'sort', 'dir']) if (q[k]) params.set(k, q[k]);
  const data = await api('GET', '/api/tasks?' + params);
  const allTags = [...new Set((await api('GET', '/api/tasks')).tasks.flatMap((t) => t.tags))].sort();

  const filter = h('form', { class: 'grid', onsubmit: (e) => { e.preventDefault(); setQuery('/tasks', { ...formData(filter), overdue: q.overdue, blocked: q.blocked, due_from: q.due_from, due_to: q.due_to }); } },
    field('검색(이름·메모·태그)', h('input', { name: 'q', type: 'search', value: q.q || '' })),
    field('계획', select('plan_id', [['', '전체'], ...plans.map((p) => [p.id, `PLAN-${p.id} ${p.title}`])], q.plan_id || '')),
    field('상태', select('status', [['', '전체'], ['open', '진행 중'], ['done', '완료']], q.status || '')),
    field('우선순위', select('priority', [['', '전체'], ...priOptions], q.priority || '')),
    field('태그', select('tag', [['', '전체'], ...allTags.map((t) => [t, t])], q.tag || '')),
    field('정렬 기준', select('sort', Object.entries(meta.sorts), data.sort.key)),
    field('방향', select('dir', [['asc', '기본'], ['desc', '반대']], data.sort.dir)),
    h('button', { type: 'submit' }, '적용'), h('button', { type: 'button', class: 'ghost', onclick: () => { location.hash = '#/tasks'; } }, '초기화'));

  const chips = [];
  if (q.overdue === '1') chips.push('지연된 것만');
  if (q.blocked === '1') chips.push('막힌 이유가 적힌 것만');
  if (q.due_from || q.due_to) chips.push(`마감일 ${q.due_from || ''} ~ ${q.due_to || ''}`);

  const addForm = h('form', { class: 'grid', onsubmit: guard(async (e) => {
    e.preventDefault();
    await api('POST', '/api/tasks', formData(addForm));
    toast('할 일을 만들었습니다');
    render();
  }) },
    field('계획', select('plan_id', plans.map((p) => [p.id, `PLAN-${p.id} ${p.title}`]), q.plan_id || (plans[0] && plans[0].id))),
    h('label', { class: 'wide' }, '할 일 이름', h('input', { name: 'title', required: true, maxlength: 200 })),
    field('마감일', h('input', { name: 'due_date', type: 'date' })),
    field('우선순위', select('priority', priOptions, 2)),
    field('예상 시간(분)', h('input', { name: 'estimated_minutes', type: 'number', min: 0, value: 30, required: true })),
    field('태그(쉼표로 구분)', h('input', { name: 'tags', placeholder: '예: 공부, 코드' })),
    h('label', { class: 'wide' }, '메모(선택)', h('input', { name: 'note', maxlength: 2000 })),
    h('button', { type: 'submit' }, plans.length ? '할 일 만들기' : '먼저 계획을 만드세요'));
  if (!plans.length) addForm.querySelector('button').disabled = true;

  return h('div', {},
    h('h2', {}, `할 일 (${data.tasks.length}개)`),
    h('div', { class: 'card' }, filter, chips.length ? h('div', { class: 'small mt' }, '추가 조건: ', chips.join(' · '), ' ', link('#/tasks', '조건 풀기')) : null),
    h('div', { class: 'sortnote small' }, h('b', {}, '현재 정렬: '), data.sort.label, h('br'), `지연 기준일: 오늘(서울) ${data.today}. 거르기·정렬은 서버(DB)에서 합니다.`),
    data.tasks.length ? h('div', { class: 'tasklist' }, data.tasks.map(taskRows))
    : h('p', { class: 'muted' }, '조건에 맞는 할 일이 없습니다.'),
    h('h2', {}, '새 할 일'), h('div', { class: 'card' }, addForm));
};

function taskRows(t) {
  const detail = h('div', { class: 'task-detail', hidden: true, id: 'detail-' + t.id });
  const toggle = (mode) => {
    if (!detail.hidden && detail.dataset.mode === mode) { detail.hidden = true; return; }
    detail.hidden = false; detail.dataset.mode = mode;
    detail.replaceChildren(mode === 'edit' ? taskEditForm(t) : runPanel(t));
  };
  const key = keyFor('c', t.id);
  const done = t.status === 'done';
  return h('div', { class: 'task' + (done ? ' is-done' : ''), id: 'task-' + t.id },
    h('div', { class: 'task-main' },
      h('div', { class: 't-title' }, h('span', { class: done ? 'done-title' : '' }, t.title), done ? h('span', { class: 'badge done' }, '완료') : null, t.overdue ? h('span', { class: 'badge late' }, '지연') : null, t.blocked_count ? h('span', { class: 'badge late' }, '막힘 ' + t.blocked_count) : null),
      t.note ? h('div', { class: 'small muted' }, t.note) : null,
      h('div', { class: 't-meta' },
        h('span', {}, 'T-' + t.id), link('#/plan/' + t.plan_id, 'PLAN-' + t.plan_id),
        h('span', {}, '마감 ' + (t.due_date || '없음')), h('span', { class: 'pri pri-' + t.priority }, '우선순위 ' + PRI[t.priority]),
        t.tags.map((g) => h('span', { class: 'tag' }, g)))),
    h('div', { class: 'task-nums' },
      h('div', {}, h('span', { class: 'muted small' }, '예상 '), fmtMin(t.estimated_minutes)),
      h('div', {}, h('span', { class: 'muted small' }, '실제 '), t.run_count ? fmtMin(t.actual_minutes) : '-'),
      h('div', { class: 'small' }, link(`#/runs?task_id=${t.id}`, `기록 ${t.run_count}건`))),
    h('div', { class: 'task-actions' },
      done
        ? h('button', { class: 'ghost', onclick: guard(async () => { await api('POST', `/api/tasks/${t.id}/reopen`); pendingKeys.delete('c' + t.id); toast('진행 중으로 되돌렸습니다'); render(); }) }, '되돌리기')
        : h('button', { onclick: guard(async () => {
          const r = await api('POST', `/api/tasks/${t.id}/complete`, null, { 'Idempotency-Key': key });
          toast(r.counted ? '완료로 바꿨습니다' : '이미 완료로 기록되어 있습니다'); pendingKeys.delete('c' + t.id); render();
        }) }, '완료'),
      h('button', { class: 'ghost', onclick: () => toggle('edit') }, '고치기'),
      h('button', { class: 'ghost', onclick: () => toggle('run') }, '실행 기록'),
      h('button', { class: 'danger', onclick: guard(async () => { if (!confirm(`「${t.title}」을(를) 지울까요?`)) return; await api('DELETE', '/api/tasks/' + t.id); toast('지웠습니다'); render(); }) }, '지우기')),
    detail);
}

function taskEditForm(t) {
  const f = h('form', { class: 'grid', onsubmit: guard(async (e) => {
    e.preventDefault();
    await api('PUT', '/api/tasks/' + t.id, formData(f));
    toast('고쳤습니다'); render();
  }) },
    h('label', { class: 'wide' }, '할 일 이름', h('input', { name: 'title', required: true, maxlength: 200, value: t.title })),
    field('마감일', h('input', { name: 'due_date', type: 'date', value: t.due_date || '' })),
    field('우선순위', select('priority', priOptions, t.priority)),
    field('예상 시간(분)', h('input', { name: 'estimated_minutes', type: 'number', min: 0, required: true, value: t.estimated_minutes })),
    field('태그(쉼표로 구분)', h('input', { name: 'tags', value: t.tags.join(', ') })),
    h('label', { class: 'wide' }, '메모', h('input', { name: 'note', maxlength: 2000, value: t.note })),
    h('button', { type: 'submit' }, '저장'));
  return f;
}

function runPanel(t) {
  const start = seoulLocalInput(new Date(Date.now() - 30 * 60000)), end = seoulLocalInput();
  const runKey = `r-${crypto.randomUUID()}`;
  const f = h('form', { class: 'grid', onsubmit: guard(async (e) => {
    e.preventDefault();
    const d = formData(f);
    const r = await api('POST', `/api/tasks/${t.id}/runs`, d, { 'Idempotency-Key': runKey });
    toast(r.created ? '실행 기록을 저장했습니다 (원래 계획 값은 그대로입니다)' : '같은 기록이 이미 저장되어 있습니다'); render();
  }) },
    field('시작 시각(서울)', h('input', { name: 'started_at', type: 'datetime-local', required: true, value: start })),
    field('끝난 시각(서울)', h('input', { name: 'ended_at', type: 'datetime-local', required: true, value: end })),
    field('실제로 걸린 시간(분, 비우면 시각 차이)', h('input', { name: 'actual_minutes', type: 'number', min: 0 })),
    h('label', { class: 'wide' }, '막혔던 이유(없으면 비움)', h('input', { name: 'blocked_reason', maxlength: 1000 })),
    h('button', { type: 'submit' }, '기록 저장'));
  return h('div', {}, h('div', { class: 'small muted' }, `T-${t.id}「${t.title}」에 붙는 실행 기록 · 계획상 예상 시간 ${fmtMin(t.estimated_minutes)}(기록을 저장해도 바뀌지 않음)`), f);
}

// ---------- 실행 기록 ----------
views.runs = async (parts, q) => {
  const params = new URLSearchParams();
  for (const k of ['task_id', 'plan_id', 'blocked', 'due_from', 'due_to']) if (q[k]) params.set(k, q[k]);
  const { runs } = await api('GET', '/api/runs?' + params);
  const total = runs.reduce((s, r) => s + r.actual_minutes, 0);
  return h('div', {},
    h('h2', {}, `실행 기록 (${runs.length}건)`),
    h('p', { class: 'muted small' }, `합계 실제 시간 ${fmtMin(total)} · 시각은 서울 기준 ${Object.keys(q).length ? '· ' : ''}`, Object.keys(q).length ? link('#/runs', '조건 풀기') : null),
    runs.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['기록', '붙어 있는 할 일', '계획', '시작', '끝', '실제 시간', '(계획상 예상)', '막혔던 이유'].map((t) => h('th', {}, t)))),
      h('tbody', {}, runs.map((r) => h('tr', { id: 'run-' + r.id },
        h('td', {}, 'R-' + r.id), h('td', {}, link(`#/tasks?plan_id=${r.plan_id}`, `T-${r.task_id} ${r.task_title}`)), h('td', {}, link('#/plan/' + r.plan_id, 'PLAN-' + r.plan_id)),
        h('td', {}, fmtTime(r.started_at)), h('td', {}, fmtTime(r.ended_at)), h('td', {}, fmtMin(r.actual_minutes)),
        h('td', {}, fmtMin(r.task_estimated_minutes)), h('td', {}, r.blocked_reason || '-')))))) : h('p', { class: 'muted' }, '조건에 맞는 실행 기록이 없습니다. 할 일 화면의 「실행 기록」 버튼으로 남길 수 있습니다.'));
};

// ---------- 돌아보기 ----------
views.review = async (parts, q) => {
  const { plans } = await api('GET', '/api/plans');
  const params = new URLSearchParams();
  if (q.plan_id) params.set('plan_id', q.plan_id);
  if (q.from) params.set('from', q.from);
  if (q.to) params.set('to', q.to);
  const [r, snaps] = await Promise.all([api('GET', '/api/review?' + params), api('GET', '/api/review/snapshots')]);
  const m = r.metrics, dq = r.drill_query;
  const tasksHref = (extra) => '#/tasks?' + [dq, extra].filter(Boolean).join('&');
  const runsHref = (extra) => '#/runs?' + [dq, extra].filter(Boolean).join('&');

  const filter = h('form', { class: 'grid', onsubmit: (e) => { e.preventDefault(); setQuery('/review', formData(filter)); } },
    field('계획', select('plan_id', [['', '전체'], ...plans.map((p) => [p.id, `PLAN-${p.id} ${p.title}`])], q.plan_id || '')),
    field('마감일 기간 시작', h('input', { name: 'from', type: 'date', value: q.from || '' })),
    field('마감일 기간 끝', h('input', { name: 'to', type: 'date', value: q.to || '' })),
    h('button', { type: 'submit' }, '모아 보기'));
  const metric = (href, num, label) => h('a', { class: 'metric', href }, h('b', {}, num), h('span', {}, label));

  const carryPlan = q.plan_id ? plans.find((p) => String(p.id) === q.plan_id) : null;
  const carryForm = !carryPlan ? h('p', { class: 'muted' }, '고칠 점을 다음 계획으로 넘기려면 위에서 계획 하나를 골라 모아 보세요.') : (() => {
    const f = h('form', { class: 'grid', onsubmit: guard(async (e) => {
      e.preventDefault();
      const d = formData(f);
      const out = await api('POST', '/api/review/carry', { from_plan_id: carryPlan.id, text: d.text, next_title: d.next_title || undefined });
      toast(out.created ? '다음 계획으로 넘겼습니다' : '이미 넘긴 고칠 점이 있습니다');
      location.hash = '#/plan/' + out.next_plan.id;
    }) },
      h('label', { class: 'wide' }, `PLAN-${carryPlan.id}에서 고칠 점 한 줄`, h('input', { name: 'text', required: true, maxlength: 300 })),
      h('label', { class: 'wide' }, '다음 계획 이름(비우면 고칠 점으로 자동)', h('input', { name: 'next_title', maxlength: 200 })),
      h('button', { type: 'submit' }, '다음 계획으로 넘기기'));
    return f;
  })();

  return h('div', {},
    h('h2', {}, '돌아보기'),
    h('div', { class: 'card' }, filter, h('div', { class: 'small muted mt' }, `기준: 지우지 않은 할 일 · 기간은 할 일 마감일 기준 · 오늘(서울) ${r.today} · 단위 분`)),
    h('div', { class: 'metrics' },
      metric(tasksHref('status=all'), m.plan_count, '계획 수 (딸린 할 일, 계획 ' + m.plans_included + '개)'),
      metric(tasksHref('status=done'), m.done_count, '완료 수'),
      metric(tasksHref('overdue=1'), m.overdue_count, '지연 수 (미완료·마감일 지남)'),
      metric(tasksHref('blocked=1'), m.blocked_count, '막힘 수 (막힌 이유 적힌 할 일)'),
      metric(tasksHref(''), fmtMin(m.estimated_minutes), '예상 시간 합계'),
      metric(runsHref(''), fmtMin(m.actual_minutes), `실제 시간 합계 (기록 ${m.run_count}건)`),
      h('div', { class: 'metric' }, h('b', {}, (m.diff_minutes > 0 ? '+' : '') + fmtMin(m.diff_minutes)), h('span', {}, '차이 = 실제 − 예상'))),
    h('p', { class: 'small muted' }, '숫자를 누르면 그 숫자가 나온 기록 목록으로 갑니다.'),
    h('div', { class: 'row' }, h('button', { class: 'ghost', onclick: guard(async () => { await api('POST', '/api/review/snapshots', { plan_id: q.plan_id, from: q.from, to: q.to }); toast('이 돌아보기를 저장했습니다'); render(); }) }, '이 돌아보기 저장')),
    h('h3', {}, '다음 계획으로 넘길 고칠 점'), h('div', { class: 'card' }, carryForm),
    h('h3', {}, '저장한 돌아보기'),
    snaps.snapshots.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['저장 시각', '범위', '계획 수', '완료', '지연', '막힘', '예상', '실제', '차이'].map((t) => h('th', {}, t)))),
      h('tbody', {}, snaps.snapshots.map((s) => h('tr', {}, h('td', {}, fmtTime(s.created_at)),
        h('td', {}, [s.plan_id ? 'PLAN-' + s.plan_id : '전체', s.from_date || s.to_date ? ` (${s.from_date || ''}~${s.to_date || ''})` : ''].join('')),
        [s.metrics.plan_count, s.metrics.done_count, s.metrics.overdue_count, s.metrics.blocked_count, s.metrics.estimated_minutes, s.metrics.actual_minutes, s.metrics.diff_minutes].map((v) => h('td', {}, v))))))) : h('p', { class: 'muted' }, '아직 저장한 돌아보기가 없습니다.'));
};

render();
