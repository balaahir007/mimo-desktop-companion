{
  const el = id => document.getElementById(id);
  const types = {webhook:'Call n8n',pin:'Open pin',documents:'Open Documents',search:'Search in Chrome'};
  const conditions = {always:'Always',yes:'n8n continue is true',no:'n8n continue is false'};
  let data, selected = 'open-documents', editor = null, recent = null, busy = false;
  let editableRequest = false;

  const workflow = () => data?.workflows.find(item => item.id === selected);
  const title = step => {
    if (step.type === 'pin') {
      const pin = data.pins.find(item => item.id === step.pin);
      return pin ? `Open ${pin.name} (${pin.target})` : 'Missing pin';
    }
    if (step.type === 'webhook') return data.connection.url ? `Send input to ${data.connection.url}` : 'Call n8n (connection needed)';
    if (step.type === 'search') return 'Search Google for the workflow input';
    return types[step.type];
  };

  function item(text) {
    const entry = document.createElement('li');
    entry.textContent = text;
    return entry;
  }

  function message(value) {
    el('workflowStatus').textContent = value instanceof Error ? value.message.replace(/^.*?Error: /,'') : value;
  }

  function render() {
    if (!data) return;
    if (!workflow()) selected = data.workflows[0]?.id;
    const flow = workflow();
    if (!flow) return;
    const locked = busy || Boolean(data.active);
    el('workflowList').replaceChildren(...data.workflows.map(entry => {
      const button = document.createElement('button');
      button.textContent = entry.name;
      button.setAttribute('aria-pressed',String(entry.id === selected));
      button.disabled = locked || Boolean(editor);
      button.onclick = () => {
        selected = entry.id;
        recent = null;
        message('');
        render();
        el('workflowList').querySelector('[aria-pressed=true]')?.focus();
      };
      return button;
    }));
    el('workflowTitle').textContent = editor ? editor.id ? 'Edit workflow' : 'New workflow' : flow.name;
    el('workflowReview').hidden = Boolean(editor);
    el('workflowEditor').hidden = !editor;
    el('workflowNew').disabled = locked || Boolean(editor);
    el('workflowEdit').hidden = el('workflowRemove').hidden = Boolean(flow.builtin);
    el('workflowEdit').disabled = el('workflowRemove').disabled = el('workflowRun').disabled = locked;
    el('workflowStop').hidden = !data.active;
    el('workflowInputLabel').hidden = !flow.steps.some(step => ['webhook','search'].includes(step.type));
    el('workflowInput').disabled = locked;
    el('workflowSteps').replaceChildren(...flow.steps.map(step => item(title(step) +
      (step.when === 'always' ? '' : ` · ${conditions[step.when]}`))));
    el('workflowDisconnect').disabled = locked || !data.connection.url;
    el('workflowConnectionStatus').textContent = data.connection.url ?
      (data.connection.hasKey ? 'Webhook connected. Key saved securely on this PC.' : 'Webhook saved without a key.') :
      'Enter the URL from the n8n Webhook node. Use the same header and key you set there.';
    el('workflowHistory').replaceChildren(...data.history.map(run => {
      const entry = document.createElement('li');
      const button = document.createElement('button');
      button.textContent = `${run.name} · ${run.status} · ${new Date(run.startedAt).toLocaleString()}`;
      button.disabled = locked;
      button.onclick = () => {
        recent = run;
        message(run.error || `Run ${run.status}.`);
        render();
      };
      entry.append(button);
      return entry;
    }));
    const run = data.active || recent;
    el('workflowResult').hidden = !run;
    if (run) {
      el('workflowResultSteps').replaceChildren(...run.steps.map(step => item(`${title(step)} · ${step.status}`)));
      el('workflowReply').hidden = !run.reply;
      el('workflowReply').textContent = run.reply || '';
    }
  }

  async function load() {
    data = await mimo.workflows();
    if (!editableRequest) {
      el('workflowUrl').value = data.connection.url;
      el('workflowHeader').value = data.connection.header;
    }
    render();
  }

  function select(label, value, values, change) {
    const wrapper = document.createElement('label');
    wrapper.textContent = label;
    const input = document.createElement('select');
    for (const [id,caption] of Object.entries(values)) input.add(new Option(caption,id));
    input.value = value;
    input.onchange = () => change(input.value);
    wrapper.append(input);
    return wrapper;
  }

  function editSteps(focus) {
    el('workflowEditorSteps').replaceChildren(...editor.steps.map((step,index) => {
      const row = document.createElement('fieldset');
      row.className = 'workflow-editor-step';
      const legend = document.createElement('legend');
      legend.textContent = `Step ${index+1}`;
      row.append(legend,select('Action',step.type,types,value => {
        step.type = value;
        if (value === 'webhook') step.when = 'always';
        if (value === 'pin') step.pin = data.pins[0]?.id || '';
        editSteps(index);
      }));
      if (step.type === 'pin') row.append(select('Pin',step.pin,
        {'':'Choose a pin',...Object.fromEntries(data.pins.map(pin => [pin.id,pin.name]))},value => { step.pin = value; }));
      if (step.type !== 'webhook') row.append(select('Run when',step.when,conditions,value => { step.when = value; }));
      const buttons = document.createElement('div');
      buttons.className = 'action-buttons';
      const command = (label,disabled,fn) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.disabled = disabled;
        button.onclick = fn;
        buttons.append(button);
      };
      function move(to) {
        editor.steps.splice(index,1);
        editor.steps.splice(to,0,step);
        editSteps(to);
      }
      command('Move up',index === 0,() => move(index-1));
      command('Move down',index === editor.steps.length-1,() => move(index+1));
      command('Remove step',false,() => { editor.steps.splice(index,1); editSteps(Math.min(index,editor.steps.length-1)); });
      row.append(buttons);
      return row;
    }));
    el('workflowAddStep').disabled = editor.steps.length >= 8;
    if (focus !== undefined)
      (el('workflowEditorSteps').children[focus]?.querySelector('select') || el('workflowAddStep')).focus();
  }

  function startEditor(flow) {
    editor = flow ? structuredClone(flow) : {name:'',steps:[{type:'documents',when:'always'}]};
    el('workflowName').value = editor.name;
    editSteps();
    render();
    el('workflowName').focus();
  }

  el('workflowNew').onclick = () => startEditor();
  el('workflowEdit').onclick = () => startEditor(workflow());
  el('workflowAddStep').onclick = () => { editor.steps.push({type:'documents',when:'always'}); editSteps(editor.steps.length-1); };
  el('workflowCancelEdit').onclick = () => { editor = null; message(''); render(); };
  el('workflowEditor').onsubmit = async event => {
    event.preventDefault();
    if (busy || !editor) return;
    busy = true;
    try {
      const saved = await mimo.workflowSave({...editor,name:el('workflowName').value});
      selected = saved.id;
      editor = null;
      recent = null;
      await load();
      message('Workflow saved.');
    } catch (error) { message(error); }
    finally { busy = false; render(); }
  };
  el('workflowRemove').onclick = async () => {
    if (!confirm(`Remove “${workflow().name}” from Workflows?`)) return;
    try { await mimo.workflowRemove(selected); recent = null; await load(); }
    catch (error) { message(error); }
  };
  el('workflowConnectionForm').oninput = () => { editableRequest = true; };
  el('workflowConnectionForm').onsubmit = async event => {
    event.preventDefault();
    const input = {url:el('workflowUrl').value,header:el('workflowHeader').value,key:el('workflowKey').value};
    el('workflowKey').value = '';
    try {
      data.connection = await mimo.workflowConnect(input);
      editableRequest = false;
      await load();
      message('Connection saved. Run a webhook workflow to verify it.');
    } catch (error) { message(error); }
  };
  el('workflowDisconnect').onclick = async () => {
    try { await mimo.workflowDisconnect(); editableRequest = false; await load(); message('n8n disconnected.'); }
    catch (error) { message(error); }
  };
  el('workflowExport').onclick = async () => {
    try { if (await mimo.workflowTemplate()) message('Starter saved. Import it into n8n.'); }
    catch (error) { message(error); }
  };

  el('workflowRun').onclick = async () => {
    if (busy || data.active) return;
    busy = true;
    message('Starting…');
    render();
    try {
      recent = await mimo.workflowRun(selected,el('workflowInputLabel').hidden ? '' : el('workflowInput').value);
      message(recent.error || `Run ${recent.status}.`);
      await load();
    } catch (error) { message(error); }
    finally { busy = false; render(); }
  };
  el('workflowStop').onclick = () => mimo.workflowStop(data.active?.id).catch(message);
  mimo.workflowProgress(run => {
    if (!data) return;
    data.active = run.status === 'running' ? run : null;
    recent = run;
    if (data.active) message('Workflow running…');
    render();
  });
  document.querySelector('[data-view=workflows]').addEventListener('click', () => { void load().catch(message); });
  mimo.showWorkflows(draft => {
    switchView('workflows');
    void load().then(() => {
      if (!draft || editor || busy || data.active) return;
      const match = draft.name && data.workflows.find(flow => flow.name.toLowerCase() === draft.name.toLowerCase());
      if (match) {
        selected = match.id;
        recent = null;
        el('workflowInput').value = draft.text || '';
      }
      message(draft.name && !match ? 'Choose a workflow to run.' : '');
      render();
    }).catch(message);
  });
  void load().catch(message);
}
