(function () {
  const dirty = new Set();
  document.querySelectorAll('form[data-dirty-track]').forEach(form => {
    const update = () => { dirty.add(form); const label = form.querySelector('[data-save-state]'); if (label) { label.textContent = 'יש שינויים שלא נשמרו'; label.classList.add('is-dirty'); } };
    form.addEventListener('input', update); form.addEventListener('change', update);
    form.addEventListener('submit', event => { queueMicrotask(() => { if (!event.defaultPrevented) dirty.delete(form); }); });
  });
  window.addEventListener('beforeunload', event => { if (dirty.size) { event.preventDefault(); event.returnValue = ''; } });
  document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(new URL(button.dataset.copy, window.location.origin).href); button.textContent = 'הקישור הועתק'; } catch { button.textContent = 'לא ניתן להעתיק'; }
  }));
  document.querySelectorAll('[data-filter-table]').forEach(section => {
    const search = section.querySelector('[data-search]'); const status = section.querySelector('[data-filter]'); const rows = Array.from(section.querySelectorAll('tbody tr[data-search-text]')); const count = section.querySelector('[data-count]');
    function apply() { let visible=0; rows.forEach(row => { const matches = (!search || row.dataset.searchText.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())) && (!status || !status.value || (row.dataset.status || '').split(' ').includes(status.value)); row.hidden=!matches; if(matches)visible++; }); if(count)count.textContent=visible+' מתוך '+rows.length; }
    if(search)search.addEventListener('input',apply);if(status)status.addEventListener('change',apply);apply();
  });
})();
