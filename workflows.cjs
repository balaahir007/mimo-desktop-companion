const {randomUUID} = require('node:crypto');

const MAX_REPLY_BYTES = 128 * 1024;
const builtin = {
  id:'ask-n8n', name:'Ask n8n', builtin:true,
  steps:[{type:'webhook',when:'always'}]
};
const localDemo = {
  id:'open-documents', name:'Open Documents', builtin:true,
  steps:[{type:'documents',when:'always'}]
};
const historyKey = 'workflowRuns';

function webhookUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) throw Error('Enter the n8n webhook URL.');
  let url;
  try { url = new URL(value.trim()); } catch { throw Error('Enter a complete n8n webhook URL.'); }
  const loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (loopback && url.protocol === 'http:')) ||
      url.username || url.password || url.hash || url.search || url.pathname === '/' ||
      /(?:^|\/)api\/v\d+(?:\/|$)/i.test(url.pathname)) {
    throw Error('Use an HTTPS webhook URL or an HTTP webhook on this PC.');
  }
  return url.href;
}

async function readReply(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const {value,done} = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_REPLY_BYTES) throw Error('n8n returned more than 128 KB. Return a shorter reply.');
      text += decoder.decode(value,{stream:true});
    }
  } finally { await reader.cancel().catch(() => {}); }
}

function responseValue(text) {
  let data;
  try { data = JSON.parse(text); } catch { return {reply:text, proceed:null}; }
  const item = Array.isArray(data) ? data[0] : data;
  const reply = typeof item === 'string' ? item : [item?.reply,item?.output,item?.answer,item?.text].find(value => typeof value === 'string');
  return {reply:reply ?? JSON.stringify(data,null,2),proceed:typeof item?.continue === 'boolean' ? item.continue : null};
}

class Workflows {
  constructor({db,actions,safeStorage,openDocuments,publish,request = fetch}) {
    Object.assign(this,{db,actions,safeStorage,openDocuments,publish,request});
    this.active = null;
    const previous = this.history();
    if (previous.some(run => run.status === 'running')) {
      db.set(historyKey,previous.map(run => run.status === 'running' ? {
        ...run,status:'interrupted',finishedAt:Date.now(),
        steps:run.steps.map(step => ['running','pending'].includes(step.status) ?
          {...step,status:'interrupted'} : step)
      } : run));
    }
  }

  entries() { return [localDemo,builtin,...this.db.get('workflows',[])]; }
  history() { return this.db.get(historyKey,[]); }
  pins() { return this.actions.list().filter(pin => ['folder','application','website'].includes(pin.kind)); }

  connection() {
    const {url = '',header = 'X-Mimo-Key',secret = ''} = this.db.get('n8nWebhook',{});
    return {url,header,hasKey:!!secret};
  }

  config() {
    return {workflows:this.entries(),pins:this.pins(),connection:this.connection(),history:this.history(),
      active:this.active?.view ?? null};
  }

  connect(input) {
    if (this.active) throw Error('Finish the current workflow before changing the connection.');
    const url = webhookUrl(input?.url);
    if (input.header != null && typeof input.header !== 'string') throw Error('Enter a valid authentication header.');
    const header = input.header?.trim() || 'X-Mimo-Key';
    if (!/^[A-Za-z][A-Za-z0-9-]{0,59}$/.test(header) ||
        /^(?:(?:proxy|sec|content)-|host$|connection$|expect$|upgrade$|transfer-encoding$|trailer$|cookie$|accept$)/i.test(header))
      throw Error('Enter a valid authentication header, such as X-Mimo-Key.');
    const previous = this.db.get('n8nWebhook',{});
    let secret = previous.url === url && previous.header?.toLowerCase() === header.toLowerCase() ? previous.secret : '';
    if (input.key != null && input.key !== '') {
      if (typeof input.key !== 'string' || !/^[\x20-\x7E]{1,1000}$/.test(input.key) || input.key !== input.key.trim())
        throw Error('Enter a webhook key on one line.');
      if (!this.safeStorage.isEncryptionAvailable()) throw Error('Windows credential encryption is unavailable.');
      secret = this.safeStorage.encryptString(input.key).toString('base64');
    }
    if (input.clearKey === true) secret = '';
    this.db.set('n8nWebhook',{url,header,secret});
    return this.connection();
  }

  disconnect() {
    if (this.active) throw Error('Stop the current workflow before disconnecting.');
    this.db.set('n8nWebhook',{});
    return this.connection();
  }

  save(value) {
    const name = typeof value?.name === 'string' ? value.name.trim() : '';
    if (!name || name.length > 70 || !Array.isArray(value.steps) || !value.steps.length || value.steps.length > 8)
      throw Error('Enter a name and add one to eight steps.');
    const pins = this.pins();
    let hasCall = false;
    const steps = value.steps.map(step => {
      if (!step || !['webhook','pin','documents','search'].includes(step.type) || !['always','yes','no'].includes(step.when))
        throw Error('Choose a supported step and condition.');
      if (step.when !== 'always' && !hasCall) throw Error('A conditional step must come after n8n.');
      if (step.type === 'webhook') {
        if (hasCall || step.when !== 'always') throw Error('Use one unconditional n8n call per workflow.');
        hasCall = true;
      }
      const next = {type:step.type,when:step.when};
      if (step.type === 'pin') {
        if (!pins.some(pin => pin.id === step.pin)) throw Error('Choose an existing pin for each Open pin step.');
        next.pin = step.pin;
      }
      return next;
    });
    const workflows = this.db.get('workflows',[]);
    if (value.id && !workflows.some(flow => flow.id === value.id)) throw Error('Choose an editable workflow.');
    if (!value.id && workflows.length >= 30) throw Error('Remove a workflow before adding another.');
    if (this.entries().some(flow => flow.id !== value.id && flow.name.toLowerCase() === name.toLowerCase()))
      throw Error('Choose a unique workflow name.');
    const saved = {id:value.id || randomUUID(),name,steps};
    this.db.set('workflows',value.id ? workflows.map(flow => flow.id === value.id ? saved : flow) : [...workflows,saved]);
    return saved;
  }

  remove(id) {
    if (this.active?.view.workflow === id) throw Error('Stop the workflow before removing it.');
    this.db.set('workflows',this.db.get('workflows',[]).filter(flow => flow.id !== id));
  }

  update(view) {
    const {reply, ...receipt} = view;
    this.db.set(historyKey,[receipt,...this.history().filter(item => item.id !== view.id)].slice(0,20));
    this.publish(structuredClone(view));
  }

  async call(connection,text,id,signal) {
    const headers = {'Content-Type':'application/json','Accept':'application/json, text/plain'};
    if (connection.secret) {
      try { headers[connection.header] = this.safeStorage.decryptString(Buffer.from(connection.secret,'base64')); }
      catch { throw Error('Windows could not unlock the webhook key. Save it again.'); }
    }
    let response;
    try {
      response = await this.request(connection.url,{
        method:'POST',redirect:'error',headers,body:JSON.stringify({input:text,runId:id}),
        signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])
      });
    } catch {
      if (signal.aborted) throw Error('Run stopped.');
      throw Error('The n8n webhook did not respond. Check its address and published status.');
    }
    if ([401,403].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      throw Error('n8n refused the request. Check the webhook header and key.');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Error(`The n8n webhook returned HTTP ${response.status}.`);
    }
    return responseValue(await readReply(response));
  }

  async run(id,text) {
    if (this.active) throw Error('A workflow is already running.');
    const flow = this.entries().find(item => item.id === id);
    if (!flow) throw Error('Choose a saved workflow.');
    if (typeof text !== 'string' || text.length > 8000) throw Error('Use no more than 8,000 characters of input.');
    const connection = this.db.get('n8nWebhook',{});
    if (flow.steps.some(step => step.type === 'webhook') && !connection.url)
      throw Error('Connect an n8n webhook before running this workflow.');
    if (flow.steps.some(step => step.type === 'search') && (!text.trim() || text.length > 1000))
      throw Error('Enter a search query of up to 1,000 characters.');
    const pins = this.pins();
    if (flow.steps.some(step => step.type === 'pin' && !pins.some(pin => pin.id === step.pin)))
      throw Error('A pinned action was removed. Edit the workflow before running.');
    const view = {id:randomUUID(),workflow:flow.id,name:flow.name,status:'running',
      startedAt:Date.now(),steps:flow.steps.map(step => ({...step,status:'pending'})),reply:''};
    const controller = new AbortController();
    let settle;
    const done = new Promise(resolve => { settle = resolve; });
    this.active = {view,controller,done};
    let proceed = null;
    try {
      this.update(view);
      for (const step of view.steps) {
        controller.signal.throwIfAborted();
        if (step.when !== 'always' && proceed !== (step.when === 'yes')) {
          step.status = 'skipped';
          this.update(view);
          continue;
        }
        step.status = 'running';
        this.update(view);
        if (step.type === 'webhook') {
          const result = await this.call(connection,text,view.id,controller.signal);
          view.reply = result.reply;
          proceed = result.proceed;
        }
        if (step.type === 'pin') await this.actions.open(step.pin);
        if (step.type === 'search') await this.actions.open('chrome',text);
        if (step.type === 'documents') await this.openDocuments();
        step.status = 'done';
        this.update(view);
      }
      view.status = controller.signal.aborted ? 'stopped' : 'complete';
    } catch (error) {
      view.status = controller.signal.aborted ? 'stopped' : 'failed';
      view.error = view.status === 'stopped' ? 'Run stopped. Completed actions are recorded below.' :
        (error.message || 'The workflow stopped at an error.');
      const running = view.steps.find(step => step.status === 'running');
      if (running) running.status = view.status;
    } finally {
      for (const step of view.steps) if (step.status === 'pending') step.status = 'skipped';
      view.finishedAt = Date.now();
      this.active = null;
      try { this.update(view); } finally { settle(); }
    }
    return view;
  }

  stop(id) {
    if (!id || this.active?.view.id === id) this.active?.controller.abort();
  }

  shutdown() {
    const active = this.active;
    this.stop();
    return active?.done;
  }
}

module.exports = {Workflows};
