let profile;
let wakeState = {};
const studio = document.querySelector('#studio');
const control = key => document.getElementById(key);

function switchView(view) {
  for (const panel of document.querySelectorAll('body > main')) panel.hidden = panel.id !== view;
  for (const button of document.querySelectorAll('[data-view]'))
    button.setAttribute('aria-pressed', String(button.dataset.view === view));
}

for (const button of document.querySelectorAll('[data-view]'))
  button.onclick = () => switchView(button.dataset.view);
mimo.showStudio(() => switchView('studio'));

function status(id, text) {
  const element = control(id);
  element.textContent = text;
  element.hidden = !text;
}

let appearanceOptions;
const presetColors = {Bunny:'Lavender',Cloud:'Sky',Robot:'Peach',Sprout:'Mint',Star:'Sunshine'};

function setProfile(next) {
  profile = next;
  for (const [key,value] of Object.entries(profile)) {
    const field = control(key);
    if (!field) continue;
    if (field.type === 'checkbox') field.checked = value === true;
    else if (key !== 'voice' || Array.from(field.options).some(option => option.value === value)) field.value = value;
  }
  control('wakeName').textContent = profile.name;
  drawAvatar(control('preview'), profile);
  drawAvatar(control('mini'), profile);
  if (appearanceOptions) renderLooks();
  showWakeStatus();
}

function showWakeStatus() {
  if (!profile) return;
  const label = profile.wake ?
    (wakeState.error ? 'Microphone retrying' : wakeState.listening ? 'Listening for “Hey Mimo”' : 'Voice wake enabled') :
    'Voice wake off';
  control('homeWakeStatus').textContent = label;
  status('wakeStatus',wakeState.error || label);
}

function renderLooks() {
  const fields = {preset:'avatarChoices',color:'avatarColors',face:'avatarFaces',accessory:'avatarAccessories',size:'avatarSizes'};
  for (const [key,id] of Object.entries(fields)) {
    const parent = control(id);
    const focused = parent.contains(document.activeElement) ? document.activeElement.dataset.value : undefined;
    parent.replaceChildren(...appearanceOptions[key].map(value => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.value = value;
      button.setAttribute('aria-pressed',String(profile[key] === value));
      if (key === 'preset') {
        const preview = document.createElement('span');
        preview.className = 'avatar';
        drawAvatar(preview,{...profile,preset:value,size:'Small',color:profile.preset === value ? profile.color : presetColors[value]});
        button.append(preview);
      }
      if (key === 'color') {
        const swatch = document.createElement('span');
        swatch.className = 'avatar-swatch';
        swatch.dataset.color = value;
        swatch.setAttribute('aria-hidden','true');
        button.append(swatch);
      }
      const label = document.createElement('span');
      label.textContent = value;
      button.append(label);
      button.onclick = async () => {
        if (profile[key] === value) return;
        try {
          setProfile(await mimo.setting(key,value));
          if (key === 'preset') setProfile(await mimo.setting('color',presetColors[value]));
          status('settingStatus','');
        } catch (error) { status('settingStatus',error.message.replace(/^.*?Error: /,'')); }
      };
      return button;
    }));
    if (focused) [...parent.children].find(button => button.dataset.value === focused)?.focus();
  }
}

async function setupStudio() {
  const config = await mimo.config();
  appearanceOptions = config.options;
  for (const [key,values] of Object.entries({...config.options,rate:[0.8,1,1.2]})) {
    const field = control(key);
    if (field) for (const value of values) field.add(new Option(key === 'rate' ? value + '×' : value, value));
  }
  const voice = control('voice');
  voice.add(new Option('Memo — cartoon voice',''));
  const shortcutProblems = {...config.shortcutErrors};
  const showShortcutProblems = () => status('shortcutStatus', Object.values(shortcutProblems).join(' '));
  setProfile(config.profile);
  showShortcutProblems();
  status('schedulerStatus', config.schedulerError);
  wakeState = config.wakeStatus;
  showWakeStatus();
  mimo.wakeStatus(value => { wakeState = value; showWakeStatus(); });
  control('talkToMimo').onclick = () => mimo.talk();
  studio.onchange = async event => {
    const field = event.target;
    const key = field.id;
    const value = field.type === 'checkbox' ? field.checked :
      ['rate','volume'].includes(key) ? Number(field.value) : field.value.trim();
    try {
      setProfile(await mimo.setting(key,value));
      if (['shortcut','stopShortcut'].includes(key)) delete shortcutProblems[key];
      showShortcutProblems();
      status('settingStatus','');
      if (key === 'action') playAction(control('preview'),value);
    } catch (error) {
      status('settingStatus', error.message.replace(/^.*?Error: /, ''));
    }
  };
  control('play').onclick = () => { playAction(control('preview'),profile.action); mimo.perform(profile.action); };
  for (const button of studio.querySelectorAll('[data-move]')) {
    button.onclick = () => {
      playAction(control('preview'),button.dataset.move);
      mimo.perform(button.dataset.move);
    };
  }
  control('sample').onclick = () => mimo.read(`Hello! I'm ${profile.name}. It’s time for your reminder.`);
  control('stop').onclick = () => mimo.read('');
  mimo.onProfile(setProfile);
  mimo.voiceStatus(text => status('studioVoiceStatus',text));
  mimo.schedulerStatus(text => status('schedulerStatus',text));
  for (const name of await mimo.voices()) voice.add(new Option(name,name));
  if (Array.from(voice.options).some(option => option.value === profile.voice)) voice.value = profile.voice;
}
setupStudio().catch(() => status('settingStatus','Mimo could not load companion preferences.'));

control('commandForm').onsubmit = event => {
  event.preventDefault();
  const raw = control('command').value.trim();
  if (!raw) return;
  const match = /^(?:remind me to\s+)?(.+?)\s+in\s+(\d{1,4})\s+(minutes?|hours?)$/i.exec(raw);
  if (match && Number(match[2]) > 0) form({title:match[1],due:Date.now()+Number(match[2])*(/^h/i.test(match[3])?3600000:60000)});
  else { form({title:raw}); control('due').value = ''; control('due').focus(); }
};
