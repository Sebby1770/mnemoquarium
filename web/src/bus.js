/* A minimum viable event bus. Subsystems shout; whoever cares listens. */

export class Bus {
  constructor() {
    this.handlers = new Map();
  }

  on(name, fn) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(fn);
    return () => this.off(name, fn);
  }

  once(name, fn) {
    const off = this.on(name, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off(name, fn) {
    const set = this.handlers.get(name);
    if (set) set.delete(fn);
  }

  emit(name, payload) {
    const set = this.handlers.get(name);
    if (!set) return;
    // Copy so a handler may unsubscribe itself mid-emit.
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`bus handler for "${name}" failed`, err);
      }
    }
  }

  clear() {
    this.handlers.clear();
  }
}
