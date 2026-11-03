(function (root, factory) {
  const ui = factory();
  if (typeof module === 'object' && module.exports) module.exports = ui;
  else root.ClassroomUI = ui;
})(typeof window === 'undefined' ? globalThis : window, function () {
  function createSlides(document, onNavigate) {
    const slides = document.getElementsByClassName('mySlides');
    const dots = document.getElementsByClassName('demo');
    let index = 1;
    function show(value) {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || !slides.length) return;
      index = ((n - 1) % slides.length + slides.length) % slides.length + 1;
      for (let i = 0; i < slides.length; i++) {
        slides[i].style.display = i === index - 1 ? 'block' : 'none';
        if (dots[i]) dots[i].classList.toggle('active', i === index - 1);
      }
      const caption = document.getElementById('caption');
      if (caption) caption.textContent = dots[index - 1]?.alt || '';
    }
    function select(value) {
      if (!Number.isSafeInteger(Number(value)) || !slides.length) return;
      show(value);
      if (onNavigate) onNavigate(index);
    }
    show(1);
    return {
      show, select,
      next(delta) { if (Number.isSafeInteger(Number(delta))) select(index + Number(delta)); },
      current() { return index; }
    };
  }

  function appendMessage(document, message) {
    const div = document.createElement('div');
    div.className = 'messages';
    const paragraph = document.createElement('p');
    paragraph.className = 'lead';
    const author = document.createElement('span');
    author.style.color = 'cornflowerblue';
    author.textContent = message.username;
    const time = document.createElement('span');
    time.style.fontSize = '0.5rem';
    time.textContent = message.time || '';
    paragraph.append(author, document.createTextNode(' '), time,
      document.createTextNode(': ' + message.text));
    div.appendChild(paragraph);
    const messages = document.getElementById('txtmsg');
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  function appendNotice(document, text) {
    const div = document.createElement('div');
    div.className = 'messages';
    div.textContent = text;
    document.getElementById('txtmsg').appendChild(div);
  }

  function renderUsers(document, users) {
    const list = document.getElementById('list');
    if (!list) return;
    list.replaceChildren();
    users.forEach((user, i) => {
      const item = document.createElement('li');
      item.className = 'nav-item';
      const link = document.createElement('a');
      link.className = 'nav-link';
      link.href = '#';
      const label = document.createElement('span');
      label.className = 'link-text';
      label.textContent = '(' + (i + 1) + ') ' + user.username;
      link.appendChild(label);
      item.appendChild(link);
      list.appendChild(item);
    });
  }

  function start(options = {}) {
    const document = window.document;
    const teacher = options.teacher === true;
    const room = document.getElementById('session_id').textContent.trim();
    let username = teacher ? document.getElementById('username').textContent.trim() : '';
    let joined = false;
    const socket = window.io();
    const notice = text => appendNotice(document, text);
    const slides = createSlides(document, teacher ? n => {
      if (joined) socket.emit('currentslide', n, result => {
        if (!result.ok) notice(result.error);
      });
    } : undefined);

    function join() {
      if (!username || !socket.connected) return;
      socket.emit('joinRoom', { username, room }, result => {
        joined = result.ok;
        if (!joined) return notice(result.error);
        slides.show(result.currentSlide);
        if (!teacher) {
          document.getElementById('screen1').style.display = 'none';
          document.getElementById('slideDisp').style.display = 'block';
        }
      });
    }
    socket.on('connect', join);
    socket.on('disconnect', () => { joined = false; });
    socket.on('changeslide', n => slides.show(n));
    socket.on('newUser', name => notice(name + ' joined'));
    socket.on('deadUser', name => notice(name + ' disconnected'));
    socket.on('userList', users => renderUsers(document, users));
    socket.on('message', message => appendMessage(document, message));
    socket.on('sessionEnded', () => window.location.assign('/'));
    if (socket.connected) join();

    window.plusSlides = n => slides.next(n);
    window.currentSlide = n => slides.select(n);
    window.openForm = () => {
      document.getElementById('myForm').style.display = 'block';
      const color = document.getElementById('chat-color');
      if (color) color.style.backgroundColor = '#555';
    };
    window.closeForm = () => { document.getElementById('myForm').style.display = 'none'; };
    if (!teacher) {
      window.Userfn = () => {
        username = document.getElementById('username').value.trim() || 'guest';
        join();
      };
      document.getElementById('nameform').addEventListener('submit', event => {
        event.preventDefault();
        window.Userfn();
      });
    }
    document.getElementById('chatForm').addEventListener('submit', event => {
      event.preventDefault();
      const input = document.getElementById('message');
      if (!joined || !input.value.trim()) return;
      socket.emit('chatMessage', input.value, result => {
        if (!result.ok) return notice(result.error);
        input.value = '';
        input.focus();
      });
    });
    document.addEventListener('keydown', event => {
      if (event.target?.closest('input, textarea, select, [contenteditable]')) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        slides.next(event.key === 'ArrowLeft' ? -1 : 1);
      }
    });
    return { socket, slides };
  }

  return { createSlides, appendMessage, appendNotice, renderUsers, start };
});
