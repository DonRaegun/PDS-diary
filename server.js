'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('./db');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

// ---------- 시간/검증 ----------
function seoulToday() {
  if (process.env.PDS_TODAY) return process.env.PDS_TODAY;
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
const nowIso = () => new Date().toISOString();

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function reqDate(v, name) { if (!isDate(v)) throw bad(`${name}: YYYY-MM-DD 형식의 날짜가 필요합니다`); return v; }
function optDate(v, name) { return v === null || v === undefined || v === '' ? null : reqDate(v, name); }
function reqText(v, name, max = 200) {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${name}: 비워 둘 수 없습니다`);
  if (v.trim().length > max) throw bad(`${name}: ${max}자 이하여야 합니다`);
  return v.trim();
}
function optText(v, name, max = 2000) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') throw bad(`${name}: 글자여야 합니다`);
  if (v.trim().length > max) throw bad(`${name}: ${max}자 이하여야 합니다`);
  return v.trim();
}
function reqInt(v, name, min, max) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name}: ${min}~${max} 사이의 정수여야 합니다`);
  return n;
}
function priorityOf(v) { return reqInt(v, '우선순위(1 높음·2 보통·3 낮음)', 1, 3); }
function minutesOf(v, name) { return reqInt(v, name + '(분)', 0, 100000); }
function parseTags(v) {
  if (v === null || v === undefined || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const out = [];
  for (const t of arr) {
    if (typeof t !== 'string') throw bad('태그는 글자여야 합니다');
    const s = t.trim();
    if (!s) continue;
    if (s.length > 30) throw bad('태그는 30자 이하여야 합니다');
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > 10) throw bad('태그는 10개까지 넣을 수 있습니다');
  return out;
}
// 서울 시각 입력('YYYY-MM-DDTHH:mm' 또는 offset 포함 ISO)을 UTC ISO로 바꾼다
function toUtcIso(v, name) {
  if (typeof v !== 'string') throw bad(`${name}: 시각이 필요합니다`);
  let s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) s += '+09:00';
  else if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) throw bad(`${name}: 시각 형식이 올바르지 않습니다`);
  const d = new Date(s);
  if (isNaN(d)) throw bad(`${name}: 시각 형식이 올바르지 않습니다`);
  return d.toISOString();
}
function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function createApp(db) {
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const plain = (r) => (r ? { ...r } : r);

  // ---------- 계획 ----------
  const PLAN_FIELDS = ['title', 'goal', 'start_date', 'end_date', 'priority', 'success_criteria', 'estimated_minutes'];
  function readPlanInput(b) {
    const p = {
      title: reqText(b.title, '계획 이름'),
      goal: optText(b.goal, '목표'),
      start_date: reqDate(b.start_date, '시작일'),
      end_date: reqDate(b.end_date, '종료일'),
      priority: priorityOf(b.priority),
      success_criteria: reqText(b.success_criteria, '성공 기준', 1000),
      estimated_minutes: minutesOf(b.estimated_minutes, '예상 시간'),
    };
    if (p.end_date < p.start_date) throw bad('종료일은 시작일보다 빠를 수 없습니다');
    return p;
  }
  function planRow(id) {
    const p = one(`SELECT p.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.plan_id=p.id AND t.deleted_at IS NULL) AS task_count,
      (SELECT COUNT(*) FROM plan_revisions r WHERE r.plan_id=p.id) AS revision_count
      FROM plans p WHERE p.id=?`, id);
    if (!p) throw new HttpError(404, '계획을 찾을 수 없습니다');
    return plain(p);
  }
  function insertPlan(p, extra = {}) {
    const t = nowIso();
    const r = run(`INSERT INTO plans (title,goal,start_date,end_date,priority,success_criteria,estimated_minutes,carried_from_plan_id,carried_text,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, p.title, p.goal, p.start_date, p.end_date, p.priority, p.success_criteria,
      p.estimated_minutes, extra.carried_from_plan_id ?? null, extra.carried_text ?? null, t, t);
    const id = Number(r.lastInsertRowid);
    run(`INSERT INTO plan_revisions (plan_id,rev_no,title,goal,start_date,end_date,priority,success_criteria,estimated_minutes,change_note,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, 1, p.title, p.goal, p.start_date, p.end_date, p.priority, p.success_criteria,
      p.estimated_minutes, '처음 세운 계획', t);
    return id;
  }
  function createPlan(b) { return tx(() => planRow(insertPlan(readPlanInput(b)))); }
  function updatePlan(id, b) {
    return tx(() => {
      const cur = planRow(id);
      const next = readPlanInput({ ...cur, ...b });
      const changed = PLAN_FIELDS.filter((f) => cur[f] !== next[f]);
      if (changed.length) {
        const t = nowIso();
        const rev = one('SELECT MAX(rev_no) m FROM plan_revisions WHERE plan_id=?', id).m + 1;
        run(`UPDATE plans SET title=?,goal=?,start_date=?,end_date=?,priority=?,success_criteria=?,estimated_minutes=?,updated_at=? WHERE id=?`,
          next.title, next.goal, next.start_date, next.end_date, next.priority, next.success_criteria, next.estimated_minutes, t, id);
        run(`INSERT INTO plan_revisions (plan_id,rev_no,title,goal,start_date,end_date,priority,success_criteria,estimated_minutes,change_note,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, rev, next.title, next.goal, next.start_date, next.end_date, next.priority,
          next.success_criteria, next.estimated_minutes, `바뀐 항목: ${changed.join(', ')}`, t);
      }
      return planRow(id);
    });
  }
  function planDetail(id) {
    const plan = planRow(id);
    const revisions = all('SELECT * FROM plan_revisions WHERE plan_id=? ORDER BY rev_no', id).map(plain);
    const carry = one('SELECT * FROM review_carryovers WHERE from_plan_id=?', id);
    return { plan, revisions, carryover: plain(carry) };
  }

  // ---------- 할 일 ----------
  const SORTS = {
    due: { label: '마감일 빠른 순', sql: 't.due_date IS NULL, t.due_date ASC' },
    priority: { label: '우선순위 높은 순', sql: 't.priority ASC' },
    estimate: { label: '예상 시간 긴 순', sql: 't.estimated_minutes DESC' },
    created: { label: '등록 순서', sql: 't.id ASC' },
    title: { label: '이름 가나다 순', sql: 't.title COLLATE NOCASE ASC' },
  };
  // 같은 값일 때는 항상 마감일 → 우선순위 → 등록 번호 순으로 정한다
  const TIE = 't.due_date IS NULL, t.due_date ASC, t.priority ASC, t.id ASC';

  function tagsFor(ids) {
    const map = new Map(ids.map((i) => [i, []]));
    if (!ids.length) return map;
    for (const r of all(`SELECT task_id, tag FROM task_tags WHERE task_id IN (${ids.map(() => '?').join(',')}) ORDER BY tag`, ...ids)) map.get(r.task_id).push(r.tag);
    return map;
  }
  function taskFilter(q) {
    const where = ['t.deleted_at IS NULL'];
    const args = [];
    if (q.plan_id) { where.push('t.plan_id=?'); args.push(reqInt(q.plan_id, 'plan_id', 1, 1e9)); }
    if (q.status === 'open' || q.status === 'done') { where.push('t.status=?'); args.push(q.status); }
    else if (q.status && q.status !== 'all') throw bad('status는 open·done·all 중 하나입니다');
    if (q.priority) { where.push('t.priority=?'); args.push(priorityOf(q.priority)); }
    if (q.tag) { where.push('EXISTS (SELECT 1 FROM task_tags g WHERE g.task_id=t.id AND g.tag=?)'); args.push(String(q.tag)); }
    if (q.due_from) { where.push('t.due_date >= ?'); args.push(reqDate(q.due_from, 'due_from')); }
    if (q.due_to) { where.push('t.due_date <= ?'); args.push(reqDate(q.due_to, 'due_to')); }
    if (q.overdue === '1') { where.push("t.status<>'done' AND t.due_date IS NOT NULL AND t.due_date < ?"); args.push(seoulToday()); }
    if (q.blocked === '1') where.push("EXISTS (SELECT 1 FROM runs r WHERE r.task_id=t.id AND TRIM(r.blocked_reason)<>'')");
    if (q.q && String(q.q).trim()) {
      const like = '%' + String(q.q).trim().replace(/[\\%_]/g, '\\$&') + '%';
      where.push(`(t.title LIKE ? ESCAPE '\\' OR t.note LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM task_tags g WHERE g.task_id=t.id AND g.tag LIKE ? ESCAPE '\\'))`);
      args.push(like, like, like);
    }
    return { where, args };
  }
  function listTasks(q) {
    const { where, args } = taskFilter(q);
    const sortKey = q.sort || 'due';
    const s = SORTS[sortKey];
    if (!s) throw bad('정렬 기준이 올바르지 않습니다');
    const dir = q.dir === 'desc' ? 'desc' : 'asc';
    let orderBy = s.sql;
    if (dir === 'desc') orderBy = orderBy.split(', ').map((c) => c.replace(/ASC$/, 'DESC').replace(/^(t\.due_date) IS NULL$/, '$1 IS NOT NULL')).join(', ');
    const rows = all(`SELECT t.*, p.title AS plan_title,
      (SELECT COUNT(*) FROM runs r WHERE r.task_id=t.id) AS run_count,
      (SELECT COALESCE(SUM(r.actual_minutes),0) FROM runs r WHERE r.task_id=t.id) AS actual_minutes,
      (SELECT COUNT(*) FROM runs r WHERE r.task_id=t.id AND TRIM(r.blocked_reason)<>'') AS blocked_count
      FROM tasks t JOIN plans p ON p.id=t.plan_id WHERE ${where.join(' AND ')} ORDER BY ${orderBy}, ${TIE}`, ...args).map(plain);
    const tags = tagsFor(rows.map((r) => r.id));
    const today = seoulToday();
    for (const r of rows) {
      r.tags = tags.get(r.id);
      r.overdue = r.status !== 'done' && !!r.due_date && r.due_date < today;
    }
    const base = dir === 'desc' ? s.label + ' (반대 방향)' : s.label;
    return {
      today, tasks: rows,
      sort: { key: sortKey, dir, label: `${base} → 값이 같으면 마감일 빠른 순 → 우선순위 높은 순 → 등록 번호 순` },
    };
  }
  function taskRow(id) {
    const r = one(`SELECT t.*, p.title AS plan_title,
      (SELECT COUNT(*) FROM runs r WHERE r.task_id=t.id) AS run_count,
      (SELECT COALESCE(SUM(r.actual_minutes),0) FROM runs r WHERE r.task_id=t.id) AS actual_minutes
      FROM tasks t JOIN plans p ON p.id=t.plan_id WHERE t.id=? AND t.deleted_at IS NULL`, id);
    if (!r) throw new HttpError(404, '할 일을 찾을 수 없습니다');
    const t = plain(r);
    t.tags = tagsFor([id]).get(id);
    t.overdue = t.status !== 'done' && !!t.due_date && t.due_date < seoulToday();
    return t;
  }
  function setTags(id, tags) {
    run('DELETE FROM task_tags WHERE task_id=?', id);
    for (const g of tags) run('INSERT INTO task_tags (task_id, tag) VALUES (?,?)', id, g);
  }
  function createTask(b) {
    const planId = reqInt(b.plan_id, '계획', 1, 1e9);
    const d = {
      title: reqText(b.title, '할 일 이름'), note: optText(b.note, '메모'), due_date: optDate(b.due_date, '마감일'),
      priority: priorityOf(b.priority ?? 2), estimated_minutes: minutesOf(b.estimated_minutes ?? 0, '예상 시간'),
    };
    const tags = parseTags(b.tags);
    return tx(() => {
      planRow(planId);
      const t = nowIso();
      const r = run(`INSERT INTO tasks (plan_id,title,note,due_date,priority,estimated_minutes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
        planId, d.title, d.note, d.due_date, d.priority, d.estimated_minutes, t, t);
      const id = Number(r.lastInsertRowid);
      setTags(id, tags);
      return taskRow(id);
    });
  }
  function updateTask(id, b) {
    return tx(() => {
      const cur = taskRow(id);
      const merged = { ...cur, ...b };
      const d = {
        title: reqText(merged.title, '할 일 이름'), note: optText(merged.note, '메모'), due_date: optDate(merged.due_date, '마감일'),
        priority: priorityOf(merged.priority), estimated_minutes: minutesOf(merged.estimated_minutes, '예상 시간'),
      };
      const tags = 'tags' in b ? parseTags(b.tags) : cur.tags;
      run('UPDATE tasks SET title=?,note=?,due_date=?,priority=?,estimated_minutes=?,updated_at=? WHERE id=?',
        d.title, d.note, d.due_date, d.priority, d.estimated_minutes, nowIso(), id);
      setTags(id, tags);
      return taskRow(id);
    });
  }
  function deleteTask(id) {
    return tx(() => {
      taskRow(id);
      run('UPDATE tasks SET deleted_at=?, updated_at=? WHERE id=?', nowIso(), nowIso(), id);
      return { deleted: true, id };
    });
  }
  // 완료: 같은 요청 키·할 일 상태·DB 부분 유일 인덱스 세 겹으로 중복을 막는다
  function completeTask(id, key) {
    return tx(() => {
      const cur = taskRow(id);
      if (key) {
        const prev = one('SELECT task_id FROM completions WHERE idempotency_key=?', key);
        if (prev) {
          if (prev.task_id !== id) throw new HttpError(409, '이 요청 키는 다른 할 일에 이미 쓰였습니다');
          return { task: cur, counted: false };
        }
      }
      if (cur.status === 'done') return { task: cur, counted: false };
      const t = nowIso();
      run("UPDATE tasks SET status='done', completed_at=?, updated_at=? WHERE id=?", t, t, id);
      try {
        run('INSERT INTO completions (task_id, idempotency_key, completed_at) VALUES (?,?,?)', id, key || null, t);
      } catch (e) {
        if (/UNIQUE/i.test(e.message)) return { task: taskRow(id), counted: false };
        throw e;
      }
      return { task: taskRow(id), counted: true };
    });
  }
  function reopenTask(id) {
    return tx(() => {
      const cur = taskRow(id);
      if (cur.status !== 'done') return { task: cur, reopened: false };
      const t = nowIso();
      run("UPDATE tasks SET status='open', completed_at=NULL, updated_at=? WHERE id=?", t, id);
      run('UPDATE completions SET reverted_at=? WHERE task_id=? AND reverted_at IS NULL', t, id);
      return { task: taskRow(id), reopened: true };
    });
  }

  // ---------- 실행 기록 ----------
  function createRun(taskId, b, key) {
    const started = toUtcIso(b.started_at, '시작 시각');
    const ended = toUtcIso(b.ended_at, '끝난 시각');
    if (ended < started) throw bad('끝난 시각은 시작 시각보다 빠를 수 없습니다');
    let actual;
    if (b.actual_minutes === undefined || b.actual_minutes === null || b.actual_minutes === '') {
      actual = Math.round((new Date(ended) - new Date(started)) / 60000);
    } else actual = minutesOf(b.actual_minutes, '실제 걸린 시간');
    const reason = optText(b.blocked_reason, '막혔던 이유', 1000);
    return tx(() => {
      taskRow(taskId);
      if (key) {
        const prev = one('SELECT * FROM runs WHERE idempotency_key=?', key);
        if (prev) {
          if (prev.task_id !== taskId) throw new HttpError(409, '이 요청 키는 다른 할 일에 이미 쓰였습니다');
          return { run: plain(prev), created: false };
        }
      }
      const r = run('INSERT INTO runs (task_id,started_at,ended_at,actual_minutes,blocked_reason,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?)',
        taskId, started, ended, actual, reason, key || null, nowIso());
      return { run: plain(one('SELECT * FROM runs WHERE id=?', Number(r.lastInsertRowid))), created: true };
    });
  }
  function listRuns(q) {
    const where = ['t.deleted_at IS NULL'];
    const args = [];
    if (q.task_id) { where.push('r.task_id=?'); args.push(reqInt(q.task_id, 'task_id', 1, 1e9)); }
    if (q.plan_id) { where.push('t.plan_id=?'); args.push(reqInt(q.plan_id, 'plan_id', 1, 1e9)); }
    if (q.blocked === '1') where.push("TRIM(r.blocked_reason)<>''");
    if (q.due_from) { where.push('t.due_date >= ?'); args.push(reqDate(q.due_from, 'due_from')); }
    if (q.due_to) { where.push('t.due_date <= ?'); args.push(reqDate(q.due_to, 'due_to')); }
    return all(`SELECT r.*, t.title AS task_title, t.plan_id, t.estimated_minutes AS task_estimated_minutes, p.title AS plan_title
      FROM runs r JOIN tasks t ON t.id=r.task_id JOIN plans p ON p.id=t.plan_id
      WHERE ${where.join(' AND ')} ORDER BY r.started_at DESC, r.id DESC`, ...args).map(plain);
  }

  // ---------- 돌아보기 ----------
  function review(q) {
    const f = {};
    if (q.plan_id) f.plan_id = String(reqInt(q.plan_id, 'plan_id', 1, 1e9));
    if (q.from) f.due_from = reqDate(q.from, 'from');
    if (q.to) f.due_to = reqDate(q.to, 'to');
    if (f.due_from && f.due_to && f.due_to < f.due_from) throw bad('기간의 끝이 시작보다 빠릅니다');
    const today = seoulToday();
    const { where, args } = taskFilter(f);
    const W = where.join(' AND ');
    const m = one(`SELECT
      COUNT(*) AS plan_count,
      COALESCE(SUM(t.status='done'),0) AS done_count,
      COALESCE(SUM(t.status<>'done' AND t.due_date IS NOT NULL AND t.due_date < ?),0) AS overdue_count,
      COALESCE(SUM(EXISTS (SELECT 1 FROM runs r WHERE r.task_id=t.id AND TRIM(r.blocked_reason)<>'')),0) AS blocked_count,
      COALESCE(SUM(t.estimated_minutes),0) AS estimated_minutes,
      COALESCE(SUM((SELECT COALESCE(SUM(r.actual_minutes),0) FROM runs r WHERE r.task_id=t.id)),0) AS actual_minutes,
      COUNT(DISTINCT t.plan_id) AS plans_included
      FROM tasks t WHERE ${W}`, today, ...args);
    const out = plain(m);
    out.diff_minutes = out.actual_minutes - out.estimated_minutes;
    out.run_count = one(`SELECT COUNT(*) c FROM runs r JOIN tasks t ON t.id=r.task_id WHERE ${W}`, ...args).c;
    const qs = new URLSearchParams(f).toString();
    return { today, timezone: 'Asia/Seoul', unit: 'minutes', filter: f, metrics: out, drill_query: qs };
  }
  function saveSnapshot(b) {
    const r = review(b);
    const t = nowIso();
    const res = run('INSERT INTO review_snapshots (plan_id,from_date,to_date,today,metrics_json,created_at) VALUES (?,?,?,?,?,?)',
      r.filter.plan_id ? Number(r.filter.plan_id) : null, r.filter.due_from || null, r.filter.due_to || null, r.today, JSON.stringify(r.metrics), t);
    return { id: Number(res.lastInsertRowid), ...r, created_at: t };
  }
  function listSnapshots() {
    return all('SELECT * FROM review_snapshots ORDER BY id DESC LIMIT 50').map((s) => ({ ...s, metrics: JSON.parse(s.metrics_json), metrics_json: undefined }));
  }
  function carryOver(b) {
    const fromId = reqInt(b.from_plan_id, '돌아본 계획', 1, 1e9);
    const text = reqText(b.text, '고칠 점', 300);
    return tx(() => {
      const src = planRow(fromId);
      const prev = one('SELECT * FROM review_carryovers WHERE from_plan_id=?', fromId);
      if (prev) return { carryover: plain(prev), next_plan: planRow(prev.to_plan_id), created: false };
      const today = seoulToday();
      const id = insertPlan({
        title: reqText(b.next_title || `다음 계획: ${text}`.slice(0, 120), '다음 계획 이름'),
        goal: `「${src.title}」 돌아보기에서 넘어옴`,
        start_date: today, end_date: addDays(today, 7), priority: 2,
        success_criteria: text, estimated_minutes: minutesOf(b.estimated_minutes ?? 60, '예상 시간'),
      }, { carried_from_plan_id: fromId, carried_text: text });
      const r = run('INSERT INTO review_carryovers (from_plan_id,to_plan_id,text,created_at) VALUES (?,?,?,?)', fromId, id, text, nowIso());
      return { carryover: plain(one('SELECT * FROM review_carryovers WHERE id=?', Number(r.lastInsertRowid))), next_plan: planRow(id), created: true };
    });
  }

  // ---------- 내보내기 ----------
  function exportAll() {
    return {
      app: 'plandoosee-diary', schema: 'pds-schema-v2', exported_at: nowIso(), timezone: 'Asia/Seoul',
      units: { time: 'minutes', date: 'YYYY-MM-DD (Asia/Seoul calendar date)', timestamp: 'UTC ISO-8601', priority: '1 high · 2 medium · 3 low' },
      data: {
        plans: all('SELECT * FROM plans ORDER BY id').map(plain),
        plan_revisions: all('SELECT * FROM plan_revisions ORDER BY plan_id, rev_no').map(plain),
        tasks: all('SELECT * FROM tasks ORDER BY id').map(plain),
        task_tags: all('SELECT * FROM task_tags ORDER BY task_id, tag').map(plain),
        runs: all('SELECT * FROM runs ORDER BY id').map(plain),
        completions: all('SELECT * FROM completions ORDER BY id').map(plain),
        review_snapshots: all('SELECT * FROM review_snapshots ORDER BY id').map(plain),
        review_carryovers: all('SELECT * FROM review_carryovers ORDER BY id').map(plain),
      },
    };
  }

  // ---------- 라우팅 ----------
  const ROUTES = [];
  const route = (method, pattern, fn) => ROUTES.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>\\d+)') + '$'), fn });
  const idOf = (m, k = 'id') => Number(m.groups[k]);

  route('GET', '/api/health', () => ({ ok: true, today: seoulToday() }));
  route('GET', '/api/meta', () => ({ today: seoulToday(), timezone: 'Asia/Seoul', sorts: Object.fromEntries(Object.entries(SORTS).map(([k, v]) => [k, v.label])) }));
  route('GET', '/api/plans', () => ({ plans: all(`SELECT p.*,
    (SELECT COUNT(*) FROM tasks t WHERE t.plan_id=p.id AND t.deleted_at IS NULL) AS task_count,
    (SELECT COUNT(*) FROM plan_revisions r WHERE r.plan_id=p.id) AS revision_count FROM plans p ORDER BY p.id`).map(plain) }));
  route('POST', '/api/plans', (c) => [201, createPlan(c.body)]);
  route('GET', '/api/plans/:id', (c) => planDetail(idOf(c.m)));
  route('PUT', '/api/plans/:id', (c) => updatePlan(idOf(c.m), c.body));
  route('GET', '/api/tasks', (c) => listTasks(c.query));
  route('POST', '/api/tasks', (c) => [201, createTask(c.body)]);
  route('GET', '/api/tasks/:id', (c) => taskRow(idOf(c.m)));
  route('PUT', '/api/tasks/:id', (c) => updateTask(idOf(c.m), c.body));
  route('DELETE', '/api/tasks/:id', (c) => deleteTask(idOf(c.m)));
  route('POST', '/api/tasks/:id/complete', (c) => completeTask(idOf(c.m), keyOf(c)));
  route('POST', '/api/tasks/:id/reopen', (c) => reopenTask(idOf(c.m)));
  route('GET', '/api/tasks/:id/runs', (c) => ({ runs: listRuns({ task_id: String(idOf(c.m)) }) }));
  route('POST', '/api/tasks/:id/runs', (c) => { const r = createRun(idOf(c.m), c.body, keyOf(c)); return [r.created ? 201 : 200, r]; });
  route('GET', '/api/runs', (c) => ({ runs: listRuns(c.query) }));
  route('GET', '/api/review', (c) => review(c.query));
  route('GET', '/api/review/snapshots', () => ({ snapshots: listSnapshots() }));
  route('POST', '/api/review/snapshots', (c) => [201, saveSnapshot(c.body)]);
  route('POST', '/api/review/carry', (c) => { const r = carryOver(c.body); return [r.created ? 201 : 200, r]; });
  route('GET', '/api/export', () => ({ __download: 'plandoosee-export.json', body: exportAll() }));

  function keyOf(c) {
    const k = c.headers['idempotency-key'];
    if (k === undefined) return null;
    if (!/^[A-Za-z0-9_.:-]{8,100}$/.test(k)) throw bad('Idempotency-Key 형식이 올바르지 않습니다');
    return k;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > 100_000) { reject(new HttpError(413, '요청이 너무 큽니다')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (v === null || typeof v !== 'object' || Array.isArray(v)) throw 0;
          resolve(v);
        } catch { reject(bad('JSON 객체 본문이 필요합니다')); }
      });
      req.on('error', reject);
    });
  }

  const SEC = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  };
  function send(res, status, body, headers = {}) {
    const isStr = typeof body === 'string' || Buffer.isBuffer(body);
    res.writeHead(status, { ...SEC, 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(isStr ? body : JSON.stringify(body));
  }

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) {
        let matchedPath = false;
        for (const r of ROUTES) {
          const m = r.re.exec(url.pathname);
          if (!m) continue;
          matchedPath = true;
          if (r.method !== req.method) continue;
          const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
          const out = r.fn({ m, body, query: Object.fromEntries(url.searchParams), headers: req.headers });
          if (out && out.__download) {
            return send(res, 200, JSON.stringify(out.body, null, 2), { 'Content-Disposition': `attachment; filename="${out.__download}"` });
          }
          return Array.isArray(out) ? send(res, out[0], out[1]) : send(res, 200, out);
        }
        throw new HttpError(matchedPath ? 405 : 404, matchedPath ? '허용되지 않는 요청 방식입니다' : '없는 주소입니다');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '허용되지 않는 요청 방식입니다');
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      const file = path.normalize(path.join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, '없는 파일입니다');
      res.writeHead(200, { ...SEC, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      if (e instanceof URIError) return send(res, 400, { error: '주소가 올바르지 않습니다' });
      console.error(e);
      send(res, 500, { error: '서버 오류가 났습니다. 잠시 뒤 다시 시도해 주세요' });
    }
  };
}

function start({ file = process.env.PDS_DB || path.join(__dirname, 'data', 'diary.sqlite'), port = Number(process.env.PORT) || 3000 } = {}) {
  const db = open(file);
  const server = http.createServer(createApp(db));
  server.listen(port, () => console.log(`플랜두씨 다이어리: http://localhost:${port}  (DB: ${file})`));
  return { server, db };
}

module.exports = { createApp, start, seoulToday };
if (require.main === module) start();
