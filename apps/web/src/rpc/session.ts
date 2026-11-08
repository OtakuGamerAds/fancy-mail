/**
 * The desktop shell opens the app with `?t=<session token>`. In development the page comes
 * from Vite, so the client trades the token for the server's cookie itself, then removes it
 * from the address (the token never stays in history). In production the server already
 * did that with a redirect before the page loaded.
 */
export async function establishSession(): Promise<void> {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("t");
  if (!token) return;
  url.searchParams.delete("t");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  try {
    await fetch(`/api/session?t=${encodeURIComponent(token)}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    // The server may still be starting; the socket keeps retrying and the cookie may already be set.
  }
}
