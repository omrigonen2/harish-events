(function(){
const form=document.getElementById('campaignForm');if(!form)return;
const text=document.getElementById('messageText'), preview=document.getElementById('messagePreview'), person=document.getElementById('testRegistrationId'), summary=document.getElementById('campaignSummary'), picker=document.getElementById('recipientPicker'), attach=document.getElementById('attachTicket');
function selected(){return Array.from(form.querySelectorAll('.recipient-checkbox:checked'));}
function update(){
const manual=form.querySelector('[name=audienceMode]:checked').value==='selected';picker.hidden=!manual;
document.getElementById('ticketDelayFields').hidden=!attach?.checked;
const option=person.selectedOptions[0];const values={parentFirstName:option.dataset.first||'שם פרטי',parentLastName:option.dataset.last||'שם משפחה',eventName:preview.dataset.event,eventDate:preview.dataset.date,ticketUrl:'[קישור אישי לכרטיס]'};
preview.textContent=text.value.replace(/\{\{\s*(\w+)\s*\}\}/g,(m,key)=>values[key]??m)||'ההודעה תופיע כאן בזמן הכתיבה.';
summary.textContent='נבחרו '+(manual?selected().length:summary.dataset.total)+' הרשמות. '+(document.getElementById('scheduledAt').value?'השליחה מתוזמנת למועד שנבחר.':'שליחה מיידית.')+(attach?.checked?' לאחר ההודעה יישלח גם כרטיס.':'')+' מספרי טלפון כפולים יקבלו הודעה אחת.';
}
form.addEventListener('input',update);form.addEventListener('change',update);
document.querySelectorAll('[data-insert-variable]').forEach(button=>button.addEventListener('click',()=>{const variable='{{'+button.dataset.insertVariable+'}}';text.setRangeText(variable,text.selectionStart,text.selectionEnd,'end');text.dispatchEvent(new Event('input',{bubbles:true}));text.focus();}));
document.getElementById('recipientSearch').addEventListener('input',function(){Array.from(document.getElementById('recipientRows').children).forEach(row=>row.hidden=!row.dataset.name.includes(this.value.trim().toLowerCase()));});
document.getElementById('selectVisibleBtn').addEventListener('click',()=>{form.querySelectorAll('#recipientRows tr:not([hidden]) input').forEach(input=>input.checked=true);update();});
document.getElementById('clearSelectionBtn').addEventListener('click',()=>{form.querySelectorAll('.recipient-checkbox').forEach(input=>input.checked=false);update();});
form.addEventListener('submit',event=>{if(form.querySelector('[name=audienceMode]:checked').value==='selected'&&!selected().length){event.preventDefault();alert('יש לבחור לפחות נרשם אחד.');return;}if(!confirm(summary.textContent+'\nלהמשיך לשליחה?'))event.preventDefault();});
document.getElementById('sendTestButton').addEventListener('click',async function(){
const feedback=document.getElementById('testFeedback');if(!text.value.trim()){feedback.textContent='יש לכתוב תוכן להודעה.';return;}
if(!document.getElementById('testPhone').value.trim()){feedback.textContent='יש למלא מספר טלפון לבדיקה.';return;}
if(attach?.checked&&!person.value){feedback.textContent='יש לסגור חלון זה ולבחור נרשם לדוגמה לכרטיס.';return;}
this.disabled=true;feedback.textContent='שולח את הודעת הבדיקה…';
try{const response=await fetch(this.dataset.url,{method:'POST',body:new FormData(form),headers:{Accept:'application/json'}});const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error||'השליחה נכשלה');feedback.textContent=result.message;feedback.className='small text-success mt-3';}
catch(error){feedback.textContent=error.message;feedback.className='small text-danger mt-3';}finally{this.disabled=false;}
});
update();
})();