import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Suppress the WKWebView native context menu on macOS — it leaks browser
// affordances like "Inspect Element", "Look Up", "Reload" into the desktop
// app. Keep it on inputs/textareas/contenteditables so the user still gets
// "Paste" etc. when editing text. App-defined context menus (shadcn/radix)
// run their own preventDefault before this listener and are unaffected.
if (typeof window !== "undefined") {
  window.addEventListener("contextmenu", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('input, textarea, [contenteditable="true"]')) return;
    event.preventDefault();
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
