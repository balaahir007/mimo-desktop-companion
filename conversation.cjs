const {randomUUID} = require('node:crypto');
const {currentTimezone} = require('./store.cjs');
const {voiceLines} = require('./companion.cjs');
const {voiceAction} = require('./actions.cjs');
const {parseReminder, normalize, withoutWake, formatDue, alertIntent, closeIntent} = require('./reminder-language.cjs');

const goodbye = /^(?:(?:no[, ]+)?(?:that(?:'s| is) all|nothing else)|no|no thanks|goodbye|bye|you can go now|hide (?:the )?avatar)[.! ]*$/;
const yes = /^(?:yes|confirm|save(?: it| reminder)?|sure|correct|that's right|go ahead|ok(?:ay)?)[.! ]*$/;
const edit = /^(?:edit(?: it)?|change(?: it)?|try again|no(?:pe)?|wrong)[.! ]*$/;
const pick = phrases => phrases[Math.floor(Math.random() * phrases.length)];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class Conversation {
  constructor({db, speech, profile, show, hide, publish, update, onClosed, handoff, model, animate}) {
    Object.assign(this, {db, speech, profile, show, hide, publish, update, onClosed, handoff, model, animate});
    this.session = null;
    this.audio = null;
  }

  render(state, fields = {}) {
    if (!this.session) return;
    Object.assign(this.session.view, {state}, fields);
    this.publish({...this.session.view, mode: this.session.mode, alert: this.session.row?.title,
      urgent: this.session.row?.due < Date.now() - 60000});
  }

  begin(row, notice) {
    if (this.session) return false;
    this.session = {
      row, notice, mode: notice ? 'notice' : row ? 'alert' : 'request', view: {}, draft: {}, transcript: [],
      revision: 0, key: randomUUID(), micStopped: false
    };
    this.show();
    this.render(row || notice ? 'REMINDER_ALERT' : 'APPEARING', {message: notice || row?.title || '', hint: '', heard: ''});
    const token = this.token();
    void this.arrive(token);
    return true;
  }

  token() { return {session: this.session, revision: this.session.revision}; }
  valid(token) { return token.session === this.session && token.revision === this.session.revision; }

  async stopAudio() {
    const audio = this.audio;
    if (!audio) return;
    audio.cancel();
    await audio.result;
    if (this.audio === audio) this.audio = null;
  }

  async play(token, text, state = 'SPEAKING', motion = '') {
    if (!this.valid(token)) return;
    this.render(state, {message: text, hint: '', motion, ready: false, recording: false, consent: false});
    await this.stopAudio();
    if (!this.valid(token)) return;
    if (!this.profile().speech) return;
    const audio = this.speech.speak(text, this.profile());
    this.audio = audio;
    const result = await audio.result;
    if (this.audio === audio) this.audio = null;
    if (this.valid(token) && result.type === 'error') this.render(state, {hint: result.text});
  }

  async arrive(token) {
    await delay(680);
    if (!this.valid(token)) return;
    const {row,notice} = this.session;
    if (notice) {
      await this.play(token,notice,'SPEAKING','saved');
      if (this.valid(token)) await delay(2600);
      if (this.valid(token)) await this.finish(token);
      return;
    }
    if (row) {
      const text = row.state === 'missed' ?
        `A reminder came due while you were away. You wanted to ${row.title}.` :
        pick([`Little reminder! It's time to ${row.title}.`, `Hey! You asked me to remind you to ${row.title}.`]);
      await this.play(token, text);
    } else {
      await this.play(token, voiceLines.greeting, 'GREETING');
    }
    if (this.valid(token)) this.listen(token);
  }

  listen(token, hint) {
    if (!this.valid(token)) return;
    const session = this.session;
    const profile = this.profile();
    const consent = profile.recognition === null && !session.row && !session.micStopped;
    const phase = ['confirm', 'reschedule-confirm', 'model-confirm'].includes(session.mode) ? 'AWAITING_CONFIRMATION' :
      session.row ? 'WAITING_FOR_REMINDER_RESPONSE' : 'LISTENING';
    this.render(phase, {ready: true, consent, recording: false, partial: '',
      canListen: profile.recognition === true, hint: hint ?? session.view.hint ?? '', motion: ''});
    this.clearExpiry();
    this.expiry = setTimeout(() => {
      if (!this.valid(token)) return;
      if (session.goodbyeAt && session.mode === 'request') void this.finish(token, 'All set. See you later!');
      else this.closeSilently();
    }, session.goodbyeAt ? Math.max(0, session.goodbyeAt - Date.now()) : 180000);
    if (profile.recognition === true && !session.micStopped) void this.capture(token);
  }

  async capture(token) {
    await this.stopAudio();
    if (!this.valid(token) || this.session.micStopped || this.profile().recognition !== true) return;
    let partial = '';
    const job = this.speech.listen(event => {
      if (!this.valid(token)) return;
      if (event.type === 'ready') this.render(this.session.view.state, {recording: true, hint: ''});
      if (event.type === 'partial') {
        partial = event.text;
        this.render('TRANSCRIBING', {partial, recording: true});
      }
    }, 'en-US', this.profile().name);
    this.audio = job;
    const result = await job.result;
    if (this.audio === job) this.audio = null;
    if (!this.valid(token)) return;
    if (result.type === 'empty' && !partial) {
      this.render(this.session.view.state,{recording:false,partial:''});
      // Re-arm quietly within the current session's existing idle deadline.
      await delay(350);
      if (this.valid(token)) void this.capture(token);
      return;
    }
    this.session.micStopped = true;
    this.render(this.session.view.state, {recording: false, partial: ''});
    if (result.type === 'final' && result.text && result.confidence >= 0.35) {
      await this.submit(result.text, true);
    } else if (this.session.mode === 'request' &&
        (/\b(?:remind me|remember|i (?:need to|have to))\b/i.test(result.text || partial) ||
          voiceAction(withoutWake(result.text || partial,this.profile().name))?.view === 'agent')) {
      // A draft still needs an explicit confirmation. Never use a hypothesis for a control command.
      await this.submit(result.text || partial, true);
    } else {
      const message = result.type === 'error' ? result.text :
        (result.type === 'final' || partial ? 'I didn’t catch that clearly. Edit the text or try the microphone again.' :
          'I didn’t hear anything. Try the microphone again or type your response.');
      this.render(result.type === 'error' ? 'ERROR' : this.session.view.state, {heard: result.text || partial});
      this.listen(token, message);
    }
  }

  restartMic() {
    if (!this.session?.view.ready || this.profile().recognition !== true) return;
    this.clearExpiry();
    this.session.revision++;
    this.session.micStopped = false;
    this.listen(this.token());
  }

  consent(enabled) {
    if (!this.session?.view.consent || this.profile().recognition !== enabled) return;
    this.session.revision++;
    this.session.micStopped = !enabled;
    this.listen(this.token(), enabled ? '' : 'The microphone is off. You can type your request.');
  }

  interrupt() {
    if (!this.session) { void this.stopAudio(); return; }
    if (this.session.view.state === 'CLOSING') return;
    if (this.session.finishing || this.session.notice) { this.closeSilently(); return; }
    this.session.revision++;
    this.session.micStopped = true;
    const token = this.token();
    this.render(this.session.view.state, {recording: false, partial: '', consent: false});
    void this.stopAudio().then(() => {
      if (this.valid(token)) this.listen(token, 'Audio stopped. Type a response or start the microphone again.');
    });
  }

  async respond(token, text, motion = '') {
    await this.play(token, text, 'SPEAKING', motion);
    if (this.valid(token)) this.listen(token);
  }

  collect(text, spoken) {
    if (spoken) this.session.transcript.push(text);
    if (this.session.transcript.join(' ').length > 3000) this.session.transcript.shift();
  }

  async submit(value, spoken = false, replace = false) {
    const session = this.session;
    if (!session?.view.ready || typeof value !== 'string' || !value.trim() || value.length > 800) return;
    this.clearExpiry();
    session.revision++;
    session.goodbyeAt = null;
    session.micStopped = !spoken && session.micStopped;
    if (replace) {
      session.draft = {};
      session.mode = session.row ? 'reschedule' : 'request';
    }
    const token = this.token();
    const raw = value.trim();
    const command = withoutWake(raw, this.profile().name);
    const text = normalize(command);
    const modelRequest = /^(?:talk to|chat with|switch to|use) (claude|chat\s*gpt)[.!? ]*$/.exec(text);
    const actionDraft = session.mode === 'request' && voiceAction(command);
    const move = /^(?:please )?(dance|jump|wave)(?: for me)?[.! ]*$/.exec(text)?.[1];
    this.render('THINKING', {ready: false, recording: false, consent: false, partial: '', heard: spoken ? raw : '',
      hint: '', motion: ''});
    await this.stopAudio();
    await delay(160);
    if (!this.valid(token)) return;
    try {
      if (!text) {
        await this.respond(token, session.row ? "I'm here. What would you like to do with this reminder?" :
          "I'm listening. What would you like me to remember?");
      } else if (/^(?:stop listening|mute(?: the)? microphone)[.! ]*$/.test(text)) {
        this.interrupt();
      } else if (move && session.mode === 'request' && this.animate) {
        if (await this.finish(token, 'Here I go!')) this.animate(move[0].toUpperCase() + move.slice(1));
      } else if (actionDraft && this.handoff) {
        const area = actionDraft.view === 'agent' ? 'the agent planner' : actionDraft.view === 'workflows' ? 'Workflows' : 'Actions';
        if (await this.finish(token, `I’ll open ${area} so you can review that.`)) this.handoff(actionDraft);
      } else if (closeIntent(text, this.profile().name)) {
        const farewell = voiceLines.goodbye;
        if (session.row) await this.reminderAction(token, 'dismiss', undefined, farewell);
        else await this.finish(token, farewell);
      } else if (goodbye.test(text) && (!/^no[.! ]*$/.test(text) || (!session.row && !['confirm','model-confirm'].includes(session.mode)))) {
        if (session.row) await this.reminderAction(token, 'dismiss');
        else await this.finish(token, session.saved ? "All set. See you later!" : "See you later!");
      } else if (modelRequest && !session.row && this.model) {
        const id = modelRequest[1] === 'claude' ? 'claude' : 'chatgpt';
        const name = id === 'claude' ? 'Claude' : 'ChatGPT';
        if (!this.model.connected(id)) {
          if (await this.finish(token, `Connect your ${name} API key in Actions to talk here.`)) this.handoff?.({id});
        } else {
          session.modelChat = {id,name,history:[]};
          session.draft = {};
          session.transcript = [];
          session.mode = 'model-chat';
          this.render('THINKING',{modelDraft:'',modelReply:''});
          await this.respond(token,`Connected to ${name}. What would you like to ask?`);
        }
      } else if (session.modelChat && /^(?:exit chat|back to reminders|stop chat)[.! ]*$/.test(text)) {
        session.modelChat = null;
        session.mode = 'request';
        this.render('THINKING',{modelDraft:'',modelReply:''});
        await this.respond(token,'Back to reminders. What would you like me to remember?');
      } else if (session.mode === 'model-confirm') {
        if (yes.test(text)) await this.sendModelTurn(token);
        else if (edit.test(text) || /^cancel[.! ]*$/.test(text)) {
          session.mode = 'model-chat';
          this.render('THINKING',{modelDraft:''});
          await this.respond(token,'What would you like to ask instead?');
        } else await this.respond(token,'Say confirm to send this message, or edit to change it.');
      } else if (session.mode === 'model-chat') {
        session.modelChat.draft = command;
        session.mode = 'model-confirm';
        this.render('THINKING',{modelDraft:command,modelReply:''});
        await this.respond(token,`Send this to ${session.modelChat.name}?`);
      } else if (session.mode === 'confirm' || session.mode === 'reschedule-confirm') {
        if (yes.test(text)) {
          if (session.row) await this.reminderAction(token, 'reschedule', session.draft.due);
          else await this.save(token);
        } else if (edit.test(text)) {
          session.mode = session.row ? 'reschedule' : 'request';
          session.draft = {};
          await this.respond(token, session.row ? 'When would you like me to remind you?' : 'Sure. Tell me the reminder again, or type the updated request.');
        } else {
          await this.respond(token, 'Say confirm to use this date and time, or edit to change it.');
        }
      } else if (session.mode === 'alert') {
        const intent = alertIntent(text, this.profile().name);
        if (intent.type === 'done' || intent.type === 'dismiss') await this.reminderAction(token, intent.type);
        else if (intent.type === 'snooze') await this.reminderAction(token, 'snooze', intent.minutes);
        else if (intent.type === 'reschedule') {
          session.mode = 'reschedule';
          await this.interpret(token, command, spoken);
        } else await this.respond(token, 'Did you want to mark it done, snooze it, or pick another time?');
      } else if (/^(?:cancel|never mind|nevermind)[.! ]*$/.test(text)) {
        if (session.row) { session.mode = 'alert'; await this.respond(token, 'The reminder is still open. What would you like to do?'); }
        else await this.finish(token, 'Okay. See you later!');
      } else {
        await this.interpret(token, command, spoken);
      }
    } catch (error) {
      if (!this.valid(token)) return;
      this.render('ERROR', {hint: error.message || 'Something went wrong. Please try again.',
        ...(session.mode === 'model-confirm' ? {modelDraft:session.modelChat.draft} : {})});
      this.listen(token);
    }
  }

  async sendModelTurn(token) {
    const chat = this.session.modelChat;
    const draft = chat.draft;
    this.render('THINKING',{message:`Waiting for ${chat.name}…`,modelDraft:''});
    const answer = await this.model.send(chat.id,draft,chat.history);
    if (!this.valid(token)) return;
    chat.history.push({role:'user',content:draft},{role:'assistant',content:answer.slice(0,2500)});
    chat.history = chat.history.slice(-6);
    this.session.mode = 'model-chat';
    const spoken = answer.replace(/^[#>*]+\s*/gm,'').replace(/[*`]/g,'').trim();
    const preview = spoken.length > 420 ? spoken.slice(0,420).replace(/\s+\S*$/,'') +
      '. The full reply is in the bubble.' : spoken;
    await this.play(token,preview);
    if (this.valid(token)) {
      this.render('THINKING',{message:chat.name,modelReply:answer});
      this.listen(token);
    }
  }

  async interpret(token, command, spoken) {
    const session = this.session;
    this.collect(this.session.view.heard || command, spoken);
    const {draft, question} = parseReminder(command, session.draft, Date.now(), !!session.row);
    session.draft = draft;
    if (question) { await this.respond(token, question); return; }
    const when = formatDue(draft.due);
    session.mode = session.row ? 'reschedule-confirm' : 'confirm';
    this.render('THINKING', {draft: {title: draft.title, when, due: draft.due, description: draft.description,
      recurrence: draft.recurrence, request: session.transcript.at(-1) || command}});
    const repeat = draft.recurrence ? ` Repeat ${draft.recurrence}.` : '';
    const text = session.row ? `Move this reminder to ${when}?` : `Remind you to ${draft.title} on ${when}?${repeat}`;
    await this.respond(token, text);
  }

  async save(token) {
    const session = this.session;
    if (session.draft.due <= Date.now()) {
      session.mode = 'request';
      session.draft = {title: session.draft.title, description: session.draft.description, recurrence: session.draft.recurrence};
      await this.respond(token, 'That time has passed. When should I remind you instead?');
      return;
    }
    this.render('SAVING_REMINDER', {ready: false});
    this.db.save(session.draft.title, session.draft.due, null, {
      description: session.draft.description, transcript: session.transcript.join(' '),
      recurrence: session.draft.recurrence, timezone: currentTimezone(), submissionKey: session.key
    });
    this.update();
    session.saved = true;
    session.mode = 'request';
    session.key = randomUUID();
    session.draft = {};
    session.transcript = [];
    this.render('SAVING_REMINDER', {draft: null, heard: ''});
    await this.play(token, pick(["Got it! Your reminder is saved. Anything else?", "You're all set! Can I help you remember anything else?"]), 'SPEAKING', 'saved');
    if (this.valid(token)) {
      session.goodbyeAt = Date.now() + 14000;
      this.listen(token);
    }
  }

  async reminderAction(token, action, value, farewell) {
    const current = this.db.find(this.session.row.id);
    if (!current || !['notified','missed'].includes(current.state) || current.acknowledged_at) {
      this.session.resolved = true;
      await this.finish(token, 'That reminder has already changed.');
      return;
    }
    this.render('SAVING_REMINDER', {ready: false});
    this.db.act(this.session.row.id, action, value);
    this.session.resolved = true;
    this.update();
    const text = {
      done: pick(["Awesome! One more thing off your list.", "Nice work! I marked it complete."]),
      snooze: value === 1 ? "Of course! I'll be back in one minute." : `Of course! I'll be back in ${value} minutes.`,
      dismiss: farewell || 'Okay, see you later!',
      reschedule: action === 'reschedule' ? `All set. I'll come back on ${formatDue(value)}.` : ''
    }[action];
    await this.finish(token, text, action === 'done' ? 'saved' : action === 'snooze' ? 'snoozed' : '');
  }

  async action(action, value) {
    if (!this.session?.view.ready) return;
    if (action === 'cancel' && !this.session.row) {
      this.closeSilently();
      return;
    }
    const commands = {confirm: 'confirm', edit: 'edit', done: 'done', dismiss: 'dismiss', snooze: `snooze for ${value} minutes`};
    if (Object.hasOwn(commands, action)) {
      if (this.session.row && ['done','dismiss','snooze'].includes(action)) this.session.mode = 'alert';
      await this.submit(commands[action]);
    }
  }

  clearExpiry() { clearTimeout(this.expiry); }

  async finish(token, text, motion) {
    if (!this.valid(token)) return;
    this.clearExpiry();
    if (text) {
      this.session.finishing = true;
      await this.play(token, text, 'SPEAKING', motion);
    }
    if (!this.valid(token)) return;
    this.render('CLOSING', {recording: false, ready: false, message: '', motion: ''});
    await delay(550);
    if (!this.valid(token)) return;
    this.session = null;
    this.hide();
    this.onClosed();
    return true;
  }

  closeSilently() {
    if (!this.session || this.session.view.state === 'CLOSING') return;
    this.session.revision++;
    this.clearExpiry();
    const token = this.token();
    const row = this.session.row;
    if (row && !this.session.resolved) {
      try {
        const current = this.db.find(row.id);
        if (current && ['notified','missed'].includes(current.state)) this.db.act(row.id, 'dismiss');
        this.update();
      } catch {
        this.render('ERROR', {hint: 'The reminder could not be updated. Try again.', ready: true});
        return;
      }
    }
    this.render('CLOSING', {recording: false, ready: false});
    void this.stopAudio().then(() => this.finish(token));
  }

  abort() {
    this.session = null;
    this.clearExpiry();
    void this.stopAudio();
  }
}

module.exports = {Conversation};
