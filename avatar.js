const inks={Lavender:'#bbadee',Mint:'#9edcc5',Peach:'#f2b79e',Sky:'#9ccded',Rose:'#efb1d0',Sunshine:'#f1cd76'};
const bodies={
 Bunny:'M23 68Q18 38 39 32Q29 9 38 5Q48 2 55 28H65Q75 0 84 7Q89 12 79 32Q98 41 97 63Q100 84 81 87Q75 94 64 87H51Q36 95 34 85Q24 83 23 68Z',
 Cloud:'M20 79Q3 69 15 52Q18 44 29 45Q31 27 48 29Q58 12 73 20Q85 23 88 37Q106 35 107 52Q121 63 108 77Q98 89 80 83Q61 93 46 84Q28 90 20 79Z',
 Robot:'M58 28V18H62V28H80Q97 28 97 43V72Q97 85 83 85H37Q23 85 23 71V44Q23 28 38 28Z',
 Sprout:'M29 74Q20 50 36 37Q45 30 58 33Q57 24 54 21Q37 24 33 9Q48 4 59 19Q62 8 84 9Q86 23 65 27L66 33Q91 29 97 53Q105 83 80 87Q69 94 61 87Q51 93 42 87Q32 85 29 74Z',
 Star:'M54 15Q60 4 66 15L76 35L99 38Q110 40 103 49L86 64L89 86Q91 96 81 92L60 82L40 92Q30 96 31 85L34 64L17 49Q9 40 21 38L44 35Z'
};
const faces={Curious:'<circle cx="47" cy="55" r="3"/><circle cx="74" cy="55" r="3"/>',Happy:'<path d="M42 56q5-9 10 0m17 0q5-9 10 0" fill="none"/>',Sleepy:'<path d="M42 55q5 5 10 0m17 0q5 5 10 0" fill="none"/>'};
const accessories={None:'',Bow:'<path d="M74 32l-10-7v14zM74 32l10-7v14z" fill="#eb8399"/>',Crown:'<path d="M47 29l-4-15 11 6 7-11 7 11 11-6-4 15z" fill="#ffd36c"/>'};
function drawAvatar(el,p){
  el.dataset.size=p.size;
  el.innerHTML='<svg viewBox="0 0 120 100" aria-hidden="true"><ellipse cx="60" cy="92" rx="32" ry="4" fill="#463f65" opacity=".14"/><g class="character" stroke="#423d54" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"><path fill="'+inks[p.color]+'" d="'+bodies[p.preset]+'"/>'+(p.preset==='Robot'?'<circle cx="60" cy="15" r="5" fill="#ffc982"/>':'')+'<path class="hand" fill="'+inks[p.color]+'" d="M90 66q13-15 16-7q3 9-13 16"/><g class="eyes" fill="#423d54">'+faces[p.face]+'</g><path class="smile" d="M55 65q6 7 12 0" fill="none"/><ellipse class="talk-mouth" cx="61" cy="67" rx="4" ry="3" fill="#423d54"/><path class="sleep-eyes" d="M42 55q5 5 10 0m17 0q5 5 10 0" fill="none"/><g fill="#e89da6" stroke="none"><ellipse cx="38" cy="63" rx="5" ry="2.5"/><ellipse cx="83" cy="63" rx="5" ry="2.5"/></g>'+accessories[p.accessory]+'</g></svg>';
}
function playAction(el,action){
  el.dataset.motion='';void el.offsetWidth;el.dataset.motion=action;
}

const standardMotion = {
  HIDDEN: 'idle', APPEARING: 'entrance', GREETING: 'speaking', LISTENING: 'listening',
  TRANSCRIBING: 'listening', THINKING: 'thinking', SPEAKING: 'speaking',
  AWAITING_CONFIRMATION: 'listening', SAVING_REMINDER: 'thinking',
  REMINDER_ALERT: 'arrival', WAITING_FOR_REMINDER_RESPONSE: 'listening',
  CLOSING: 'goodbye', ERROR: 'listening'
};

function setAvatarState(el, state, accent, reminderAction, pack = standardMotion) {
  const pose = accent || pack[state] || pack.HIDDEN;
  if (el.dataset.pose === pose) return;
  el.dataset.pose = pose;
  if (state === 'REMINDER_ALERT') playAction(el, reminderAction || 'Wave');
  else el.dataset.motion = '';
}
