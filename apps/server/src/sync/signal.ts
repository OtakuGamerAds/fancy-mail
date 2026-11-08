/** Small async primitives for the workers. */

/** A wake-up flag: `notify()` resolves the current `wait()` (or the next one, if none is waiting). */
export class Signal {
  #waiters: (() => void)[] = [];
  #pending = false;

  notify(): void {
    if (this.#waiters.length === 0) {
      this.#pending = true;
      return;
    }
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w();
  }

  /** Resolves true when notified, false when `ms` passed first. */
  wait(ms: number): Promise<boolean> {
    if (this.#pending) {
      this.#pending = false;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const waiter = () => {
        if (timer) clearTimeout(timer);
        resolve(true);
      };
      if (Number.isFinite(ms)) {
        timer = setTimeout(() => {
          this.#waiters = this.#waiters.filter((w) => w !== waiter);
          resolve(false);
        }, Math.max(0, ms));
      }
      this.#waiters.push(waiter);
    });
  }
}

/** At most `size` holders at once (the initial syncs); others wait in order. */
export class Semaphore {
  #free: number;
  #queue: (() => void)[] = [];

  constructor(size: number) {
    this.#free = size;
  }

  get available(): number {
    return this.#free;
  }

  /**
   * Resolves with the release function once a slot is free, or with null when `canceled()`
   * says the caller no longer wants it (checked when the slot would be granted, and on `poke`).
   */
  acquire(canceled: () => boolean = () => false): Promise<(() => void) | null> {
    return new Promise((resolve) => {
      const grant = (): boolean => {
        if (canceled()) {
          resolve(null);
          return false;
        }
        this.#free--;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.#free++;
          this.#next();
        });
        return true;
      };
      if (this.#free > 0) grant();
      else this.#queue.push(() => void grant());
    });
  }

  #next(): void {
    while (this.#free > 0 && this.#queue.length > 0) {
      const before = this.#free;
      this.#queue.shift()!();
      if (this.#free < before) return;
    }
  }
}
