const {randomUUID} = require('node:crypto');
const {stat, access} = require('node:fs/promises');
const {spawn} = require('node:child_process');
const path = require('node:path');

const chats = {
  chatgpt: {
    name:'ChatGPT', web:'https://chatgpt.com/', api:'https://api.openai.com/v1/responses',
    body: (input,history) => ({model:'gpt-5-mini',input:history.length ?
      [...history,{role:'user',content:input}] : input,store:false,max_output_tokens:1500}),
    reply: data => data.output?.flatMap(item => item.content || [])
      .filter(item => item.type === 'output_text' || item.type === 'refusal')
      .map(item => item.text || item.refusal).filter(Boolean).join('\n')
  },
  claude: {
    name:'Claude', web:'https://claude.ai/new', api:'https://api.anthropic.com/v1/messages',
    headers:key => ({'x-api-key':key,'anthropic-version':'2023-06-01'}),
    body: (content,history) => ({model:'claude-haiku-4-5',messages:[...history,{role:'user',content}],max_tokens:1000}),
    reply: data => data.content?.filter(item => item.type === 'text').map(item => item.text).join('\n')
  }
};
const builtins = [
  {id:'chatgpt',name:'ChatGPT',kind:'chat'}, {id:'claude',name:'Claude',kind:'chat'},
  {id:'chrome',name:'Chrome search',kind:'search'}
];

function chat(id) {
  if (!Object.hasOwn(chats,id)) throw Error('Choose ChatGPT or Claude.');
  return chats[id];
}

function inputText(text, limit = 8000) {
  if (typeof text !== 'string' || !text.trim() || text.length > limit)
    throw Error(`Enter text under ${limit + 1} characters.`);
  return text.trim();
}

function webAddress(text) {
  if (typeof text !== 'string' || text.length > 2000) throw Error('Enter a valid HTTPS address.');
  let url;
  try { url = new URL(text.trim()); } catch { throw Error('Enter a valid HTTPS address.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('Use an HTTPS address without login details.');
  return url.href;
}

function voiceAction(text) {
  const agent = /^(?:ask (?:memo|mimo)|plan (?:this|a task)|do this)(?:[\s,:]+(.+))?[.!?]*$/i.exec(text);
  if (agent) return {view:'agent',text:agent[1] || ''};
  const flow = /^(?:run|open) (?:the )?workflow(?:\s+(.+?))?[.!?]*$/i.exec(text);
  if (flow) return {view:'workflows',name:flow[1] || ''};
  const n8n = /^ask (?:n8n|n eight n|n 8 n)(?:[, :]+(.+))?[.!?]*$/i.exec(text);
  if (n8n) return {view:'workflows',name:'Ask n8n',text:n8n[1] || ''};
  const pin = /^open (?:pin|folder|app)\s+(.+?)\s*[.!?]*$/i.exec(text);
  if (pin) return {targetName:pin[1]};
  const routed = /^(?:(?:open|ask)\s+(chatgpt|chat gpt|claude)(?:[\s,:]+(.+))?|(?:search (?:chrome|google)(?: for)?|google)(?:[\s,:]+(.+))?|give (?:a )?(?:comment|text)(?:[\s,:]+(.+))?|open (?:my )?(?:pins|actions|folders?))[.!?]*$/i.exec(text);
  if (!routed) return null;
  const id = routed[1]?.toLowerCase().replace(/ /g,'') || (routed[3] || /^search|^google/i.test(text) ? 'chrome' : '');
  return {id,text:routed[2] || routed[3] || routed[4] || ''};
}

function startExecutable(file,args = []) {
  return new Promise((resolve,reject) => {
    const child = spawn(file,args,{detached:true,stdio:'ignore',shell:false,windowsHide:false});
    child.once('error', () => reject(Error('Windows could not open that application.')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function localSelection(file,kind) {
  if (kind !== 'folder' && kind !== 'application') throw Error('Unknown local action.');
  if (typeof file !== 'string' || !/^[a-z]:\\[^:\r\n]*$/i.test(file) ||
      (kind === 'application' && !/\.exe$/i.test(file))) throw Error('Choose a local Windows folder or .exe application.');
  return file;
}

class Actions {
  constructor({db,shell,clipboard,safeStorage,dialog,owner,request = fetch}) {
    Object.assign(this,{db,shell,clipboard,safeStorage,dialog,owner,request});
    this.inFlight = false;
  }

  pins() { return this.db.get('actionPins',[]); }
  key(id) { return this.db.get('actionKey:' + id,''); }

  list() {
    return [...builtins.map(item => ({...item,connected:!!this.key(item.id)})),...this.pins()];
  }

  add(pin) {
    const pins = this.pins();
    if (pins.length >= 30) throw Error('Remove a pin before adding another.');
    const saved = {id:randomUUID(),...pin};
    this.db.set('actionPins',[...pins,saved]);
    return saved;
  }

  addSite(name,address) {
    return this.add({name:inputText(name,60),kind:'website',target:webAddress(address)});
  }

  async choose(kind) {
    if (!['folder','application'].includes(kind)) throw Error('Choose a folder or application.');
    const result = await this.dialog.showOpenDialog(this.owner,{
      properties:[kind === 'folder' ? 'openDirectory' : 'openFile'],
      ...(kind === 'application' ? {filters:[{name:'Windows applications',extensions:['exe']}]} : {})
    });
    if (result.canceled) return null;
    const target = localSelection(result.filePaths[0],kind);
    return this.add({kind,target,name:path.win32.basename(target) || target});
  }

  remove(id) { this.db.set('actionPins',this.pins().filter(pin => pin.id !== id)); }

  connect(id,key) {
    chat(id);
    if (key === '') {
      this.db.set('actionKey:' + id,'');
      return false;
    }
    const value = inputText(key,500);
    if (!/^[\x21-\x7e]+$/.test(value)) throw Error('Paste the API key as a single line.');
    if (!this.safeStorage.isEncryptionAvailable()) throw Error('Windows credential encryption is unavailable.');
    this.db.set('actionKey:' + id,this.safeStorage.encryptString(value).toString('base64'));
    return true;
  }

  async send(id,text,history = [],planning = false) {
    const provider = chat(id);
    const prompt = inputText(text,planning ? 24000 : 8000);
    const encrypted = this.key(id);
    if (!encrypted) throw Error('Connect an API key to send from Memo.');
    if (this.inFlight) throw Error('Wait for the current response.');
    this.inFlight = true;
    try {
      let key;
      try { key = this.safeStorage.decryptString(Buffer.from(encrypted,'base64')); }
      catch { throw Error('Windows could not unlock this key. Connect it again.'); }
      let response;
      try {
        const body = provider.body(prompt,history);
        if (planning && id === 'chatgpt') body.max_output_tokens = 3500;
        if (planning && id === 'claude') body.max_tokens = 2200;
        response = await this.request(provider.api,{
          method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),
          headers:{'Content-Type':'application/json',
            ...(provider.headers ? provider.headers(key) : {Authorization:'Bearer ' + key})},
          body:JSON.stringify(body)
        });
      } catch { throw Error(`${provider.name} could not be reached. Try again.`); }
      if (!response.ok) {
        if ([401,403].includes(response.status)) throw Error('Check the API key and model access for this account.');
        if (response.status === 429) throw Error('The provider reached a rate or usage limit.');
        throw Error(`${provider.name} could not complete the request (HTTP ${response.status}).`);
      }
      const reply = provider.reply(await response.json());
      if (!reply) throw Error('The provider returned no text. Try a shorter request.');
      return reply;
    } finally { this.inFlight = false; }
  }

  async open(id,text = '') {
    const action = this.list().find(item => item.id === id);
    if (!action) throw Error('Choose a saved action.');
    if (action.kind === 'chat') {
      const provider = chat(id);
      const prompt = inputText(text);
      await this.shell.openExternal(provider.web);
      this.clipboard.writeText(prompt);
      return `Opened ${provider.name} and copied your text. Paste it into the chat to send it.`;
    }
    if (action.kind === 'search') {
      const query = inputText(text,1000);
      const url = new URL('https://www.google.com/search');
      url.searchParams.set('q',query);
      for (const folder of [process.env.LOCALAPPDATA,process.env.ProgramFiles,process.env['ProgramFiles(x86)']].filter(Boolean)) {
        const chrome = path.join(folder,'Google','Chrome','Application','chrome.exe');
        try { await access(chrome); } catch { continue; }
        await startExecutable(chrome,[url.href]);
        return 'Opened the search in Chrome.';
      }
      await this.shell.openExternal(url.href);
      return 'Chrome was unavailable in its usual install locations. Opened the search in your default browser.';
    }
    if (action.kind === 'website') {
      await this.shell.openExternal(webAddress(action.target));
    } else {
      const file = localSelection(action.target,action.kind);
      const info = await stat(file).catch(() => null);
      if (action.kind === 'application' && info?.isFile()) await startExecutable(file);
      else if (action.kind === 'folder' && info?.isDirectory()) {
        if (await this.shell.openPath(file)) throw Error('Windows could not open that folder.');
      } else throw Error('This target moved or is unavailable. Pin it again.');
    }
    return `Opened ${action.name}.`;
  }
}

module.exports = {Actions, voiceAction};
