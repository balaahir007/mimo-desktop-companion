const {app, BrowserWindow, globalShortcut} = require('electron');
const assert = require('node:assert/strict');
const {existsSync, mkdirSync} = require('node:fs');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const path = require('node:path');
const {WindowsSpeech} = require('./speech.cjs');
const {Store} = require('./store.cjs');
const {wakePhrases} = require('./reminder-language.cjs');

const run = promisify(execFile);
const directory = process.env.MIMO_TEST_DATA;
assert.ok(directory && path.isAbsolute(directory), 'Set MIMO_TEST_DATA to an absolute path for an isolated test profile.');
mkdirSync(directory, {recursive:true});
app.setPath('userData', directory);

const restoring = process.env.MIMO_TEST_PHASE === 'restart';
const speech = new WindowsSpeech();
const voices = [];
const wakeFiles = [];
const nativeListen = WindowsSpeech.prototype.listen;
const nativeSpeak = WindowsSpeech.prototype.speak;
let failMic = false;
let emptyMic = false;
let wakeStarts = 0;

WindowsSpeech.prototype.listen = function (onEvent,language,name = 'Memo') {
  if (failMic) {
    failMic = false;
    return {cancel() {}, result:Promise.resolve({type:'error',text:'Microphone permission denied. You can type below.'})};
  }
  if (emptyMic) {
    emptyMic = false;
    return {cancel(){},result:Promise.resolve({type:'empty'})};
  }
  const waveFile = voices.shift();
  if (waveFile) return this.run('listen',{onEvent,language,waveFile,input:{names:[...new Set([name,'Memo','Mimo'])]}});
  // The integration test never switches to a physical microphone.
  let end;
  const result = new Promise(resolve => { end = resolve; });
  const timer = setTimeout(() => end({type:'empty'}), 6500);
  queueMicrotask(() => onEvent({type:'ready'}));
  return {result,cancel() { clearTimeout(timer); end({type:'cancelled'}); }};
};

WindowsSpeech.prototype.wake = function (name,onEvent) {
  wakeStarts++;
  const waveFile = wakeFiles.shift();
  if (waveFile) return this.run('wake',{onEvent,waveFile,input:{phrases:wakePhrases(name)}});
  let end;
  const result = new Promise(resolve => { end = resolve; });
  queueMicrotask(() => onEvent({type:'ready'}));
  return {result, cancel() { end({type:'cancelled'}); }};
};

let spokenCount = 0;
WindowsSpeech.prototype.speak = function (text, profile) {
  const job = nativeSpeak.call(this, text, profile);
  job.result.then(result => {
    if (result.type === 'spoken') spokenCount++;
    if (result.type === 'error') console.error('Native voice:', result.text);
  });
  return job;
};

async function fixture(name, text) {
  const waveFile = path.join(directory, name + '.wav');
  const result = await speech.run('speak',{input:{text,voice:'Microsoft Zira Desktop',rate:0,volume:100},waveFile}).result;
  assert.equal(result.type, 'spoken', JSON.stringify(result));
  assert.ok(existsSync(waveFile));
  return waveFile;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(label, fn, timeout = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await fn();
    if (result) return result;
    await wait(150);
  }
  throw Error('Timed out: ' + label);
}

async function pressShortcut() {
  await run('powershell.exe', ['-NoProfile','-NonInteractive','-Command', `
    Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class MimoKeys {
      [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,System.UIntPtr data);
    }'
    foreach ($key in 17,18,32) { [MimoKeys]::keybd_event($key,0,0,[UIntPtr]::Zero) }
    Start-Sleep -Milliseconds 120
    foreach ($key in 32,18,17) { [MimoKeys]::keybd_event($key,0,2,[UIntPtr]::Zero) }
  `], {windowsHide:true});
}

require('./desktop.cjs');

app.whenReady().then(async () => {
  const [main,widget] = await until('windows', () => {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length !== 2 || windows.some(win => win.webContents.isLoading())) return;
    const main = windows.find(win => win.webContents.getURL().endsWith('/index.html'));
    const widget = windows.find(win => win.webContents.getURL().endsWith('/widget.html'));
    if (main && widget) return [main,widget];
  });
  assert.match(main.webContents.getURL(), /index.html$/);
  const ui = code => widget.webContents.executeJavaScript(code);
  const mainUi = code => main.webContents.executeJavaScript(code);
  const visible = id => ui(`!document.getElementById('${id}').hidden`);
  const click = id => ui(`document.getElementById('${id}').click()`);
  const text = id => ui(`document.getElementById('${id}').textContent`);
  const submit = value => ui(`document.getElementById('turnInput').value = ${JSON.stringify(value)};
    document.getElementById('turnForm').requestSubmit()`);
  const rows = () => mainUi('mimo.list()');
  const profile = (key,value) => mainUi(`mimo.setting(${JSON.stringify(key)},${JSON.stringify(value)})`);
  const db = new Store(path.join(directory, 'mimo.sqlite'));
  const forceDue = id => db.db.prepare('UPDATE reminders SET due=? WHERE id=?').run(Date.now()-500,id);
  assert.ok(globalShortcut.isRegistered('Ctrl+Alt+Space'));

  async function wakeAndClose() {
    const wake = await fixture('hey-mimo','Hey Mimo');
    const close = await fixture('close-mimo','Close Mimo');
    emptyMic = true;
    voices.length = 0;
    voices.push(close,close);
    wakeFiles.push(wake,wake);
    const beforeGoodbye = spokenCount;
    main.close();
    assert.equal(main.isVisible(),false);
    await profile('wake',true);
    await until('“Hey Mimo” opens avatar from the tray', () => widget.isVisible());
    assert.equal(main.isVisible(),false);
    await until('wake and close twice, including one silent turn', () => !widget.isVisible() && spokenCount >= beforeGoodbye + 4);
    assert.equal((await mainUi('mimo.config()')).profile.wake,true);
    await profile('wake',false);
    console.log('PASS tray wake, silence recovery, voice close, and re-wake');
  }

  if (process.env.MIMO_TEST_PHASE === 'wake') {
    await wakeAndClose();
  } else if (restoring) {
    await until('recovered alert', async () => widget.isVisible() && await text('alertTitle') === 'Recovered on restart');
    await until('recovered alert controls', () => visible('alertActions'));
    await click('dismissTurn');
    await until('dismiss complete', () => !widget.isVisible());
    const [row] = (await rows()).filter(value => value.title === 'Recovered on restart');
    assert.equal(row.state, 'missed');
    assert.ok(row.acknowledged_at);
    console.log('PASS restart recovery and dismissal');
  } else {
    const create = await fixture('create', 'Remind me to check the deployment in five minutes');
    const confirm = await fixture('confirm', 'Confirm');
    const goodbye = await fixture('goodbye', 'No, that is all');
    const snooze = await fixture('snooze', 'Remind me again in ten minutes');
    const complete = await fixture('done', 'I completed it');
    assert.equal(wakeStarts,0);
    main.minimize();
    await pressShortcut();
    await until('shortcut activated avatar', () => widget.isVisible());
    await until('first use microphone consent', () => visible('consent'));
    assert.equal(await ui("document.getElementById('activity').dataset.recording"), 'false');
    voices.push(create);
    const beforeCreate = Date.now();
    await click('allowMic');
    try { await until('voice interpretation and confirmation', () => visible('confirmActions')); }
    catch (error) {
      console.error('Widget:', await ui('document.body.dataset.state'), await text('message'), await text('voiceStatus'),
        await text('transcript'));
      throw error;
    }
    const confirmation = await text('message');
    console.log('Voice confirmation:', confirmation);
    assert.match(confirmation, /check the deployment/i);
    voices.push(confirm);
    const saved = await until('SQLite voice reminder', async () => (await rows()).find(row => /deployment/.test(row.title)));
    assert.equal(saved.title.toLowerCase(),'check the deployment');
    assert.match(saved.original_transcript,/check the deployment/i);
    assert.ok(saved.due >= beforeCreate + 300000 && saved.due < Date.now() + 300000);
    voices.push(goodbye);
    await until('voice departure', () => !widget.isVisible());
    assert.equal((await rows()).length,1);
    console.log('PASS global shortcut while minimized, real speech creation, confirmation and hide');

    voices.length = 0;
    voices.push(snooze);
    const beforeSnooze = Date.now();
    forceDue(saved.id);
    await until('scheduled alert', async () => widget.isVisible() && await text('alertTitle') === saved.title);
    const snoozed = await until('ten-minute voice snooze', async () => (await rows()).find(row => row.snoozed_until));
    assert.ok(snoozed.due >= beforeSnooze + 600000 && snoozed.due < Date.now() + 600000);
    await until('snooze departure', () => !widget.isVisible());
    console.log('PASS scheduler, spoken alert, and ten-minute snooze');

    voices.length = 0;
    voices.push(complete);
    forceDue(saved.id);
    await until('snoozed reminder redelivery', async () => widget.isVisible() && await text('alertTitle') === saved.title);
    await until('voice completion', async () => (await rows()).find(row => row.id === saved.id && row.state === 'completed'));
    await until('completion departure', () => !widget.isVisible());
    console.log('PASS snoozed reminder redelivery and voice completion');

    failMic = true;
    await pressShortcut();
    await until('visible microphone error', async () => /permission denied/i.test(await text('voiceStatus')));
    await submit('Remind me to test typed fallback tomorrow');
    await until('missing-time follow-up', async () => await visible('turnForm') && /what time/i.test(await text('message')));
    await submit('Around 9 in the morning');
    await until('typed reminder confirmation', () => visible('confirmActions'));
    await click('confirmTurn');
    await until('typed reminder saved', async () => (await rows()).find(row => row.title === 'test typed fallback'));
    await until('typed fallback next turn', () => visible('turnForm'));
    await submit('goodbye');
    await until('typed departure', () => !widget.isVisible());
    assert.ok(spokenCount >= 8, `Expected native Windows speech playback, completed ${spokenCount} times`);
    await wakeAndClose();
    db.save('Recovered on restart', Date.now()-90000);
    console.log('PASS microphone failure fallback, missing-time follow-up, typed persistence, and Windows speech playback');
  }
  db.db.close();
  WindowsSpeech.prototype.listen = nativeListen;
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
