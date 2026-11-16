// Building a course a slice at a time. A course's scenery is a lot of work
// on the page's one thread (terrain, towns, forests, merges): done in one
// go, the page would stop for seconds, its cover's bar frozen and the
// netcode unable to send. Builders are generators that `yield` wherever
// the page may have a moment; a race runs them a slice at a time, and the
// menus, which have nothing else to do meanwhile, at once.

/** A builder: does its work in pieces, yielding between them, and gives what it built. */
export type Steps<T = void> = Generator<void, T, void>;

/** How long a slice works before the page has a moment (ms). */
const SLICE_MS = 12;

/** Builds at once, in one go. */
export function buildNow<T>(steps: Steps<T>): T {
  for (;;) {
    const s = steps.next();
    if (s.done) return s.value;
  }
}

/** Who waits for the page's next moment. */
const waiting: (() => void)[] = [];
let channel: MessageChannel | null = null;

/** Lets the page have a moment (draw a frame if one is due, run its timers, take input), in turn with its other
 * tasks: a message to itself, which no timer clamping slows. */
function breather(): Promise<void> {
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.addEventListener("message", () => waiting.shift()?.());
    channel.port1.start();
  }
  const port = channel.port2;
  return new Promise((resolve) => {
    waiting.push(resolve);
    port.postMessage(null);
  });
}

/** Builds a slice at a time (about SLICE_MS each), the page carrying on between slices. */
export function buildSliced<T>(steps: Steps<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const slice = () => {
      try {
        const until = performance.now() + SLICE_MS;
        for (;;) {
          const s = steps.next();
          if (s.done) {
            resolve(s.value);
            return;
          }
          if (performance.now() >= until) break;
        }
        void breather().then(slice);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    slice();
  });
}

/** A builder that does `work` (one piece). */
export function* step(work: () => void): Steps {
  work();
  yield;
}

/** Runs `work` for each of `items`, yielding after each. */
export function* each<T>(items: Iterable<T>, work: (item: T) => void): Steps {
  for (const item of items) {
    work(item);
    yield;
  }
}
