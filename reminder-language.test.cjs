const test = require('node:test');
const assert = require('node:assert/strict');
const {parseReminder, withoutWake, alertIntent, closeIntent, wakePhrases} = require('./reminder-language.cjs');

const now = new Date(2026,10,21,13,0).getTime();
const parse = (text, prior, only) => parseReminder(text, prior, now, only);

test('parses absolute, relative and date-first requests in local time', () => {
  const {draft} = parse('Remind me to check the deployment in five minutes.');
  assert.equal(draft.title, 'check the deployment');
  assert.equal(draft.due, now + 300000);
  assert.equal(parse('Tomorrow morning at 10, remind me to check the API.').draft.due, new Date(2026,10,22,10).getTime());
  assert.equal(parse('Remember that I have to update the dashboard at 6 PM.').draft.title, 'update the dashboard');
  assert.equal(parse('Call the client at 4 PM with a note that you need their estimate').draft.description, 'you need their estimate');
});

test('asks for date, missing time and ambiguous AM/PM before producing a due time', () => {
  const missing = parse('Remind me to check the deployment tomorrow.');
  assert.match(missing.question, /what time/i);
  assert.equal(missing.draft.due, undefined);
  const ambiguous = parse('Around 9', missing.draft);
  assert.match(ambiguous.question, /AM or PM/);
  assert.equal(parse('In the morning', ambiguous.draft).draft.due, new Date(2026,10,22,9).getTime());
  const invalid = parse('Review work on 2026-11-31 at 10 AM');
  assert.equal(invalid.draft.due, undefined);
  assert.equal(parse('December 1', invalid.draft).draft.due, new Date(2026,11,1,10).getTime());
  assert.match(parse('Move it to 4 PM', {}, true).draft.due.toString(), /^\d+$/);
});

test('sets weekly cadence and keeps recurrence wording out of titles', () => {
  const first = parse('Remind me every Friday to send the weekly report.');
  assert.equal(first.draft.title, 'send the weekly report');
  assert.equal(first.draft.recurrence, 'weekly');
  assert.equal(first.draft.due, undefined);
  assert.equal(parse('11 AM', first.draft).draft.due, new Date(2026,10,27,11).getTime());
  assert.equal(parse('Send the weekly report tomorrow at noon').draft.recurrence, undefined);
});

test('matches configured wake phrases and reminder control intents', () => {
  assert.equal(withoutWake('Wake up, Buddy! Remind me to make tea', 'Buddy'), 'Remind me to make tea');
  assert.deepEqual(alertIntent('come back after half an hour'), {type:'snooze', minutes:30});
  assert.deepEqual(alertIntent('remind me again in twenty-five minutes'), {type:'snooze', minutes:25});
  assert.equal(alertIntent('okay, done').type, 'done');
  assert.equal(alertIntent('remind me tomorrow').type, 'reschedule');
  assert.equal(alertIntent('not now').type, 'dismiss');
  assert.equal(withoutWake('Pay Memo, remind me to make tea', 'Mimo'), 'remind me to make tea');
  assert.ok(wakePhrases('Buddy').includes('Hey Memo'));
  assert.ok(wakePhrases('Buddy').includes('Pay Memo'));
  assert.ok(closeIntent('close memo.', 'Buddy'));
  assert.ok(closeIntent('hide buddy', 'Buddy'));
  assert.equal(closeIntent('close memo tomorrow', 'Buddy'), false);
});
