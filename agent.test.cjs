const test = require('node:test');
const assert = require('node:assert/strict');
const {Agent} = require('./agent.cjs');

function fixture() {
  const data = new Map();
  const calls = [];
  const moves = [];
  const pins = [{id:'notes',kind:'folder',name:'Notes',target:'C:\\Private\\Notes'}];
  const now = Date.parse('2026-11-21T10:00:00.000Z');
  let output = [{type:'answer',text:'One answer.'},{type:'open',pin:'notes'},{type:'animate',motion:'Dance'}];
  const agent = new Agent({
    db:{get:(key,fallback) => data.get(key) ?? fallback,set:(key,value) => data.set(key,structuredClone(value)),
      save:(title,due) => moves.push([title,due])},
    actions:{key:() => 'encrypted',list:() => pins,
      send:async (id,prompt) => { calls.push({id,prompt}); return JSON.stringify({nodes:output}); },
      open:async id => { moves.push(id); return 'Opened.'; }},
    animate:move => moves.push(move),refresh() {},publish() {},now:() => now
  });
  return {agent,pins,moves,calls,setOutput:value => { output = value; }};
}
const preferences = {provider:'chatgpt',enabled:['answer','open','search','remind','animate'],memory:true};

test('executes only selected nodes in plan order and keeps approved replies when memory is enabled',async () => {
  const {agent,calls,moves} = fixture();
  agent.configure(preferences);
  const plan = await agent.plan('Open my Notes folder and dance.');
  assert.ok(!calls[0].prompt.includes('Private'));
  assert.deepEqual(plan.nodes.map(node => node.type),['answer','open','animate']);
  const result = await agent.run(plan.id,[3,1,2]);
  assert.deepEqual(moves,['notes','Dance']);
  assert.equal(result.reply,'One answer.');
  assert.equal(agent.config().memoryCount,1);
  await agent.plan('What happened before?');
  assert.match(calls[1].prompt,/One answer/);
  await assert.rejects(agent.run(plan.id,[1]),/already ran/);
  agent.configure({...preferences,memory:false});
  await agent.plan('What next?');
  assert.ok(!calls[2].prompt.includes('One answer'));
});

test('keeps disabled, invented or changed pins from running',async () => {
  const {agent,pins,moves,setOutput} = fixture();
  await assert.rejects(agent.plan('Open my notes'),/turned off/);
  agent.configure(preferences);
  setOutput([{type:'open',pin:'C:\\Windows'}]);
  await assert.rejects(agent.plan('Open that'),/does not exist/);
  setOutput([{type:'open',pin:'notes'},{type:'animate',motion:'Jump'}]);
  const plan = await agent.plan('Open Notes then jump');
  pins[0].target = 'C:\\Other';
  const result = await agent.run(plan.id,[1,2]);
  assert.equal(result.status,'failed');
  assert.equal(result.nodes[1].status,'skipped');
  assert.deepEqual(moves,[]);
});

test('rejects reminders with a missing time and validates selected node IDs',async () => {
  const {agent,setOutput,moves} = fixture();
  agent.configure(preferences);
  setOutput([{type:'remind',request:'Remind me to check notes tomorrow'}]);
  await assert.rejects(agent.plan('Remind me tomorrow'),/What time/);
  setOutput([{type:'remind',request:'Remind me to check notes in 15 minutes'}]);
  const plan = await agent.plan('Set a reminder in 15 minutes');
  await assert.rejects(agent.run(plan.id,[99]),/reviewed node/);
  assert.equal((await agent.run(plan.id,[1])).status,'complete');
  assert.equal(moves[0][0],'check notes');
});
