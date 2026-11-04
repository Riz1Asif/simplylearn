const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const yauzl = require('yauzl');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

const MAX_SLIDES = 40;
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const JOB_TIMEOUT_MS = 120000;

class ConversionError extends Error {}
const invalidDeck = () => new ConversionError('This PPTX could not be read. Export it again, or upload a PDF.');

async function validateSource(filename, kind) {
  const handle = await fs.open(filename, 'r');
  try {
    const header = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    if ((await handle.stat()).size > MAX_DOCUMENT_BYTES) {
      throw new ConversionError('Presentations must be at most 25 MiB.');
    }
    if (kind === 'pdf' && !bytes.includes(Buffer.from('%PDF-'))) {
      throw new ConversionError('This file is not a readable PDF.');
    }
    if (kind === 'pptx' && !bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'))) {
      if (bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) {
        throw new ConversionError('Encrypted presentations are not supported. Upload an unprotected PPTX or PDF.');
      }
      throw invalidDeck();
    }
  } finally {
    await handle.close();
  }
}

function parseXml(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw invalidDeck();
  return new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: false }).parse(text);
}

// Inspect the archive without extracting teacher-controlled paths to disk.
function validatePptx(filename) {
  return new Promise((resolve, reject) => {
    yauzl.open(filename, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(invalidDeck());
      let total = 0;
      let xmlBytes = 0;
      let slides;
      let types;
      let done = false;
      const names = new Set();
      function fail(error) {
        if (done) return;
        done = true;
        zip.close();
        reject(error instanceof ConversionError ? error : invalidDeck());
      }
      zip.on('error', fail);
      zip.on('entry', entry => {
        total += entry.uncompressedSize;
        if (names.has(entry.fileName) || names.size >= 10000 ||
            entry.fileName.startsWith('/') || entry.fileName.split('/').includes('..') ||
            entry.generalPurposeBitFlag & 1 || total > MAX_EXPANDED_BYTES) {
          return fail(new ConversionError('This presentation is too large or contains an unsupported archive.'));
        }
        names.add(entry.fileName);
        if (/vbaProject|activeX/i.test(entry.fileName)) {
          return fail(new ConversionError('Macro-enabled or ActiveX presentations are not supported. Export a PDF instead.'));
        }
        const inspect = entry.fileName === 'ppt/presentation.xml' ||
          entry.fileName === '[Content_Types].xml' || entry.fileName.endsWith('.rels');
        if (!inspect) return zip.readEntry();
        xmlBytes += entry.uncompressedSize;
        if (entry.uncompressedSize > 2 * 1024 * 1024 || xmlBytes > 16 * 1024 * 1024) {
          return fail(new ConversionError('This presentation contains too much document metadata. Export a PDF instead.'));
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail(error);
          const chunks = [];
          let size = 0;
          stream.on('error', fail);
          stream.on('data', chunk => {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) {
              stream.destroy();
              return fail(invalidDeck());
            }
            chunks.push(chunk);
          });
          stream.on('end', () => {
            if (done) return;
            try {
              const parsed = parseXml(Buffer.concat(chunks).toString('utf8'));
              if (entry.fileName === 'ppt/presentation.xml') {
                const ids = parsed.presentation?.sldIdLst?.sldId;
                slides = ids ? (Array.isArray(ids) ? ids.length : 1) : 0;
              } else if (entry.fileName === '[Content_Types].xml') {
                types = parsed.Types;
              } else {
                const relations = parsed.Relationships?.Relationship || [];
                for (const relation of Array.isArray(relations) ? relations : [relations]) {
                  const external = String(relation['@_TargetMode']).toLowerCase() === 'external' ||
                    /^[a-z][a-z0-9+.-]*:|^\/\//i.test(String(relation['@_Target']));
                  if (external && !String(relation['@_Type']).endsWith('/hyperlink')) {
                    throw new ConversionError('Linked media is not supported. Embed the media or upload a PDF.');
                  }
                }
              }
              zip.readEntry();
            } catch (error) {
              fail(error);
            }
          });
        });
      });
      zip.on('end', () => {
        if (done) return;
        done = true;
        if (!types || !slides || !names.has('ppt/_rels/presentation.xml.rels')) return reject(invalidDeck());
        if (slides > MAX_SLIDES) return reject(new ConversionError('Presentations may contain at most 40 slides.'));
        resolve(slides);
      });
      zip.readEntry();
    });
  });
}

function runCommand(command, args, { cwd, signal, timeoutMs = JOB_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new ConversionError('Conversion cancelled.'));
    const env = {};
    // Keep proxy/CA routing intact, without exposing database credentials to parsers.
    for (const name of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
      'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'LD_LIBRARY_PATH']) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    Object.assign(env, { TMPDIR: cwd || '/tmp', SAL_USE_VCLPLUGIN: 'svp', SAL_DISABLE_OPENCL: '1' });
    const child = spawn('prlimit', ['--as=2147483648', '--cpu=90', '--fsize=67108864', '--nofile=256',
      '--', command, ...args], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    let failure;
    function stop(error) {
      failure = error;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure = error; }
      }
    }
    const abort = () => stop(signal.reason || new ConversionError('Conversion cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new ConversionError('Conversion took too long. Try a smaller deck or an exported PDF.')), timeoutMs);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length + errors.length > 65536) stop(new ConversionError('This document could not be processed safely.'));
    });
    child.stderr.on('data', chunk => {
      errors += chunk;
      if (output.length + errors.length > 65536) stop(new ConversionError('This document could not be processed safely.'));
    });
    child.on('error', () => { failure = new ConversionError('Presentation conversion is unavailable on this server.'); });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      if (code !== 0) {
        if (/password|encrypted/i.test(errors)) return reject(new ConversionError('Password-protected PDFs are not supported. Upload an unprotected PDF.'));
        if (code === 127 || /failed to execute|not found/i.test(errors)) {
          return reject(new ConversionError('Presentation conversion is unavailable on this server.'));
        }
        return reject(new ConversionError('This document could not be converted. Try exporting it as a PDF.'));
      }
      resolve(output);
    });
  });
}

async function convertPresentation(source, kind, runtime, { signal, onProgress = async () => {} } = {}) {
  await fs.mkdir(runtime, { recursive: true });
  await validateSource(source, kind);
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  const run = (command, args) => runCommand(command, args, {
    cwd: runtime, signal, timeoutMs: Math.max(1, deadline - Date.now())
  });
  let pdf = source;
  if (kind === 'pptx') {
    await validatePptx(source);
    const profile = path.join(runtime, 'profile');
    await fs.mkdir(path.join(profile, 'user'), { recursive: true });
    await fs.writeFile(path.join(profile, 'user/registrymodifications.xcu'),
      '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>');
    const filter = 'pdf:impress_pdf_Export:' + JSON.stringify({
      ExportHiddenSlides: { type: 'boolean', value: 'false' },
      ExportNotesPages: { type: 'boolean', value: 'false' },
      ExportOnlyNotesPages: { type: 'boolean', value: 'false' }
    });
    await run(process.env.SOFFICE_BIN || 'soffice', [
      '-env:UserInstallation=' + pathToFileURL(profile).href, '--headless', '--norestore',
      '--convert-to', filter, '--outdir', runtime, source
    ]);
    pdf = path.join(runtime, path.basename(source, '.pptx') + '.pdf');
    try { await fs.access(pdf); } catch { throw new ConversionError('This presentation could not be rendered. Try exporting it as a PDF.'); }
  }
  const info = await run(process.env.PDFINFO_BIN || 'pdfinfo', [pdf]);
  if (/^Encrypted:\s+yes/im.test(info)) throw new ConversionError('Encrypted PDFs are not supported. Upload an unprotected PDF.');
  const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
  if (!pages || pages > MAX_SLIDES) throw new ConversionError('Presentations must contain between 1 and 40 visible slides.');
  const imageDirectory = path.join(runtime, 'images');
  await fs.mkdir(imageDirectory);
  const images = [];
  let bytes = 0;
  for (let page = 1; page <= pages; page++) {
    const prefix = 'slide-' + String(page).padStart(3, '0');
    await run(process.env.PDFTOPPM_BIN || 'pdftoppm', ['-f', String(page), '-l', String(page),
      '-singlefile', '-scale-to', '1600', '-jpeg', '-jpegopt', 'quality=82', pdf, path.join(imageDirectory, prefix)]);
    const name = prefix + '.jpg';
    const stat = await fs.stat(path.join(imageDirectory, name));
    bytes += stat.size;
    if (!stat.size || bytes > MAX_OUTPUT_BYTES) throw new ConversionError('The converted slides are too large. Try a smaller presentation.');
    images.push(name);
    await onProgress(page, pages);
  }
  return { imageDirectory, images };
}

module.exports = { ConversionError, MAX_DOCUMENT_BYTES, convertPresentation, validateSource, validatePptx, runCommand };
