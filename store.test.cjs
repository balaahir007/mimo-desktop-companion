const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('./store.cjs');
test('claim, snooze, redeliver once and complete', () => {
  const s = new Store(':memory:');
  s.save('Check deployment',1000);
  assert.equal(s.claim(999).length,0);
  const [r] = s.claim(1000);
  assert.equal(r.state,'notified');
  assert.equal(s.claim(1001).length,0);
  s.act(r.id,'snooze',5,1000);
  assert.equal(s.claim(300999).length,0);
  assert.equal(s.claim(301000).length,1);
  s.act(r.id,'done');
  assert.equal(s.list()[0].state,'completed');
});
test('recover overdue items and reject invalid titles', () => {
  const s = new Store(':memory:');
  assert.throws(()=>s.save(' ',1000));
  s.save('Review notes',100);
  assert.equal(s.claim(60101)[0].state,'missed');
  assert.equal(s.claim(60102).length,0);
});

const {mkdtempSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');

test('migrates an old database and resumes an unacknowledged reminder after restart', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mimo-store-'));
  try {
    const file = path.join(directory,'example.sqlite');
    const legacy = new DatabaseSync(file);
    legacy.exec("CREATE TABLE reminders (id INTEGER PRIMARY KEY, title TEXT, due INTEGER, state TEXT DEFAULT 'pending'); INSERT INTO reminders(title,due) VALUES ('Older reminder', 1000);");
    legacy.close();
    const before = new Store(file);
    assert.equal(before.claim(90000)[0].state, 'missed');
    before.db.close();
    const after = new Store(file);
    const row = after.nextAlert();
    assert.equal(row.title, 'Older reminder');
    after.act(row.id, 'dismiss', null, 91000);
    assert.equal(after.nextAlert(), undefined);
    assert.equal(after.find(row.id).state, 'missed');
    after.db.close();
  } finally { rmSync(directory, {recursive:true,force:true}); }
});

test('deduplicates a voice submission and queues reminders in due order', () => {
  const store = new Store(':memory:');
  const id = store.save('Deployment', 10000, null, {submissionKey:'voice-1', transcript:'Check deployment'});
  assert.equal(store.save('Deployment', 20000, null, {submissionKey:'voice-1'}), id);
  store.save('Send notes', 11000);
  store.claim(20000);
  assert.equal(store.nextAlert().id,id);
  store.act(id,'done');
  assert.equal(store.nextAlert().title,'Send notes');
  store.db.close();
});

test('recurrence preserves the original local weekday/time after snooze and DST', () => {
  const store = new Store(':memory:');
  const due = Date.parse('2026-03-06T14:00:00Z');
  const id = store.save('Weekly report', due, null, {recurrence:'weekly',timezone:'America/New_York'});
  store.claim(due);
  store.act(id,'snooze',30,due);
  const snoozed = due + 1800000;
  assert.equal(store.find(id).due,snoozed);
  store.claim(snoozed);
  store.act(id,'done',null,snoozed);
  const next = store.find(id);
  assert.equal(next.due, Date.parse('2026-03-13T13:00:00Z'));
  assert.equal(next.completed_at,snoozed);
  assert.equal(next.state,'pending');
  store.db.close();
});
