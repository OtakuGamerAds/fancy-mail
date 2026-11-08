/**
 * What the demo mail says. Every company, person and domain here is fictional (domains end in
 * .example). The person: Alex Morgan runs "Brightwave Studio", a small German video studio
 * with cooking and travel channels; writes English, German and Arabic; does German bookkeeping.
 */
import type { Address } from "@fancy-mail/contracts";

import { makeCsv, makeIcs, makePdf, makePng } from "./files.ts";
import type { PdfLine } from "./files.ts";

export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    chance: (p) => next() < p,
  };
}

export interface DemoAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
  contentId?: string;
  inline?: boolean;
}

export interface DemoMessage {
  from: Address;
  to: Address[];
  cc?: Address[];
  subject: string;
  text: string;
  html?: string;
  attachments?: DemoAttachment[];
  fromMe: boolean;
  at: number;
}

export type Placement = "inbox" | "archive" | "trash" | "spam" | "sent";

export interface DemoThread {
  kind: string;
  messages: DemoMessage[];
  labels: string[];
  place: Placement;
  /** An IMAP folder other than the archive for archived mail ("Rechnungen"). */
  folder?: string;
  starred?: boolean;
  /** Leave the last received message unread (decided by the seed when undefined). */
  unread?: boolean;
  /** Names a thread the seed refers to later (drafts, activity). */
  key?: string;
}

export interface Ctx {
  rng: Rng;
  me: Address;
  /** Start of the thread. */
  at: number;
  now: number;
  /** Days since the thread started. */
  age: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ── Formatting ──────────────────────────────────────────────────────────────────────────────

export function euroDe(amount: number): string {
  const [whole, cents] = amount.toFixed(2).split(".");
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${cents} €`;
}

export function euroEn(amount: number): string {
  const [whole, cents] = amount.toFixed(2).split(".");
  return `€${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

function dateDe(at: number): string {
  const d = new Date(at);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

function dateEn(at: number): string {
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

const MONTHS_DE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

function monthDe(at: number): string {
  const d = new Date(at);
  return `${MONTHS_DE[d.getMonth()]} ${d.getFullYear()}`;
}

function a(name: string | null, address: string): Address {
  return { name, address };
}

function clampTimes(messages: DemoMessage[], now: number): DemoMessage[] {
  let last = 0;
  return messages.map((m) => {
    let at = Math.min(m.at, now - MIN * 2);
    if (at <= last) at = last + MIN * 3;
    last = at;
    return { ...m, at };
  });
}

function signoffDe(me: Address): string {
  return `Viele Grüße\n${me.name ?? "Alex"}\nBrightwave Studio`;
}

function signoffEn(me: Address): string {
  return `Best,\n${me.name ?? "Alex"}\nBrightwave Studio`;
}

// ── People and companies ───────────────────────────────────────────────────────────────────

export const PEOPLE = {
  weber: a("Sabine Weber", "s.weber@weber-partner.example"),
  weberOffice: a("Steuerkanzlei Weber & Partner", "kanzlei@weber-partner.example"),
  kemal: a("Kemal Aydin", "k.aydin@weber-partner.example"),
  finanzamt: a("Finanzamt Lindenau", "poststelle@finanzamt-lindenau.example"),
  kreator: a("Kreator Network Partnerships", "partnerships@kreator-network.example"),
  lena: a("Lena Hoffmann", "lena@kreator-network.example"),
  mama: a("ماما", "mama@familie-home.example"),
  yusuf: a("Yusuf", "yusuf.k@familie-home.example"),
  layla: a("Layla", "layla.k@familie-home.example"),
  paketpost: a("Paketpost", "benachrichtigung@paketpost.example"),
  stadtwerke: a("Stadtwerke Lindenau", "kundenservice@stadtwerke-lindenau.example"),
  nordbank: a("Nordbank", "service@nordbank.example"),
  payflow: a("PayFlow", "receipts@payflow.example"),
  streamhub: a("StreamHub Studio", "no-reply@streamhub.example"),
  streamhubPartner: a("StreamHub Partner Support", "partners@streamhub.example"),
  railnord: a("RailNord", "buchung@railnord.example"),
  hotel: a("Hotel Am Markt Berlin", "reservierung@hotel-am-markt.example"),
};

interface Vendor {
  name: string;
  from: Address;
  prefix: string;
  lang: "de" | "en";
  items: { text: string; min: number; max: number }[];
}

export const VENDORS: Vendor[] = [
  {
    name: "CloudKiln",
    from: a("CloudKiln Billing", "billing@cloudkiln.example"),
    prefix: "RE-2026-",
    lang: "de",
    items: [
      { text: "Render-Cluster GPU (Stunden)", min: 38, max: 410 },
      { text: "Objektspeicher 2 TB", min: 18, max: 46 },
    ],
  },
  {
    name: "Ledgerly",
    from: a("Ledgerly", "invoices@ledgerly.example"),
    prefix: "INV-",
    lang: "en",
    items: [{ text: "Ledgerly Business plan (monthly)", min: 29, max: 29 }],
  },
  {
    name: "VoiceForge AI",
    from: a("VoiceForge AI", "billing@voiceforge.example"),
    prefix: "VF-",
    lang: "en",
    items: [
      { text: "Studio voices — 400k characters", min: 49, max: 99 },
      { text: "Arabic voice pack add-on", min: 15, max: 15 },
    ],
  },
  {
    name: "AdPilot",
    from: a("AdPilot Billing", "billing@adpilot.example"),
    prefix: "AP-",
    lang: "en",
    items: [{ text: "Campaign spend — Shorts promotion", min: 120, max: 860 }],
  },
  {
    name: "Pixelmarkt",
    from: a("Pixelmarkt", "rechnung@pixelmarkt.example"),
    prefix: "PM-",
    lang: "de",
    items: [
      { text: "Stock-Footage Lizenz (erweitert)", min: 24, max: 140 },
      { text: "Sound-Effekte Paket", min: 9, max: 39 },
    ],
  },
  {
    name: "StreamHub Studio",
    from: a("StreamHub Studio Billing", "billing@streamhub.example"),
    prefix: "SH-",
    lang: "en",
    items: [{ text: "Creator Pro subscription", min: 14, max: 14 }],
  },
];

// ── Invoices and receipts ───────────────────────────────────────────────────────────────────

function invoicePdf(input: {
  vendor: string;
  number: string;
  at: number;
  lines: { text: string; amount: number }[];
  lang: "de" | "en";
  customer: string;
}): Buffer {
  const net = input.lines.reduce((s, l) => s + l.amount, 0);
  const vat = Math.round(net * 19) / 100;
  const total = net + vat;
  const de = input.lang === "de";
  const money = de ? euroDe : euroEn;
  const rows: PdfLine[] = [
    { text: input.vendor, size: 18, bold: true },
    { text: de ? "Rechnung" : "Invoice", size: 12, gap: 4 },
    { text: `${de ? "Rechnungsnummer" : "Invoice number"}: ${input.number}`, gap: 16 },
    { text: `${de ? "Rechnungsdatum" : "Invoice date"}: ${de ? dateDe(input.at) : dateEn(input.at)}` },
    { text: `${de ? "Kunde" : "Customer"}: Brightwave Studio, ${input.customer}` },
    { text: de ? "Leistung" : "Item", bold: true, gap: 18, right: de ? "Betrag" : "Amount" },
    ...input.lines.map((l) => ({ text: l.text, right: money(l.amount) })),
    { text: de ? "Nettobetrag" : "Net amount", gap: 12, right: money(net) },
    { text: de ? "Umsatzsteuer 19 %" : "VAT 19%", right: money(vat) },
    { text: de ? "Gesamtbetrag" : "Total", bold: true, right: money(total) },
    {
      text: de
        ? "Zahlbar innerhalb von 14 Tagen ohne Abzug. Vielen Dank für Ihren Auftrag."
        : "Payable within 14 days. Thank you for your business.",
      gap: 24,
      size: 9,
    },
    { text: `${input.vendor} · USt-IdNr. DE${String(100000000 + (input.number.length * 7919) % 899999999).slice(0, 9)}`, size: 8, gap: 6 },
  ];
  return makePdf(`${de ? "Rechnung" : "Invoice"} ${input.number}`, rows);
}

export function invoiceThread(c: Ctx, vendor: Vendor = c.rng.pick(VENDORS)): DemoThread {
  const number = `${vendor.prefix}${c.rng.int(1000, 9999)}`;
  const lines = vendor.items
    .filter((_, i) => i === 0 || c.rng.chance(0.5))
    .map((item) => ({ text: item.text, amount: Math.round((item.min + c.rng.next() * (item.max - item.min)) * 100) / 100 }));
  const net = lines.reduce((s, l) => s + l.amount, 0);
  const total = net + Math.round(net * 19) / 100;
  const de = vendor.lang === "de";
  const pdf = invoicePdf({ vendor: vendor.name, number, at: c.at, lines, lang: vendor.lang, customer: c.me.address });
  const subject = de ? `Ihre Rechnung ${number} von ${vendor.name}` : `Your ${vendor.name} invoice ${number}`;
  const text = de
    ? `Guten Tag,\n\nanbei erhalten Sie Ihre Rechnung ${number} vom ${dateDe(c.at)} über ${euroDe(total)} (inkl. 19 % USt).\n\nDer Betrag wird in den nächsten Tagen von Ihrem hinterlegten Konto abgebucht. Bitte prüfen Sie die Rechnung im Anhang.\n\nMit freundlichen Grüßen\nIhr ${vendor.name} Team\n\nDiese E-Mail wurde automatisch erstellt.`
    : `Hi Alex,\n\nYour invoice ${number} for ${euroEn(total)} (incl. 19% VAT) is attached. It will be charged to your card on file within the next few days.\n\nQuestions about this invoice? Just reply to this email.\n\nThe ${vendor.name} team`;
  return {
    kind: "invoice",
    messages: [
      {
        from: vendor.from,
        to: [c.me],
        subject,
        text,
        attachments: [{ filename: `${de ? "Rechnung" : "Invoice"}_${number}.pdf`, mimeType: "application/pdf", data: pdf }],
        fromMe: false,
        at: c.at,
      },
    ],
    labels: c.rng.chance(0.3) ? ["Invoices"] : [],
    place: c.age > 12 && c.rng.chance(0.65) ? "archive" : "inbox",
  };
}

export function receiptThread(c: Ctx): DemoThread {
  const kind = c.rng.int(0, 2);
  const amount = Math.round((8 + c.rng.next() * 180) * 100) / 100;
  if (kind === 0) {
    const shop = c.rng.pick(["Pixelmarkt", "CloudKiln", "AdPilot", "Paketpost"]);
    const ref = `PF-${c.rng.int(100000, 999999)}`;
    return {
      kind: "receipt",
      messages: [
        {
          from: PEOPLE.payflow,
          to: [c.me],
          subject: `Zahlungsbeleg: ${euroDe(amount)} an ${shop}`,
          text: `Hallo Alex,\n\ndu hast ${euroDe(amount)} an ${shop} gezahlt.\n\nTransaktions-ID: ${ref}\nDatum: ${dateDe(c.at)}\nZahlungsquelle: Nordbank Business ••• 4471\n\nDieser Beleg dient als Zahlungsnachweis. Eine Rechnung erhältst du direkt vom Händler.\n\nDein PayFlow Team`,
          html: `<div style="font-family:Arial,sans-serif;color:#1f2937;max-width:560px"><h2 style="color:#0f766e;margin:0 0 12px">Zahlung gesendet</h2><p>Hallo Alex,</p><p>du hast <b>${euroDe(amount)}</b> an <b>${shop}</b> gezahlt.</p><table style="border-collapse:collapse;font-size:14px"><tr><td style="padding:4px 12px 4px 0;color:#6b7280">Transaktions-ID</td><td>${ref}</td></tr><tr><td style="padding:4px 12px 4px 0;color:#6b7280">Datum</td><td>${dateDe(c.at)}</td></tr><tr><td style="padding:4px 12px 4px 0;color:#6b7280">Quelle</td><td>Nordbank Business ••• 4471</td></tr></table><p style="font-size:12px;color:#6b7280;margin-top:24px">Dieser Beleg dient als Zahlungsnachweis. Eine Rechnung erhältst du direkt vom Händler.</p></div>`,
          fromMe: false,
          at: c.at,
        },
      ],
      labels: c.rng.chance(0.4) ? ["Receipts"] : [],
      place: c.age > 10 && c.rng.chance(0.6) ? "archive" : "inbox",
    };
  }
  if (kind === 1) {
    const order = `${c.rng.int(300, 399)}-${c.rng.int(1000000, 9999999)}`;
    const item = c.rng.pick(["LED panel light 60W", "Shure-style dynamic mic stand", "USB-C capture card 4K", "Acoustic foam panels (12 pack)", "Mechanical keyboard switches"]);
    const pdf = makePdf(`Receipt ${order}`, [
      { text: "Pixelmarkt", size: 18, bold: true },
      { text: "Receipt", size: 12, gap: 4 },
      { text: `Order ${order}`, gap: 16 },
      { text: `Date: ${dateEn(c.at)}` },
      { text: item, gap: 18, right: euroEn(amount) },
      { text: "Includes VAT 19%", right: euroEn(Math.round((amount - amount / 1.19) * 100) / 100) },
      { text: "Total paid", bold: true, right: euroEn(amount) },
    ]);
    return {
      kind: "receipt",
      messages: [
        {
          from: a("Pixelmarkt Orders", "orders@pixelmarkt.example"),
          to: [c.me],
          subject: `Your receipt for order ${order}`,
          text: `Thanks for your order!\n\n${item} — ${euroEn(amount)}\n\nYour receipt is attached. You can download it again from your Pixelmarkt account at any time.\n\nPixelmarkt`,
          attachments: [{ filename: `Receipt_${order}.pdf`, mimeType: "application/pdf", data: pdf }],
          fromMe: false,
          at: c.at,
        },
      ],
      labels: c.rng.chance(0.45) ? ["Receipts"] : [],
      place: c.age > 10 && c.rng.chance(0.6) ? "archive" : "inbox",
    };
  }
  return {
    kind: "receipt",
    messages: [
      {
        from: a("AdPilot Billing", "billing@adpilot.example"),
        to: [c.me],
        subject: `Payment receipt — AdPilot account ${c.rng.int(2000, 2999)}-${c.rng.int(100, 999)}`,
        text: `We received your payment of ${euroEn(amount)} on ${dateEn(c.at)}.\n\nPayment method: Visa ending 1182\nBalance: ${euroEn(0)}\n\nYour ads keep running without interruption.\n\nAdPilot`,
        fromMe: false,
        at: c.at,
      },
    ],
    labels: c.rng.chance(0.35) ? ["Receipts"] : [],
    place: c.age > 10 && c.rng.chance(0.7) ? "archive" : "inbox",
  };
}

// ── Banking ─────────────────────────────────────────────────────────────────────────────────

const MERCHANTS = ["REWE Lindenau", "Bäckerei Krume", "Tankstelle Nordring", "Elektro Lindner", "Pixelmarkt GmbH", "CloudKiln Europe", "Café Sonnenseite", "Baumarkt Weidner", "Apotheke am Markt", "RailNord Ticketautomat"];

export function bankThread(c: Ctx, business: boolean): DemoThread {
  const roll = c.rng.next();
  const account = business ? "Geschäftskonto ••• 4471" : "Girokonto ••• 9023";
  if (roll < 0.55) {
    const merchant = c.rng.pick(MERCHANTS);
    const amount = Math.round((3 + c.rng.next() * (business ? 240 : 90)) * 100) / 100;
    return {
      kind: "bank",
      messages: [
        {
          from: PEOPLE.nordbank,
          to: [c.me],
          subject: `Kartenzahlung über ${euroDe(amount)}`,
          text: `Guten Tag,\n\nmit Ihrer Nordbank Debitkarte (${account}) wurde eine Zahlung ausgeführt:\n\nBetrag: ${euroDe(amount)}\nHändler: ${merchant}\nDatum: ${dateDe(c.at)}\n\nWaren Sie das nicht? Sperren Sie Ihre Karte sofort in der Nordbank App oder unter 0800 000 0000.\n\nIhre Nordbank`,
          fromMe: false,
          at: c.at,
        },
      ],
      labels: [],
      place: c.age > 5 && c.rng.chance(0.75) ? "archive" : "inbox",
    };
  }
  if (roll < 0.8) {
    const incoming = c.rng.chance(0.6);
    const amount = Math.round((incoming ? 200 + c.rng.next() * 3800 : 40 + c.rng.next() * 900) * 100) / 100;
    const party = incoming
      ? c.rng.pick(["StreamHub Studio Payouts", "Kreator Network GmbH", "VoiceForge AI Ltd (Sponsoring)", "Pixelmarkt Affiliate"])
      : c.rng.pick(["Steuerkanzlei Weber & Partner", "Stadtwerke Lindenau", "Finanzamt Lindenau", "Hausverwaltung Berger"]);
    return {
      kind: "bank",
      messages: [
        {
          from: PEOPLE.nordbank,
          to: [c.me],
          subject: incoming ? `Zahlungseingang: ${euroDe(amount)}` : `Lastschrift angekündigt: ${euroDe(amount)}`,
          text: incoming
            ? `Guten Tag,\n\nauf Ihrem ${account} ist ein Betrag eingegangen.\n\nBetrag: ${euroDe(amount)}\nAuftraggeber: ${party}\nBuchungsdatum: ${dateDe(c.at)}\n\nIhre Nordbank`
            : `Guten Tag,\n\n${party} hat eine SEPA-Lastschrift über ${euroDe(amount)} angekündigt. Sie wird am ${dateDe(c.at + 3 * DAY)} von Ihrem ${account} abgebucht.\n\nIhre Nordbank`,
          fromMe: false,
          at: c.at,
        },
      ],
      labels: [],
      place: c.age > 5 && c.rng.chance(0.75) ? "archive" : "inbox",
    };
  }
  return {
    kind: "bank",
    messages: [
      {
        from: PEOPLE.nordbank,
        to: [c.me],
        subject: c.rng.chance(0.5) ? "Sicherheitshinweis: Neues Gerät angemeldet" : "Ihre Nordbank Kreditkartenabrechnung ist da",
        text: `Guten Tag,\n\nes gibt Neuigkeiten zu Ihrem Konto. Melden Sie sich im Nordbank Online-Banking an, um die Details zu sehen.\n\nWir fragen Sie niemals per E-Mail nach PIN oder TAN.\n\nIhre Nordbank`,
        fromMe: false,
        at: c.at,
      },
    ],
    labels: [],
    place: c.age > 5 ? "archive" : "inbox",
  };
}

export function statementThread(c: Ctx, business: boolean, withCsv: boolean): DemoThread {
  const month = monthDe(c.at - 3 * DAY);
  const attachments: DemoAttachment[] = [];
  if (withCsv) {
    const rows: (string | number)[][] = [["Buchungstag", "Valuta", "Auftraggeber/Empfänger", "Verwendungszweck", "Betrag (EUR)"]];
    for (let i = 0; i < 18; i++) {
      const at = c.at - (30 - i * 1.6) * DAY;
      const incoming = c.rng.chance(0.25);
      const amount = incoming ? 300 + c.rng.next() * 2500 : -(4 + c.rng.next() * 220);
      rows.push([
        dateDe(at),
        dateDe(at + DAY),
        incoming ? c.rng.pick(["StreamHub Studio Payouts", "Kreator Network GmbH"]) : c.rng.pick(MERCHANTS),
        incoming ? `Auszahlung ${c.rng.int(10000, 99999)}` : `Kartenzahlung ${c.rng.int(100000, 999999)}`,
        amount.toFixed(2).replace(".", ","),
      ]);
    }
    attachments.push({ filename: `Umsaetze_${business ? "Geschaeftskonto" : "Girokonto"}_${month.replace(" ", "_")}.csv`, mimeType: "text/csv", data: makeCsv(rows) });
  }
  return {
    kind: "statement",
    messages: [
      {
        from: PEOPLE.nordbank,
        to: [c.me],
        subject: `Ihr Kontoauszug ist verfügbar – ${month}`,
        text: `Guten Tag,\n\nIhr Kontoauszug für ${month} (${business ? "Geschäftskonto ••• 4471" : "Girokonto ••• 9023"}) steht im Online-Banking für Sie bereit.${withCsv ? "\n\nDie Umsätze des Monats finden Sie zusätzlich als CSV-Datei im Anhang." : ""}\n\nBitte prüfen Sie die Buchungen. Einwände sind innerhalb von sechs Wochen möglich.\n\nIhre Nordbank`,
        attachments,
        fromMe: false,
        at: c.at,
      },
    ],
    labels: [],
    place: c.age > 6 ? "archive" : "inbox",
    folder: c.age > 6 && business ? "Kontoauszüge" : undefined,
  };
}

// ── Steuerberater and Finanzamt ─────────────────────────────────────────────────────────────

const TAX_TOPICS = [
  {
    subject: (at: number) => `USt-VA ${MONTHS_DE[new Date(at - 20 * DAY).getMonth()]} – fehlende Belege`,
    open: (me: Address) =>
      `Hallo Herr ${me.name?.split(" ").at(-1) ?? "Morgan"},\n\nfür die Umsatzsteuer-Voranmeldung fehlen uns noch folgende Belege:\n\n- CloudKiln (Render-Cluster), Rechnung vom 03.\n- VoiceForge AI, zwei Rechnungen\n- PayFlow-Zahlungen an Pixelmarkt\n\nKönnten Sie uns diese bis Freitag hochladen oder per E-Mail schicken? Die Abgabefrist ist der 10.\n\nFreundliche Grüße\nSabine Weber\nSteuerkanzlei Weber & Partner`,
    reply: (me: Address) =>
      `Hallo Frau Weber,\n\ndanke für den Hinweis. Die CloudKiln-Rechnung schicke ich Ihnen heute noch, die beiden von VoiceForge suche ich gerade heraus.\n\nIst es in Ordnung, wenn die PayFlow-Belege als PDF-Export kommen?\n\n${signoffDe(me)}`,
    answer: `Hallo Herr Morgan,\n\nja, der PDF-Export von PayFlow reicht völlig. Bitte achten Sie darauf, dass Datum und Empfänger sichtbar sind.\n\nFreundliche Grüße\nSabine Weber`,
  },
  {
    subject: () => "Jahresabschluss 2025: Rückfragen zu Anlagegütern",
    open: () =>
      `Guten Tag,\n\nbeim Jahresabschluss 2025 haben wir Rückfragen zu zwei Anschaffungen:\n\n1. Kamera-Set (Rechnung Pixelmarkt, 2.380,00 € netto) – soll das über drei Jahre abgeschrieben werden?\n2. Der Schnittrechner vom November – privat oder betrieblich genutzt?\n\nViele Grüße\nKemal Aydin\nSteuerkanzlei Weber & Partner`,
    reply: (me: Address) =>
      `Hallo Herr Aydin,\n\n1. Ja, bitte über drei Jahre.\n2. Der Rechner wird zu 100 % betrieblich genutzt (Schnitt und Rendering).\n\n${signoffDe(me)}`,
    answer: `Danke, dann buchen wir das so. Der Entwurf des Abschlusses kommt nächste Woche.\n\nViele Grüße\nKemal Aydin`,
  },
  {
    subject: () => "Fristverlängerung Einkommensteuer 2025",
    open: () =>
      `Hallo Herr Morgan,\n\nzur Info: Für Ihre Einkommensteuererklärung 2025 gilt als steuerlich beratener Mandant die verlängerte Frist. Wir planen die Abgabe für Februar.\n\nBitte schicken Sie uns bis Ende Januar die Spendenbescheinigungen und die Nachweise zur Krankenversicherung.\n\nFreundliche Grüße\nSabine Weber`,
    reply: (me: Address) => `Hallo Frau Weber,\n\nalles klar, ich sammle die Unterlagen und schicke sie gesammelt.\n\n${signoffDe(me)}`,
    answer: null,
  },
  {
    subject: () => "Minijob-Abrechnung Schnitt-Assistenz",
    open: () =>
      `Guten Tag,\n\nanbei die Lohnabrechnung für Ihre Schnitt-Assistenz. Die Abgaben an die Minijob-Zentrale werden automatisch eingezogen.\n\nViele Grüße\nKemal Aydin`,
    reply: null,
    answer: null,
  },
];

export function taxThread(c: Ctx, topicIndex?: number): DemoThread {
  const topic = TAX_TOPICS[topicIndex ?? c.rng.int(0, TAX_TOPICS.length - 1)]!;
  const subject = topic.subject(c.at);
  const opener = topic === TAX_TOPICS[1] || topic === TAX_TOPICS[3] ? PEOPLE.kemal : PEOPLE.weber;
  const messages: DemoMessage[] = [
    {
      from: opener,
      to: [c.me],
      cc: [PEOPLE.weberOffice],
      subject,
      text: topic.open(c.me),
      attachments:
        topic === TAX_TOPICS[3]
          ? [
              {
                filename: `Lohnabrechnung_${monthDe(c.at).replace(" ", "_")}.pdf`,
                mimeType: "application/pdf",
                data: makePdf("Lohnabrechnung", [
                  { text: "Steuerkanzlei Weber & Partner", size: 16, bold: true },
                  { text: `Lohnabrechnung ${monthDe(c.at)}`, size: 12, gap: 4 },
                  { text: "Arbeitgeber: Brightwave Studio", gap: 16 },
                  { text: "Tätigkeit: Schnitt-Assistenz (Minijob)" },
                  { text: "Bruttolohn", gap: 18, right: euroDe(538) },
                  { text: "Pauschalabgaben Arbeitgeber", right: euroDe(162.48) },
                  { text: "Auszahlung", bold: true, right: euroDe(538) },
                ]),
              },
            ]
          : undefined,
      fromMe: false,
      at: c.at,
    },
  ];
  if (topic.reply) {
    messages.push({ from: c.me, to: [opener], subject: `AW: ${subject}`, text: topic.reply(c.me), fromMe: true, at: c.at + c.rng.int(2, 20) * HOUR });
    if (topic.answer) {
      messages.push({ from: opener, to: [c.me], subject: `AW: ${subject}`, text: topic.answer, fromMe: false, at: c.at + c.rng.int(22, 50) * HOUR });
    }
  }
  return {
    kind: "tax",
    messages: clampTimes(messages, c.now),
    labels: c.rng.chance(0.75) ? ["Taxes 2026"] : [],
    place: c.age > 20 && c.rng.chance(0.6) ? "archive" : "inbox",
  };
}

export function finanzamtThread(c: Ctx): DemoThread {
  const roll = c.rng.int(0, 2);
  const subjects = [
    "Elektronische Steuerbescheinigung: Übermittlung erfolgreich",
    `Bescheid über Umsatzsteuer-Vorauszahlung ${monthDe(c.at - 30 * DAY)}`,
    "Erinnerung: Abgabe der Umsatzsteuer-Voranmeldung",
  ];
  const texts = [
    `Sehr geehrte Damen und Herren,\n\nIhre Übermittlung (Transferticket ${c.rng.int(100000, 999999)}-${c.rng.int(1000, 9999)}) wurde erfolgreich empfangen und wird bearbeitet.\n\nDiese Nachricht wurde maschinell erstellt.\n\nFinanzamt Lindenau`,
    `Sehr geehrte Damen und Herren,\n\nein neuer Bescheid liegt in Ihrem Postfach im Steuerportal bereit. Die festgesetzte Vorauszahlung beträgt ${euroDe(Math.round((400 + c.rng.next() * 1600) * 100) / 100)}.\n\nFinanzamt Lindenau`,
    "Sehr geehrte Damen und Herren,\n\nfür den letzten Voranmeldungszeitraum liegt uns noch keine Umsatzsteuer-Voranmeldung vor. Bitte reichen Sie diese umgehend ein, um einen Verspätungszuschlag zu vermeiden.\n\nFinanzamt Lindenau",
  ];
  return {
    kind: "finanzamt",
    messages: [{ from: PEOPLE.finanzamt, to: [c.me], subject: subjects[roll]!, text: texts[roll]!, fromMe: false, at: c.at }],
    labels: c.rng.chance(0.7) ? ["Taxes 2026"] : [],
    place: c.age > 15 ? "archive" : "inbox",
  };
}

// ── Channels: platform notices and sponsorships ─────────────────────────────────────────────

const VIDEO_TITLES_EN = ["Street Food Tour: 10 Stalls in One Night", "I Cooked Every Recipe From a 1950s Cookbook", "One Pan, Five Dinners", "48 Hours in a Coastal Town", "The Hidden Kitchens of the Old Market"];
const VIDEO_TITLES_DE = ["Die besten Herbstsuppen 2026", "Meine Küche erklärt", "Rezepte, die niemand kennt (aber jeder kochen sollte)", "Wir bewerten eure Brote", "Herbstgemüse Tier-Liste"];

export function platformThread(c: Ctx, lang: "en" | "de" | "ar"): DemoThread {
  const roll = c.rng.int(0, 3);
  const amount = Math.round((300 + c.rng.next() * 2600) * 100) / 100;
  if (lang === "de") {
    const title = c.rng.pick(VIDEO_TITLES_DE);
    const options = [
      {
        subject: `Urheberrechtsanspruch für dein Video „${title}“`,
        text: `Hallo Brightwave Kitchen DE,\n\nfür dein Video „${title}“ wurde ein Content-ID-Anspruch erhoben (Musik, 0:42–1:15). Das Video bleibt online, Werbeeinnahmen gehen an den Rechteinhaber.\n\nDu kannst den Anspruch in StreamHub Studio prüfen und Einspruch einlegen.\n\nDein StreamHub Team`,
      },
      {
        subject: `Auszahlung veranlasst: ${euroDe(amount)}`,
        text: `Hallo,\n\nwir haben deine Auszahlung für ${monthDe(c.at - 15 * DAY)} veranlasst: ${euroDe(amount)}.\nDas Geld ist in 3–5 Werktagen auf deinem Konto.\n\nDein StreamHub Team`,
      },
      {
        subject: "Dein Kanal hat 100.000 Abonnenten erreicht 🎉",
        text: "Glückwunsch! Dein Kanal hat 100.000 Abonnenten erreicht. Du kannst jetzt deinen Creator Award anfordern.\n\nDein StreamHub Team",
      },
      {
        subject: "Neue Richtlinien für Kommentare ab nächsten Monat",
        text: "Hallo,\n\nab nächsten Monat gelten neue Regeln für die Moderation von Kommentaren. Was sich für dich ändert, liest du in StreamHub Studio unter „Einstellungen › Community“.\n\nDein StreamHub Team",
      },
    ];
    const pick = options[roll]!;
    return {
      kind: "platform",
      messages: [{ from: PEOPLE.streamhub, to: [c.me], subject: pick.subject, text: pick.text, fromMe: false, at: c.at }],
      labels: [],
      place: c.age > 8 && c.rng.chance(0.7) ? "archive" : "inbox",
    };
  }
  const title = c.rng.pick(VIDEO_TITLES_EN);
  const options = [
    {
      subject: `Copyright claim on your video “${title}”`,
      text: `Hi Brightwave,\n\nA Content ID claim was made on “${title}” (music, 3:10–3:52). Your video is still available; ad revenue will go to the claimant.\n\nYou can review the claim or dispute it in StreamHub Studio within 30 days.\n\n— StreamHub Studio`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;color:#111827"><p style="font-size:13px;color:#6b7280">StreamHub Studio</p><h2 style="margin:4px 0 16px">Copyright claim on your video</h2><p>A Content ID claim was made on <b>“${title}”</b> (music, 3:10–3:52).</p><p>Your video is still available; ad revenue will go to the claimant.</p><p><a href="https://studio.streamhub.example/claims" style="background:#dc2626;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Review claim</a></p><p style="font-size:12px;color:#9ca3af;margin-top:28px">You received this email because you own a channel on StreamHub.</p></div>`,
    },
    {
      subject: `Your payment of ${euroEn(amount)} has been sent`,
      text: `Hi Brightwave,\n\nYour StreamHub earnings for ${new Date(c.at - 15 * DAY).toLocaleDateString("en-GB", { month: "long", year: "numeric" })} (${euroEn(amount)}) are on the way to your bank account ending 4471.\n\n— StreamHub Payments`,
    },
    {
      subject: "Monetization review complete — you're in",
      text: "Good news: your channel passed the monetization review. Ads can now run on your eligible videos, Shorts included.\n\n— StreamHub Partner Program",
    },
    {
      subject: `Your video “${title}” is trending in Food`,
      text: `“${title}” is #${c.rng.int(3, 40)} on trending in Food in Germany. Nice work!\n\n— StreamHub Studio`,
    },
  ];
  const pick = options[roll]!;
  return {
    kind: "platform",
    messages: [{ from: roll === 2 ? PEOPLE.streamhubPartner : PEOPLE.streamhub, to: [c.me], subject: pick.subject, text: pick.text, html: pick.html, fromMe: false, at: c.at }],
    labels: [],
    place: c.age > 8 && c.rng.chance(0.7) ? "archive" : "inbox",
  };
}

const BRANDS = [
  { name: "VoiceForge AI", contact: a("Priya Nair", "priya@voiceforge.example"), product: "AI voice studio for creators" },
  { name: "NovaPad", contact: a("Jonas Becker", "jonas.becker@novapad.example"), product: "drawing tablet NovaPad Pro 13" },
  { name: "Ember Valley", contact: a("Mika Tanaka", "mika@embervalley-game.example"), product: "cozy fantasy RPG Ember Valley (launching next month)" },
  { name: "CloudKiln", contact: a("Sam Rivera", "sam.rivera@cloudkiln.example"), product: "cloud rendering for video creators" },
  { name: "Pixelmarkt", contact: a("Clara Vogel", "clara.vogel@pixelmarkt.example"), product: "stock footage library" },
];

export function sponsorshipThread(c: Ctx, channel: string, lang: "en" | "de"): DemoThread {
  const brand = c.rng.pick(BRANDS);
  const fee = c.rng.int(8, 45) * 100;
  const subject =
    lang === "de"
      ? `Kooperationsanfrage: ${brand.name} x ${channel}`
      : c.rng.pick([`Sponsorship for ${channel} — ${brand.name}`, `Paid integration offer: ${brand.name} x ${channel}`, `Partnership idea for your next video`]);
  const open =
    lang === "de"
      ? `Hallo Team ${channel},\n\nwir sind große Fans eurer Videos! Wir würden gerne unser Produkt (${brand.product}) in einem eurer nächsten Videos vorstellen – als 60–90 Sekunden Integration.\n\nUnser Budget liegt bei ${euroDe(fee)}. Habt ihr Interesse? Dann schicke ich gerne das Briefing.\n\nViele Grüße\n${brand.contact.name}\n${brand.name}`
      : `Hi ${channel} team,\n\nI'm ${brand.contact.name?.split(" ")[0]} from ${brand.name}. We'd love to sponsor a 60–90 second integration of our ${brand.product} in one of your upcoming videos.\n\nOur budget for this is ${euroEn(fee)}, and we're flexible on timing. Would you be open to it? Happy to send a brief and our talking points.\n\nCheers,\n${brand.contact.name}\nCreator Partnerships, ${brand.name}`;
  const messages: DemoMessage[] = [{ from: brand.contact, to: [c.me], subject, text: open, fromMe: false, at: c.at }];
  if (c.rng.chance(0.45)) {
    messages.push({
      from: c.me,
      to: [brand.contact],
      subject: `${lang === "de" ? "AW" : "Re"}: ${subject}`,
      text:
        lang === "de"
          ? `Hallo ${brand.contact.name?.split(" ")[0]},\n\ndanke für die Anfrage! Grundsätzlich gerne. Unser Satz für eine Integration liegt bei ${euroDe(fee + 600)}, inklusive Link in der Beschreibung für 30 Tage. Schick mir gern das Briefing.\n\n${signoffDe(c.me)}`
          : `Hi ${brand.contact.name?.split(" ")[0]},\n\nThanks for reaching out — sounds like a good fit. Our rate for a dedicated integration is ${euroEn(fee + 600)}, including a pinned comment and description link for 30 days. Media kit attached.\n\n${signoffEn(c.me)}`,
      attachments:
        lang === "en"
          ? [
              {
                filename: "Brightwave_Media_Kit_2026.pdf",
                mimeType: "application/pdf",
                data: makePdf("Media kit", [
                  { text: "Brightwave Studio — Media Kit 2026", size: 16, bold: true },
                  { text: "Channels: Kitchen DE · Travel AR · Shorts", gap: 12 },
                  { text: "Combined subscribers: 412,000" },
                  { text: "Average views per video (30 days): 86,000" },
                  { text: "Audience: 18–34 (71%), Germany, Austria, MENA" },
                  { text: "Dedicated integration (60–90 s)", gap: 16, right: euroEn(fee + 600) },
                  { text: "Shorts package (3 Shorts)", right: euroEn(fee) },
                ]),
              },
            ]
          : undefined,
      fromMe: true,
      at: c.at + c.rng.int(3, 30) * HOUR,
    });
    if (c.rng.chance(0.6)) {
      messages.push({
        from: brand.contact,
        to: [c.me],
        subject: `${lang === "de" ? "AW" : "Re"}: ${subject}`,
        text:
          lang === "de"
            ? "Super, das passt für uns. Ich schicke euch heute noch das Briefing und den Vertragsentwurf.\n\nViele Grüße"
            : "That works for us! I'll send over the brief and a draft agreement today. Could you share two possible upload dates?\n\nThanks!",
        fromMe: false,
        at: c.at + c.rng.int(32, 70) * HOUR,
      });
    }
  }
  return {
    kind: "sponsorship",
    messages: clampTimes(messages, c.now),
    labels: c.rng.chance(0.5) ? ["Sponsorships"] : [],
    place: c.age > 25 && c.rng.chance(0.5) ? "archive" : "inbox",
    starred: c.rng.chance(0.08),
  };
}

const AR_SPONSORS = [
  { name: "صحارى جير", contact: a("فريق الشراكات - صحارى جير", "partners@sahara-gear.example") },
  { name: "شبكة كريتور", contact: a("نور الهدى", "nour@kreator-network.example") },
  { name: "نوفاباد", contact: a("خالد منصور", "khaled@novapad.example") },
];

export function arabicSponsorshipThread(c: Ctx): DemoThread {
  const brand = c.rng.pick(AR_SPONSORS);
  const fee = c.rng.int(10, 40) * 100;
  const subject = c.rng.pick([`عرض رعاية لقناة Brightwave`, `تعاون مدفوع مع ${brand.name}`, "فرصة رعاية لفيديو الأسبوع القادم"]);
  const messages: DemoMessage[] = [
    {
      from: brand.contact,
      to: [c.me],
      subject,
      text: `مرحباً فريق Brightwave،\n\nنتابع قناتكم منذ فترة ونحب أسلوبكم في تقديم الرحلات. نود أن نعرض عليكم رعاية فيديو واحد مع فقرة مدتها دقيقة واحدة عن منتجاتنا.\n\nالميزانية المقترحة: ${euroEn(fee)}.\n\nهل يناسبكم ذلك؟ يسعدنا إرسال التفاصيل.\n\nمع خالص التحية،\n${brand.contact.name}`,
      fromMe: false,
      at: c.at,
    },
  ];
  if (c.rng.chance(0.4)) {
    messages.push({
      from: c.me,
      to: [brand.contact],
      subject: `رد: ${subject}`,
      text: `أهلاً وسهلاً،\n\nشكراً على تواصلكم. يسعدنا التعاون معكم. أرسلوا لنا التفاصيل وموعد النشر المقترح وسنرد عليكم خلال يومين.\n\nمع التحية،\nأليكس\nBrightwave Studio`,
      fromMe: true,
      at: c.at + c.rng.int(4, 30) * HOUR,
    });
  }
  return {
    kind: "sponsorship",
    messages: clampTimes(messages, c.now),
    labels: c.rng.chance(0.5) ? ["Sponsorships"] : [],
    place: c.age > 25 && c.rng.chance(0.5) ? "archive" : "inbox",
  };
}

// ── Newsletters ─────────────────────────────────────────────────────────────────────────────

const NEWSLETTERS = [
  { name: "CloudKiln Weekly", from: a("CloudKiln Weekly", "news@cloudkiln.example"), color: "#f97316", topic: "Render 4K timelines 40% faster with the new GPU tier" },
  { name: "Kreator Network Digest", from: a("Kreator Network", "digest@kreator-network.example"), color: "#8b5cf6", topic: "Five sponsorship trends for Q1 and how to price them" },
  { name: "Pixelmarkt Fresh Assets", from: a("Pixelmarkt", "newsletter@pixelmarkt.example"), color: "#10b981", topic: "1,200 new winter stock clips, free for Pro members this week" },
  { name: "AdPilot Insights", from: a("AdPilot Insights", "insights@adpilot.example"), color: "#3b82f6", topic: "Shorts ads now reach 30% more viewers in the DACH region" },
  { name: "StreamHub Creator News", from: a("StreamHub Creators", "creators@streamhub.example"), color: "#ef4444", topic: "New: chapters for Shorts and a redesigned analytics tab" },
  { name: "Food Media Radar", from: a("Food Media Radar", "radar@foodradar.example"), color: "#ec4899", topic: "This week's launches, recipe trends and the big platform announcements" },
];

export function newsletterThread(c: Ctx): DemoThread {
  const n = c.rng.pick(NEWSLETTERS);
  const issue = c.rng.int(40, 220);
  const img = `https://images.example/${n.name.toLowerCase().replace(/[^a-z]+/g, "-")}/issue-${issue}.png`;
  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;font-family:Helvetica,Arial,sans-serif;color:#1f2937">
<tr><td style="background:${n.color};padding:18px 28px;color:#ffffff;font-size:20px;font-weight:bold">${n.name} <span style="font-weight:normal;opacity:.8;font-size:14px">#${issue}</span></td></tr>
<tr><td><img src="${img}" width="600" height="220" alt="${n.name}" style="display:block;width:100%;height:auto"></td></tr>
<tr><td style="padding:24px 28px"><h1 style="font-size:22px;margin:0 0 12px">${n.topic}</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 14px">Hi Alex, here's what's new this week. We picked the three things that matter most for small studios and channel teams.</p>
<ul style="font-size:15px;line-height:1.7;padding-left:20px"><li>What changed and who it helps</li><li>A five-minute setup guide</li><li>Real numbers from creators who tried it</li></ul>
<p style="margin:22px 0"><a href="https://${n.from.address.split("@")[1]}/issue/${issue}" style="background:${n.color};color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Read the full issue</a></p></td></tr>
<tr><td style="padding:18px 28px;background:#f9fafb;font-size:12px;color:#6b7280;line-height:1.5">You're receiving this because you subscribed with ${c.me.address}.<br><a href="https://${n.from.address.split("@")[1]}/unsubscribe?u=${issue}" style="color:#6b7280">Unsubscribe</a> · <a href="https://${n.from.address.split("@")[1]}/preferences" style="color:#6b7280">Email preferences</a><br>${n.name}, Musterstraße 1, 10115 Berlin</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${n.name} #${issue}\n\n${n.topic}\n\nHi Alex, here's what's new this week. We picked the three things that matter most for small studios and channel teams.\n\n- What changed and who it helps\n- A five-minute setup guide\n- Real numbers from creators who tried it\n\nRead the full issue: https://${n.from.address.split("@")[1]}/issue/${issue}\n\nUnsubscribe: https://${n.from.address.split("@")[1]}/unsubscribe?u=${issue}`;
  return {
    kind: "newsletter",
    messages: [{ from: n.from, to: [c.me], subject: `${n.name}: ${n.topic}`, text, html, fromMe: false, at: c.at }],
    labels: c.rng.chance(0.4) ? ["Newsletters"] : [],
    place: c.age > 30 && c.rng.chance(0.4) ? "archive" : "inbox",
  };
}

// ── Personal ────────────────────────────────────────────────────────────────────────────────

export function shippingThread(c: Ctx): DemoThread {
  const tracking = `00340434${c.rng.int(10000000, 99999999)}`;
  const shop = c.rng.pick(["Pixelmarkt", "Elektro Lindner", "Buchhandlung Seitenwind", "Baumarkt Weidner"]);
  const messages: DemoMessage[] = [
    {
      from: PEOPLE.paketpost,
      to: [c.me],
      subject: `Ihre Sendung von ${shop} ist unterwegs`,
      text: `Hallo Alex,\n\nIhre Sendung ${tracking} von ${shop} ist unterwegs.\nVoraussichtliche Zustellung: ${dateDe(c.at + 2 * DAY)}, 10:00–14:00 Uhr.\n\nSie möchten einen Ablageort festlegen? Das geht in der Paketpost App.\n\nIhre Paketpost`,
      fromMe: false,
      at: c.at,
    },
  ];
  if (c.rng.chance(0.6)) {
    messages.push({
      from: PEOPLE.paketpost,
      to: [c.me],
      subject: c.rng.chance(0.85) ? `Zugestellt: Ihre Sendung ${tracking}` : `Zustellung verschoben: Sendung ${tracking}`,
      text: `Hallo Alex,\n\nIhre Sendung ${tracking} wurde zugestellt (Ablageort: Garage).\n\nIhre Paketpost`,
      fromMe: false,
      at: c.at + c.rng.int(30, 60) * HOUR,
    });
  }
  return { kind: "shipping", messages: clampTimes(messages, c.now), labels: [], place: c.age > 7 ? "archive" : "inbox" };
}

export function travelThread(c: Ctx): DemoThread {
  const trip = c.at + c.rng.int(7, 40) * DAY;
  const code = `RN${c.rng.int(100000, 999999)}`;
  if (c.rng.chance(0.6)) {
    const price = Math.round((29 + c.rng.next() * 90) * 100) / 100;
    return {
      kind: "travel",
      messages: [
        {
          from: PEOPLE.railnord,
          to: [c.me],
          subject: `Ihre Buchungsbestätigung ${code}: Lindenau → Berlin`,
          text: `Hallo Alex,\n\nvielen Dank für Ihre Buchung.\n\nHinfahrt: ${dateDe(trip)}, 08:14 Lindenau Hbf → 10:02 Berlin Hbf, Wagen 7, Platz 64\nRückfahrt: ${dateDe(trip + 2 * DAY)}, 17:56 Berlin Hbf → 19:41 Lindenau Hbf\nPreis: ${euroDe(price)}\n\nIhr Ticket finden Sie im Anhang und in der RailNord App.\n\nGute Reise!\nRailNord`,
          attachments: [
            {
              filename: `Ticket_${code}.pdf`,
              mimeType: "application/pdf",
              data: makePdf(`Ticket ${code}`, [
                { text: "RailNord", size: 18, bold: true },
                { text: "Online-Ticket", size: 12, gap: 4 },
                { text: `Auftragsnummer: ${code}`, gap: 16 },
                { text: `Hinfahrt: ${dateDe(trip)} 08:14 Lindenau Hbf → Berlin Hbf` },
                { text: `Rückfahrt: ${dateDe(trip + 2 * DAY)} 17:56 Berlin Hbf → Lindenau Hbf` },
                { text: "Fahrgast: Alex", gap: 10 },
                { text: "Gesamtpreis inkl. 7 % MwSt.", gap: 16, right: euroDe(price) },
              ]),
            },
          ],
          fromMe: false,
          at: c.at,
        },
      ],
      labels: c.rng.chance(0.7) ? ["Travel"] : [],
      place: c.age > 14 ? "archive" : "inbox",
    };
  }
  return {
    kind: "travel",
    messages: [
      {
        from: PEOPLE.hotel,
        to: [c.me],
        subject: `Reservierungsbestätigung – ${dateDe(trip)}`,
        text: `Guten Tag,\n\nwir freuen uns, Sie vom ${dateDe(trip)} bis ${dateDe(trip + 2 * DAY)} bei uns begrüßen zu dürfen.\n\nZimmer: Doppelzimmer zur Einzelnutzung, inkl. Frühstück\nCheck-in ab 15:00 Uhr\n\nKostenlose Stornierung bis 48 Stunden vor Anreise.\n\nHotel Am Markt Berlin`,
        fromMe: false,
        at: c.at,
      },
    ],
    labels: c.rng.chance(0.7) ? ["Travel"] : [],
    place: c.age > 14 ? "archive" : "inbox",
  };
}

export function utilityThread(c: Ctx): DemoThread {
  const amount = Math.round((60 + c.rng.next() * 90) * 100) / 100;
  const yearly = c.rng.chance(0.4);
  const number = `SW-${c.rng.int(10000000, 99999999)}`;
  return {
    kind: "utility",
    messages: [
      {
        from: PEOPLE.stadtwerke,
        to: [c.me],
        subject: yearly ? "Ihre Jahresabrechnung Strom 2025" : `Abschlagsänderung ab ${monthDe(c.at + 30 * DAY)}`,
        text: yearly
          ? `Sehr geehrter Kunde,\n\nanbei erhalten Sie Ihre Jahresabrechnung für Strom (Vertragskonto ${number}). Ihr Guthaben von ${euroDe(Math.round(c.rng.next() * 8000) / 100)} wird Ihnen erstattet.\n\nIhr neuer monatlicher Abschlag beträgt ${euroDe(amount)}.\n\nIhre Stadtwerke Lindenau`
          : `Sehr geehrter Kunde,\n\nIhr monatlicher Abschlag für Strom ändert sich ab ${monthDe(c.at + 30 * DAY)} auf ${euroDe(amount)}.\n\nIhre Stadtwerke Lindenau`,
        attachments: yearly
          ? [
              {
                filename: `Jahresabrechnung_Strom_2025_${number}.pdf`,
                mimeType: "application/pdf",
                data: makePdf("Jahresabrechnung Strom 2025", [
                  { text: "Stadtwerke Lindenau", size: 18, bold: true },
                  { text: "Jahresabrechnung Strom 2025", size: 12, gap: 4 },
                  { text: `Vertragskonto: ${number}`, gap: 16 },
                  { text: `Rechnungsdatum: ${dateDe(c.at)}` },
                  { text: "Verbrauch 01.01.–31.12.2025: 2.418 kWh", gap: 14 },
                  { text: "Arbeitspreis", gap: 10, right: euroDe(701.22) },
                  { text: "Grundpreis", right: euroDe(156.0) },
                  { text: "Umsatzsteuer 19 %", right: euroDe(162.87) },
                  { text: "Gesamtbetrag", bold: true, right: euroDe(1020.09) },
                  { text: "Geleistete Abschläge", right: euroDe(1068.0) },
                  { text: "Guthaben", bold: true, right: euroDe(47.91) },
                ]),
              },
            ]
          : undefined,
        fromMe: false,
        at: c.at,
      },
    ],
    labels: yearly && c.rng.chance(0.5) ? ["Invoices"] : [],
    place: c.age > 10 ? "archive" : "inbox",
  };
}

const FAMILY_THREADS: { subject: string; from: keyof typeof PEOPLE; text: string; reply?: string; answer?: string }[] = [
  {
    subject: "موعد العشاء يوم الجمعة",
    from: "mama",
    text: "حبيبي أليكس،\n\nالعشاء عندنا يوم الجمعة الساعة السابعة مساءً. خالتك ستأتي مع الأولاد. لا تتأخر!\n\nأمك",
    reply: "إن شاء الله يا ماما، سأكون هناك في الوقت. هل أحضر شيئاً معي؟",
    answer: "أحضر الحلويات من المحل الذي تحبه. ننتظرك ❤️",
  },
  {
    subject: "صور العيد",
    from: "layla",
    text: "مرحباً أليكس،\n\nأرسلت لك بعض الصور من يوم العيد. الأطفال كانوا سعداء جداً بالهدايا!\n\nليلى",
    reply: "صور جميلة جداً! شكراً يا ليلى، كل عام وأنتم بخير.",
  },
  {
    subject: "كيف حالك؟",
    from: "yusuf",
    text: "أهلاً أخي،\n\nكيف حالك وكيف الشغل؟ رأيت الفيديو الجديد على القناة، كان رائعاً. متى ستزورنا؟\n\nيوسف",
    reply: "أهلاً يوسف! الحمد لله، الشغل كثير هذه الأيام. سأزوركم الشهر القادم إن شاء الله.",
    answer: "ممتاز، أخبرني بالموعد حتى أرتب وقتي.",
  },
  {
    subject: "عيد ميلاد ماما",
    from: "yusuf",
    text: "أليكس، عيد ميلاد ماما بعد أسبوعين. ما رأيك أن نشتري لها هدية مشتركة؟ عندي فكرة: ساعة جديدة.",
    reply: "فكرة ممتازة، أنا موافق. أرسل لي الرابط وسأدفع نصيبي.",
  },
  {
    subject: "وصفة الكبة",
    from: "mama",
    text: "يا ابني، هذه وصفة الكبة التي طلبتها:\n\n- نصف كيلو برغل ناعم\n- ربع كيلو لحم مفروم\n- بصلة كبيرة\n- بهارات: كمون، فلفل، قرفة\n\nاتصل بي إذا احتجت مساعدة.",
  },
];

export function familyThread(c: Ctx, index?: number): DemoThread {
  const f = FAMILY_THREADS[index ?? c.rng.int(0, FAMILY_THREADS.length - 1)]!;
  const from = PEOPLE[f.from];
  const messages: DemoMessage[] = [{ from, to: [c.me], subject: f.subject, text: f.text, fromMe: false, at: c.at }];
  if (f.reply) messages.push({ from: c.me, to: [from], subject: `رد: ${f.subject}`, text: f.reply, fromMe: true, at: c.at + c.rng.int(1, 8) * HOUR });
  if (f.reply && f.answer) messages.push({ from, to: [c.me], subject: `رد: ${f.subject}`, text: f.answer, fromMe: false, at: c.at + c.rng.int(9, 26) * HOUR });
  return {
    kind: "family",
    messages: clampTimes(messages, c.now),
    labels: c.rng.chance(0.6) ? ["Family"] : [],
    place: c.age > 20 && c.rng.chance(0.5) ? "archive" : "inbox",
    starred: c.rng.chance(0.1),
  };
}

/** The family message with an inline (cid:) image. */
export function familyPhotoThread(c: Ctx): DemoThread {
  const png = makePng(64, 40, (x, y) => {
    const sky = y < 22;
    const sun = (x - 48) ** 2 + (y - 10) ** 2 < 40;
    if (sun) return [253, 224, 71];
    if (sky) return [96 + y * 3, 165 + y, 250];
    const hill = y > 22 + Math.round(4 * Math.sin(x / 9));
    return hill ? [34 + (x % 7), 139, 84] : [134, 239, 172];
  });
  return {
    kind: "family",
    key: "family-photo",
    messages: [
      {
        from: PEOPLE.layla,
        to: [c.me],
        subject: "صورة من الرحلة 🌄",
        text: "شوف المنظر من الرحلة يوم السبت! [صورة]\n\nليلى",
        html: `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;font-size:15px;line-height:1.7"><p>شوف المنظر من الرحلة يوم السبت!</p><p><img src="cid:trip-photo@familie-home.example" width="320" height="200" alt="منظر من الرحلة" style="border-radius:8px"></p><p>ليلى</p></div>`,
        attachments: [{ filename: "trip.png", mimeType: "image/png", data: png, contentId: "trip-photo@familie-home.example", inline: true }],
        fromMe: false,
        at: c.at,
      },
    ],
    labels: ["Family"],
    place: "inbox",
  };
}

// ── Business correspondence ─────────────────────────────────────────────────────────────────

export function partnerThread(c: Ctx): DemoThread {
  const topics = [
    {
      subject: "Collab call next week?",
      open: "Hi Alex,\n\nWe're planning a creator collab for the winter recipe season and would love to have Brightwave on board. Do you have 30 minutes next week for a quick call?\n\nBest,\nLena\nKreator Network",
      reply: "Hi Lena,\n\nSounds great! Tuesday or Thursday afternoon works for me. Send an invite whenever you like.\n\nBest,\nAlex",
      answer: "Perfect — Thursday 15:00 it is. Invite is on its way.\n\nLena",
    },
    {
      subject: "Revenue share statement Q3",
      open: "Hi Alex,\n\nAttached is your revenue share statement for Q3. Payout goes out with the next payment run.\n\nKind regards,\nKreator Network Finance",
      reply: null,
      answer: null,
    },
    {
      subject: "Thumbnail feedback for the Ember Valley video",
      open: "Hey Alex,\n\nThe sponsor asked for two small changes on the thumbnail: a bit more contrast on the logo and the title text 10% smaller. Can you send a revised version by Friday?\n\nThanks!\nLena",
      reply: "Hi Lena,\n\nNo problem, revised thumbnail coming Thursday.\n\nAlex",
      answer: null,
    },
  ];
  const t = c.rng.pick(topics);
  const from = t === topics[1] ? PEOPLE.kreator : PEOPLE.lena;
  const messages: DemoMessage[] = [
    {
      from,
      to: [c.me],
      subject: t.subject,
      text: t.open,
      attachments:
        t === topics[1]
          ? [
              {
                filename: "Kreator_Network_Revenue_Share_Q3.pdf",
                mimeType: "application/pdf",
                data: makePdf("Revenue share Q3", [
                  { text: "Kreator Network", size: 18, bold: true },
                  { text: "Revenue share statement Q3 2026", size: 12, gap: 4 },
                  { text: "Partner: Brightwave Studio", gap: 16 },
                  { text: "Gross revenue", gap: 14, right: euroEn(9412.4) },
                  { text: "Network share (20%)", right: euroEn(1882.48) },
                  { text: "Payout", bold: true, right: euroEn(7529.92) },
                ]),
              },
            ]
          : undefined,
      fromMe: false,
      at: c.at,
    },
  ];
  if (t.reply) messages.push({ from: c.me, to: [from], subject: `Re: ${t.subject}`, text: t.reply, fromMe: true, at: c.at + c.rng.int(2, 20) * HOUR });
  if (t.reply && t.answer) messages.push({ from, to: [c.me], subject: `Re: ${t.subject}`, text: t.answer, fromMe: false, at: c.at + c.rng.int(21, 40) * HOUR });
  return {
    kind: "partner",
    messages: clampTimes(messages, c.now),
    labels: [],
    place: c.age > 20 && c.rng.chance(0.6) ? "archive" : "inbox",
    starred: c.rng.chance(0.1),
  };
}

export function inviteThread(c: Ctx): DemoThread {
  const start = c.at + c.rng.int(2, 9) * DAY;
  const startAt = new Date(start);
  startAt.setHours(c.rng.pick([10, 11, 14, 15, 16]), 0, 0, 0);
  const options = [
    { title: "Abstimmung Q4-Kampagne", organizer: PEOPLE.lena, location: "Video call", de: true },
    { title: "Collab call with Kreator Network", organizer: PEOPLE.lena, location: "Video call", de: false },
    { title: "Besprechung Jahresabschluss", organizer: PEOPLE.weber, location: "Kanzlei Weber & Partner, Lindenau", de: true },
    { title: "Sponsor review: Ember Valley", organizer: a("Mika Tanaka", "mika@embervalley-game.example"), location: "Video call", de: false },
  ];
  const o = c.rng.pick(options);
  const when = startAt.toLocaleString(o.de ? "de-DE" : "en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return {
    kind: "invite",
    messages: [
      {
        from: o.organizer,
        to: [c.me],
        subject: o.de ? `Einladung: ${o.title} @ ${when}` : `Invitation: ${o.title} @ ${when}`,
        text: o.de
          ? `${o.organizer.name} hat Sie zu einem Termin eingeladen.\n\n${o.title}\nWann: ${when} (45 Minuten)\nWo: ${o.location}\n\nZusagen, absagen oder einen neuen Termin vorschlagen: Öffnen Sie die Einladung im Anhang.`
          : `${o.organizer.name} invited you to an event.\n\n${o.title}\nWhen: ${when} (45 minutes)\nWhere: ${o.location}\n\nAccept, decline or propose a new time by opening the attached invite.`,
        attachments: [
          {
            filename: "invite.ics",
            mimeType: "text/calendar",
            data: makeIcs({ uid: `${c.rng.int(100000, 999999)}@demo.example`, title: o.title, start: startAt.getTime(), minutes: 45, organizer: o.organizer.address, location: o.location }),
          },
        ],
        fromMe: false,
        at: c.at,
      },
    ],
    labels: [],
    place: c.age > 10 ? "archive" : "inbox",
  };
}

export function sentOnlyThread(c: Ctx): DemoThread {
  const options = [
    {
      to: a("Clara Vogel", "clara.vogel@pixelmarkt.example"),
      subject: "Angebot Videoproduktion Produktlaunch",
      text: `Hallo Clara,\n\nwie besprochen hier unser Angebot für das Launch-Video (60 s, inkl. Schnitt und zwei Korrekturschleifen): ${euroDe(2400)} netto.\n\nLieferung zwei Wochen nach Briefing.\n\n${signoffDe(c.me)}`,
    },
    {
      to: a("Hausverwaltung Berger", "info@hv-berger.example"),
      subject: "Heizung im Studio – Wartungstermin",
      text: `Guten Tag,\n\ndie Heizung im Studio (EG links) macht seit einer Woche Geräusche. Könnten Sie einen Wartungstermin vereinbaren?\n\n${signoffDe(c.me)}`,
    },
    {
      to: a("Jonas Becker", "jonas.becker@novapad.example"),
      subject: "Footage for the NovaPad integration",
      text: `Hi Jonas,\n\nthe rough cut of the NovaPad segment is ready for review: 74 seconds, with the drawing timelapse you asked for. Download link expires in 7 days.\n\n${signoffEn(c.me)}`,
    },
  ];
  const o = c.rng.pick(options);
  return { kind: "sent", messages: [{ from: c.me, to: [o.to], subject: o.subject, text: o.text, fromMe: true, at: c.at }], labels: [], place: "sent" };
}

export function spamThread(c: Ctx): DemoThread {
  const options = [
    { from: a("Gewinnspiel Team", "winner@lucky-prize.example"), subject: "Herzlichen Glückwunsch!!! Sie haben einen 1000€ Gutschein gewonnen", text: "Klicken Sie JETZT hier, um Ihren Gewinn abzuholen. Nur noch heute gültig!!!" },
    { from: a("Nordbank Sicherheit", "security@nordbank-verify.example"), subject: "Dringend: Ihr Konto wird gesperrt", text: "Sehr geehrter Kunde, Ihr Konto wird in 24 Stunden gesperrt. Bestätigen Sie Ihre Daten unter folgendem Link." },
    { from: a("Crypto Daily Gains", "vip@crypto-gains.example"), subject: "Turn €250 into €12,000 in 30 days", text: "Our AI trading bot made 4,700% last year. Limited seats. Reply YES to join." },
    { from: a("SEO Experts", "outreach@rank-fast.example"), subject: "Your channel deserves 1M subscribers", text: "We guarantee 1,000,000 subscribers in 60 days. 100% safe. Packages from $99." },
  ];
  const o = c.rng.pick(options);
  return { kind: "spam", messages: [{ from: o.from, to: [c.me], subject: o.subject, text: o.text, fromMe: false, at: c.at }], labels: [], place: "spam" };
}
