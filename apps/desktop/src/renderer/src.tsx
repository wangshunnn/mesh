import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { TooltipProvider } from "./ui/controls.js";
import "./app.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Mesh renderer root is missing.");
}

createRoot(root).render(
  <StrictMode>
    <TooltipProvider delayDuration={350} skipDelayDuration={150}>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
