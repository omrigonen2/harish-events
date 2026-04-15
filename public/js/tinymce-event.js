(function () {
  var ta = document.getElementById('eventDescription');
  if (!ta) return;

  function init() {
    if (typeof tinymce === 'undefined') return;
    tinymce.init({
      selector: '#eventDescription',
      license_key: 'gpl',
      promotion: false,
      branding: false,
      height: 420,
      base_url: 'https://cdn.jsdelivr.net/npm/tinymce@7',
      suffix: '.min',
      plugins: 'lists link autolink code table help wordcount',
      toolbar:
        'undo redo | blocks | bold italic underline strikethrough | alignright aligncenter alignleft | bullist numlist | link table | code removeformat',
      menubar: false,
      content_style:
        'body { font-family: system-ui, "Segoe UI", Arial, sans-serif; font-size: 16px; direction: rtl; line-height: 1.6; }',
      directionality: 'rtl',
      setup: function (editor) {
        editor.on('change input undo redo', function () {
          editor.save();
        });
      },
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  document.querySelectorAll('form').forEach(function (form) {
    form.addEventListener('submit', function () {
      if (typeof tinymce !== 'undefined') tinymce.triggerSave();
    });
  });
})();
