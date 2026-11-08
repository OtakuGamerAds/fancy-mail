/**
 * Email HTML → a safe document for a sandboxed iframe. Email content is untrusted: no scripts,
 * forms, frames, objects or event handlers survive; <style> and inline styles do. Remote
 * images (img src/srcset, background attributes, CSS url()) are removed unless allowed, and
 * counted so the reader can offer "Show images". cid: images point at the server.
 */
import DOMPurify from "dompurify";

export interface SanitizedEmail {
  /** A whole <html> document for `srcdoc`. */
  document: string;
  /** How many remote images (or CSS backgrounds) were left out. */
  blockedImages: number;
}

const TRANSPARENT_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const FORBID_TAGS = [
  "script",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "optgroup",
  "datalist",
  "base",
  "meta",
  "link",
  "template",
  "audio",
  "video",
  "source",
  "track",
  "dialog",
  "canvas",
];

const FORBID_ATTR = ["action", "formaction", "ping", "srcdoc", "autofocus", "contenteditable", "popover"];

const REMOTE_URL = /^\s*(?:https?:)?\/\//i;
const CSS_REMOTE_URL = /url\(\s*(['"]?)\s*(?:https?:)?\/\/[^)]*\)/gi;
const CSS_IMPORT = /@import\s+[^;]+;?/gi;

/** The app's defaults inside the paper; the email's own styles come after and win. */
const BASE_CSS = `
html{color-scheme:light;overflow-x:auto;overflow-y:hidden}
body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f2328;background:transparent;overflow-wrap:break-word}
img{max-width:100%;height:auto}
a{color:#1a5fd6}
blockquote{margin:0 0 0 .8ex;border-left:2px solid #d0d7de;padding-left:1ex;color:#57606a}
pre{white-space:pre-wrap}
`;

function cidUrl(messageId: string, cid: string): string {
  const id = cid.replace(/^cid:/i, "").replace(/^<|>$/g, "");
  return `/api/messages/${encodeURIComponent(messageId)}/cid/${encodeURIComponent(id)}`;
}

export function sanitizeEmailHtml(
  html: string,
  options: { messageId: string; allowRemote: boolean },
): SanitizedEmail {
  let blocked = 0;
  const purify = DOMPurify(window);

  purify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style" && node.textContent) {
      let css = node.textContent.replace(CSS_IMPORT, "");
      if (!options.allowRemote) {
        css = css.replace(CSS_REMOTE_URL, () => {
          blocked++;
          return "none";
        });
      }
      node.textContent = css;
    }
  });

  purify.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    if (!el.getAttribute) return;
    const tag = el.tagName.toLowerCase();

    const style = el.getAttribute("style");
    if (style && !options.allowRemote && CSS_REMOTE_URL.test(style)) {
      CSS_REMOTE_URL.lastIndex = 0;
      el.setAttribute(
        "style",
        style.replace(CSS_REMOTE_URL, () => {
          blocked++;
          return "none";
        }),
      );
    }
    CSS_REMOTE_URL.lastIndex = 0;

    const background = el.getAttribute("background");
    if (background) {
      if (/^cid:/i.test(background)) el.setAttribute("background", cidUrl(options.messageId, background));
      else if (REMOTE_URL.test(background) && !options.allowRemote) {
        el.removeAttribute("background");
        blocked++;
      }
    }

    if (tag === "img") {
      const src = el.getAttribute("src") ?? "";
      if (/^cid:/i.test(src)) {
        el.setAttribute("src", cidUrl(options.messageId, src));
      } else if (REMOTE_URL.test(src) && !options.allowRemote) {
        el.setAttribute("src", TRANSPARENT_GIF);
        el.removeAttribute("alt");
        // A hidden image takes no room: an empty box the size of a newsletter's header reads
        // as a broken email. The bar above the message says images are hidden.
        el.setAttribute("style", `${el.getAttribute("style") ?? ""};display:none !important`);
        blocked++;
      }
      if (el.hasAttribute("srcset") && !options.allowRemote) {
        el.removeAttribute("srcset");
      }
      el.setAttribute("loading", "lazy");
      el.setAttribute("referrerpolicy", "no-referrer");
    }

    if (tag === "picture" || tag === "source") {
      el.removeAttribute("srcset");
    }

    // SVG references to remote files.
    if (tag === "image" || tag === "use" || tag === "feimage") {
      for (const attr of ["href", "xlink:href"]) {
        const value = el.getAttribute(attr);
        if (value && REMOTE_URL.test(value) && !options.allowRemote) {
          el.removeAttribute(attr);
          blocked++;
        }
      }
    }

    if (tag === "a") {
      const href = el.getAttribute("href");
      if (href) {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
    }
  });

  const root = purify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ["target"],
  }) as HTMLElement;

  const doc = root.ownerDocument;
  let head = root.querySelector("head");
  if (!head) {
    head = doc.createElement("head");
    root.insertBefore(head, root.firstChild);
  }
  const base = doc.createElement("base");
  base.setAttribute("target", "_blank");
  const charset = doc.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  const style = doc.createElement("style");
  style.textContent = BASE_CSS;
  head.insertBefore(style, head.firstChild);
  head.insertBefore(base, head.firstChild);
  head.insertBefore(charset, head.firstChild);

  return { document: `<!doctype html>${root.outerHTML}`, blockedImages: blocked };
}

/** Whether a message's sender is allowed to show remote images. */
export function senderAllowsImages(sender: string | null | undefined, allowed: string[]): boolean {
  if (!sender) return false;
  const address = sender.trim().toLowerCase();
  const domain = address.split("@")[1] ?? "";
  return allowed.some((entry) => {
    const e = entry.trim().toLowerCase();
    return e === address || (e.startsWith("@") ? e.slice(1) === domain : false);
  });
}
