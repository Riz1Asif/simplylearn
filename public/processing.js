(function () {
  const state = document.getElementById('conversion-state');
  const message = document.getElementById('conversion-message');
  const progress = document.getElementById('conversion-progress');
  const classroom = '/teacher/' + state.dataset.classroomId;
  let timer;
  async function poll() {
    try {
      const response = await fetch(classroom + '/status', { cache: 'no-store', credentials: 'same-origin' });
      if (response.status === 403) {
        message.textContent = 'Open this classroom in the browser that uploaded it.';
        progress.hidden = true;
        return;
      }
      if (!response.ok) throw new Error('Status unavailable');
      const data = await response.json();
      if (data.status === 'ready') return window.location.replace(classroom);
      if (data.status === 'failed') {
        message.textContent = data.error || 'Conversion failed. Try uploading a PDF or slide images.';
        progress.hidden = true;
        return;
      }
      if (data.status === 'queued') {
        message.textContent = 'Your presentation is waiting to be converted.';
        progress.removeAttribute('value');
      } else if (data.totalSlides) {
        message.textContent = 'Preparing slide ' + data.convertedSlides + ' of ' + data.totalSlides + '…';
        progress.value = data.convertedSlides;
        progress.max = data.totalSlides;
      } else {
        message.textContent = 'Converting your presentation…';
        progress.removeAttribute('value');
      }
    } catch (_) {
      message.textContent = 'Waiting for the server. Your page will check again shortly…';
    }
    timer = window.setTimeout(poll, 1500);
  }
  window.addEventListener('pagehide', () => window.clearTimeout(timer));
  if (state.dataset.status !== 'failed') poll();
})();
