const assert = require('node:assert/strict');
const { describe, it, before, after, afterEach } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const mongoose = require('mongoose');
const { io: connectSocket } = require('socket.io-client');
const { JSDOM } = require('jsdom');

process.env.MONGODB_URI = process.env.TEST_MONGODB_URI ||
  'mongodb://127.0.0.1:27017/simplylearn_test';
const { start, io, conversions } = require('../index');
const { makePptx, makePdf } = require('../test-support/presentations.cjs');
const { ConversionQueue } = require('../services/conversion-queue');
const Teacher = require('../models/teacher');
const { getRoom } = require('../utils/users');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
const root = path.join(__dirname, '..');
const uiSource = require('node:fs').readFileSync(path.join(root, 'public/classroom.js'), 'utf8');

describe('classroom HTTP, realtime and browser regressions', { timeout: 60000 }, () => {
  let base;
  let main;
  const classrooms = [];
  const sockets = [];
  const windows = [];

  function request(url, options = {}) {
    return fetch(base + url, { signal: AbortSignal.timeout(10000), ...options });
  }
  async function waitUntil(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for classroom state');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  async function createClass(name = 'Regression teacher', { count = 3, fileFirst = false } = {}) {
    const form = new FormData();
    const images = () => {
      for (let i = 0; i < count; i++) {
        form.append('pptimages', new Blob([png], { type: 'image/png' }), 'same-name.png');
      }
    };
    if (fileFirst) images();
    form.append('name', name);
    form.append('classname', 'Regression classroom');
    if (!fileFirst) images();
    const response = await request('/teacher', { method: 'POST', body: form, redirect: 'manual' });
    assert.equal(response.status, 302, await response.text());
    const id = response.headers.get('location').split('/').pop();
    const cookie = response.headers.getSetCookie()[0].split(';')[0];
    const classroom = { id, cookie, directory: path.join(root, 'uploads', id) };
    classrooms.push(classroom);
    return classroom;
  }
  async function uploadPresentation(bytes, extension = 'pdf') {
    const form = new FormData();
    form.append('name', 'Presentation teacher');
    form.append('classname', 'Automatic conversion');
    form.append('pptimages', new Blob([bytes], { type: extension === 'pdf' ? 'application/pdf' :
      'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), 'deck.' + extension);
    const response = await request('/teacher/presentation', { method: 'POST', body: form, redirect: 'manual' });
    assert.equal(response.status, 302, await response.text());
    const id = response.headers.get('location').split('/').pop();
    const cookie = response.headers.getSetCookie()[0].split(';')[0];
    const item = { id, cookie, directory: path.join(root, 'uploads', id) };
    classrooms.push(item);
    return item;
  }
  async function converted(item, expected = 'ready') {
    const deadline = Date.now() + 30000;
    for (;;) {
      const response = await request('/teacher/' + item.id + '/status', { headers: { Cookie: item.cookie } });
      assert.equal(response.status, 200);
      const data = await response.json();
      if (data.status === expected) return data;
      if (data.status === 'failed') assert.fail(data.error);
      if (Date.now() > deadline) assert.fail('Timed out waiting for conversion');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  function event(socket, name, predicate = () => true) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off(name, listener);
        reject(new Error('Timed out waiting for ' + name));
      }, 3000);
      function listener(value) {
        if (!predicate(value)) return;
        clearTimeout(timer);
        socket.off(name, listener);
        resolve(value);
      }
      socket.on(name, listener);
    });
  }
  function ack(socket, name, value) {
    return socket.timeout(3000).emitWithAck(name, value);
  }
  async function connect(cookie) {
    const socket = connectSocket(base, {
      transports: ['websocket'], forceNew: true, reconnection: false, timeout: 3000,
      extraHeaders: cookie ? { Cookie: cookie } : {}
    });
    sockets.push(socket);
    await event(socket, 'connect');
    return socket;
  }
  async function join(cookie, room = main.id, username = 'Participant') {
    const socket = await connect(cookie);
    const result = await ack(socket, 'joinRoom', { username, room });
    assert.equal(result.ok, true);
    return { socket, result };
  }
  async function domFor(url, cookie) {
    const response = await request(url, { headers: cookie ? { Cookie: cookie } : {} });
    assert.equal(response.status, 200);
    const dom = new JSDOM(await response.text(), { url: base + url, runScripts: 'outside-only' });
    windows.push(dom.window);
    dom.window.eval(uiSource);
    return dom;
  }

  before(async () => {
    const server = await start(0);
    base = 'http://127.0.0.1:' + server.address().port;
    main = await createClass();
  });
  afterEach(async () => {
    await conversions.draining;
    for (const window of windows.splice(0)) window.close();
    for (const socket of sockets.splice(0)) socket.close();
    await waitUntil(() => classrooms.every(item => getRoom(item.id).length === 0));
  });
  after(async () => {
    await conversions.stop();
    for (const socket of sockets) socket.close();
    for (const item of classrooms) {
      await Teacher.deleteOne({ _id: item.id });
      await fs.rm(item.directory, { recursive: true, force: true });
      await fs.rm(path.join(root, '.conversion-jobs', item.id), { recursive: true, force: true });
    }
    await new Promise(resolve => io.close(resolve));
    await mongoose.disconnect();
  });

  it('connects to MongoDB and renders the five public pages', async () => {
    assert.equal((await mongoose.connection.db.admin().ping()).ok, 1);
    for (const [url, text] of [
      ['/', /Simplylearn/], ['/teacher', /pptimages/], ['/student', /Student/],
      ['/info', /Simplylearn/i], ['/donation', /donat/i]
    ]) {
      const response = await request(url);
      assert.equal(response.status, 200);
      assert.match(await response.text(), text);
    }
  });

  it('serves the browser scripts and local stylesheets', async () => {
    for (const url of ['/teacherstyle.css', '/coroclas.css', '/socket.io/socket.io.js',
      '/assets/classroom.js', '/assets/share.js']) {
      const response = await request(url);
      assert.equal(response.status, 200, url);
      assert.ok((await response.text()).length > 100);
    }
  });

  it('stores each slide under its classroom ID with a unique generated filename', async () => {
    const data = await Teacher.findById(main.id).lean();
    assert.equal(data.pptimages.length, 3);
    assert.equal(new Set(data.pptimages).size, 3);
    assert.equal(data.ownerTokenHash, undefined);
    for (const image of data.pptimages) {
      assert.ok(image.startsWith('uploads/' + main.id + '/'));
      assert.match(path.basename(image), /^[a-f0-9-]+\.png$/);
      const response = await request('/' + image);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    }
    const secured = await Teacher.findById(main.id).select('+ownerTokenHash');
    assert.equal(secured.ownerTokenHash.length, 64);
    assert.notEqual(secured.ownerTokenHash, main.cookie.split('=')[1]);
  });

  it('accepts files before form fields without using the display name as a path', async () => {
    const original = await fs.readFile(path.join(root, 'utils/messages.js'));
    const item = await createClass('../utils', { fileFirst: true });
    const data = await Teacher.findById(item.id);
    assert.ok(data.pptimages.every(image => image.startsWith('uploads/' + item.id + '/')));
    assert.deepEqual(await fs.readFile(path.join(root, 'utils/messages.js')), original);
    const response = await request('/session/' + item.id + '/teacher', {
      method: 'POST', headers: { Cookie: item.cookie }, redirect: 'manual'
    });
    assert.equal(response.status, 302);
    assert.deepEqual(await fs.readFile(path.join(root, 'utils/messages.js')), original);
  });

  it('keeps same-name classrooms isolated when one is terminated', async () => {
    const a = await createClass('Same teacher');
    const b = await createClass('Same teacher');
    const images = (await Teacher.findById(b.id)).pptimages;
    const response = await request('/session/' + a.id + '/teacher', {
      method: 'POST', headers: { Cookie: a.cookie }, redirect: 'manual'
    });
    assert.equal(response.status, 302);
    assert.ok(await Teacher.findById(b.id));
    for (const image of images) {
      assert.equal((await request('/' + image)).status, 200);
    }
    await assert.rejects(fs.access(a.directory), { code: 'ENOENT' });
  });

  it('rejects empty uploads, unsupported types, fake images and oversized files without leftovers', async () => {
    const before = (await fs.readdir(path.join(root, 'uploads'))).sort();
    assert.equal((await request('/teacher', { method: 'POST' })).status, 400);
    for (const file of [
      null,
      { type: 'text/plain', bytes: Buffer.from('not an image') },
      { type: 'image/png', bytes: Buffer.from('not actually a PNG') },
      { type: 'image/png', bytes: Buffer.alloc(5 * 1024 * 1024 + 1) }
    ]) {
      const form = new FormData();
      form.append('name', 'Invalid upload');
      form.append('classname', 'Must not be saved');
      if (file) form.append('pptimages', new Blob([file.bytes], { type: file.type }), 'slide.png');
      const response = await request('/teacher', { method: 'POST', body: form, redirect: 'manual' });
      assert.equal(response.status, 400);
    }
    assert.deepEqual((await fs.readdir(path.join(root, 'uploads'))).sort(), before);
  });

  it('restricts teacher pages and termination to the creating browser', async () => {
    for (const url of ['/teacher/' + main.id, '/session/' + main.id + '/teacher',
      '/session/' + main.id + '/recordteacher']) {
      assert.equal((await request(url)).status, 403);
      assert.equal((await request(url, { headers: { Cookie: main.cookie } })).status, 200);
    }
    assert.equal((await request('/session/' + main.id)).status, 200);
    const another = await createClass('Different owner');
    for (const cookie of [undefined, another.cookie, main.cookie.replace(/.$/, 'x')]) {
      const response = await request('/session/' + main.id + '/teacher', {
        method: 'POST', redirect: 'manual', headers: cookie ? { Cookie: cookie } : {}
      });
      assert.equal(response.status, 403);
    }
    assert.ok(await Teacher.findById(main.id));
    assert.ok((await fs.readdir(main.directory)).length > 0);
  });

  it('rejects malformed joins without crashing or adding participants', async () => {
    const socket = await connect();
    for (const payload of [null, [], {}, 'room', { room: main.id, username: {} },
      { room: '../room', username: 'Student' }, { room: main.id, username: '' },
      { room: main.id, username: 'x'.repeat(101) }]) {
      assert.equal((await ack(socket, 'joinRoom', payload)).ok, false);
    }
    assert.equal((await ack(socket, 'joinRoom', {
      room: new mongoose.Types.ObjectId().toString(), username: 'Missing room'
    })).ok, false);
    assert.equal(socket.connected, true);
    assert.equal((await request('/')).status, 200);
    assert.equal(getRoom(main.id).length, 0);
  });

  it('keeps legacy classrooms viewable without allowing anyone to claim their controls', async () => {
    const data = await Teacher.create({ name: 'Legacy teacher', classname: 'Legacy classroom',
      pptimages: (await Teacher.findById(main.id)).pptimages });
    const id = data._id.toString();
    classrooms.push({ id, directory: path.join(root, 'uploads', id) });
    assert.equal((await request('/session/' + id)).status, 200);
    assert.equal((await request('/session/' + id + '/teacher', {
      headers: { Cookie: main.cookie }
    })).status, 403);
    const participant = await join(main.cookie, id);
    assert.equal(participant.result.role, 'student');
    assert.equal((await ack(participant.socket, 'currentslide', 2)).ok, false);
  });

  it('makes repeated joins idempotent and removes participants on disconnect', async () => {
    const { socket } = await join(undefined, main.id, 'Repeated');
    for (let i = 0; i < 3; i++) {
      assert.equal((await ack(socket, 'joinRoom', { username: 'Repeated', room: main.id })).ok, true);
    }
    assert.equal(getRoom(main.id).length, 1);
    socket.disconnect();
    await waitUntil(() => getRoom(main.id).length === 0);
  });

  it('leaves the old room when a socket switches classrooms', async () => {
    const another = await createClass();
    const { socket } = await join();
    await ack(socket, 'joinRoom', { username: 'Moved', room: another.id });
    assert.equal(getRoom(main.id).length, 0);
    assert.equal(getRoom(another.id).length, 1);
  });

  it('allows only the authenticated teacher to change an in-range shared slide', async () => {
    const owner = await join(main.cookie, main.id, 'Teacher');
    const student = await join(undefined, main.id, 'Teacher');
    assert.equal(owner.result.role, 'teacher');
    assert.equal(student.result.role, 'student');
    assert.equal((await ack(student.socket, 'currentslide', 2)).ok, false);
    for (const n of [null, {}, '2', 0, -1, 4, 1.5]) {
      assert.equal((await ack(owner.socket, 'currentslide', n)).ok, false);
    }
    const changed = event(student.socket, 'changeslide', n => n === 3);
    assert.equal((await ack(owner.socket, 'currentslide', 3)).ok, true);
    assert.equal(await changed, 3);
    assert.equal((await Teacher.findById(main.id)).currentSlide, 3);
  });

  it('sends the saved current slide to a late participant', async () => {
    const owner = await join(main.cookie);
    await ack(owner.socket, 'currentslide', 2);
    const late = await join();
    assert.equal(late.result.currentSlide, 2);
  });

  it('lets students skim privately until the teacher next changes the shared slide', async () => {
    const item = await createClass('Independent browsing', { count: 4 });
    async function openPage(teacher, username) {
      const url = '/session/' + item.id + (teacher ? '/teacher' : '');
      const dom = await domFor(url, teacher ? item.cookie : undefined);
      const socket = connectSocket(base, {
        autoConnect: false, forceNew: true, transports: ['websocket'], reconnection: false,
        extraHeaders: teacher ? { Cookie: item.cookie } : {}
      });
      sockets.push(socket);
      dom.window.io = () => socket;
      const ui = dom.window.ClassroomUI.start({ teacher });
      if (!teacher) {
        dom.window.document.getElementById('username').value = username;
        dom.window.Userfn();
      }
      socket.connect();
      await waitUntil(() => teacher
        ? getRoom(item.id).some(user => user.id === socket.id)
        : dom.window.document.getElementById('screen1').style.display === 'none');
      return { window: dom.window, ...ui };
    }
    const teacher = await openPage(true);
    const alice = await openPage(false, 'Alice');
    const bob = await openPage(false, 'Bob');
    await waitUntil(() => teacher.window.document.getElementById('list').textContent.includes('Bob'));

    function visibleSlide(page) {
      const slides = [...page.window.document.querySelectorAll('.mySlides')];
      assert.equal(slides.filter(slide => slide.style.display === 'block').length, 1);
      return slides.findIndex(slide => slide.style.display === 'block') + 1;
    }
    const views = () => [teacher, alice, bob].map(visibleSlide);
    const teacherUpdates = [];
    let studentBroadcasts = 0;
    for (const student of [alice, bob]) {
      student.socket.onAnyOutgoing(name => { if (name === 'currentslide') studentBroadcasts++; });
    }
    teacher.socket.on('changeslide', n => teacherUpdates.push(n));
    assert.deepEqual(views(), [1, 1, 1]);

    teacher.window.plusSlides(1);
    await waitUntil(() => views().every(n => n === 2));
    assert.deepEqual(views(), [2, 2, 2]);

    alice.window.currentSlide(4);
    bob.window.document.body.dispatchEvent(new bob.window.KeyboardEvent('keydown', {
      key: 'ArrowLeft', bubbles: true
    }));
    assert.deepEqual(views(), [2, 4, 1]);
    const chat = event(alice.socket, 'message', message => message.text === 'Still browsing');
    await ack(bob.socket, 'chatMessage', 'Still browsing');
    await chat;
    assert.deepEqual(views(), [2, 4, 1]);
    assert.equal((await Teacher.findById(item.id)).currentSlide, 2);
    assert.equal(studentBroadcasts, 0);
    assert.deepEqual(teacherUpdates, [2]);

    teacher.window.plusSlides(1);
    await waitUntil(() => views().every(n => n === 3));
    assert.deepEqual(views(), [3, 3, 3]);
    assert.equal((await Teacher.findById(item.id)).currentSlide, 3);
    assert.equal(studentBroadcasts, 0);
    assert.deepEqual(teacherUpdates, [2, 3]);
  });

  it('orders rapid teacher changes and exposes the final slide to late joins', async () => {
    const owner = await join(main.cookie);
    await Promise.all([1, 2, 3].map(n => ack(owner.socket, 'currentslide', n)));
    assert.equal((await join()).result.currentSlide, 3);
    assert.equal((await Teacher.findById(main.id)).currentSlide, 3);
  });

  it('exchanges chat only within a classroom and rejects malformed messages', async () => {
    const otherClass = await createClass();
    const owner = await join(main.cookie);
    const student = await join();
    const other = await join(undefined, otherClass.id);
    let leaked = false;
    other.socket.on('message', () => { leaked = true; });
    const message = event(owner.socket, 'message');
    assert.equal((await ack(student.socket, 'chatMessage', 'Hello classroom')).ok, true);
    const received = await message;
    assert.equal(received.text, 'Hello classroom');
    assert.match(received.time, /\d{1,2}:\d{2} [ap]m/);
    for (const invalid of [null, {}, '', 'x'.repeat(2001)]) {
      assert.equal((await ack(student.socket, 'chatMessage', invalid)).ok, false);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(leaked, false);
  });

  it('restores the browser participant and current slide after reconnecting', async () => {
    const owner = await join(main.cookie);
    await ack(owner.socket, 'currentslide', 3);
    const dom = await domFor('/session/' + main.id);
    const browserSocket = connectSocket(base, { autoConnect: false, forceNew: true,
      transports: ['websocket'], reconnection: false });
    sockets.push(browserSocket);
    dom.window.io = () => browserSocket;
    const ui = dom.window.ClassroomUI.start();
    dom.window.document.getElementById('username').value = 'Reconnecting student';
    dom.window.Userfn();
    browserSocket.connect();
    await waitUntil(() => getRoom(main.id).length === 2);
    await waitUntil(() => ui.slides.current() === 3);
    browserSocket.disconnect();
    await waitUntil(() => getRoom(main.id).length === 1);
    await ack(owner.socket, 'currentslide', 2);
    browserSocket.connect();
    await waitUntil(() => getRoom(main.id).length === 2);
    await waitUntil(() => ui.slides.current() === 2);
    assert.equal(dom.window.document.getElementById('screen1').style.display, 'none');
  });

  it('navigates numeric and string thumbnail indices, including previous and wraparound', async () => {
    const dom = await domFor('/session/' + main.id + '/teacher', main.cookie);
    const emitted = [];
    const controller = dom.window.ClassroomUI.createSlides(dom.window.document, n => emitted.push(n));
    controller.select('2');
    controller.next(1);
    assert.equal(controller.current(), 3);
    controller.next(1);
    assert.equal(controller.current(), 1);
    controller.next(-1);
    assert.equal(controller.current(), 3);
    controller.select('2');
    controller.next(-1);
    assert.equal(controller.current(), 1);
    assert.deepEqual(emitted, [2, 3, 1, 3, 2, 1]);
    assert.equal(dom.window.document.querySelectorAll('.mySlides[style*="block"]').length, 1);
    assert.equal(dom.window.document.querySelectorAll('.demo.active').length, 1);
  });

  it('restores teacher controls on reconnect without resetting the saved slide', async () => {
    const owner = await join(main.cookie);
    await ack(owner.socket, 'currentslide', 3);
    owner.socket.disconnect();
    await waitUntil(() => getRoom(main.id).length === 0);
    const dom = await domFor('/session/' + main.id + '/teacher', main.cookie);
    const browserSocket = connectSocket(base, { autoConnect: false, forceNew: true,
      transports: ['websocket'], reconnection: false, extraHeaders: { Cookie: main.cookie } });
    sockets.push(browserSocket);
    dom.window.io = () => browserSocket;
    const ui = dom.window.ClassroomUI.start({ teacher: true });
    browserSocket.connect();
    await waitUntil(() => ui.slides.current() === 3);
    let changed = event(browserSocket, 'changeslide', n => n === 2);
    dom.window.currentSlide('2');
    await changed;
    changed = event(browserSocket, 'changeslide', n => n === 3);
    dom.window.plusSlides(1);
    await changed;
    const input = dom.window.document.getElementById('message');
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    assert.equal(ui.slides.current(), 3);
    browserSocket.disconnect();
    await waitUntil(() => getRoom(main.id).length === 0);
    ui.slides.show(1);
    browserSocket.connect();
    await waitUntil(() => getRoom(main.id).length === 1 && ui.slides.current() === 3);
    assert.equal((await Teacher.findById(main.id)).currentSlide, 3);
  });

  it('renders malicious chat, names and notices as text instead of executable markup', () => {
    const dom = new JSDOM('<div id="txtmsg"></div><ul id="list"></ul>', { runScripts: 'outside-only' });
    windows.push(dom.window);
    dom.window.eval(uiSource);
    const payload = '<img src=x onerror="window.injected=true"><script>window.injected=true</script>';
    const document = dom.window.document;
    dom.window.ClassroomUI.appendMessage(document, { username: payload, text: payload, time: payload });
    dom.window.ClassroomUI.appendNotice(document, payload + ' joined');
    dom.window.ClassroomUI.renderUsers(document, [{ username: payload }]);
    assert.equal(document.querySelectorAll('img,script,[onerror]').length, 0);
    assert.ok(document.getElementById('txtmsg').textContent.includes(payload));
    assert.ok(document.getElementById('list').textContent.includes(payload));
    assert.equal(dom.window.injected, undefined);
  });

  it('copies a student link for the current origin without submitting the form', async () => {
    const dom = await domFor('/teacher/' + main.id, main.cookie);
    let copied;
    dom.window.document.execCommand = command => {
      assert.equal(command, 'copy');
      copied = dom.window.document.querySelector('textarea').value;
      return true;
    };
    dom.window.eval(await fs.readFile(path.join(root, 'public/share.js'), 'utf8'));
    const button = dom.window.document.getElementById('copy-link');
    assert.equal(button.type, 'button');
    button.click();
    assert.equal(copied, base + '/session/' + main.id);
    assert.equal(dom.window.document.getElementById('copytext').textContent, copied);
    assert.equal(button.textContent, 'Copied');
  });

  it('redirects missing classroom IDs without errors', async () => {
    for (const id of [new mongoose.Types.ObjectId().toString(), 'not-an-id']) {
      for (const suffix of ['', '/teacher', '/recordteacher']) {
        const response = await request('/session/' + id + suffix, { redirect: 'manual' });
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('location'), '/teacher');
      }
    }
  });

  it('terminates a classroom, notifies viewers and removes only its files and participants', async () => {
    const item = await createClass();
    const viewer = await join(undefined, item.id);
    const ended = event(viewer.socket, 'sessionEnded');
    const response = await request('/session/' + item.id + '/teacher', {
      method: 'POST', headers: { Cookie: item.cookie }, redirect: 'manual'
    });
    assert.equal(response.status, 302);
    await ended;
    assert.equal(await Teacher.findById(item.id), null);
    assert.equal(getRoom(item.id).length, 0);
    await assert.rejects(fs.access(item.directory), { code: 'ENOENT' });
    assert.equal((await ack(viewer.socket, 'chatMessage', 'After termination')).ok, false);
    assert.ok(await Teacher.findById(main.id));
  });

  it('converts a PDF upload to ordered private-source classroom slides', async () => {
    const item = await uploadPresentation(makePdf(12));
    const state = await converted(item);
    assert.equal(state.totalSlides, 12);
    const data = await Teacher.findById(item.id);
    assert.equal(data.pptimages.length, 12);
    assert.ok(data.pptimages[9].endsWith('/slide-010.jpg'));
    assert.equal(data.sourceType, 'pdf');
    const image = await request('/' + data.pptimages[0]);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    for (const privatePath of ['/uploads/' + item.id + '/source.pdf', '/.conversion-jobs/' + item.id + '/source.pdf']) {
      assert.equal((await request(privatePath)).status, 404);
    }
    await conversions.draining;
    await assert.rejects(fs.access(path.join(root, '.conversion-jobs', item.id)), { code: 'ENOENT' });
    const owner = await join(item.cookie, item.id);
    assert.equal((await ack(owner.socket, 'currentslide', 12)).ok, true);
    assert.equal((await join(undefined, item.id)).result.currentSlide, 12);
  });

  it('converts a PPTX upload and excludes hidden slides and notes pages', async () => {
    const item = await uploadPresentation(await makePptx(4, { hidden: 1, notes: true }), 'pptx');
    await converted(item);
    const data = await Teacher.findById(item.id);
    assert.equal(data.pptimages.length, 3);
    assert.equal(data.sourceType, 'pptx');
    const ownerPage = await request('/teacher/' + item.id, { headers: { Cookie: item.cookie } });
    assert.match(await ownerPage.text(), /Start Session/);
  });

  it('reports corrupt and over-limit document failures without publishing partial slides', async () => {
    for (const [bytes, extension, expected] of [
      [Buffer.from('PK\u0003\u0004broken archive'), 'pptx', /could not be read/],
      [makePdf(41), 'pdf', /between 1 and 40/]
    ]) {
      const item = await uploadPresentation(bytes, extension);
      const state = await converted(item, 'failed');
      assert.match(state.error, expected);
      assert.equal((await Teacher.findById(item.id)).pptimages.length, 0);
      assert.equal((await request('/session/' + item.id)).status, 409);
      await conversions.draining;
      await assert.rejects(fs.access(item.directory), { code: 'ENOENT' });
      await assert.rejects(fs.access(path.join(root, '.conversion-jobs', item.id)), { code: 'ENOENT' });
    }
  });

  it('rejects invalid signatures, mixed document uploads and files larger than 25 MiB', async () => {
    for (const files of [
      [{ bytes: Buffer.from('not a PDF'), name: 'fake.pdf', type: 'application/pdf' }],
      [{ bytes: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(25 * 1024 * 1024)]), name: 'large.pdf', type: 'application/pdf' }],
      [{ bytes: makePdf(), name: 'deck.pdf', type: 'application/pdf' }, { bytes: png, name: 'image.png', type: 'image/png' }]
    ]) {
      const form = new FormData();
      form.append('name', 'Invalid presentation');
      form.append('classname', 'Must not be saved');
      for (const file of files) form.append('pptimages', new Blob([file.bytes], { type: file.type }), file.name);
      assert.equal((await request('/teacher/presentation', { method: 'POST', body: form })).status, 400);
    }
    assert.equal(await Teacher.countDocuments({ name: 'Invalid presentation' }), 0);
  });

  it('keeps conversions private, queues one worker, and lets the owner cancel queued or active work', async () => {
    const original = conversions.convert;
    let release;
    let activeSignal;
    let calls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    conversions.convert = async (source, kind, runtime, options) => {
      calls++;
      activeSignal = options.signal;
      await new Promise((resolve, reject) => {
        const abort = () => reject(options.signal.reason);
        options.signal.addEventListener('abort', abort, { once: true });
        gate.then(() => { options.signal.removeEventListener('abort', abort); resolve(); });
      });
      return original(source, kind, runtime, options);
    };
    let first;
    let second;
    try {
      first = await uploadPresentation(makePdf());
      await waitUntil(() => !!activeSignal);
      second = await uploadPresentation(makePdf());
      assert.equal((await Teacher.findById(second.id)).status, 'queued');
      assert.equal(calls, 1);
      assert.equal((await request('/teacher/' + first.id + '/status')).status, 403);
      const page = await request('/teacher/' + first.id, { headers: { Cookie: first.cookie } });
      assert.match(await page.text(), /Preparing your classroom/);
      assert.equal((await request('/session/' + first.id)).status, 409);
      const viewer = await connect();
      assert.equal((await ack(viewer, 'joinRoom', { room: first.id, username: 'Too early' })).ok, false);
      assert.equal((await request('/session/' + first.id + '/teacher', { method: 'POST' })).status, 403);
      for (const item of [second, first]) {
        const response = await request('/session/' + item.id + '/teacher', {
          method: 'POST', headers: { Cookie: item.cookie }, redirect: 'manual'
        });
        assert.equal(response.status, 302);
        assert.equal(await Teacher.findById(item.id), null);
        await assert.rejects(fs.access(path.join(root, '.conversion-jobs', item.id)), { code: 'ENOENT' });
      }
      assert.equal(activeSignal.aborted, true);
      assert.equal(calls, 1);
    } finally {
      release();
      conversions.convert = original;
      if (first) await conversions.cancel(first.id);
      if (second) await conversions.cancel(second.id);
    }
  });

  it('recovers an interrupted persisted conversion on startup', async () => {
    const data = await Teacher.create({ name: 'Restart test', classname: 'Resume conversion',
      status: 'processing', sourceType: 'pdf' });
    const id = data._id.toString();
    const temporary = await fs.mkdtemp('/tmp/simplylearn-recovery-test-');
    const worker = new ConversionQueue({ uploadRoot: path.join(temporary, 'uploads'), workRoot: path.join(temporary, 'jobs') });
    classrooms.push({ id, directory: path.join(temporary, 'uploads', id) });
    try {
      await fs.mkdir(path.join(temporary, 'jobs', id), { recursive: true });
      await fs.writeFile(path.join(temporary, 'jobs', id, 'source.pdf'), makePdf(2));
      await fs.mkdir(path.join(temporary, 'uploads', id), { recursive: true });
      await fs.writeFile(path.join(temporary, 'uploads', id, 'stale.jpg'), 'interrupted publication');
      await worker.resume();
      await worker.draining;
      const ready = await Teacher.findById(id);
      assert.equal(ready.status, 'ready');
      assert.equal(ready.pptimages.length, 2);
      await fs.access(path.join(temporary, 'uploads', id, 'slide-002.jpg'));
      await assert.rejects(fs.access(path.join(temporary, 'uploads', id, 'stale.jpg')), { code: 'ENOENT' });
      await assert.rejects(fs.access(path.join(temporary, 'jobs', id)), { code: 'ENOENT' });
    } finally {
      await worker.stop();
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });

  it('retains the private source on graceful shutdown and finishes it after restart', async () => {
    const temporary = await fs.mkdtemp('/tmp/simplylearn-shutdown-test-');
    const data = await Teacher.create({ name: 'Graceful restart', classname: 'Retained source',
      sourceType: 'pdf', status: 'queued' });
    const id = data._id.toString();
    const roots = { uploadRoot: path.join(temporary, 'uploads'), workRoot: path.join(temporary, 'jobs') };
    let began;
    const started = new Promise(resolve => { began = resolve; });
    const worker = new ConversionQueue({ ...roots, convert: (source, kind, runtime, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        began();
      }) });
    const restarted = new ConversionQueue(roots);
    classrooms.push({ id, directory: path.join(roots.uploadRoot, id) });
    try {
      await fs.mkdir(path.join(roots.workRoot, id), { recursive: true });
      const source = path.join(roots.workRoot, id, 'source.pdf');
      await fs.writeFile(source, makePdf(2));
      worker.enqueue(id);
      await started;
      await worker.stop();
      assert.equal((await Teacher.findById(id)).status, 'queued');
      await fs.access(source);
      await restarted.resume();
      await restarted.draining;
      assert.equal((await Teacher.findById(id)).status, 'ready');
      await fs.access(path.join(roots.uploadRoot, id, 'slide-002.jpg'));
    } finally {
      await worker.stop();
      await restarted.stop();
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });
});
