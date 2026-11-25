const $=s=>document.querySelector(s);
let filter='active',editing=null;
function button(text,fn){const b=document.createElement('button');b.textContent=text;b.onclick=fn;return b;}
function form(row){
  editing=row?.id??null;$('#formTitle').textContent=row?.id?'Edit reminder':'New reminder';
  $('#title').value=row?.title??'';
  const date=new Date(row?.due??Date.now()+600000);
  $('#due').value=new Date(date-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
  if(!$('dialog').open)$('dialog').showModal();$('#title').focus();
}
async function render(){
  const rows=(await mimo.list()).filter(r=>(r.state==='completed')===(filter==='completed'));
  const list=$('#list');list.replaceChildren();
  if(!rows.length){
    const empty=document.createElement('div');empty.className='empty';
    const img=new Image();img.src='mimo.svg';img.alt='';
    const p=document.createElement('p');p.textContent=filter==='active'?'No active reminders. Add one when something needs your attention.':'Completed reminders will appear here.';
    empty.append(img,p);list.append(empty);
  }
  for(const r of rows){
    const row=document.createElement('article');row.className='row';
    const info=document.createElement('div'),title=document.createElement('strong'),time=document.createElement('small');
    title.textContent=r.title;time.textContent=new Date(r.due).toLocaleString()+' · '+r.state;
    info.append(title,time);const actions=document.createElement('div');
    if(r.state!=='completed')actions.append(button('Done',()=>mimo.act(r.id,'done')));
    actions.append(button('Read aloud',()=>mimo.read(r.title)));actions.append(button(r.state==='completed'?'Reopen':'Edit',()=>form(r)),button('Delete',()=>{if(confirm('Delete this reminder?'))mimo.act(r.id,'delete');}));
    row.append(info,actions);list.append(row);
  }
}
$('#date').textContent=new Date().toLocaleDateString('en',{weekday:'long',month:'long',day:'numeric'});
$('#add').onclick=()=>form();$('#cancel').onclick=()=>$('dialog').close();
$('dialog form').onsubmit=async e=>{e.preventDefault();try{await mimo.save($('#title').value,new Date($('#due').value).getTime(),editing);$('dialog').close();}catch{alert('Enter a title and valid date and try again.');}};
for(const b of document.querySelectorAll('[data-filter]'))b.onclick=()=>{filter=b.dataset.filter;for(const x of document.querySelectorAll('[data-filter]'))x.setAttribute('aria-pressed',String(x===b));render();};
mimo.changed(render);mimo.showForm(()=>form());render();
