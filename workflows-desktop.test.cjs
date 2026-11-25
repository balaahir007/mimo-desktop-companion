const {app,BrowserWindow,shell} = require('electron');
const assert = require('node:assert/strict');
const {createServer} = require('node:http');
const {mkdtempSync} = require('node:fs');
const path = require('node:path');
const {tmpdir} = require('node:os');

const directory = mkdtempSync(path.join(tmpdir(),'mimo-workflow-test-'));
app.setPath('userData',directory);
const requests = [];
const opened = [];
const openPath = shell.openPath.bind(shell);
shell.openPath = async target => {
  assert.equal(target,app.getPath('documents'));
  const result = process.env.MIMO_WORKFLOW_OPEN_DOCUMENTS === '1' ? await openPath(target) : '';
  if (!result) opened.push(target);
  return result;
};

const server = createServer(async (request,response) => {
  if (request.url !== '/webhook/mimo' || request.method !== 'POST' || request.headers['x-mimo-key'] !== 'test-key') {
    response.writeHead(401).end();
    return;
  }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  response.setHeader('Content-Type','application/json');
  response.end(JSON.stringify({reply:'Mimo reached the workflow fixture.',continue:true}));
});

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
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const window = await until(() => BrowserWindow.getAllWindows().find(win =>
    /\/index\.html$/.test(win.webContents.getURL()) && !win.webContents.isLoading()),'dashboard');
  const widget = await until(() => BrowserWindow.getAllWindows().find(win =>
    /\/widget\.html$/.test(win.webContents.getURL()) && !win.webContents.isLoading()),'avatar');
  const page = script => window.webContents.executeJavaScript(script);
  const click = id => page(`document.getElementById(${JSON.stringify(id)}).click()`);
  const set = (id,value) => page(`document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}`);
  const submit = id => page(`document.getElementById(${JSON.stringify(id)}).requestSubmit()`);
  const visible = id => page(`!document.getElementById(${JSON.stringify(id)}).hidden`);
  const text = id => page(`document.getElementById(${JSON.stringify(id)}).textContent`);
  await page("mimo.setting('speech',false)");

  await page("document.querySelector('[data-view=workflows]').click()");
  assert.equal(await visible('workflows'),true);
  await set('workflowUrl',`http://127.0.0.1:${server.address().port}/webhook/mimo`);
  await set('workflowKey','test-key');
  await submit('workflowConnectionForm');
  await until(async () => (await text('workflowStatus')).startsWith('Connection saved'),'encrypted connection');

  await click('workflowNew');
  await set('workflowName','Desktop demo');
  await page(`{
    const input=document.querySelector('#workflowEditorSteps fieldset select');
    input.value='webhook'; input.dispatchEvent(new Event('change'));
  }`);
  await click('workflowAddStep');
  await page(`{
    const row=document.querySelector('#workflowEditorSteps fieldset:last-child');
    const condition=row.querySelectorAll('select')[1];
    condition.value='yes'; condition.dispatchEvent(new Event('change'));
  }`);
  await submit('workflowEditor');
  await until(async () => (await text('workflowStatus')).includes('Workflow saved'),'saved workflow');
  await set('workflowInput','Open Documents after the test webhook responds.');
  await click('workflowRun');
  await until(async () => (await text('workflowStatus')).includes('Run complete'),'completed workflow');
  assert.equal(requests.length,1);
  assert.match(requests[0].input,/Open Documents/);
  assert.equal(await text('workflowReply'),'Mimo reached the workflow fixture.');
  assert.match(await text('workflowResultSteps'),/Open Documents · done/);
  assert.deepEqual(opened,[app.getPath('documents')]);
  const config = await page('mimo.workflows()');
  assert.equal(config.history[0].status,'complete');
  assert.equal(config.connection.hasKey,true);
  assert.ok(!JSON.stringify(config).includes('test-key'));
  await until(async () => widget.isVisible() && await widget.webContents.executeJavaScript(
    "document.getElementById('message').textContent === 'Your workflow is complete.'"),'avatar completion notice');
  await until(() => !widget.isVisible(),'avatar returns to tray');
  console.log('PASS Windows workflow editor, authenticated HTTP webhook, conditional step, and run receipt');
  if (process.env.MIMO_WORKFLOW_OPEN_DOCUMENTS === '1') console.log('Windows opened Documents in File Explorer.');
  server.closeAllConnections();
  server.close();
  app.quit();
}).catch(error => { console.error(error); server.closeAllConnections(); app.exit(1); });
