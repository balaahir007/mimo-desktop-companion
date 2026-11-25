const el = id => document.getElementById(id);
const pet = el('pet');
const model = el('widgetAvatar');
const field = el('turnInput');
let preferences, view = {state:'HIDDEN'}, origin, dragged = false, editing = false, displayedHeard = '';

pet.onpointerdown = event => {
  origin = {x:event.screenX, y:event.screenY, left:window.screenX, top:window.screenY};
  dragged = false;
  pet.setPointerCapture(event.pointerId);
};
pet.onpointermove = event => {
  if (!origin) return;
  const dx = event.screenX - origin.x, dy = event.screenY - origin.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) dragged = true;
  if (dragged) mimo.move(Math.round(origin.left + dx), Math.round(origin.top + dy));
};
pet.onpointerup = pet.onpointercancel = () => {
  if (dragged) mimo.position();
  origin = null;
};
pet.onclick = event => {
  if (dragged && event.detail !== 0) return;
  if (view.state === 'HIDDEN') mimo.open();
  else mimo.focusWidget();
};

function applyProfile(profile) {
  preferences = profile;
  drawAvatar(model, profile);
  el('companionName').textContent = profile.name;
  pet.setAttribute('aria-label', `Open ${profile.name}, or drag to move`);
}
mimo.config().then(config => applyProfile(config.profile));
mimo.onProfile(applyProfile);
let moveTimer;
mimo.onPerform(action => {
  clearTimeout(moveTimer);
  playAction(model, action);
  moveTimer = setTimeout(() => {
    if (model.dataset.pose === 'idle') model.dataset.motion = '';
  },2200);
});

function setText(id, text) {
  const target = el(id);
  if (target.textContent !== text) target.textContent = text;
}

function render(next) {
  const previous = view;
  view = next;
  const active = view.state !== 'HIDDEN';
  const closing = view.state === 'CLOSING';
  const confirm = ['confirm','reschedule-confirm','model-confirm'].includes(view.mode);
  const speaking = ['GREETING','SPEAKING'].includes(view.state);
  const waiting = view.ready && !view.consent;
  document.body.dataset.state = view.state;
  document.body.dataset.urgent = String(!!view.urgent);
  setAvatarState(model, view.state, view.motion, preferences?.action);
  setText('spark', view.motion === 'saved' ? '✓' : '✦');
  el('bubble').hidden = !active || closing || view.state === 'APPEARING';
  setText('message', view.message || '');
  el('modelText').hidden = !view.modelDraft && !view.modelReply;
  setText('modelText', view.modelDraft || view.modelReply || '');
  el('alertTitle').hidden = !view.alert;
  setText('alertTitle', view.alert || '');
  el('activity').dataset.recording = String(!!view.recording);
  setText('activityText', view.recording ? 'Listening' : speaking ? 'Speaking' :
    view.state === 'THINKING' ? 'Thinking…' : view.state === 'SAVING_REMINDER' ? 'Saving…' : '');
  const transcript = view.partial || view.heard || '';
  el('transcript').hidden = !transcript;
  setText('transcript', transcript);
  setText('voiceStatus', view.hint || '');
  const draftDetails = confirm ? [view.draft?.description, view.draft?.recurrence === 'weekly' ?
    'Repeats weekly' : view.draft?.recurrence === 'daily' ? 'Repeats daily' : null].filter(Boolean).join(' · ') : '';
  el('draftDetails').hidden = !draftDetails;
  setText('draftDetails', draftDetails);

  el('consent').hidden = !view.consent;
  el('turnForm').hidden = !waiting;
  el('confirmActions').hidden = !waiting || !confirm || editing;
  el('alertActions').hidden = !waiting || !view.alert || confirm;
  el('cancelTurn').hidden = !active || closing || Boolean(view.alert && waiting);
  el('stopAudio').hidden = !view.recording && !speaking && !(waiting && view.canListen && !view.hint);
  el('startMic').hidden = !waiting || !view.canListen || view.recording || !view.hint;

  if (!active || closing || previous.state === 'HIDDEN') {
    field.value = '';
    editing = false;
    displayedHeard = '';
  } else if (waiting && !confirm && view.heard && view.heard !== displayedHeard && view.hint && !field.value) {
    field.value = view.heard;
    displayedHeard = view.heard;
  }
}

mimo.conversation(render);
el('turnForm').onsubmit = event => {
  event.preventDefault();
  const text = field.value.trim();
  if (!text) return;
  const replace = editing;
  editing = false;
  field.value = '';
  mimo.submit(text, replace);
};

function editRequest() {
  const draft = view.draft;
  if (!draft?.due) { mimo.action('edit'); return; }
  const local = new Date(draft.due);
  const date = new Date(draft.due - local.getTimezoneOffset() * 60000).toISOString();
  const when = `${date.slice(0,10)} at ${date.slice(11,16)}`;
  const repeat = draft.recurrence ? ` ${draft.recurrence}` : '';
  const note = draft.description ? ` note: ${draft.description}` : '';
  field.value = draft.title ? `Remind me to ${draft.title} on ${when}${repeat}${note}` : when;
  editing = true;
  mimo.stopAudio();
  field.focus();
  field.select();
}
el('editTurn').onclick = editRequest;
el('confirmTurn').onclick = () => mimo.action('confirm');
el('completeTurn').onclick = () => mimo.action('done');
el('snoozeTurn').onclick = () => mimo.action('snooze',10);
el('dismissTurn').onclick = () => mimo.action('dismiss');
el('cancelTurn').onclick = () => mimo.closeCompanion();
el('stopAudio').onclick = () => mimo.stopAudio();
el('startMic').onclick = () => mimo.startMic();

field.addEventListener('input', () => {
  if (view.recording || !view.hint && view.canListen) mimo.stopAudio();
});
function micConsent(enabled) {
  mimo.micConsent(enabled).catch(() => setText('voiceStatus', 'Mimo could not save your permission choice. Try again.'));
}
el('allowMic').onclick = () => micConsent(true);
el('useTyping').onclick = () => micConsent(false);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); mimo.stopAudio(); }
});
