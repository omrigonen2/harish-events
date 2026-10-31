(function () {
  const list = document.getElementById('fieldList');
  const template = document.getElementById('field-editor-template');
  const hidden = document.getElementById('fieldsJson');
  const systemTypes = ['parent_first','parent_last','phone'];
  function markChanged(form) { if(form) form.dispatchEvent(new Event('change', { bubbles:true })); }
  function readFields() {
    return Array.from(list.children).map((row, order) => {
      const value = { ...row.fieldData, order };
      row.querySelectorAll('[data-prop]').forEach(input => {
        const key=input.dataset.prop;
        value[key] = input.type === 'checkbox' ? input.checked : key==='options' ? input.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean) : key==='maxRows' ? input.value === '' ? null : Number(input.value) : input.value;
      });
      return value;
    });
  }
  function syncRow(row) {
    const type=row.querySelector('[data-prop="type"]').value;
    const label=row.querySelector('[data-prop="label"]').value;
    row.querySelector('.field-title').textContent=label||'שדה חדש';
    row.querySelector('.field-type').textContent=row.querySelector('[data-prop="type"]').selectedOptions[0].textContent;
    row.querySelectorAll('[data-for]').forEach(el => {
      el.hidden = el.dataset.for==='checkbox' ? type!=='checkbox' : el.dataset.for==='people' ? type!=='children' : el.dataset.for==='options' ? type!=='select' : !['parent_first','parent_last','phone','text','textarea'].includes(type);
    });
    const childrenRequired = document.getElementById('hasChildrenEdit')?.checked;
    row.querySelector('[data-remove-field]').disabled=systemTypes.includes(type)||(type==='children'&&childrenRequired);
  }
  function addRow(field, open=false) {
    const row=template.content.firstElementChild.cloneNode(true);
    row.fieldData={ id:field.id || 'f_'+crypto.randomUUID().replaceAll('-',''), ...field };
    row.querySelectorAll('[data-prop]').forEach(input => {
      const key=input.dataset.prop; const value=field[key];
      if(input.type==='checkbox')input.checked=key==='collectAge'?value!==false:!!value;
      else input.value=key==='options'?(value||[]).join('\n'):value??'';
      if(key==='type') {
        input.disabled=systemTypes.includes(field.type)||field.type==='children';
        if (!input.disabled) Array.from(input.options).filter(option=>systemTypes.includes(option.value)).forEach(option=>option.remove());
      }
      input.addEventListener('input',()=>syncRow(row));input.addEventListener('change',()=>syncRow(row));
    });
    row.querySelector('[data-remove-field]').addEventListener('click',()=>{row.remove();markChanged(list.closest('form'));});
    row.querySelectorAll('[data-move]').forEach(button=>button.addEventListener('click',()=>{
      if(button.dataset.move==='-1'&&row.previousElementSibling)list.insertBefore(row,row.previousElementSibling);
      if(button.dataset.move==='1'&&row.nextElementSibling)list.insertBefore(row.nextElementSibling,row);
      markChanged(list.closest('form'));
    }));
    row.addEventListener('dragstart',event=>{if(event.target.closest('input,textarea,select,button')){event.preventDefault();return;}row.classList.add('dragging');});
    row.addEventListener('dragend',()=>{row.classList.remove('dragging');markChanged(list.closest('form'));});
    row.addEventListener('dragover',event=>{event.preventDefault();const dragged=list.querySelector('.dragging');if(dragged&&dragged!==row){const box=row.getBoundingClientRect();list.insertBefore(dragged,event.clientY<box.top+box.height/2?row:row.nextSibling);}});
    list.appendChild(row);row.open=open;syncRow(row);
  }
  if(list&&template){
    JSON.parse(document.getElementById('fields-config').textContent).forEach(field=>addRow(field));
    document.getElementById('addFieldBtn').addEventListener('click',()=>{addRow({type:'text',label:'שדה חדש',required:false},true);markChanged(list.closest('form'));});
    document.getElementById('hasChildrenEdit')?.addEventListener('change',()=>list.querySelectorAll('.field-editor').forEach(syncRow));
    list.closest('form').addEventListener('submit',()=>{hidden.value=JSON.stringify(readFields());});
  }
  let uploading=0;
  document.querySelectorAll('[data-image-upload]').forEach(zone=>{
    const input=zone.querySelector('input[type=file]'); const key=zone.querySelector('input[type=hidden]'); const image=zone.querySelector('img'); const status=zone.querySelector('[data-upload-status]'); const form=zone.closest('form');
    async function upload(file){
      if(!file||!file.type.startsWith('image/')){status.textContent='יש לבחור קובץ תמונה.';return;}
      if(file.size>8*1024*1024){status.textContent='גודל התמונה המרבי להעלאה הוא 8MB.';return;}
      uploading++;zone.classList.add('is-uploading');status.textContent='מעלה ומכווץ את התמונה…';
      form.querySelectorAll('button[type=submit],.form-savebar button').forEach(b=>b.disabled=true);
      try{
        const data=new FormData();data.append('image',file);
        const response=await fetch('/admin/upload-image',{method:'POST',body:data});const result=await response.json();
        if(!response.ok||!result.key)throw new Error(result.error||'העלאת התמונה נכשלה');
        key.value=result.key;image.src=URL.createObjectURL(file);image.hidden=false;status.textContent='התמונה הועלתה. יש לשמור את העמוד.';markChanged(form);
      }catch(error){status.textContent=error.message||'לא ניתן להעלות כרגע. נסו שוב.';}
      finally{uploading--;zone.classList.remove('is-uploading');if(!uploading)form.querySelectorAll('button[type=submit],.form-savebar button').forEach(b=>b.disabled=false);input.value='';}
    }
    input.addEventListener('change',()=>upload(input.files[0]));
    zone.addEventListener('dragover',event=>event.preventDefault());
    zone.addEventListener('drop',event=>{event.preventDefault();upload(event.dataTransfer.files[0]);});
    zone.tabIndex=0;zone.addEventListener('paste',event=>{const file=Array.from(event.clipboardData?.items||[]).find(i=>i.type.startsWith('image/'))?.getAsFile();if(file){event.preventDefault();upload(file);}});
    zone.querySelector('[data-clear-image]').addEventListener('click',()=>{key.value='';image.src='';image.hidden=true;status.textContent='התמונה תוסר לאחר שמירת העמוד.';markChanged(form);});
  });
  const publish=document.getElementById('publishEvent');const date=document.getElementById('eventDate');
  if(publish&&date){function sync(){date.required=publish.checked;}publish.addEventListener('change',sync);sync();}
})();
