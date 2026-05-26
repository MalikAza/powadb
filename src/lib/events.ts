/// Minimal typed in-process event bus.
///
/// Lets one Zustand store fire a notification without reaching into another
/// store's `getState()` — the receiving store (or any other module) subscribes
/// here instead, so the producer doesn't carry an import-time dependency on
/// the consumer. Mirrors `mitt` (~200 bytes) but kept inline so we don't pull
/// the dep just for two events.

/// The full map of events the app emits. Add a new entry here to introduce a
/// new event; both `emit` and `on` become type-safe against it automatically.
type EventMap = {
  /** A connection's tunnel/pool has been closed by the user. Payload is the
   *  connection id. */
  "connection-disconnected": string;
};

type Listener<T> = (payload: T) => void;

type Bus = {
  [K in keyof EventMap]: Set<Listener<EventMap[K]>>;
};

const bus: Bus = {
  "connection-disconnected": new Set(),
};

export function on<K extends keyof EventMap>(
  event: K,
  listener: Listener<EventMap[K]>,
): () => void {
  bus[event].add(listener);
  // Return an unsubscribe — useful as the return value of a useEffect.
  return () => {
    bus[event].delete(listener);
  };
}

export function emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
  // Snapshot before iterating in case a listener unsubscribes itself, which
  // would otherwise mutate the set mid-loop.
  for (const listener of [...bus[event]]) {
    try {
      listener(payload);
    } catch (e) {
      // One bad subscriber can't break the others.
      console.error(`events: listener for "${event}" threw`, e);
    }
  }
}

/// Test-only escape hatch. Reset the bus between Vitest cases so subscribers
/// from a previous test don't leak.
export function _resetForTests(): void {
  for (const key of Object.keys(bus) as (keyof EventMap)[]) {
    bus[key].clear();
  }
}
