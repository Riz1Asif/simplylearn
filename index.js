const express = require('express');
const { createServer } = require('node:http');
const { Server } = require('socket.io');
const { randomBytes, randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const { open } = require('node:fs/promises');
const bodyParser = require('body-parser');
const multer = require('multer');
const mongoose = require('mongoose');
const path = require('node:path');
const fs = require('fs-extra');
const formatMessage = require('./utils/messages');
const { userJoin, getCurrentUser, userLeave, getRoom } = require('./utils/users');
const Teacher = require('./models/teacher');

const app = express();
const http = createServer(app);
const io = new Server(http);
const uploadRoot = path.join(__dirname, 'uploads');
const hashToken = token => createHash('sha256').update(token).digest('hex');
const cookieName = id => 'teacher_' + id;
const roomActions = new Map();

// Keep joins, slide updates and termination ordered within each classroom.
function inRoom(room, action) {
  const pending = (roomActions.get(room) || Promise.resolve()).catch(() => {}).then(action);
  roomActions.set(room, pending);
  const cleanup = () => { if (roomActions.get(room) === pending) roomActions.delete(room); };
  pending.then(cleanup, cleanup);
  return pending;
}

function isOwner(cookies, classroom) {
  if (!classroom.ownerTokenHash || typeof cookies !== 'string') return false;
  const prefix = cookieName(classroom._id) + '=';
  const cookie = cookies.split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
  if (!cookie) return false;
  const token = cookie.slice(prefix.length);
  if (!/^[a-f0-9]{64}$/.test(token)) return false;
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(classroom.ownerTokenHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const directory = path.join(uploadRoot, req.classroomId);
    fs.ensureDir(directory).then(() => cb(null, directory), cb);
  },
  filename(req, file, cb) {
    cb(null, randomUUID() + (file.mimetype === 'image/png' ? '.png' : '.jpg'));
  }
});

const uploads = multer({
  storage,
  limits: { fieldSize: 1024, fields: 2, fileSize: 5 * 1024 * 1024, files: 40 },
  fileFilter(req, file, cb) {
    if (file.mimetype !== 'image/png' && file.mimetype !== 'image/jpeg') {
      return cb(Object.assign(new Error('Only PNG and JPEG slides are supported.'), { status: 400 }));
    }
    cb(null, true);
  }
}).array('pptimages', 40);

async function validImage(file) {
  const handle = await open(file.path, 'r');
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return file.mimetype === 'image/png'
      ? bytesRead === 8 && header.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytesRead >= 3 && header[0] === 255 && header[1] === 216 && header[2] === 255;
  } finally {
    await handle.close();
  }
}

app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadRoot, {
  setHeaders(res) { res.setHeader('X-Content-Type-Options', 'nosniff'); }
}));
app.use('/assets', express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'views')));

app.get('/', (req, res) => res.render('index'));
app.get('/teacher', (req, res) => res.render('teacher'));
app.get('/student', (req, res) => res.render('student'));
app.get('/info', (req, res) => res.render('info'));
app.get('/donation', (req, res) => res.render('donation'));

app.post('/teacher', (req, res) => {
  req.classroomId = new mongoose.Types.ObjectId().toString();
  uploads(req, res, async uploadError => {
    try {
      if (uploadError) throw uploadError;
      const name = req.body?.name;
      const classname = req.body?.classname;
      if (typeof name !== 'string' || !name.trim() || name.length > 100 ||
          typeof classname !== 'string' || !classname.trim() || classname.length > 200 ||
          !req.files?.length) {
        throw Object.assign(new Error('A teacher name, class name and at least one slide are required.'), { status: 400 });
      }
      for (const file of req.files) {
        if (!await validImage(file)) {
          throw Object.assign(new Error('A slide is not a valid PNG or JPEG image.'), { status: 400 });
        }
      }
      const token = randomBytes(32).toString('hex');
      const saved = await Teacher.create({
        _id: req.classroomId,
        name: name.trim(),
        classname: classname.trim(),
        ownerTokenHash: hashToken(token),
        currentSlide: 1,
        pptimages: req.files.map(file => path.posix.join('uploads', req.classroomId, file.filename))
      });
      res.cookie(cookieName(saved._id), token, {
        httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/',
        maxAge: 30 * 24 * 60 * 60 * 1000
      });
      res.redirect('/teacher/' + saved._id);
    } catch (error) {
      await fs.remove(path.join(uploadRoot, req.classroomId)).catch(cleanupError => console.error(cleanupError));
      const status = error instanceof multer.MulterError ? 400 : error.status || 500;
      if (status === 500) console.error(error);
      res.status(status).send(status === 500 ? 'Unable to create the classroom.' : error.message);
    }
  });
});

async function loadClassroom(req, res, next) {
  try {
    if (!mongoose.isObjectIdOrHexString(req.params.id)) return res.redirect('/teacher');
    const data = await Teacher.findById(req.params.id).select('+ownerTokenHash');
    if (!data) return res.redirect('/teacher');
    req.classroom = data;
    next();
  } catch (error) {
    next(error);
  }
}

function requireTeacher(req, res, next) {
  if (!isOwner(req.headers.cookie, req.classroom)) {
    return res.status(403).send('Only the classroom creator can access teacher controls.');
  }
  res.setHeader('Cache-Control', 'no-store');
  next();
}

const renderClassroom = view => (req, res) => res.render(view, { data: req.classroom });
app.get('/teacher/:id', loadClassroom, requireTeacher, renderClassroom('linkshare'));
app.get('/session/:id/teacher', loadClassroom, requireTeacher, renderClassroom('presentation-page-teacher'));
app.get('/session/:id/recordteacher', loadClassroom, requireTeacher, renderClassroom('working-on-this'));
app.get('/session/:id', loadClassroom, renderClassroom('presentation-page-student'));

app.post('/session/:id/teacher', loadClassroom, requireTeacher, async (req, res, next) => {
  try {
    const id = req.classroom._id.toString();
    await inRoom(id, async () => {
      await Teacher.deleteOne({ _id: id });
      io.to(id).emit('sessionEnded');
      for (const user of getRoom(id)) userLeave(user.id);
      io.in(id).socketsLeave(id);
      // Never derive deletion paths from the display name, including legacy records.
      await fs.remove(path.join(uploadRoot, id));
    });
    res.clearCookie(cookieName(id), { path: '/' });
    res.redirect('/');
  } catch (error) {
    next(error);
  }
});

io.on('connection', socket => {
  let joins = Promise.resolve();
  const reply = (ack, value) => { if (typeof ack === 'function') ack(value); };
  const notifyDeparture = user => {
    if (!user) return;
    io.to(user.room).emit('deadUser', user.username);
    io.to(user.room).emit('userList', getRoom(user.room));
  };

  socket.on('joinRoom', (payload, ack) => {
    joins = joins.then(async () => {
      if (!payload || typeof payload !== 'object' ||
          typeof payload.username !== 'string' || !payload.username.trim() ||
          payload.username.length > 100 || typeof payload.room !== 'string' ||
          !/^[a-f0-9]{24}$/.test(payload.room)) {
        return reply(ack, { ok: false, error: 'Invalid classroom or participant name.' });
      }
      return inRoom(payload.room, async () => {
        const classroom = await Teacher.findById(payload.room).select('+ownerTokenHash');
        if (!classroom) return reply(ack, { ok: false, error: 'This classroom no longer exists.' });
        if (!socket.connected) return;
        const previous = getCurrentUser(socket.id);
        const sameRoom = previous?.room === payload.room;
        if (previous && !sameRoom) {
          await socket.leave(previous.room);
          userLeave(socket.id);
          notifyDeparture(previous);
        }
        await socket.join(payload.room);
        if (!socket.connected) return;
        const role = isOwner(socket.request.headers.cookie, classroom) ? 'teacher' : 'student';
        const user = userJoin(socket.id, payload.username.trim(), payload.room, role);
        if (!sameRoom) io.to(user.room).emit('newUser', user.username);
        io.to(user.room).emit('userList', getRoom(user.room));
        // The room queue keeps this snapshot ordered with teacher updates.
        const currentSlide = classroom.currentSlide || 1;
        socket.emit('changeslide', currentSlide);
        reply(ack, { ok: true, role, currentSlide });
      });
    }).catch(error => {
      console.error(error);
      reply(ack, { ok: false, error: 'Unable to join the classroom.' });
    });
  });

  socket.on('currentslide', async (n, ack) => {
    try {
      const user = getCurrentUser(socket.id);
      if (!user || user.role !== 'teacher') {
        return reply(ack, { ok: false, error: 'Only the teacher can change the shared slide.' });
      }
      if (!Number.isSafeInteger(n) || n < 1) {
        return reply(ack, { ok: false, error: 'Invalid slide number.' });
      }
      await inRoom(user.room, async () => {
        const classroom = await Teacher.findById(user.room).select('+ownerTokenHash');
        if (!classroom || !isOwner(socket.request.headers.cookie, classroom) ||
            n > classroom.pptimages.length || getCurrentUser(socket.id) !== user) {
          return reply(ack, { ok: false, error: 'Invalid classroom or slide number.' });
        }
        await Teacher.updateOne({ _id: user.room }, { $set: { currentSlide: n } });
        io.to(user.room).emit('changeslide', n);
        reply(ack, { ok: true });
      });
    } catch (error) {
      console.error(error);
      reply(ack, { ok: false, error: 'Unable to change the slide.' });
    }
  });

  socket.on('chatMessage', (msg, ack) => {
    const user = getCurrentUser(socket.id);
    if (!user || typeof msg !== 'string' || !msg.trim() || msg.length > 2000) {
      return reply(ack, { ok: false, error: 'Enter a message of at most 2000 characters.' });
    }
    io.to(user.room).emit('message', formatMessage(user.username, msg.trim()));
    reply(ack, { ok: true });
  });

  socket.on('disconnect', () => notifyDeparture(userLeave(socket.id)));
});

async function start(port = process.env.PORT || 1690) {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/simplylearn';
  await mongoose.connect(uri);
  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, () => {
      http.off('error', reject);
      console.log('Running on ' + http.address().port);
      resolve(http);
    });
  });
}

if (require.main === module) {
  start().catch(() => {
    console.error('Unable to start the server. Check MongoDB connectivity and PORT.');
    io.close();
    mongoose.disconnect().finally(() => { process.exitCode = 1; });
  });
}

module.exports = { app, http, io, start };
