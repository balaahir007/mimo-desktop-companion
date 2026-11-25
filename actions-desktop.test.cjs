const {app,BrowserWindow,dialog,shell} = require('electron');
const assert = require('node:assert/strict');
const {mkdtempSync} = require('node:fs');
const path = require('node:path');
const {tmpdir} = require('node:os');

const directory = mkdtempSync(path.join(tmpdir(),'memo-actions-test-'));
app.setPath('userData',directory);
const external = [];
const folders = [];
dialog.showOpenDialog = async () => ({canceled:false,filePaths:[directory]});
shell.openPath = async target => { folders.push(target); return ''; };
shell.openExternal = async target => { external.push(target); };
global.fetch = async (url,options) => {
  assert.equal(url,'https://api.openai.com/v1/responses');
  assert.equal(JSON.parse(options.body).input,'Draft a meeting note');
  return {ok:true,json:async () => ({output:[{content:[{type:'output_text',text:'Draft from the test provider.'}]}]})};
};

require('./desktop.cjs');

async function until(fn, label) {
  for (let i=0;i<100;i++) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve,80));
  }
  throw Error('Timed out while waiting for ' + label);
}

app.whenReady().then(async () => {
  const main = await until(() => BrowserWindow.getAllWindows()
    .find(win => /\/index\.html$/.test(win.webContents.getURL()) && !win.webContents.isLoading()),'dashboard');
  const page = script => main.webContents.executeJavaScript(script);
  const click = id => page(`document.getElementById(${JSON.stringify(id)}).click()`);
  const text = id => page(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const choose = name => page(`Array.from(document.querySelectorAll('#actionList button')).find(el => el.textContent === ${JSON.stringify(name)}).click()`);

  await page("document.querySelector('[data-view=actions]').click()");
  assert.equal(await page("document.getElementById('actions').hidden"),false);
  await until(async () => await text('runAction') === 'Copy text and open chat','default chat action');
  await click('giveComment');
  assert.equal(await text('draftLabel'),'Comment');
  await page("document.getElementById('actionText').value = 'Draft a meeting note'");
  await click('runAction');
  await until(async () => (await text('actionStatus')).includes('copied'),'browser handoff');
  assert.deepEqual(external,['https://chatgpt.com/']);
  await page("document.getElementById('actionKey').value='test-key'; document.getElementById('keyForm').requestSubmit()");
  await until(() => page("!document.getElementById('sendAction').hidden && !document.getElementById('sendAction').disabled"),'cloud connection');
  await click('sendAction');
  await until(async () => await text('replyText') === 'Draft from the test provider.','rendered API reply');

  await click('pinFolder');
  await until(async () => await text('runAction') === 'Open folder','folder pin');
  await click('runAction');
  await until(() => folders.length === 1,'folder launch');
  assert.deepEqual(folders,[directory]);
  await choose('Chrome search');
  assert.equal(await text('runAction'),'Search in Chrome');
  console.log('PASS desktop Actions, comment composer, browser handoff, cloud reply, folder pin and Chrome control');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
