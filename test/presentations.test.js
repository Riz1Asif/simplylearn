const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');
const { makePptx, makePdf } = require('../test-support/presentations.cjs');
const { convertPresentation, validatePptx, validateSource, runCommand } = require('../services/presentations');

describe('presentation parser and renderer', { timeout: 60000 }, () => {
  let root;
  let original;
  let sequence = 0;
  before(async () => {
    root = await fs.mkdtemp('/tmp/simplylearn-presentation-tests-');
    original = await makePptx();
  });
  after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  async function file(buffer, extension = 'pptx') {
    const filename = path.join(root, 'source-' + (++sequence) + '.' + extension);
    await fs.writeFile(filename, buffer);
    return filename;
  }
  async function edit(change) {
    const zip = await JSZip.loadAsync(original);
    await change(zip);
    return file(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  }

  it('validates a real PPTX and rejects fake or encrypted sources', async () => {
    const filename = await file(original);
    await validateSource(filename, 'pptx');
    assert.equal(await validatePptx(filename), 3);
    await assert.rejects(validateSource(await file(Buffer.from('not PPTX')), 'pptx'), /could not be read/);
    await assert.rejects(validateSource(await file(Buffer.from('d0cf11e0a1b11ae1', 'hex')), 'pptx'), /Encrypted/);
    await assert.rejects(validateSource(await file(Buffer.from('not PDF'), 'pdf'), 'pdf'), /not a readable PDF/);
  });

  it('rejects malformed XML and archive paths without extracting them', async () => {
    await assert.rejects(validatePptx(await edit(zip => zip.file('ppt/presentation.xml', '<broken>'))), /could not be read/);
    await assert.rejects(validatePptx(await edit(zip => zip.file('../outside.txt', 'outside'))), /could not be read|unsupported archive/);
    await assert.rejects(validatePptx(await edit(zip => zip.file('ppt/presentation.xml',
      '<!DOCTYPE x [<!ENTITY y "value">]><presentation/>'))), /could not be read/);
  });

  it('bounds expanded archive size and XML metadata size', async () => {
    const zip = Buffer.from(await fs.readFile(await edit(() => {})));
    const central = zip.indexOf(Buffer.from('504b0102', 'hex'));
    assert.ok(central >= 0);
    zip.writeUInt32LE(300 * 1024 * 1024, central + 24);
    await assert.rejects(validatePptx(await file(zip)), /too large|could not be read/);
    await assert.rejects(validatePptx(await edit(zip => zip.file('ppt/presentation.xml',
      ' '.repeat(2 * 1024 * 1024 + 1)))), /metadata/);
  });

  it('rejects macros and external media while allowing ordinary hyperlinks', async () => {
    await assert.rejects(validatePptx(await edit(zip => zip.file('ppt/vbaProject.bin', 'macro'))), /Macro-enabled/);
    async function relationship(type) {
      return edit(async zip => {
        const name = 'ppt/_rels/presentation.xml.rels';
        const xml = await zip.file(name).async('string');
        zip.file(name, xml.replace('</Relationships>', '<Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/' +
          type + '" Target="https://example.invalid/asset" TargetMode="External"/></Relationships>'));
      });
    }
    await assert.rejects(validatePptx(await relationship('image')), /Linked media/);
    assert.equal(await validatePptx(await relationship('hyperlink')), 3);
  });

  it('rejects more than forty PPTX slides and PDF pages', async () => {
    await assert.rejects(validatePptx(await file(await makePptx(41))), /at most 40/);
    await assert.rejects(convertPresentation(await file(makePdf(41), 'pdf'), 'pdf',
      path.join(root, 'too-many-pages')), /between 1 and 40/);
  });

  it('renders only visible PPTX slides and excludes presenter notes', async () => {
    const source = await file(await makePptx(4, { hidden: 1, notes: true }));
    const runtime = path.join(root, 'pptx-render');
    const result = await convertPresentation(source, 'pptx', runtime);
    assert.deepEqual(result.images, ['slide-001.jpg', 'slide-002.jpg', 'slide-003.jpg']);
    const pdf = path.join(runtime, path.basename(source, '.pptx') + '.pdf');
    const text = await runCommand('pdftotext', [pdf, '-'], { cwd: runtime });
    assert.match(text, /Slide 1/);
    assert.match(text, /Slide 3/);
    assert.match(text, /Slide 4/);
    assert.doesNotMatch(text, /Slide 2|PRIVATE TEACHER NOTES/);
  });

  it('renders PDF pages in numerical order with bounded image dimensions', async () => {
    const result = await convertPresentation(await file(makePdf(12), 'pdf'), 'pdf', path.join(root, 'pdf-render'));
    assert.equal(result.images.length, 12);
    assert.equal(result.images[1], 'slide-002.jpg');
    assert.equal(result.images[9], 'slide-010.jpg');
    for (const name of result.images) {
      const image = await fs.readFile(path.join(result.imageDirectory, name));
      assert.equal(image.subarray(0, 2).toString('hex'), 'ffd8');
      assert.ok(image.length < 500000);
      let foundDimensions = false;
      for (let offset = 2; offset + 9 < image.length;) {
        assert.equal(image[offset], 255);
        const marker = image[offset + 1];
        if ([0xc0, 0xc1, 0xc2].includes(marker)) {
          const height = image.readUInt16BE(offset + 5);
          const width = image.readUInt16BE(offset + 7);
          assert.ok(width > 0 && height > 0 && Math.max(width, height) <= 1600);
          assert.ok(Math.abs(width / height - 16 / 9) < 0.01);
          foundDimensions = true;
          break;
        }
        offset += image.readUInt16BE(offset + 2) + 2;
      }
      assert.equal(foundDimensions, true);
    }
  });

  it('rejects a real password-protected PDF with a helpful error', async () => {
    await assert.rejects(convertPresentation(path.join(__dirname, '../test-support/encrypted.pdf'),
      'pdf', path.join(root, 'encrypted')), /[Pp]assword|[Ee]ncrypted/);
  });

  it('terminates converters on timeout and cancellation', async () => {
    await assert.rejects(runCommand('/bin/sh', ['-c', 'sleep 10'], { cwd: root, timeoutMs: 50 }), /too long/);
    const controller = new AbortController();
    const running = runCommand('/bin/sh', ['-c', 'sleep 10'], { cwd: root, signal: controller.signal });
    controller.abort(new Error('test cancellation'));
    await assert.rejects(running, /test cancellation/);
  });
});
