"use strict";

// Minimal PDF 1.4 writer — dependency-free, sufficient for evidence exports:
// Helvetica text (regular/bold), JPEG images via DCTDecode passthrough.
// Evidence images are always JPEG (uploads are sanitized by sharp), so no
// decoding is ever needed here.

const A4 = { width: 595, height: 842 };

/** Parse JPEG SOF marker for pixel dimensions (no decode). */
function jpegDimensions(buf) {
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) throw new Error("not a JPEG");
  let pos = 2;
  while (pos < buf.length - 9) {
    if (buf[pos] !== 0xff) { pos++; continue; }
    const marker = buf[pos + 1];
    // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
    }
    const len = buf.readUInt16BE(pos + 2);
    pos += 2 + len;
  }
  throw new Error("JPEG SOF marker not found");
}

const CHAR_MAP = {
  "—": "-", "–": "-", "‘": "'", "’": "'",
  "“": '"', "”": '"', "…": "...", "₦": "NGN ",
  " ": " ", "•": "*"
};

function escapeText(s) {
  return String(s)
    .replace(/[—–‘’“”…₦ •]/g, (c) => CHAR_MAP[c])
    .replace(/[^\x20-\x7E]/g, "?") // remaining non-ASCII → placeholder
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

class PdfDoc {
  constructor() {
    this.pages = []; // {ops: string[], images: Map<name, imageIndex>}
    this.images = []; // {buffer, width, height}
  }

  addPage() {
    const doc = this;
    const page = {
      ops: [],
      images: new Map(),
      /** @param {number} x left, {number} y baseline (PDF coords, origin bottom-left) */
      text(x, y, str, { size = 10, bold = false, gray = 0 } = {}) {
        const font = bold ? "/F2" : "/F1";
        page.ops.push(`BT ${font} ${size} Tf ${gray} g ${x} ${y} Td (${escapeText(str)}) Tj ET 0 g`);
        return page;
      },
      line(x1, y1, x2, y2, { grayStroke = 0.8 } = {}) {
        page.ops.push(`${grayStroke} G 0.5 w ${x1} ${y1} m ${x2} ${y2} l S 0 G`);
        return page;
      },
      /** Draw JPEG fitted (aspect-preserving) inside box; returns drawn height. */
      image(jpegBuffer, x, y, boxW, boxH) {
        const { width, height } = jpegDimensions(jpegBuffer);
        const scale = Math.min(boxW / width, boxH / height);
        const w = width * scale;
        const h = height * scale;
        let idx = doc.images.findIndex((im) => im.buffer === jpegBuffer);
        if (idx === -1) {
          doc.images.push({ buffer: jpegBuffer, width, height });
          idx = doc.images.length - 1;
        }
        const name = `/Im${idx}`;
        page.images.set(name, idx);
        // y is the TOP of the box; PDF places images from bottom-left
        page.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x} ${(y - h).toFixed(2)} cm ${name} Do Q`);
        return h;
      }
    };
    this.pages.push(page);
    return page;
  }

  /** @returns {Buffer} complete PDF file */
  render() {
    const objects = []; // 1-indexed bodies (Buffer)
    const add = (body) => { objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body)); return objects.length; };

    const fontRegular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    const fontBold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");

    const imageObjIds = this.images.map((im) =>
      add(Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.buffer.length} >>\nstream\n`
        ),
        im.buffer,
        Buffer.from("\nendstream")
      ]))
    );

    // Allocate content streams first, then page objects, then the page tree —
    // so the tree object id is known before pages reference it as /Parent.
    const pageObjIds = [];
    const contentObjIds = [];
    for (const page of this.pages) {
      const stream = page.ops.join("\n");
      contentObjIds.push(add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`));
    }
    const pageTreeId = objects.length + this.pages.length + 1;
    this.pages.forEach((page, i) => {
      const xobjects = [...page.images.entries()]
        .map(([name, idx]) => `${name} ${imageObjIds[idx]} 0 R`).join(" ");
      pageObjIds.push(add(
        `<< /Type /Page /Parent ${pageTreeId} 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] ` +
        `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >>` +
        (xobjects ? ` /XObject << ${xobjects} >>` : "") +
        ` >> /Contents ${contentObjIds[i]} 0 R >>`
      ));
    });
    const kids = pageObjIds.map((id) => `${id} 0 R`).join(" ");
    const actualTreeId = add(`<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`);
    if (actualTreeId !== pageTreeId) throw new Error("pdf writer internal: page tree id mismatch");
    const catalogId = add(`<< /Type /Catalog /Pages ${pageTreeId} 0 R >>`);

    // Serialize with xref
    const chunks = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
    let offset = chunks[0].length;
    const offsets = [0];
    objects.forEach((body, i) => {
      const head = Buffer.from(`${i + 1} 0 obj\n`);
      const tail = Buffer.from("\nendobj\n");
      offsets.push(offset);
      chunks.push(head, body, tail);
      offset += head.length + body.length + tail.length;
    });
    const xrefStart = offset;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objects.length; i++) {
      xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    }
    xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    chunks.push(Buffer.from(xref));
    return Buffer.concat(chunks);
  }
}

module.exports = { PdfDoc, jpegDimensions, A4 };
