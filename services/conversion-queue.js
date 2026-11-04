const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const Teacher = require('../models/teacher');
const { ConversionError, convertPresentation } = require('./presentations');

class ConversionQueue {
  constructor({ uploadRoot, workRoot, convert = convertPresentation }) {
    Object.assign(this, { uploadRoot, workRoot, convert });
    this.pending = [];
    this.active = null;
    this.draining = null;
    this.stopping = false;
  }

  async resume() {
    await fs.mkdir(this.workRoot, { recursive: true });
    await Teacher.updateMany({ status: 'processing' }, {
      $set: { status: 'queued', convertedSlides: 0, totalSlides: 0 }
    });
    const jobs = await Teacher.find({ status: 'queued', sourceType: { $in: ['pptx', 'pdf'] } }).sort({ _id: 1 });
    for (const job of jobs) this.enqueue(job._id.toString());
  }

  enqueue(id) {
    if (this.stopping || this.active?.id === id || this.pending.includes(id)) return;
    this.pending.push(id);
    this.kick();
  }

  kick() {
    if (!this.draining && !this.stopping && this.pending.length) {
      this.draining = this.drain().finally(() => {
        this.draining = null;
        this.kick();
      });
    }
  }

  async drain() {
    while (!this.stopping && this.pending.length) {
      const id = this.pending.shift();
      const controller = new AbortController();
      const active = { id, controller };
      this.active = active;
      active.promise = this.run(id, controller.signal);
      await active.promise;
      this.active = null;
    }
  }

  async run(id, signal) {
    const directory = path.join(this.workRoot, id);
    const runtime = path.join(directory, 'run-' + randomUUID());
    let retainSource = false;
    try {
      const job = await Teacher.findOneAndUpdate({ _id: id, status: 'queued' }, {
        $set: { status: 'processing', conversionError: '', convertedSlides: 0, totalSlides: 0 }
      }, { returnDocument: 'after' });
      if (!job) return;
      signal.throwIfAborted();
      // A crash may have published files just before saving the ready state.
      await fs.rm(path.join(this.uploadRoot, id), { recursive: true, force: true });
      const source = path.join(directory, 'source.' + job.sourceType);
      const result = await this.convert(source, job.sourceType, runtime, {
        signal,
        onProgress: async (page, total) => {
          await Teacher.updateOne({ _id: id, status: 'processing' }, {
            $set: { convertedSlides: page, totalSlides: total }
          });
        }
      });
      signal.throwIfAborted();
      await fs.mkdir(this.uploadRoot, { recursive: true });
      await fs.rename(result.imageDirectory, path.join(this.uploadRoot, id));
      const ready = await Teacher.updateOne({ _id: id, status: 'processing' }, {
        $set: { status: 'ready', currentSlide: 1, conversionError: '',
          convertedSlides: result.images.length, totalSlides: result.images.length,
          pptimages: result.images.map(name => path.posix.join('uploads', id, name)) }
      });
      if (!ready.modifiedCount) await fs.rm(path.join(this.uploadRoot, id), { recursive: true, force: true });
    } catch (error) {
      retainSource = this.stopping && signal.aborted;
      if (!signal.aborted && !(error instanceof ConversionError)) {
        console.error('Presentation conversion failed:', error.code || error.name);
      }
      try {
        const current = await Teacher.findById(id).select('status');
        // A successful ready write can be followed by a lost DB acknowledgement.
        if (current?.status === 'ready') {
          retainSource = false;
          return;
        }
        if (!current) retainSource = false;
        await Teacher.updateOne({ _id: id, status: 'processing' }, { $set: retainSource
          ? { status: 'queued', convertedSlides: 0, totalSlides: 0 }
          : { status: 'failed', conversionError: error instanceof ConversionError ? error.message :
            'This presentation could not be converted. Try an exported PDF or upload images.' } });
        await fs.rm(path.join(this.uploadRoot, id), { recursive: true, force: true });
      } catch (databaseError) {
        // Keep the original so startup recovery can retry after a database outage.
        retainSource = true;
        console.error('Unable to save conversion state:', databaseError.name);
      }
    } finally {
      await fs.rm(retainSource ? runtime : directory, { recursive: true, force: true }).catch(error => {
        console.error('Unable to clean conversion files:', error.code);
      });
    }
  }

  async cancel(id) {
    this.pending = this.pending.filter(queued => queued !== id);
    if (this.active?.id === id) {
      this.active.controller.abort(new ConversionError('Conversion cancelled.'));
      await this.active.promise;
    }
  }

  async stop() {
    this.stopping = true;
    this.active?.controller.abort(new ConversionError('Conversion interrupted.'));
    await this.draining;
  }
}

module.exports = { ConversionQueue };
