(function () {
  const text = document.getElementById('copytext');
  text.textContent = window.location.origin + text.dataset.sessionPath;
  document.getElementById('copy-link').addEventListener('click', async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text.textContent);
      } else {
        const input = document.createElement('textarea');
        input.value = text.textContent;
        document.body.appendChild(input);
        input.select();
        const copied = document.execCommand('copy');
        input.remove();
        if (!copied) throw new Error('Copy failed');
      }
      document.getElementById('copy-link').textContent = 'Copied';
    } catch (_) {
      document.getElementById('copy-link').textContent = 'Select the link to copy';
    }
  });
})();
