(function(){
'use strict';
let directory, logins;
async function call(name,args){const r=await sb.rpc(name,args);if(r.error)throw new Error(r.error.message);return r.data;}
async function open(){
 [directory,logins]=await Promise.all([call('hr_employee_directory'),call('hr_employee_logins')]);
 document.querySelector('#main').innerHTML=`<section class="panel"><h3>HR Head · Employee details</h3><p class="note">Manage employees across all shops and link their TatGold login for photo attendance.</p><button class="btn" id="add-employee">Add employee</button><div class="stack">${directory.employees.map(e=>`<div class="panel"><b>${esc(e.name)}</b><p>${esc(e.branch)} · ${esc(e.designation)} · ${e.active?'Active':'Archived'}</p><p>${esc(logins.find(l=>l.email===e.email)?.username||'Login not linked')}</p><button class="btn ghost" data-edit="${esc(e.id)}">Edit details</button></div>`).join('')||'<p>No employees added yet.</p>'}</div></section>`;
 document.querySelector('#add-employee').onclick=()=>edit();
 document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>edit(directory.employees.find(e=>e.id===b.dataset.edit)));
}
function edit(existing){
 const e=existing||{id:crypto.randomUUID(),name:'',designation:'',branch:'Ashirwad',joined:HRCore.today(),email:'',mobile:'',active:true,weeklyOff:'Sunday',shiftIn:'10:00',shiftOut:'20:30',lateGrace:15};
 const field=(key,label,type='text',extra='')=>`<label>${label}<input class="input" name="${key}" type="${type}" value="${esc(e[key]??'')}" ${extra}></label>`;
 const select=(key,label,values)=>`<label>${label}<select class="input" name="${key}">${values.map(v=>`<option ${v===e[key]?'selected':''}>${esc(v)}</option>`).join('')}</select></label>`;
 const d=document.createElement('dialog');d.id='hr-dialog';d.innerHTML=`<header><h3>${existing?'Edit':'Add'} employee</h3><button type="button" class="btn ghost" data-close>Close</button></header><div class="body"><form class="stack"><div class="fields">${field('name','Full name','text','required maxlength="100"')}${field('designation','Designation','text','maxlength="100"')}${select('branch','Shop',HRCore.branches)}${field('joined','Joining date','date','required')}${field('mobile','Mobile','tel','maxlength="20"')}<label>TatGold login<select class="input" name="email"><option value="">Not linked</option>${logins.map(l=>`<option value="${esc(l.email)}" ${l.email===e.email?'selected':''}>${esc(l.username)} · ${esc(l.fullName)}</option>`).join('')}</select></label>${select('weeklyOff','Weekly off',HRCore.WEEKDAYS)}${field('shiftIn','Shift starts','time','required')}${field('shiftOut','Shift ends','time','required')}${field('lateGrace','Late grace (minutes)','number','required min="0" max="180"')}<label>Status<select class="input" name="active"><option value="true" ${e.active?'selected':''}>Active</option><option value="false" ${!e.active?'selected':''}>Archived</option></select></label></div><p class="err" role="alert"></p><button class="btn" type="submit">Save employee</button></form></div>`;
 document.body.append(d);d.showModal();d.querySelector('[data-close]').onclick=()=>d.close();d.onclose=()=>d.remove();
 d.querySelector('form').onsubmit=async event=>{event.preventDefault();const b=d.querySelector('[type=submit]');b.disabled=true;try{const data=Object.fromEntries(new FormData(event.currentTarget));data.id=e.id;data.active=data.active==='true';data.lateGrace=Number(data.lateGrace);await call('hr_employee_save',{p_employee:data,p_version:directory.version});d.close();await open();}catch(err){d.querySelector('.err').textContent=err.message;}finally{b.disabled=false;}};
}
SCREENS.employees={icon:'☷',label:'Employee details',roles:['STAFF'],needsManager:true,open};
})();
