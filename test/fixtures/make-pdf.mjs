// Generates the PDF fixtures. Two documents: a plain one for the basics, and a
// "complex" one carrying the layout cases that make read-aloud segmentation
// hard — a title in a larger face, headings with no terminating punctuation,
// a hyphenated line break, bullets, paragraph gaps and abbreviations.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PLAIN = [
  [
    { text: 'Reading Machines' },
    { text: 'A spoken document is a sequence of sentences. The reader should know' },
    { text: 'which one it is on. Highlighting the current sentence keeps the eye and' },
    { text: 'the ear together. Without it, listeners lose their place within seconds.' },
    { text: 'Dr. Ada Lovelace wrote about this in 1843, roughly. It still holds.' },
  ],
  [
    { text: 'Page Two' },
    { text: 'Sentences may wrap across several lines of a page, which means a single' },
    { text: 'highlight can need more than one rectangle. Short ones do not.' },
    { text: 'Is that clear? Yes! Good.' },
  ],
];

const COMPLEX = [
  [
    { text: 'On the Segmentation of Spoken Documents', size: 20, leading: 30 },
    { text: 'A. Researcher and B. Collaborator', size: 11, leading: 26 },
    { text: 'Abstract', size: 13, leading: 26 },
    { text: 'Reading a document aloud requires deciding where one utterance ends', size: 10, leading: 14 },
    { text: 'and the next begins. Prior work by Knuth et al. treats the problem as', size: 10, leading: 14 },
    { text: 'a purely typographic one. We show that layout carries information', size: 10, leading: 14 },
    { text: 'that punctuation alone does not, particularly around unpunctu-', size: 10, leading: 14 },
    { text: 'ated headings. See Fig. 2 for an overview of the pipeline.', size: 10, leading: 14 },
    { text: '1  Introduction', size: 13, leading: 32 },
    { text: 'The contributions of this paper are as follows:', size: 10, leading: 18 },
    { text: '• A line-level model of paragraph structure.', size: 10, leading: 16, indent: 14 },
    { text: '• A mapping from characters back to page geometry.', size: 10, leading: 14, indent: 14 },
    { text: '• An evaluation on 400 documents, described in Sec. 4.', size: 10, leading: 14, indent: 14 },
    { text: 'The remainder is organised as follows. Section 2 reviews prior work.', size: 10, leading: 24 },
    { text: 'Section 3 gives the method, and Sec. 4 the evaluation.', size: 10, leading: 14 },
  ],
];

function esc(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Map the few non-Latin-1 characters the fixtures use onto WinAnsiEncoding.
const WIN_ANSI = { '•': '\\225', '—': '\\227', '–': '\\226', '’': '\\222' };

function encode(text) {
  return esc(text).replace(/[•—–’]/g, (c) => WIN_ANSI[c] ?? '?');
}

function contentStream(lines) {
  const out = ['BT'];
  let y = 740;
  let size = 0;
  for (const line of lines) {
    const lineSize = line.size ?? 14;
    const leading = line.leading ?? 18;
    y -= leading;
    if (lineSize !== size) {
      out.push(`/F1 ${lineSize} Tf`);
      size = lineSize;
    }
    out.push(`1 0 0 1 ${72 + (line.indent ?? 0)} ${y} Tm`);
    out.push(`(${encode(line.text)}) Tj`);
  }
  out.push('ET');
  return out.join('\n');
}

export function buildPdf(pages) {
  const objects = [];
  const add = (body) => objects.push(body);
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');

  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  for (const lines of pages) {
    const stream = contentStream(lines);
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`
    );
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [name, pages] of [['sample.pdf', PLAIN], ['complex.pdf', COMPLEX]]) {
    const out = new URL(`./${name}`, import.meta.url);
    writeFileSync(out, buildPdf(pages));
    console.log('wrote', fileURLToPath(out));
  }
}
