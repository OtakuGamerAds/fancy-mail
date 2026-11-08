import { parseAddressList } from "~/lib/addresses";
import { useUi } from "~/state/ui";

/** A mailto: link opens a new message here instead of another mail program. */
export function openMailto(href: string) {
  try {
    const url = new URL(href);
    const to = decodeURIComponent(url.pathname);
    const subject = url.searchParams.get("subject") ?? undefined;
    const valid = parseAddressList(to).filter((p) => p.valid);
    useUi.getState().openCompose({
      ...(valid.length > 0 ? { to: valid.map((p) => p.address.address).join(", ") } : {}),
      ...(subject ? { subject } : {}),
    });
  } catch {
    useUi.getState().openCompose();
  }
}
