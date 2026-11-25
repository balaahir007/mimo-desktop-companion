{
  const el = id => document.getElementById(id);
  const prompt = el('agentPrompt');
  const cards = el('agentNodes');
  let config, plan, run, busy = false;
  const selected = new Set();
  el('agentPlan').disabled = true;

  function message(error) {
    el('agentStatus').textContent = error instanceof Error ? error.message.replace(/^.*?Error: /,'') : error;
  }

  function updateControls() {
    if (!config) return;
    const locked = busy || run?.status === 'running';
    el('agentPlan').disabled = locked;
    el('agentRun').disabled = locked || !selected.size || Boolean(run);
    el('agentStop').hidden = run?.status !== 'running';
    for (const checkbox of cards.querySelectorAll('input')) checkbox.disabled = locked || Boolean(run);
  }

  function draw() {
    if (!config) return;
    const {settings,tools,providers,memoryCount} = config;
    const provider = providers.find(item => item.id === settings.provider);
    el('agentConnectionStatus').textContent = provider.connected ?
      `${provider.name} API key saved.` : `Connect an ${provider.name} API key to create a plan.`;
    el('agentDisconnect').hidden = !provider.connected;
    el('agentMemory').checked = settings.memory;
    el('agentMemoryStatus').textContent = `${memoryCount} saved · When enabled, sends up to four saved turns with a plan.`;
    el('agentForget').disabled = !memoryCount;
    el('agentProviders').replaceChildren(...providers.map(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.name;
      button.setAttribute('aria-pressed',String(item.id === settings.provider));
      button.onclick = () => saveSettings({provider:item.id});
      return button;
    }));
    el('agentTools').replaceChildren(...Object.entries(tools).map(([id,tool]) => {
      const row = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = settings.enabled.includes(id);
      input.onchange = () => saveSettings({enabled:input.checked ?
        [...settings.enabled,id] : settings.enabled.filter(value => value !== id)});
      const caption = document.createElement('span');
      caption.textContent = tool.title;
      const details = document.createElement('small');
      details.textContent = tool.detail;
      caption.append(details);
      row.append(input,caption);
      return row;
    }));
    renderPlan();
  }

  async function reload() {
    config = await mimo.agentConfig();
    draw();
  }

  async function saveSettings(value) {
    try {
      config = await mimo.agentSettings({...config.settings,...value});
      draw();
    } catch (error) { message(error); draw(); }
  }

  function renderPlan() {
    el('agentPlanPanel').hidden = !plan;
    const states = new Map(run?.nodes.map(node => [node.id,node]) || []);
    cards.replaceChildren(...(plan?.nodes || []).map(node => {
      const row = document.createElement('li');
      const label = document.createElement('label');
      const state = states.get(node.id);
      row.dataset.state = state?.status || 'review';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected.has(node.id);
      checkbox.onchange = () => {
        if (checkbox.checked) selected.add(node.id);
        else selected.delete(node.id);
        updateControls();
      };
      const content = document.createElement('span');
      const heading = document.createElement('strong');
      heading.textContent = node.title;
      const detail = document.createElement('span');
      detail.className = 'agent-node-detail';
      detail.textContent = node.detail;
      content.append(heading,detail);
      if (state) {
        const feedback = document.createElement('small');
        feedback.textContent = state.result || state.status;
        content.append(feedback);
      }
      label.append(checkbox,content);
      row.append(label);
      return row;
    }));
    el('agentAnswer').hidden = !run?.reply;
    el('agentAnswerText').textContent = run?.reply || '';
    updateControls();
  }

  el('agentForm').onsubmit = async event => {
    event.preventDefault();
    if (busy || run?.status === 'running') return;
    if (!config.providers.some(item => item.id === config.settings.provider && item.connected)) {
      el('agentConnection').open = true;
      el('agentKey').focus();
      message('Save a provider API key to create a plan.');
      return;
    }
    busy = true;
    plan = run = null;
    selected.clear();
    renderPlan();
    message('Creating a plan…');
    try {
      plan = await mimo.agentPlan(prompt.value);
      for (const node of plan.nodes) if (node.type === 'answer') selected.add(node.id);
      message('Select the nodes you want Memo to run.');
    } catch (error) { message(error); }
    finally { busy = false; renderPlan(); }
  };

  el('agentRun').onclick = async () => {
    if (!plan || busy || !selected.size || run) return;
    busy = true;
    updateControls();
    message('Running selected nodes…');
    try {
      run = await mimo.agentRun(plan.id,[...selected]);
      message(run.status === 'complete' ? 'Selected nodes completed.' : `Run ${run.status}.`);
      await reload();
    } catch (error) { message(error); }
    finally { busy = false; renderPlan(); }
  };
  el('agentStop').onclick = () => mimo.agentStop().catch(message);
  el('agentRead').onclick = () => {
    if (run?.reply) mimo.read(run.reply.slice(0,200));
  };
  el('agentMemory').onchange = () => saveSettings({memory:el('agentMemory').checked});
  el('agentForget').onclick = async () => {
    if (!confirm('Clear the saved conversations from Memo?')) return;
    try { config = await mimo.agentForget(); draw(); } catch (error) { message(error); }
  };
  el('agentKeyForm').onsubmit = async event => {
    event.preventDefault();
    const field = el('agentKey');
    const key = field.value;
    field.value = '';
    try { await mimo.connectAction(config.settings.provider,key); await reload(); message('API key saved.'); }
    catch (error) { message(error); }
  };
  el('agentDisconnect').onclick = async () => {
    try { await mimo.connectAction(config.settings.provider,''); await reload(); message('Provider disconnected.'); }
    catch (error) { message(error); }
  };
  mimo.agentProgress(state => {
    if (state.id === plan?.id) { run = state; renderPlan(); }
  });
  mimo.showAgent(draft => {
    switchView('agent');
    if (draft?.text && !busy && run?.status !== 'running') { prompt.value = draft.text; prompt.focus(); }
    void reload().catch(message);
  });
  document.querySelector('[data-view=agent]').addEventListener('click',() => { void reload().catch(message); });
  mimo.onProfile(profile => drawAvatar(el('agentAvatar'),profile));
  mimo.config().then(config => drawAvatar(el('agentAvatar'),config.profile)).catch(message);
  void reload().catch(message);
}
