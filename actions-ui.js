{
  const actionEl = id => document.getElementById(id);
  const list = actionEl('actionList');
  const draft = actionEl('actionText');
  const status = actionEl('actionStatus');
  const reply = actionEl('actionReply');
  const run = actionEl('runAction');
  const send = actionEl('sendAction');
  const remove = actionEl('removeAction');
  let entries = [];
  let selected = 'chatgpt';
  let busy = false;

  function current() { return entries.find(action => action.id === selected); }
  function message(error) { status.textContent = error.message.replace(/^.*?Error: /,''); }

  function render() {
    const action = current();
    if (!action) return;
    list.replaceChildren();
    for (const entry of entries) {
      const button = document.createElement('button');
      button.textContent = entry.name;
      button.setAttribute('aria-pressed',String(entry.id === selected));
      button.disabled = busy;
      button.onclick = () => {
        selected = entry.id;
        status.textContent = '';
        reply.hidden = true;
        actionEl('actionKey').value = '';
        render();
        list.querySelector('[aria-pressed=true]')?.focus();
      };
      list.append(button);
    }
    const chat = action.kind === 'chat';
    const search = action.kind === 'search';
    actionEl('actionTitle').textContent = action.name;
    actionEl('actionDetails').textContent = action.target || (chat ?
      'Open the website with your text copied, or send it from Memo with an API key.' :
      'Open Google results in Chrome.');
    actionEl('actionCompose').hidden = !chat && !search;
    draft.maxLength = search ? 1000 : 8000;
    if (draft.value.length > draft.maxLength) draft.value = draft.value.slice(0,draft.maxLength);
    actionEl('actionConnection').hidden = !chat;
    actionEl('connectionStatus').textContent = action.connected ? 'API key saved on this PC.' : 'No API key connected.';
    actionEl('forgetKey').hidden = !action.connected;
    run.textContent = {chat:'Copy text and open chat',search:'Search in Chrome',folder:'Open folder',
      application:'Launch app',website:'Open website'}[action.kind];
    send.hidden = !chat || !action.connected;
    remove.hidden = !action.target;
    run.disabled = send.disabled = remove.disabled = busy;
  }

  async function reload(id, targetName) {
    entries = await mimo.listActions();
    if (targetName) {
      const matches = entries.filter(action => action.target && action.name.toLowerCase() === targetName.toLowerCase());
      if (matches.length === 1) id = matches[0].id;
      else status.textContent = 'Choose the pin you want to open.';
    }
    if (entries.some(action => action.id === id)) selected = id;
    if (!current()) selected = 'chatgpt';
    render();
  }

  async function perform(fn) {
    if (busy) return;
    busy = true;
    status.textContent = '';
    render();
    try { await fn(); }
    catch (error) { message(error); }
    finally { busy = false; render(); }
  }

  function compose(comment) {
    actionEl('giveText').setAttribute('aria-pressed',String(!comment));
    actionEl('giveComment').setAttribute('aria-pressed',String(comment));
    actionEl('draftLabel').textContent = comment ? 'Comment' : 'Text';
    draft.focus();
  }

  actionEl('giveText').onclick = () => compose(false);
  actionEl('giveComment').onclick = () => compose(true);
  run.onclick = () => perform(async () => {
    reply.hidden = true;
    status.textContent = await mimo.runAction(selected,draft.value);
  });
  send.onclick = () => perform(async () => {
    const text = draft.value;
    const id = selected;
    reply.hidden = true;
    status.textContent = 'Waiting for the provider…';
    actionEl('replyText').textContent = await mimo.sendAction(id,text);
    status.textContent = '';
    reply.hidden = false;
  });
  remove.onclick = () => perform(async () => { await mimo.removePin(selected); await reload(); });
  const pinLocal = kind => perform(async () => {
    const pin = await mimo.pinLocal(kind);
    if (pin) await reload(pin.id);
  });
  actionEl('pinFolder').onclick = () => pinLocal('folder');
  actionEl('pinApp').onclick = () => pinLocal('application');
  actionEl('pinSiteForm').onsubmit = event => {
    event.preventDefault();
    const form = event.currentTarget;
    void perform(async () => {
      const pin = await mimo.pinSite(actionEl('siteName').value,actionEl('siteUrl').value);
      form.reset();
      await reload(pin.id);
    });
  };
  actionEl('keyForm').onsubmit = event => {
    event.preventDefault();
    const key = actionEl('actionKey');
    const value = key.value;
    key.value = '';
    void perform(async () => { await mimo.connectAction(selected,value); await reload(); });
  };
  actionEl('forgetKey').onclick = () => perform(async () => {
    await mimo.connectAction(selected,'');
    await reload();
  });
  mimo.showActions(data => {
    switchView('actions');
    if (data && !busy) {
      draft.value = data.text || '';
      reload(data.id,data.targetName).then(() => { if (!actionEl('actionCompose').hidden) compose(false); },message);
    }
  });
  reload().catch(message);
}
