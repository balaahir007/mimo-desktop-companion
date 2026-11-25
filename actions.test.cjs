const assert = require('node:assert/strict');
const test = require('node:test');
const {Actions,voiceAction} = require('./actions.cjs');

function setup(options = {}) {
  const data = new Map();
  const opened = [];
  const copied = [];
  const actions = new Actions({
    db:{get:(key,fallback) => data.has(key) ? data.get(key) : fallback,set:(key,value) => data.set(key,value)},
    shell:{openExternal:async url => { opened.push(url); }},
    clipboard:{writeText:text => copied.push(text)},
    safeStorage:{isEncryptionAvailable:() => true,encryptString:text => Buffer.from('encrypted:' + text),
      decryptString:buffer => buffer.toString().slice('encrypted:'.length)},
    ...options
  });
  return {actions,opened,copied,data};
}

test('browser chat handoff opens the official site and copies the draft independently',async () => {
  const {actions,opened,copied} = setup();
  await actions.open('chatgpt','Keep this draft private');
  await actions.open('claude','A second draft');
  assert.deepEqual(opened,['https://chatgpt.com/','https://claude.ai/new']);
  assert.deepEqual(copied,['Keep this draft private','A second draft']);
});

test('website pins persist and constrain targets to HTTPS',async () => {
  const {actions,opened} = setup();
  assert.throws(() => actions.addSite('File','file:///C:/Windows'),/HTTPS/);
  assert.throws(() => actions.addSite('Link','https://user:pass@example.org'),/HTTPS/);
  const pin = actions.addSite('Reference','https://example.org/guide');
  await actions.open(pin.id);
  assert.deepEqual(opened,['https://example.org/guide']);
  actions.remove(pin.id);
  await assert.rejects(actions.open(pin.id),/saved action/);
});

test('cloud adapters use fixed endpoints, encrypted key storage and text responses',async () => {
  const calls = [];
  const {actions,data} = setup({request:async (url,options) => {
    calls.push([url,options]);
    return {ok:true,json:async () => url.includes('openai') ?
      {output:[{type:'message',content:[{type:'output_text',text:'ChatGPT reply'}]}]} :
      {content:[{type:'text',text:'Claude reply'}]}};
  }});
  await assert.rejects(actions.send('claude','Hello'),/Connect an API key/);
  actions.connect('chatgpt','sk-test-openai');
  actions.connect('claude','sk-test-claude');
  assert.notEqual(data.get('actionKey:chatgpt'),'sk-test-openai');
  assert.equal(await actions.send('chatgpt','Write a note'),'ChatGPT reply');
  assert.equal(await actions.send('claude','Write a second note'),'Claude reply');
  assert.equal(calls[0][0],'https://api.openai.com/v1/responses');
  assert.equal(calls[0][1].headers.Authorization,'Bearer sk-test-openai');
  assert.equal(JSON.parse(calls[0][1].body).store,false);
  assert.equal(calls[1][0],'https://api.anthropic.com/v1/messages');
  assert.equal(calls[1][1].headers['x-api-key'],'sk-test-claude');
  assert.equal(JSON.parse(calls[1][1].body).messages[0].content,'Write a second note');
  actions.connect('claude','');
  assert.equal(actions.list().find(item => item.id === 'claude').connected,false);
});

test('voice action intent drafts a handoff without confusing reminder requests', () => {
  assert.deepEqual(voiceAction('Ask Claude, Draft a note'),{id:'claude',text:'Draft a note'});
  assert.deepEqual(voiceAction('Search Chrome for local cafés'),{id:'chrome',text:'local cafés'});
  assert.deepEqual(voiceAction('Open folder Downloads'),{targetName:'Downloads'});
  assert.equal(voiceAction('Remind me to open Chrome tomorrow'),null);
});

test('avatar confirms before sending to a selected provider and keeps follow-up context', async () => {
  const {Conversation} = require('./conversation.cjs');
  const requests = [];
  let ready;
  let last;
  const firstTurn = new Promise(resolve => { ready = resolve; });
  const conversation = new Conversation({
    profile:() => ({name:'Memo',speech:false,recognition:false}),show() {},hide() {},onClosed() {},
    publish: view => { last = view; if (view.ready) ready(); },
    model:{connected:id => id === 'claude',send:async (id,text,history) => {
      requests.push({id,text,history:structuredClone(history)});
      return requests.length === 1 ? 'Here is the first answer.' : 'Here is the follow-up.';
    }}
  });
  try {
    conversation.begin();
    await firstTurn;
    await conversation.submit('Talk to Claude');
    await conversation.submit('Draft a note');
    assert.equal(last.mode,'model-confirm');
    assert.equal(last.modelDraft,'Draft a note');
    assert.equal(requests.length,0);
    await conversation.submit('confirm');
    assert.equal(last.modelReply,'Here is the first answer.');
    await conversation.submit('Make it shorter');
    await conversation.submit('confirm');
    assert.equal(requests[1].id,'claude');
    assert.deepEqual(requests[1].history,[
      {role:'user',content:'Draft a note'},{role:'assistant',content:'Here is the first answer.'}
    ]);
    await conversation.submit('Back to reminders');
    assert.equal(last.mode,'request');
  } finally { conversation.abort(); }
});
