const fs = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');

async function makePptx(count = 3, { hidden = -1, notes = false } = {}) {
  // Clone a generated, single-slide Office Open XML fixture with a real master/theme.
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(__dirname, 'slide-template.pptx')));
  const read = name => zip.file(name).async('string');
  const slide = await read('ppt/slides/slide1.xml');
  const slideRels = await read('ppt/slides/_rels/slide1.xml.rels');
  const note = (await read('ppt/notesSlides/notesSlide1.xml')).replace('PRIVATE TEACHER NOTES: do not share.',
    notes ? 'PRIVATE TEACHER NOTES: do not share.' : '');
  const noteRels = await read('ppt/notesSlides/_rels/notesSlide1.xml.rels');
  let presentation = await read('ppt/presentation.xml');
  let relations = (await read('ppt/_rels/presentation.xml.rels'))
    .replace(/<Relationship [^>]*Type="[^"]*\/slide"[^>]*\/>/g, '');
  let types = (await read('[Content_Types].xml'))
    .replace(/<Override PartName="\/ppt\/(slides\/slide|notesSlides\/notesSlide)1.xml"[^>]*\/>/g, '');
  const ids = [];
  for (let i = 0; i < count; i++) {
    const n = i + 1;
    const rid = 'testSlide' + n;
    ids.push('<p:sldId id="' + (256 + i) + '" r:id="' + rid + '"/>');
    let xml = slide.replaceAll('Slide 1', 'Slide ' + n);
    if (i === hidden) xml = xml.replace('<p:sld ', '<p:sld show="0" ');
    zip.file('ppt/slides/slide' + n + '.xml', xml);
    zip.file('ppt/slides/_rels/slide' + n + '.xml.rels', slideRels.replace('notesSlide1.xml', 'notesSlide' + n + '.xml'));
    zip.file('ppt/notesSlides/notesSlide' + n + '.xml', note);
    zip.file('ppt/notesSlides/_rels/notesSlide' + n + '.xml.rels', noteRels.replace('slides/slide1.xml', 'slides/slide' + n + '.xml'));
    relations = relations.replace('</Relationships>', '<Relationship Id="' + rid +
      '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' + n + '.xml"/></Relationships>');
    for (const [part, type] of [['slides/slide', 'slide'], ['notesSlides/notesSlide', 'notesSlide']]) {
      types = types.replace('</Types>', '<Override PartName="/ppt/' + part + n +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.' + type + '+xml"/></Types>');
    }
  }
  presentation = presentation.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, '<p:sldIdLst>' + ids.join('') + '</p:sldIdLst>');
  zip.file('ppt/presentation.xml', presentation);
  zip.file('ppt/_rels/presentation.xml.rels', relations);
  zip.file('[Content_Types].xml', types);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function makePdf(count = 3) {
  const objects = [];
  const font = 3 + count * 2;
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [' + Array.from({ length: count }, (_, i) =>
    (3 + i * 2) + ' 0 R').join(' ') + '] /Count ' + count + ' >>');
  for (let i = 0; i < count; i++) {
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Resources << /Font << /F1 ' +
      font + ' 0 R >> >> /Contents ' + (4 + i * 2) + ' 0 R >>');
    const stream = 'BT /F1 36 Tf 100 300 Td (Slide ' + (i + 1) + ') Tj ET';
    objects.push('<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream');
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let result = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(result));
    result += (i + 1) + ' 0 obj\n' + object + '\nendobj\n';
  });
  const xref = Buffer.byteLength(result);
  result += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  result += offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  result += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(result);
}

module.exports = { makePptx, makePdf };
