const {DatabaseSync} = require('node:sqlite');
const minute = 60000;
const fields = {
  description: "TEXT NOT NULL DEFAULT ''",
  original_transcript: "TEXT NOT NULL DEFAULT ''",
  timezone: 'TEXT',
  recurrence_rule: 'TEXT',
  scheduled_at: 'INTEGER',
  created_at: 'INTEGER',
  updated_at: 'INTEGER',
  completed_at: 'INTEGER',
  snoozed_until: 'INTEGER',
  notification_count: 'INTEGER NOT NULL DEFAULT 0',
  acknowledged_at: 'INTEGER',
  submission_key: 'TEXT'
};

function currentTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function zonedParts(time, formatter) {
  const parts = Object.fromEntries(formatter.formatToParts(time).map(part => [part.type, Number(part.value)]));
  return [parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second];
}

function nextOccurrence(row, now) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: row.timezone || currentTimezone(), year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23'
  });
  const anchor = zonedParts(row.scheduled_at || row.due, formatter);
  const today = zonedParts(now, formatter);
  const step = row.recurrence_rule === 'daily' ? 1 : 7;
  const day = 86400000;
  const daysElapsed = (Date.UTC(...today.slice(0,3)) - Date.UTC(...anchor.slice(0,3))) / day;
  const first = Math.max(1, Math.floor(daysElapsed / step));
  for (let index = first; ; index++) {
    const wallTime = Date.UTC(...anchor) + index * step * day;
    // Try the offsets on either side of the local day to handle daylight-saving transitions.
    const candidates = [-day, 0, day].map(delta => {
      const probe = wallTime + delta;
      return wallTime - (Date.UTC(...zonedParts(probe, formatter)) - probe);
    });
    const matches = candidates.filter(value => Date.UTC(...zonedParts(value, formatter)) === wallTime);
    const candidate = matches.length ? Math.min(...matches) : Math.max(...candidates);
    if (candidate > now) return candidate;
  }
}

function validDue(due) {
  return Number.isSafeInteger(due) && Number.isFinite(new Date(due).getTime());
}

class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, due INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending');
      CREATE INDEX IF NOT EXISTS schedule ON reminders(state,due);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const existing = new Set(this.db.prepare('PRAGMA table_info(reminders)').all().map(column => column.name));
    this.db.exec('BEGIN');
    try {
      for (const [name, type] of Object.entries(fields)) {
        if (!existing.has(name)) this.db.exec(`ALTER TABLE reminders ADD COLUMN ${name} ${type}`);
      }
      if (!existing.has('acknowledged_at')) {
        this.db.prepare("UPDATE reminders SET scheduled_at=due, timezone=?, acknowledged_at=CASE WHEN state!='pending' THEN ? END")
          .run(currentTimezone(), Date.now());
      }
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS reminder_submission ON reminders(submission_key); COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  get(key, fallback) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    try { return row ? JSON.parse(row.value) : fallback; } catch { return fallback; }
  }

  set(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, JSON.stringify(value));
  }

  list() { return this.db.prepare('SELECT * FROM reminders ORDER BY due,id').all(); }
  find(id) { return this.db.prepare('SELECT * FROM reminders WHERE id=?').get(id); }

  save(title, due, id = null, metadata = {}) {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 160 || !validDue(due))
      throw Error('Enter a title and a valid date and time.');
    const now = Date.now();
    const timezone = metadata.timezone || currentTimezone();
    new Intl.DateTimeFormat('en', {timeZone: timezone});
    if (id !== null) {
      const result = this.db.prepare(`UPDATE reminders SET title=?, due=?, scheduled_at=?, timezone=?, state='pending',
        updated_at=?, acknowledged_at=NULL, completed_at=NULL, snoozed_until=NULL WHERE id=?`)
        .run(title.trim(), due, due, timezone, now, id);
      if (!result.changes) throw Error('This reminder no longer exists.');
      return id;
    }
    const {description = '', transcript = '', recurrence = null, submissionKey = null} = metadata;
    if (![null, 'daily', 'weekly'].includes(recurrence) || typeof description !== 'string' || description.length > 500 ||
        typeof transcript !== 'string' || transcript.length > 3000) throw Error('Check the reminder details.');
    return this.db.prepare(`INSERT INTO reminders(title,due,scheduled_at,timezone,description,original_transcript,
      recurrence_rule,created_at,updated_at,submission_key) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(submission_key) DO UPDATE SET submission_key=excluded.submission_key RETURNING id`)
      .get(title.trim(), due, due, timezone, description, transcript, recurrence, now, now, submissionKey).id;
  }

  act(id, action, value, now = Date.now()) {
    if (!Number.isSafeInteger(id)) throw Error('Invalid reminder ID.');
    const row = this.find(id);
    if (!row) throw Error('This reminder no longer exists.');
    if (action === 'delete') {
      this.db.prepare('DELETE FROM reminders WHERE id=?').run(id);
      return;
    }
    if (row.state === 'completed') return;
    if (action === 'done' || action === 'dismiss') {
      const completed = action === 'done' ? now : row.completed_at;
      if (row.recurrence_rule) {
        const due = nextOccurrence(row, now);
        this.db.prepare(`UPDATE reminders SET state='pending',due=?,scheduled_at=?,updated_at=?,
          completed_at=?,snoozed_until=NULL,acknowledged_at=NULL WHERE id=?`).run(due, due, now, completed, id);
      } else {
        this.db.prepare('UPDATE reminders SET state=?, acknowledged_at=?, updated_at=?, completed_at=?, snoozed_until=NULL WHERE id=?')
          .run(action === 'done' ? 'completed' : row.state, now, now, completed, id);
      }
      return;
    }
    if (action === 'snooze' && Number.isSafeInteger(value) && value >= 1 && value <= 10080) {
      const due = now + value * minute;
      this.db.prepare("UPDATE reminders SET state='pending',due=?,snoozed_until=?,updated_at=?,acknowledged_at=NULL WHERE id=?")
        .run(due, due, now, id);
      return;
    }
    if (action === 'reschedule' && validDue(value) && value > now) {
      this.save(row.title, value, id);
      return;
    }
    throw Error('Choose a snooze from one minute to seven days, or a future date and time.');
  }

  claim(now) {
    const rows = this.db.prepare(`UPDATE reminders SET state=CASE WHEN due < ? THEN 'missed' ELSE 'notified' END,
      updated_at=?, notification_count=notification_count+1, snoozed_until=NULL
      WHERE state='pending' AND due<=? RETURNING *`).all(now - minute, now, now);
    return rows;
  }

  nextAlert() {
    return this.db.prepare("SELECT * FROM reminders WHERE state IN ('notified','missed') AND acknowledged_at IS NULL ORDER BY due,id LIMIT 1").get();
  }

}

module.exports = {Store, currentTimezone};
