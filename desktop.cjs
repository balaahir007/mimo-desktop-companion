const {app, BrowserWindow, Tray, Menu, Notification, ipcMain, screen, powerMonitor, nativeImage, globalShortcut, session,
  shell, clipboard, safeStorage, dialog} = require('electron');
const path = require('node:path');
const {copyFile} = require('node:fs/promises');
const {options, defaults, validate} = require('./companion.cjs');
const {Store} = require('./store.cjs');
const {WindowsSpeech} = require('./speech.cjs');
const {Conversation} = require('./conversation.cjs');
const {Actions} = require('./actions.cjs');
const {Workflows} = require('./workflows.cjs');
const {Agent} = require('./agent.cjs');
const {normalize, wakePhrases} = require('./reminder-language.cjs');

const speech = new WindowsSpeech();
const width = 368, height = 370;
let db, main, widget, tray, trayImages, timer, conversation, actions, workflows, agent, widgetReady = false, quitting = false, suspended = false;
let paused = false, schedulerError = '', manualAudio, activePosition;
let wakeAudio, wakeFault = '', wakeRetryAt = 0, wakeListening = false, starting = false, reading = false;
const completionNotices = [];
const shortcuts = new Map();
const shortcutErrors = {};

function windowFor(file, bounds) {
  const win = new BrowserWindow({...bounds, webPreferences: {
    preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false
  }});
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.loadFile(path.join(__dirname, file));
  return win;
}

function open(mode, draft) {
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
  if (mode === 'new') main.webContents.send('form');
  if (mode === 'studio') main.webContents.send('studio');
  if (mode === 'actions') main.webContents.send('show-actions',draft);
  if (mode === 'workflows') main.webContents.send('show-workflows',draft);
  if (mode === 'agent') main.webContents.send('show-agent',draft);
}

function clamp(x, y, w = width, h = height) {
  const a = screen.getDisplayNearestPoint({x: x + w / 2 | 0, y: y + h / 2 | 0}).workArea;
  return [Math.max(a.x, Math.min(x, a.x + a.width - w)), Math.max(a.y, Math.min(y, a.y + a.height - h))];
}

function refresh() { main.webContents.send('changed'); }

function widgetBounds(idle) {
  const w = idle ? 134 : width;
  const h = idle ? 120 : height;
  const [left, top] = activePosition;
  const [x, y] = clamp(left + (width - w) / 2, top + height - h, w, h);
  widget.setBounds({x,y,width:w,height:h});
}

function showIdle() {
  if (!widgetReady || conversation.session) return;
  widgetBounds(true);
  widget.webContents.send('conversation', {state:'HIDDEN'});
  widget.showInactive();
  menu();
}

function animateAvatar(action) {
  if (!widgetReady || conversation.session || !options.action.includes(action))
    throw Error('Finish the current conversation before playing an avatar move.');
  showIdle();
  widget.webContents.send('perform',action);
}

async function cancelManual() {
  const audio = manualAudio;
  if (!audio) return;
  audio.cancel();
  await audio.result;
  if (manualAudio === audio) manualAudio = null;
}

function wakeStatus() {
  tray.setImage(wakeListening ? trayImages.listening : trayImages.idle);
  tray.setToolTip(wakeListening ? 'Mimo • Say “Hey Mimo”' : wakeFault ? 'Mimo • Retrying microphone' : schedulerError || 'Mimo');
  main.webContents.send('wake-status', {listening:wakeListening, error:wakeFault});
}

function trayImage(listening) {
  const pixels = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (listening && (x - 12) ** 2 + (y - 12) ** 2 <= 9) {
      pixels.set([108,206,48,255], (y * 16 + x) * 4);
    } else if ((x - 7.5) ** 2 + (y - 8) ** 2 < 51) {
      pixels.set(y === 8 && (x === 5 || x === 10) ? [40,28,42,255] : [236,181,171,255], (y * 16 + x) * 4);
    }
  }
  return nativeImage.createFromBitmap(pixels,{width:16,height:16});
}

async function cancelWake() {
  const job = wakeAudio;
  if (!job) return;
  job.cancel();
  await job.result;
}

function syncWake() {
  if (!widgetReady || quitting || suspended || starting || reading || Date.now() < wakeRetryAt ||
      wakeAudio || manualAudio || conversation.session) return;
  const {wake,recognition,name} = profile();
  if (!wake || recognition !== true) return;
  const job = speech.wake(name, event => {
    if (event.type !== 'ready' || wakeAudio !== job) return;
    wakeFault = '';
    wakeListening = true;
    wakeStatus();
  });
  wakeAudio = job;
  void job.result.then(result => {
    if (wakeAudio !== job) return;
    wakeAudio = undefined;
    wakeListening = false;
    if (result.type === 'error') {
      wakeFault = result.text + ' Mimo will retry automatically.';
      wakeRetryAt = Date.now() + 10000;
    }
    wakeStatus();
    const phrases = wakePhrases(name).map(normalize);
    if (result.type === 'final' && result.confidence >= 0.72 &&
        phrases.includes(normalize(result.text)) && profile().wake) void activate();
  });
}

async function startConversation(row, notice) {
  if (!widgetReady || suspended || quitting || starting || conversation.session) return;
  starting = true;
  try {
    await Promise.all([cancelWake(),cancelManual()]);
    if (widgetReady && !suspended && !quitting) return conversation.begin(row,notice);
  } finally { starting = false; }
}

async function activate() {
  if (!widgetReady || suspended) return;
  if (!conversation.session) await startConversation();
  else if (conversation.session.view.ready) widget.focus();
  else conversation.interrupt();
}

function stop() {
  conversation.interrupt();
  void cancelManual();
}

function queueCompletion(kind, status) {
  const message = {
    complete:`Your ${kind} is complete.`,
    failed:`Your ${kind} stopped at a failed step. Check the app for details.`,
    stopped:`Your ${kind} has stopped.`
  }[status];
  if (message) completionNotices.push(message);
}

async function showCompletion() {
  if (!completionNotices.length || !widgetReady || quitting || suspended ||
      starting || reading || manualAudio || conversation.session) return;
  if (await startConversation(undefined,completionNotices[0])) completionNotices.shift();
}

function registerShortcut(key, value) {
  const old = shortcuts.get(key);
  if (old?.toLowerCase() === value.toLowerCase()) return;
  let registered = false;
  try { registered = globalShortcut.register(value, key === 'shortcut' ? () => void activate() : stop); } catch {}
  if (!registered) throw Error(`Could not register ${value}. Choose a different shortcut. The previous shortcut is still available if registered.`);
  if (old) globalShortcut.unregister(old);
  shortcuts.set(key, value);
}

function check() {
  if (paused || suspended || quitting || !widgetReady) return;
  try {
    if (db.claim(Date.now()).length) refresh();
    const current = conversation.session;
    if (current?.row && !current.resolved && !['CLOSING','SAVING_REMINDER'].includes(current.view.state)) {
      const row = db.find(current.row.id);
      if (!row || !['notified','missed'].includes(row.state) || row.acknowledged_at) {
        current.resolved = true;
        conversation.closeSilently();
      }
    }
    if (!current && !manualAudio) {
      const row = db.nextAlert();
      if (row) void startConversation(row);
    }
    if (schedulerError) {
      schedulerError = '';
      main.webContents.send('scheduler-status', '');
      wakeStatus();
    }
  } catch (error) {
    if (!schedulerError) {
      console.error('Reminder scheduler:', error);
      schedulerError = 'Mimo couldn’t check for reminders. It will keep retrying.';
      wakeStatus();
      main.webContents.send('scheduler-status', schedulerError);
      if (Notification.isSupported()) new Notification({title:'Mimo reminder service', body:schedulerError}).show();
    }
  }
}

function menu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:'Talk to avatar', click:() => void activate()},
    {label:'Open Mimo', click:() => open()},
    {label:'New reminder', click:() => open('new')},
    {label:'Actions', click:() => open('actions')},
    {label:'Ask Memo', click:() => open('agent')},
    {label:'Workflows', click:() => open('workflows')},
    {label:'Memo moves',submenu:['Dance','Jump','Wave'].map(move => ({label:move,
      enabled:widgetReady && !conversation.session,click:() => animateAvatar(move)}))},
    {label:'Voice and shortcuts', click:() => open('studio')},
    {label:profile().wake ? 'Turn off wake microphone' : 'Set up voice wake', click:() => {
      if (profile().wake) setPreference('wake',false);
      else open('studio');
    }},
    {label:widget.isVisible() ? 'Hide avatar' : 'Show avatar', click:() => {
      if (conversation.session) conversation.closeSilently();
      else if (widget.isVisible()) { widget.hide(); menu(); }
      else showIdle();
    }},
    {label:paused ? 'Resume notifications' : 'Pause notifications', click:() => {
      db.set('paused', !paused); paused = !paused; menu(); check();
    }},
    {type:'separator'},
    {label:'Quit Mimo', click:() => app.quit()}
  ]));
}

function profile() {
  const saved = db.get('companion', {}) || {};
  return {...defaults, ...Object.fromEntries(Object.entries(saved).filter(([key,value]) => validate(key,value)))};
}

function setPreference(key, value) {
  if (!Object.hasOwn(defaults,key) || !validate(key,value)) throw Error('Enter a valid preference.');
  const isShortcut = key === 'shortcut' || key === 'stopShortcut';
  const previousShortcut = shortcuts.get(key);
  if (isShortcut) registerShortcut(key, value);
  const next = {...profile(), [key]: value};
  if (key === 'wake' && value) next.recognition = true;
  if (key === 'recognition' && !value) next.wake = false;
  try {
    db.set('companion', next);
  } catch (error) {
    if (isShortcut && previousShortcut !== shortcuts.get(key)) {
      if (previousShortcut) registerShortcut(key, previousShortcut);
      else {
        globalShortcut.unregister(shortcuts.get(key));
        shortcuts.delete(key);
      }
    }
    throw error;
  }
  if (isShortcut) delete shortcutErrors[key];
  widget.webContents.send('profile', next);
  main.webContents.send('profile', next);
  if (['wake','recognition','name'].includes(key)) {
    wakeFault = '';
    wakeRetryAt = 0;
    void cancelWake().then(syncWake);
    wakeStatus();
    menu();
  }
  return next;
}

function setupIpc() {
  const handle = (channel, owner, listener) => ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== owner.webContents) throw Error('Unavailable command.');
    return listener(...args);
  });
  const on = (channel, owner, listener) => ipcMain.on(channel, (event, ...args) => {
    if (event.sender === owner.webContents) listener(...args);
  });

  ipcMain.handle('config', event => {
    if (![main.webContents, widget.webContents].includes(event.sender)) throw Error('Unavailable configuration.');
    return {options, profile:profile(), shortcutErrors, schedulerError,
      wakeStatus:{listening:wakeListening,error:wakeFault}};
  });
  handle('setting', main, (key, value) => {
    const next = setPreference(key, value);
    if ((key === 'recognition' || key === 'speech') && !value) stop();
    return next;
  });
  on('talk', main, () => void activate());
  handle('voices', main, () => speech.voices());
  handle('list-actions', main, () => actions.list());
  handle('pin-site', main, (name,address) => actions.addSite(name,address));
  handle('pin-local', main, kind => actions.choose(kind));
  handle('remove-pin', main, id => actions.remove(id));
  handle('run-action', main, (id,text) => actions.open(id,text));
  handle('connect-action', main, (id,key) => actions.connect(id,key));
  handle('send-action', main, (id,text) => actions.send(id,text));
  handle('workflow-config', main, () => workflows.config());
  handle('workflow-connect', main, input => workflows.connect(input));
  handle('workflow-disconnect', main, () => workflows.disconnect());
  handle('workflow-save', main, input => workflows.save(input));
  handle('workflow-remove', main, id => workflows.remove(id));
  handle('workflow-run', main, async (id,text) => {
    const result = await workflows.run(id,text);
    queueCompletion('workflow',result.status);
    return result;
  });
  handle('workflow-stop', main, id => workflows.stop(id));
  handle('agent-config', main, () => agent.config());
  handle('agent-settings', main, value => agent.configure(value));
  handle('agent-plan', main, text => agent.plan(text));
  handle('agent-run', main, async (id,chosen) => {
    const result = await agent.run(id,chosen);
    if (result.nodes.some(node => node.status !== 'skipped' && node.kind !== 'answer'))
      queueCompletion('agent task',result.status);
    return result;
  });
  handle('agent-stop', main, () => agent.stop());
  handle('agent-forget', main, () => agent.forget());
  handle('workflow-template', main, async () => {
    const result = await dialog.showSaveDialog(main,{defaultPath:path.join(app.getPath('downloads'),'mimo-n8n-starter.json'),
      filters:[{name:'n8n workflow',extensions:['json']}]});
    if (result.canceled || !result.filePath) return false;
    await copyFile(path.join(__dirname,'mimo-n8n-starter.json'),result.filePath);
    return true;
  });
  on('perform', main, action => {
    if (widgetReady && !conversation.session && options.action.includes(action)) animateAvatar(action);
  });
  on('read', main, async title => {
    if (typeof title !== 'string' || title.length > 200) return;
    if (!title) { stop(); return; }
    if (conversation.session || starting || reading) {
      main.webContents.send('voice-status', 'Finish the current conversation to preview a voice.');
      return;
    }
    reading = true;
    try { await Promise.all([cancelWake(),cancelManual()]); }
    finally { reading = false; }
    if (conversation.session || starting || suspended || quitting) return;
    main.webContents.send('voice-status', '');
    const audio = speech.speak(title, profile());
    manualAudio = audio;
    const result = await audio.result;
    if (manualAudio === audio) manualAudio = null;
    if (result.type === 'error') main.webContents.send('voice-status', result.text);
    check();
  });
  handle('list', main, () => db.list());
  handle('save', main, (title,due,id) => {
    if (id != null && !Number.isSafeInteger(id)) throw Error('Invalid ID.');
    db.save(title, due, id ?? null); refresh(); check();
  });
  handle('act', main, (id,action,minutes) => {
    db.act(id,action,minutes);
    if (action === 'done' && !conversation.session) widget.webContents.send('perform','Celebrate');
    refresh(); check();
  });
  on('open', widget, () => open('studio'));
  on('move', widget, (x,y) => {
    if (![x,y].every(Number.isSafeInteger)) return;
    const idle = !conversation.session;
    const w = idle ? 134 : width, h = idle ? 120 : height;
    const pos = clamp(x,y,w,h);
    widget.setPosition(...pos);
    activePosition = [pos[0] - (width - w) / 2, pos[1] - (height - h)];
  });
  on('position', widget, () => db.set('voicePosition', activePosition));
  on('submit-turn', widget, (text, replace) => void conversation.submit(text, false, replace === true));
  on('turn-action', widget, (action,value) => void conversation.action(action,value));
  on('close-companion', widget, () => conversation.closeSilently());
  on('stop-audio', widget, stop);
  on('start-mic', widget, () => conversation.restartMic());
  handle('mic-consent', widget, enabled => {
    if (typeof enabled !== 'boolean' || !conversation.session?.view.consent) return;
    setPreference('recognition', enabled);
    conversation.consent(enabled);
  });
  on('focus-widget', widget, () => { if (conversation.session) widget.focus(); });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event,argv) => {
    if (main) open(argv.includes('--workflows') ? 'workflows' : argv.includes('--actions') ? 'actions' : 'agent');
  });
  app.on('window-all-closed', () => {});
  app.whenReady().then(() => {
    db = new Store(path.join(app.getPath('userData'),'mimo.sqlite'));
    if (!db.get('memoCharacterVoice', false)) {
      const previous = profile();
      db.set('companion', {...previous, voice:'', name:previous.name === 'Mimo' ? 'Memo' : previous.name});
      db.set('memoCharacterVoice', true);
    }
    if (!profile().voice) speech.memo.warm();
    paused = db.get('paused',false);
    // Audio is handled by the native adapter in the main process.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    main = windowFor('index.html', {width:930,height:680,minWidth:560,minHeight:420,title:'Mimo'});
    actions = new Actions({db,shell,clipboard,safeStorage,dialog,owner:main});
    agent = new Agent({db,actions,animate:animateAvatar,refresh,
      publish:run => { if (!main.isDestroyed()) main.webContents.send('agent-progress',run); }});
    workflows = new Workflows({
      db,actions,safeStorage,
      openDocuments:async () => {
        if (await shell.openPath(app.getPath('documents'))) throw Error('Windows could not open Documents.');
      },
      publish:run => { if (!main.isDestroyed()) main.webContents.send('workflow-progress',run); }
    });
    widget = windowFor('widget.html', {width,height,transparent:true,frame:false,alwaysOnTop:true,skipTaskbar:true,
      resizable:false,show:false,backgroundColor:'#00000000'});
    const area = screen.getPrimaryDisplay().workArea;
    const legacy = db.get('position', null);
    const start = db.get('voicePosition', Array.isArray(legacy) && legacy.length === 2 && legacy.every(Number.isSafeInteger) ?
      [legacy[0] - (width - 220) / 2, legacy[1] + 210 - height] : [area.x + area.width - width - 18, area.y + area.height - height - 16]);
    activePosition = Array.isArray(start) && start.length === 2 && start.every(Number.isSafeInteger) ?
      clamp(...start) : clamp(area.x, area.y);
    widgetBounds(false);
    screen.on('display-removed', () => {
      activePosition = clamp(...activePosition);
      widgetBounds(!conversation.session);
    });
    main.on('close', event => { if (!quitting) { event.preventDefault(); main.hide(); } });
    widget.on('close', event => {
      if (!quitting) { event.preventDefault(); if (conversation.session) conversation.closeSilently(); else widget.hide(); }
    });
    trayImages = {idle:trayImage(false),listening:trayImage(true)};
    tray = new Tray(trayImages.idle);
    tray.setToolTip('Mimo');
    tray.on('click', () => open());
    conversation = new Conversation({
      db, speech, profile, publish: view => widget.webContents.send('conversation', view),
      show: () => { widgetBounds(false); widget.showInactive(); menu(); },
      hide: () => { widget.hide(); menu(); }, update: refresh,
      onClosed: () => { check(); syncWake(); },
      handoff: draft => open(['agent','workflows'].includes(draft.view) ? draft.view : 'actions',draft),
      animate: move => { if (!conversation.session) animateAvatar(move); },
      model:{connected:id => !!actions.key(id),send:(id,text,history) => actions.send(id,text,history)}
    });
    setupIpc();
    if (app.commandLine.hasSwitch('actions') || app.commandLine.hasSwitch('workflows')) {
      main.webContents.once('did-finish-load', () => open(app.commandLine.hasSwitch('workflows') ? 'workflows' : 'actions'));
    }
    for (const key of ['shortcut','stopShortcut']) {
      try { registerShortcut(key, profile()[key]); } catch (error) { shortcutErrors[key] = error.message; }
    }
    widget.webContents.on('did-finish-load', () => { widgetReady = true; menu(); check(); });
    widget.webContents.on('render-process-gone', () => {
      widgetReady = false;
      conversation.abort();
      widget.hide();
      if (!quitting) widget.reload();
    });
    timer = setInterval(() => { check(); void showCompletion(); syncWake(); }, 1000);
    menu();
    powerMonitor.on('suspend', () => {
      suspended = true; conversation.abort(); void cancelManual(); void cancelWake(); widget.hide(); menu();
    });
    powerMonitor.on('resume', () => { suspended = false; wakeFault = ''; wakeRetryAt = 0; check(); syncWake(); });
  }).catch(error => {
    console.error(error);
    require('electron').dialog.showErrorBox('Mimo could not start', 'Mimo couldn’t open its local reminder data. Close other copies of the app and try again.');
    app.quit();
  });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    clearInterval(timer);
    agent?.stop();
    conversation?.abort();
    void Promise.allSettled([cancelManual(),cancelWake(),speech.memo.dispose(),workflows?.shutdown()]).then(() => app.quit());
  });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); db?.db.close(); });
}
