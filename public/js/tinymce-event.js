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
      plugins: 'lists link autolink code table image help wordcount',
      toolbar:
        'undo redo | blocks | bold italic underline strikethrough | alignright aligncenter alignleft | bullist numlist | link image table | code removeformat',
      menubar: false,
      automatic_uploads: true,
      images_upload_handler: function (blobInfo, progress) {
        return new Promise(function (resolve, reject) {
          var xhr = new XMLHttpRequest();
          var formData = new FormData();
          xhr.open('POST', '/admin/upload-image');
          xhr.upload.onprogress = function (event) {
            if (event.lengthComputable && typeof progress === 'function') {
              progress((event.loaded / event.total) * 100);
            }
          };
          xhr.onload = function () {
            var response;
            try {
              response = JSON.parse(xhr.responseText || '{}');
            } catch (err) {
              reject({ message: 'שגיאה בקריאת תגובת השרת', remove: true });
              return;
            }
            if (xhr.status < 200 || xhr.status >= 300 || !response.location) {
              reject({ message: response.error || 'העלאת התמונה נכשלה', remove: true });
              return;
            }
            resolve(response.location);
          };
          xhr.onerror = function () {
            reject({ message: 'שגיאת תקשורת בהעלאת התמונה', remove: true });
          };
          formData.append('image', blobInfo.blob(), blobInfo.filename());
          formData.append('purpose', 'event-description');
          xhr.send(formData);
        });
      },
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
