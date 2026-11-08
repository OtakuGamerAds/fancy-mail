/**
 * Tiny, valid files for the demo attachments, written from scratch: a one-page PDF with
 * Helvetica text, a PNG, a CSV and an iCalendar invite.
 */
import zlib from "node:zlib";

export interface PdfLine {
  text: string;
  size?: number;
  bold?: boolean;
  /** Extra space before the line, in points. */
  gap?: number;
  /** Right-aligned column text on the same line. */
  right?: string;
}

/** WinAnsi bytes for a string (umlauts, ß, € and the usual punctuation survive). */
function winAnsi(text: string): Buffer {
  const map: Record<string, number> = { "€": 0x80, "–": 0x96, "—": 0x97, "„": 0x84, "“": 0x93, "”": 0x94, "‘": 0x91, "’": 0x92, "•": 0x95, "…": 0x85 };
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (map[ch] !== undefined) bytes.push(map[ch]);
    else if (code < 256) bytes.push(code);
    else bytes.push(0x3f); // "?"
  }
  return Buffer.from(bytes);
}

function pdfString(text: string): Buffer {
  const raw = winAnsi(text);
  const out: number[] = [0x28];
  for (const b of raw) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c);
    out.push(b);
  }
  out.push(0x29);
  return Buffer.from(out);
}

/** Rough Helvetica width (points) for right-aligning amounts. */
function textWidth(text: string, size: number): number {
  let units = 0;
  for (const ch of text) units += /[0-9]/.test(ch) ? 556 : /[.,: ]/.test(ch) ? 278 : /[A-Z€]/.test(ch) ? 667 : 520;
  return (units / 1000) * size;
}

export function makePdf(title: string, lines: PdfLine[]): Buffer {
  const parts: Buffer[] = [];
  let y = 790;
  for (const line of lines) {
    const size = line.size ?? 10;
    y -= (line.gap ?? 0) + size * 1.45;
    const font = line.bold ? "/F2" : "/F1";
    parts.push(Buffer.from(`BT ${font} ${size} Tf 56 ${y.toFixed(1)} Td `), pdfString(line.text), Buffer.from(" Tj ET\n"));
    if (line.right) {
      const x = 540 - textWidth(line.right, size);
      parts.push(Buffer.from(`BT ${font} ${size} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td `), pdfString(line.right), Buffer.from(" Tj ET\n"));
    }
  }
  // A thin rule under the header block.
  parts.push(Buffer.from("0.6 w 56 742 m 540 742 l S\n"));
  const content = Buffer.concat(parts);

  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    ),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]),
    Buffer.concat([Buffer.from("<< /Title "), pdfString(title), Buffer.from(" /Producer (Fancy Mail demo) >>")]),
  ];

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
    chunks.push(chunk);
    offset += chunk.length;
  });
  const xref = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>`,
    "startxref",
    String(offset),
    "%%EOF",
    "",
  ].join("\n");
  chunks.push(Buffer.from(xref));
  return Buffer.concat(chunks);
}

/** A small RGB PNG drawn by `pixel(x, y) → [r, g, b]`. */
export function makePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
    return Buffer.concat([len, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function makeCsv(rows: (string | number)[][]): Buffer {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // German bank exports: semicolons, and a BOM so spreadsheet apps read the umlauts.
  return Buffer.from(`﻿${rows.map((r) => r.map(cell).join(";")).join("\r\n")}\r\n`, "utf8");
}

function icsDate(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function makeIcs(input: { uid: string; title: string; start: number; minutes: number; organizer: string; location: string }): Buffer {
  return Buffer.from(
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Fancy Mail demo//EN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      `UID:${input.uid}`,
      `DTSTAMP:${icsDate(input.start - 86_400_000)}`,
      `DTSTART:${icsDate(input.start)}`,
      `DTEND:${icsDate(input.start + input.minutes * 60_000)}`,
      `SUMMARY:${input.title}`,
      `LOCATION:${input.location}`,
      `ORGANIZER:mailto:${input.organizer}`,
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n"),
    "utf8",
  );
}
