const assert = require('node:assert/strict');
const test = require('node:test');
const {Workflows} = require('./workflows.cjs');
const {voiceAction} = require('./actions.cjs');

function fixture(response, initial = []) {
  const map = new Map([['workflowRuns',initial]]);
  const effects = [];
  const receipts = [];
  const requests = [];
  const db = {get:(key,fallback) => structuredClone(map.get(key) ?? fallback),
    set:(key,value) => map.set(key,structuredClone(value))};
  const runner = new Workflows({
    db,
    actions:{list:() => [{id:'docs',kind:'folder',name:'Notes'}],
      open:async id => { effects.push(id); }},
    safeStorage:{isEncryptionAvailable:() => true,encryptString:text => Buffer.from('locked:' + text),
      decryptString:buffer => buffer.toString().slice(7)},
    openDocuments:async () => { effects.push('Documents'); },
    request:async (url,options) => { requests.push({url,options}); return response(url,options); },
    publish:value => receipts.push(value)
  });
  return {runner,map,effects,receipts,requests};
}
const connection = {url:'http://127.0.0.1:5678/webhook/memo',header:'X-Mimo-Key',key:'local-secret'};
const webhook = {type:'webhook',when:'always'};

test('binds a webhook key to its destination and keeps credentials out of renderer data', () => {
  const {runner,map} = fixture(() => Response.json({}));
  assert.throws(() => runner.connect({...connection,url:'http://example.org/agent'}),/HTTPS/);
  assert.throws(() => runner.connect({...connection,url:'https://example.org/api/v1/workflows'}),/webhook/);
  assert.throws(() => runner.connect({...connection,header:'Host'}),/authentication header/);
  runner.connect(connection);
  assert.deepEqual(runner.config().connection,{url:connection.url,header:connection.header,hasKey:true});
  assert.notEqual(map.get('n8nWebhook').secret,connection.key);
  runner.connect({...connection,url:connection.url + '-different',key:''});
  assert.equal(runner.connection().hasKey,false);
});

test('executes reviewed steps in order and interprets only a boolean condition from n8n', async () => {
  const {runner,effects,requests,receipts} = fixture(() => Response.json({
    reply:'Ready',continue:true,commands:[{type:'execute',file:'unexpected.exe'}]
  }));
  runner.connect(connection);
  assert.throws(() => runner.save({name:'Invalid',steps:[{type:'documents',when:'no'},webhook]}),/must come after/);
  const flow = runner.save({name:'Prepare Notes',steps:[webhook,{type:'pin',pin:'docs',when:'yes'},{type:'documents',when:'no'}]});
  const run = await runner.run(flow.id,'Review my notes');
  assert.deepEqual(effects,['docs']);
  assert.equal(run.reply,'Ready');
  assert.equal(run.status,'complete');
  assert.deepEqual(run.steps.map(step => step.status),['done','done','skipped']);
  assert.ok(receipts.some(item => item.steps[1].status === 'running'));
  assert.equal(requests[0].options.redirect,'error');
  assert.equal(requests[0].options.headers['X-Mimo-Key'],connection.key);
  assert.deepEqual(JSON.parse(requests[0].options.body),{input:'Review my notes',runId:run.id});
  const history = JSON.stringify(runner.history());
  for (const privateValue of ['Ready','Review my notes','local-secret','unexpected.exe'])
    assert.equal(history.includes(privateValue),false);
});

test('skips conditional actions for string values and fails closed when n8n rejects a call', async () => {
  const {runner,effects} = fixture(() => Response.json({continue:'true'}));
  runner.connect(connection);
  const flow = runner.save({name:'Conditional',steps:[webhook,{type:'documents',when:'yes'}]});
  assert.equal((await runner.run(flow.id,'test')).steps[1].status,'skipped');
  assert.deepEqual(effects,[]);
  runner.request = async () => new Response('',{status:401});
  const failed = await runner.run(flow.id,'test');
  assert.match(failed.error,/key/);
  assert.equal(failed.status,'failed');
  assert.deepEqual(effects,[]);
});

test('stops between steps and marks a previous running receipt interrupted', async () => {
  const {runner,effects} = fixture((_url,{signal}) => new Promise((_resolve,reject) => {
    signal.addEventListener('abort',() => reject(signal.reason),{once:true});
  }),[{id:'old',status:'running',steps:[{status:'running'},{status:'pending'}]}]);
  assert.equal(runner.history()[0].status,'interrupted');
  runner.connect(connection);
  const flow = runner.save({name:'Stoppable',steps:[webhook,{type:'documents',when:'always'}]});
  const pending = runner.run(flow.id,'test');
  await assert.rejects(runner.run('open-documents',''),/already running/);
  await runner.shutdown();
  const stopped = await pending;
  assert.equal(stopped.status,'stopped');
  assert.deepEqual(stopped.steps.map(step => step.status),['stopped','skipped']);
  assert.deepEqual(effects,[]);
  assert.deepEqual(voiceAction('Run workflow Prepare Notes'),{view:'workflows',name:'Prepare Notes'});
});
