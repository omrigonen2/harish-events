(function () {
  var container = document.getElementById('children-container');
  var addBtn = document.getElementById('add-child-btn');
  if (!container || !addBtn) return;

  var nameLbl = container.getAttribute('data-name-label') || 'שם הילד/ה';
  var ageLbl = container.getAttribute('data-age-label') || 'גיל';

  function nextIndex() {
    var rows = container.querySelectorAll('.child-row');
    var max = -1;
    rows.forEach(function (row) {
      var i = parseInt(row.getAttribute('data-index'), 10);
      if (!Number.isNaN(i) && i > max) max = i;
      var nameInput = row.querySelector('input[name*="[name]"]');
      if (nameInput && nameInput.name) {
        var m = nameInput.name.match(/^children\[(\d+)\]/);
        if (m) {
          var n = parseInt(m[1], 10);
          if (n > max) max = n;
        }
      }
    });
    return max + 1;
  }

  function renumberRows() {
    var rows = container.querySelectorAll('.child-row');
    rows.forEach(function (row, idx) {
      row.setAttribute('data-index', String(idx));
      var nameIn = row.querySelector('.child-name');
      var ageIn = row.querySelector('.child-age');
      if (nameIn) nameIn.name = 'children[' + idx + '][name]';
      if (ageIn) ageIn.name = 'children[' + idx + '][age]';
    });
  }

  function bindRow(row) {
    var removeBtn = row.querySelector('.btn-remove-child');
    if (removeBtn) {
      removeBtn.addEventListener('click', function () {
        var rows = container.querySelectorAll('.child-row');
        if (rows.length <= 1) {
          var n = row.querySelector('.child-name');
          var a = row.querySelector('.child-age');
          if (n) n.value = '';
          if (a) a.value = '';
          return;
        }
        row.remove();
        renumberRows();
      });
    }
  }

  container.querySelectorAll('.child-row').forEach(bindRow);

  addBtn.addEventListener('click', function () {
    var idx = nextIndex();
    var div = document.createElement('div');
    div.className = 'child-row border rounded p-3 mb-2';
    div.setAttribute('data-index', String(idx));
    div.innerHTML =
      '<div class="row g-2 align-items-end">' +
      '<div class="col-md-6">' +
      '<label class="form-label child-lbl-name">' +
      nameLbl +
      ' *</label>' +
      '<input class="form-control child-name" type="text" name="children[' +
      idx +
      '][name]" required maxlength="120">' +
      '</div>' +
      '<div class="col-md-4">' +
      '<label class="form-label child-lbl-age">' +
      ageLbl +
      ' *</label>' +
      '<input class="form-control child-age" type="number" name="children[' +
      idx +
      '][age]" min="0" max="120" required>' +
      '</div>' +
      '<div class="col-md-2 text-md-start text-end">' +
      '<button type="button" class="btn btn-outline-danger btn-sm btn-remove-child" title="הסר">הסר</button>' +
      '</div>' +
      '</div>';
    container.appendChild(div);
    bindRow(div);
    renumberRows();
  });

  renumberRows();
})();
