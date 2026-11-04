(function () {
  const form = document.getElementById('teacher-form');
  const input = document.getElementById('myFile');
  const message = document.getElementById('upload-status');
  window.addEventListener('pageshow', () => {
    form.querySelector('input[type=submit]').disabled = false;
    message.hidden = true;
  });
  form.addEventListener('submit', event => {
    const files = [...input.files];
    const documents = files.filter(file => /\.(pptx|pdf)$/i.test(file.name));
    message.hidden = false;
    if (documents.length && (documents.length !== 1 || files.length !== 1)) {
      event.preventDefault();
      message.textContent = 'Choose one PPTX/PDF, or a set of slide images. Upload them separately.';
      return;
    }
    const documentUpload = documents.length === 1;
    const limit = (documentUpload ? 25 : 5) * 1024 * 1024;
    if (files.length > 40 || files.some(file => file.size > limit)) {
      event.preventDefault();
      message.textContent = documentUpload ? 'The presentation must be at most 25 MiB.' :
        'Choose at most 40 images, at most 5 MiB each.';
      return;
    }
    form.action = documentUpload ? '/teacher/presentation' : '/teacher';
    message.textContent = documentUpload ? 'Uploading your presentation…' : 'Uploading your slides…';
    form.querySelector('input[type=submit]').disabled = true;
  });
})();
