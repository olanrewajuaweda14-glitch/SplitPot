// Atomic JSON document store with a process-wide mutex.
//
//  - transact(fn): fn receives a deep-cloned draft and MUST be synchronous. Anything
//    async (provider calls, network, timers) inside a transaction would hold the lock
//    during I/O, so a Promise return is rejected as a programming error. The engine
//    follows: intent (transaction) -> provider call (no lock) -> result (transaction).
//  - Commit is durable-then-visible: the new state is written to a temp file, fsynced,
//    renamed over the real file, and only then swapped in. If fn throws, or the write
//    fails, nothing changes.
//  - Transactions run strictly one at a time (promise-chain mutex).
//  - Pass file: null for an in-memory store (tests).

import fs from 'node:fs';
import path from 'node:path';
import { InternalError } from '../shared/errors.js';

export class JsonStore {
  #state;
  #serialized;
  #file;
  #queue = Promise.resolve();

  constructor({ file = null, initial }) {
    this.#file = file;
    let state = null;
    if (file && fs.existsSync(file)) {
      try {
        state = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        // Never silently discard a corrupt store: keep it for inspection and start clean.
        const quarantine = `${file}.corrupt-${Date.now()}`;
        fs.renameSync(file, quarantine);
        console.error(`[store] ${file} was unreadable (${err.message}); moved to ${quarantine}`);
      }
    }
    this.#state = state ?? initial();
    if (typeof this.#state.version !== 'number') this.#state.version = 0;
    this.#serialized = JSON.stringify(this.#state);
    if (file && !state) this.#writeSync(this.#serialized);
  }

  get version() {
    return this.#state.version;
  }

  /** Read-only deep copy of the committed state. */
  snapshot() {
    return structuredClone(this.#state);
  }

  /**
   * Synchronous read of the committed state WITHOUT copying. `fn` must not mutate its argument
   * or keep a reference to it. Cheaper than snapshot() on hot paths (clock, token lookups).
   */
  read(fn) {
    return fn(this.#state);
  }

  /**
   * Run `fn(draft)` under the mutex. Returns fn's return value after the commit lands.
   * If fn leaves the draft unchanged, nothing is written and the version does not move.
   */
  transact(fn) {
    const run = async () => {
      const draft = structuredClone(this.#state);
      const priorVersion = draft.version;
      const result = fn(draft);
      if (result && typeof result.then === 'function') {
        throw new InternalError(
          'Store transactions must be synchronous. Do provider/network calls outside the lock.',
        );
      }
      draft.version = priorVersion;
      const next = JSON.stringify(draft);
      if (next !== this.#serialized) {
        draft.version = priorVersion + 1;
        const out = JSON.stringify(draft);
        await this.#write(out); // durable first...
        this.#state = draft; // ...then visible
        this.#serialized = out;
      }
      return result;
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => {});
    return p;
  }

  async #write(json) {
    if (!this.#file) return;
    const tmp = `${this.#file}.${process.pid}.tmp`;
    const fh = await fs.promises.open(tmp, 'w');
    try {
      await fh.writeFile(json);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.promises.rename(tmp, this.#file);
  }

  #writeSync(json) {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, this.#file);
  }
}
