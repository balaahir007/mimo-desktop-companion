const numberWords = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen'
];
const tens = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const number = `(?:\\d{1,5}|(?:${tens.join('|')})(?:[- ](?:${numberWords.slice(1,10).join('|')}))?|${numberWords.join('|')}|an?)`;
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const dayPattern = weekdays.join('|');
const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthPattern = months.join('|');
const minute = 60000;

function readNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  if (/^an?$/.test(value)) return 1;
  const [first, second] = value.split(/[- ]/);
  const tensIndex = tens.indexOf(first);
  return tensIndex < 0 ? numberWords.indexOf(first) : (tensIndex + 2) * 10 + (second ? numberWords.indexOf(second) : 0);
}

function duration(text) {
  if (/\b(?:in|after|for)\s+half\s+(?:an?\s+)?hour\b/.test(text)) return 30;
  const match = new RegExp(`\\b(?:in|after|for)\\s+(${number})\\s+(minutes?|hours?|days?)\\b`).exec(text);
  if (!match) return null;
  return readNumber(match[1]) * ({m: 1, h: 60, d: 1440}[match[2][0]]);
}

function normalize(text) {
  return text.toLowerCase().replace(/[’]/g, "'").replace(/\b([ap])\.\s*m\.?/g, '$1m')
    .replace(/\s+/g, ' ').trim();
}

function withoutWake(text, name) {
  return text.replace(new RegExp(`^(?:hey|pay|open|wake up)[ ,]+(?:${spokenNames(name)})(?=$|[\\s,!.?])[,!.?\\s]*`, 'i'), '');
}

function spokenNames(name) {
  return [name, 'Memo', 'Mimo'].map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

function closeIntent(text, name) {
  return new RegExp(`^(?:please +)?(?:close|hide|goodbye)[ ,]+(?:${spokenNames(name)})(?:[, ]+please)?[.!? ]*$`, 'i').test(text);
}

function wakePhrases(name) {
  return [...new Set([name, 'Memo', 'Mimo'].flatMap(value =>
    ['Hey', 'Pay', 'Open', 'Wake up'].map(prefix => `${prefix} ${value}`)))];
}

function localDay(date) {
  return [date.getFullYear(), date.getMonth(), date.getDate()];
}

function offsetDay(parts, count) {
  const date = new Date(Date.UTC(parts[0], parts[1], parts[2] + count));
  return [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()];
}

function weekday(parts) {
  return new Date(Date.UTC(...parts)).getUTCDay();
}

function validDay(parts) {
  return parts[0] >= 2000 && parts[0] <= 9999 && parts.every((v, i) => offsetDay(parts, 0)[i] === v);
}

function calendar(text, today) {
  const iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(text);
  if (iso) return {match: iso, day: [+iso[1], +iso[2] - 1, +iso[3]]};
  const slash = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.exec(text);
  if (slash) return {match: slash, day: []};
  const named = new RegExp(`\\b(?:(${monthPattern}) (\\d{1,2})(?:st|nd|rd|th)?|(\\d{1,2})(?:st|nd|rd|th)? (?:of )?(${monthPattern}))(?:,? (\\d{4})(?![:\\d]))?\\b`).exec(text);
  if (named) {
    const day = [named[5] ? +named[5] : today[0], months.indexOf(named[1] || named[4]), +(named[2] || named[3])];
    if (!named[5] && validDay(day) && Date.UTC(...day) < Date.UTC(...today)) day[0]++;
    return {match: named, day};
  }
  const relative = /\b(?:day after tomorrow|tomorrow|today|tonight)\b/.exec(text);
  if (relative) return {match: relative, day: offsetDay(today, {'day after tomorrow': 2, tomorrow: 1}[relative[0]] ?? 0)};
  const week = new RegExp(`\\b(?:(next|this) )?(${dayPattern})\\b`).exec(text);
  if (week) {
    const current = weekday(today);
    const target = weekdays.indexOf(week[2]);
    const count = week[1] === 'next' ? (target + 6) % 7 + 7 - (current + 6) % 7 :
      (target - current + 7) % 7;
    return {match: week, day: offsetDay(today, count), bareWeekday: !week[1]};
  }
  return {};
}

function clock(text, remembered) {
  const part = /\b(morning|afternoon|evening|tonight)\b/.exec(text);
  const special = /\b(?:at\s+)?(noon|midnight)\b/.exec(text);
  if (special) return {match: special, time: [special[1] === 'noon' ? 12 : 0, 0], part};
  const withMeridiem = new RegExp(`\\b(?:at\\s+)?(${number})(?::(\\d{1,2}))?\\s*(am|pm)\\b`).exec(text);
  const digital = /\b(?:at\s+)?(\d{1,2}):(\d{1,2})\b/.exec(text);
  const contextual = new RegExp(`(?:\\b(?:at|around) +|^)(${number})(?=\\b)(?![:\\d-])`).exec(text);
  const match = withMeridiem || digital || contextual;
  if (!match) {
    if (remembered?.hour != null && (/^(?:am|pm)$/.test(text) || part)) {
      const pm = text === 'pm' || ['afternoon','evening','tonight'].includes(part?.[1]);
      return {match: part || /^am$|^pm$/.exec(text), time: [remembered.hour % 12 + (pm ? 12 : 0), remembered.minutes]};
    }
    return {part};
  }
  const hour = readNumber(match[1]);
  const minutes = Number(match[2] || 0);
  const meridiem = match[3] || (part ? (part[1] === 'morning' ? 'am' : 'pm') : null);
  if (hour < 0 || hour > 23 || minutes > 59 || (meridiem && (hour < 1 || hour > 12))) return {match, invalid: true};
  if (!meridiem && !digital && hour >= 1 && hour <= 12) return {match, part, ambiguous: {hour, minutes}};
  return {match, part, time: [meridiem ? hour % 12 + (meridiem === 'pm' ? 12 : 0) : hour, minutes]};
}

function removeMatches(source, matches) {
  const spans = matches.filter(Boolean).sort((a,b) => b.index - a.index);
  let end = source.length;
  let result = '';
  for (const match of spans) {
    const start = match.index;
    result = source.slice(start + match[0].length, end) + result;
    end = Math.min(end, start);
  }
  return source.slice(0, end) + result;
}

function parseReminder(input, previous = {}, now = Date.now(), scheduleOnly = false) {
  const original = input.trim().replace(/[’]/g, "'").replace(/\s+/g, ' ')
    .replace(/\b([ap])\.\s*m\.?/gi, '$1m').trim();
  const note = /(?:\s+[;,.]?\s*|^)(?:(?:note|details|description)\s*:\s*|with (?:a )?note (?:that )?|details are\s+)(.+)$/i.exec(original);
  const source = (note ? original.slice(0, note.index) : original).trim();
  const text = source.toLowerCase();
  const draft = {...previous, description: note?.[1] ?? previous.description ?? ''};
  const repeat = new RegExp(`\\b(?:every (day|${dayPattern})|(?:daily|weekly)(?=[,.;!? ]*$))\\b`).exec(text);
  if (repeat) draft.recurrence = /^(daily|every day)$/.test(repeat[0]) ? 'daily' : 'weekly';

  const today = localDay(new Date(now));
  const date = calendar(text, today);
  if (date.day) {
    draft.day = validDay(date.day) ? date.day : null;
    draft.bareWeekday = date.bareWeekday;
    draft.needsDate = !draft.day;
    delete draft.due;
  }
  const relativeText = new RegExp(`\\b(?:in|after)\\s+(?:half\\s+(?:an?\\s+)?hour|${number}\\s+(?:minutes?|hours?|days?))\\b`).exec(text);
  const relative = relativeText ? duration(relativeText[0]) : null;
  let remainder = text;
  for (const match of [date.match, relativeText].filter(Boolean))
    remainder = remainder.slice(0, match.index) + ' '.repeat(match[0].length) + remainder.slice(match.index + match[0].length);
  const time = clock(remainder, draft.ambiguous);
  if (time.time || time.invalid || time.ambiguous) {
    draft.time = time.time;
    draft.ambiguous = time.ambiguous;
    delete draft.due;
  }
  if (relative != null && relative > 0 && relative <= 525600) {
    draft.due = now + relative * minute;
    draft.needsDate = false;
  }

  if (!scheduleOnly && (!draft.title || previous.needsTitle)) {
    const residual = removeMatches(source, [repeat, repeat && date.match?.index >= repeat.index &&
      date.match.index < repeat.index + repeat[0].length ? null : date.match, time.match,
      time.part && time.part.index !== date.match?.index && time.part !== time.match ? time.part : null, relativeText]);
    const title = residual.replace(/\b(?:please\s+)?(?:remind me(?: to| that)?|remember(?: that)?|i need to|i have to|i want to|i should)\b/gi, '')
      .replace(/\s+in the\s*$/i, '').replace(/(?:^|\s)(?:on|at|around|by|in the)(?=\s*[,.;!?]*$)/i, '')
      .replace(/^(?:[\s,.;!?-]|to\b)+|[\s,.;!?-]+$/gi, '').replace(/\s+/g, ' ');
    if (title) draft.title = title;
  }

  draft.needsTitle = !scheduleOnly && (!draft.title || draft.title.length > 160);
  if (date.day && !draft.day) return {draft, question: 'What date should I use? Say the month and day, or a day like tomorrow.'};
  if (draft.needsDate) return {draft, question: 'What date should I use?'};
  if (time.invalid || relative != null && (relative < 1 || relative > 525600))
    return {draft, question: 'That time is outside the supported range. What time should I use?'};
  if (draft.needsTitle) return {draft, question: 'What should I remind you about?'};
  if (draft.ambiguous) return {draft, question: `Did you mean ${draft.ambiguous.hour} AM or PM?`};
  if (!draft.due && !draft.time) {
    const day = draft.day ? new Date(...draft.day).toLocaleDateString('en', {weekday: 'long'}) : '';
    return {draft, question: day ? `What time on ${day}?` : 'What time should I remind you?'};
  }
  if (!draft.due) {
    let day = draft.day || today;
    let date = new Date(...day, ...draft.time);
    if (date.getTime() <= now && !draft.day) {
      day = offsetDay(day, 1);
      date = new Date(...day, ...draft.time);
    } else if (date.getTime() <= now && (draft.recurrence === 'weekly' || draft.bareWeekday)) {
      day = offsetDay(day, 7);
      date = new Date(...day, ...draft.time);
    }
    if (!validDay(day) || date.getHours() !== draft.time[0] || date.getMinutes() !== draft.time[1] || date.getTime() <= now) {
      delete draft.day;
      draft.needsDate = true;
      return {draft, question: 'That date and time has passed or is unavailable. What date and time should I use?'};
    }
    draft.due = date.getTime();
  }
  return {draft};
}

function alertIntent(text, name = 'Mimo') {
  if (/^(?:yes[, ]+|ok(?:ay)?[, ]+)?(?:done|i (?:completed|finished|did) it|(?:mark|set) (?:it|this) (?:as )?(?:done|complete|completed))[.! ]*$/.test(text))
    return {type: 'done'};
  if (/^(?:dismiss(?: it)?|not now|close(?: (?:the )?avatar)?)[.! ]*$/.test(text) ||
      text.replace(/[.! ]+$/, '') === 'close ' + name.toLowerCase()) return {type: 'dismiss'};
  if (/^(?:snooze|remind me|come back)\b/.test(text)) {
    const minutes = duration(text);
    if (minutes != null) return {type: 'snooze', minutes};
  }
  if (/^(?:remind me|reschedule|move|change|snooze|come back)\b/.test(text)) return {type: 'reschedule'};
  return {type: 'unknown'};
}

function formatDue(due, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  return new Intl.DateTimeFormat('en', {
    timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit'
  }).format(due);
}
module.exports = {parseReminder, normalize, withoutWake, duration, alertIntent, formatDue, closeIntent, wakePhrases};
