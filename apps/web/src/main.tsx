import "@fontsource-variable/inter";
import "./index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { initWindowControls } from "./lib/windowControls";
import { rpcClient } from "./rpc/client";
import { establishSession } from "./rpc/session";
import { startEvents } from "./state/events";

initWindowControls();

// The session cookie first (dev: traded from ?t=), then the socket, then the UI.
void establishSession().finally(() => {
  startEvents();
  rpcClient.start();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
