import type { KeyboardEvent } from "react";

/** Fire `handler` on Enter / Space so non-button clickable elements stay keyboard-accessible. */
export function onActivateKey<E extends HTMLElement = HTMLElement>(handler: () => void) {
  return (e: KeyboardEvent<E>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handler();
    }
  };
}
