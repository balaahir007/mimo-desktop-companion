const {app,BrowserWindow,shell} = require('electron');
const assert = require('node:assert/strict');
const {mkdtempSync,writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {Actions} = require('./actions.cjs');
const {Store} = require('./store.cjs');

const directory = mkdtempSync(path.join(tmpdir(),'memo-agent-test-'));
app.setPath('userData',directory);
const database = new Store(path.join(directory,'mimo.sqlite'));
database.set('memoCharacterVoice',true);
  database.set('companion',{voice:'Microsoft Zira Desktop',speech:false});
database.set('actionPins',[{id:'docs',kind:'folder',name:'Documents',target:app.getPath('documents')}]);
database.db.close();

const effects = [];
const nativeOpen = shell.openPath.bind(shell);
shell.openPath = async target => {
  assert.equal(target,app.getPath('documents'));
  effects.push('folder');
  return process.env.MEMO_AGENT_SHOW_ACTIONS === '1' ? nativeOpen(target) : '';
};
const actionOpen = Actions.prototype.open;
Actions.prototype.open = function(id,query) {
  if (id === 'chrome') {
    assert.equal(query,'Windows keyboard shortcuts');
    effects.push('search');
    return 'Search sent to test browser.';
  }
  return actionOpen.call(this,id,query);
};
global.fetch = async (url,options) => {
  assert.equal(url,'https://api.openai.com/v1/responses');
  assert.match(JSON.parse(options.body).input,/five demo actions/);
  return {ok:true,json:async () => ({output:[{content:[{type:'output_text',text:JSON.stringify({
    nodes:[
      {type:'answer',text:'I prepared the five demo actions for you.'},
      {type:'open',pin:'docs'},
      {type:'search',query:'Windows keyboard shortcuts'},
      {type:'remind',request:'Remind me to check the agent demo in 15 minutes'},
      {type:'animate',motion:'Dance'}
    ]
  })}]}]})};
};

require('./desktop.cjs');

async function until(fn,label) {
  for (let pass=0;pass<150;pass++) {
    const result = await fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve,80));
  }
  throw Error('Timed out waiting for ' + label);
}

app.whenReady().then(async () => {
  const main = await until(() => BrowserWindow.getAllWindows().find(win =>
    /\/index\.html$/.test(win.webContents.getURL()) && !win.webContents.isLoading()),'dashboard');
  const widget = await until(() => BrowserWindow.getAllWindows().find(win =>
    /\/widget\.html$/.test(win.webContents.getURL()) && !win.webContents.isLoading()),'avatar');
  const page = code => main.webContents.executeJavaScript(code);
  const pet = code => widget.webContents.executeJavaScript(code);
  const text = id => page(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const click = id => page(`document.getElementById(${JSON.stringify(id)}).click()`);
  const shot = async name => {
    if (!process.env.MEMO_AGENT_SCREENSHOT_DIR) return;
    main.setContentSize(990,830);
    main.webContents.setBackgroundThrottling(false);
    main.show();
    main.webContents.invalidate();
    await new Promise(resolve => setTimeout(resolve,400));
    writeFileSync(path.join(process.env.MEMO_AGENT_SCREENSHOT_DIR,name),(await main.webContents.capturePage()).toPNG());
  };

  await page(`mimo.connectAction('chatgpt','test-only').then(() =>
    mimo.agentSettings({provider:'chatgpt',enabled:['answer','open','search','remind','animate'],memory:true}))`);
  await page("document.querySelector('[data-view=agent]').click()");
  await until(async () => /API key saved/.test(await text('agentConnectionStatus')),'provider');
  await page("document.getElementById('agentPrompt').value='Create five demo actions'; document.getElementById('agentForm').requestSubmit()");
  await until(() => page("document.querySelectorAll('#agentNodes li').length === 5"),'five planned nodes');
  assert.deepEqual(effects,[]);
  assert.equal(await page("document.querySelectorAll('#agentNodes input:checked').length"),1);
  await shot('memo-agent-review.png');
  await page("document.querySelectorAll('#agentNodes input:not(:checked)').forEach(box=>box.click())");
  await click('agentRun');
  await until(async () => /nodes completed/.test(await text('agentStatus')),'completed run');
  assert.deepEqual(effects,['folder','search']);
  assert.match(await text('agentAnswerText'),/five demo/);
  await until(() => widget.isVisible() && pet("document.getElementById('widgetAvatar').dataset.motion === 'Dance'"),'desktop dance');
  const reminders = await page('mimo.list()');
  assert.equal(reminders[0].title,'check the agent demo');
  assert.equal((await page('mimo.agentConfig()')).memoryCount,1);
  await until(() => widget.isVisible() && pet("document.getElementById('message').textContent === 'Your agent task is complete.'"),'agent completion notice');
  await until(() => !widget.isVisible(),'completion notice closes');

  await page("document.querySelector('[data-view=studio]').click()");
  await until(() => page("document.querySelectorAll('#avatarChoices button').length === 5"),'avatar cards');
  await page("document.querySelector('#avatarChoices button[data-value=Sprout]').click()");
  await until(() => page("document.querySelector('#avatarColors button[data-value=Mint]').getAttribute('aria-pressed') === 'true'"),'preset and accent');
  await page("document.querySelector('#avatarColors button[data-value=Rose]').click()");
  await until(() => page("document.querySelector('#avatarColors button[data-value=Rose]').getAttribute('aria-pressed') === 'true'"),'custom color');
  await shot('memo-studio.png');
  await page("document.querySelector('[data-move=Jump]').click()");
  await until(() => pet("document.getElementById('widgetAvatar').dataset.motion === 'Jump'"),'desktop jump');
  console.log('PASS model-generated five-node plan, reviewed execution, reminder, memory, visual avatar customization, dance and jump');
  if (process.env.MEMO_AGENT_SHOW_ACTIONS === '1') console.log('Windows opened Documents and Memo danced and jumped on the desktop.');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
