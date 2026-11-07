// The race's title card, over the intro's fly-over: the circuit's name and
// place, then numbered rows of what the race is run in (season, laps or the
// run's length; weather and time of day go in as rows too), and while the
// race waits for every screen, a line saying so. Riviera paper, laid out on
// the HUD's 1920×1080 canvas.
import "./intro-card.css";

export interface IntroFacts {
  /** "The Tilt · race 1 of 4", or the place. */
  kicker: string;
  title: string;
  subtitle: string;
  /** Label and value, in order. */
  rows: [string, string][];
  /** The season's accent colour (CSS). */
  accent: string;
  /** The line shown while the race waits for every screen. */
  waiting: string;
}

export class IntroCard {
  private el: HTMLDivElement;
  private wait: HTMLDivElement;
  private shown = false;

  constructor(root: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "intro-card";
    this.wait = document.createElement("div");
    this.wait.className = "intro-wait";
    root.append(this.el, this.wait);
  }

  set(facts: IntroFacts): void {
    const el = this.el;
    el.style.setProperty("--accent", facts.accent);
    el.replaceChildren();
    const kicker = document.createElement("div");
    kicker.className = "intro-kicker";
    kicker.append(document.createElement("i"), facts.kicker);
    const title = document.createElement("h2");
    title.className = "intro-title";
    title.textContent = facts.title;
    const subtitle = document.createElement("div");
    subtitle.className = "intro-subtitle";
    subtitle.textContent = facts.subtitle;
    const rows = document.createElement("ol");
    rows.className = "intro-rows";
    facts.rows.forEach(([label, value], i) => {
      const row = document.createElement("li");
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = String(i + 1).padStart(2, "0");
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = label;
      const v = document.createElement("span");
      v.className = "v";
      v.textContent = value;
      row.append(n, k, v);
      rows.append(row);
    });
    el.append(kicker, title, subtitle, rows);
    this.wait.style.setProperty("--accent", facts.accent);
    this.wait.textContent = facts.waiting;
  }

  /** Up (sliding in), with the waiting line or not; or away. */
  show(on: boolean, waiting = false): void {
    if (on !== this.shown) {
      this.shown = on;
      this.el.classList.toggle("shown", on);
    }
    const wait = on && waiting;
    if (wait !== this.wait.classList.contains("shown")) this.wait.classList.toggle("shown", wait);
  }

  remove(): void {
    this.el.remove();
    this.wait.remove();
  }
}
