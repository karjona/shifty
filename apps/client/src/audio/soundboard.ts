// Dev: the sound board (`/?sfx`). Plays every one-shot, and drives the
// continuous voices from sliders (throttle, speed, edge, air...), with
// another rider flying past for the placement and Doppler.
import { GUI } from "lil-gui";
import { gain } from "./dsp.ts";
import { type Heard, Hearing } from "./hearing.ts";
import { audio } from "./index.ts";
import { SOUND_NAMES } from "./library.ts";
import { Board, FarBoard, FarJetski, Hull, JetEngine, stepRevs, Wind } from "./voices.ts";

export function soundBoard(): void {
  audio.install();
  const note = document.createElement("div");
  note.textContent = "Shifty sound board: click anywhere to start the sound, then play with the panel.";
  Object.assign(note.style, { position: "fixed", left: "24px", top: "24px", color: "#111", font: "16px sans-serif" });
  document.body.append(note);

  const gui = new GUI({ title: "Shifty sound board", width: 340 });
  Object.assign(gui.domElement.style, { maxHeight: "100vh", overflowY: "auto" });
  const shots = gui.addFolder("One-shots");
  const rate = { rate: 1, level: 1 };
  shots.add(rate, "level", 0, 1, 0.05);
  shots.add(rate, "rate", 0.5, 2, 0.01);
  for (const name of SOUND_NAMES) {
    shots.add({ [name]: () => audio.play(name, rate.level, 0, rate.rate) }, name);
  }
  shots
    .add(
      {
        countdown: () => {
          for (const at of [0, 1000, 2000]) setTimeout(() => audio.play("count"), at);
          setTimeout(() => audio.play("go"), 3000);
        },
      },
      "countdown",
    )
    .name("3, 2, 1, GO");

  const jet = { on: false, throttle: 0, speed: 0, steer: 0, air: false, bail: false, chop: 0 };
  const fj = gui.addFolder("Jetski (yours)");
  fj.add(jet, "on");
  fj.add(jet, "throttle", -1, 1, 0.01);
  fj.add(jet, "speed", 0, 1.2, 0.01);
  fj.add(jet, "steer", -1, 1, 0.01);
  fj.add(jet, "chop", 0, 1, 0.01);
  fj.add(jet, "air");
  fj.add(jet, "bail");

  const snow = { on: false, speed: 0, edge: 0, skid: 0, wobble: 0, air: false };
  const fs = gui.addFolder("Snowboard (yours)");
  fs.add(snow, "on");
  fs.add(snow, "speed", 0, 1.2, 0.01);
  fs.add(snow, "edge", 0, 1, 0.01);
  fs.add(snow, "skid", 0, 1, 0.01);
  fs.add(snow, "wobble", 0, 1, 0.01);
  fs.add(snow, "air");

  const other = { on: false, sport: "jetski", speed: 0.9, offset: 10, flyBy: true, x: -150 };
  const fo = gui.addFolder("Another rider (flies past)");
  fo.add(other, "on");
  fo.add(other, "sport", ["jetski", "snow"]);
  fo.add(other, "speed", 0, 1.2, 0.01);
  fo.add(other, "offset", 2, 80, 1).name("passes at (m)");
  fo.add(other, "flyBy").name("moving");
  fo.add(other, "x", -160, 160, 1).name("along (m)").listen();

  const vol = { master: audio.volume("master"), effects: audio.volume("effects"), music: audio.volume("music") };
  const fv = gui.addFolder("Volume");
  for (const k of ["master", "effects", "music"] as const) {
    fv.add(vol, k, 0, 1, 0.05).onChange((v: number) => audio.setVolume(k, v));
  }

  let voices: {
    jetBus: GainNode;
    snowBus: GainNode;
    otherBus: GainNode;
    engine: JetEngine;
    hull: Hull;
    jetWind: Wind;
    board: Board;
    snowWind: Wind;
    farJet: FarJetski;
    farBoard: FarBoard;
  } | null = null;
  const hearing = new Hearing();
  const heard: Heard = { level: 0, pan: 0, cutoff: 0, doppler: 1 };
  let revs = 0.19;
  let last = performance.now();
  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const ctx = audio.ctx;
    const kit = audio.kit;
    const sfx = audio.sfx;
    if (!ctx || !kit || !sfx) return;
    note.hidden = ctx.state === "running";
    if (!voices) {
      const bus = (): GainNode => {
        const g = gain(ctx, 0);
        g.connect(sfx);
        return g;
      };
      const jetBus = bus();
      const snowBus = bus();
      const otherBus = bus();
      const v = {
        jetBus,
        snowBus,
        otherBus,
        engine: new JetEngine(ctx, kit),
        hull: new Hull(ctx, kit),
        jetWind: new Wind(ctx, kit),
        board: new Board(ctx, kit),
        snowWind: new Wind(ctx, kit),
        farJet: new FarJetski(ctx, kit, otherBus),
        farBoard: new FarBoard(ctx, kit, otherBus),
      };
      v.engine.out.connect(jetBus);
      v.hull.out.connect(jetBus);
      v.jetWind.out.connect(jetBus);
      v.board.out.connect(snowBus);
      v.snowWind.out.connect(snowBus);
      voices = v;
    }
    const t = ctx.currentTime;
    const v = voices;
    v.jetBus.gain.setTargetAtTime(jet.on ? 1 : 0, t, 0.05);
    v.snowBus.gain.setTargetAtTime(snow.on ? 1 : 0, t, 0.05);
    v.otherBus.gain.setTargetAtTime(other.on ? 1 : 0, t, 0.05);
    v.engine.update(t, dt, jet.throttle, jet.speed, jet.air, jet.bail);
    v.hull.update(t, jet.speed, jet.air, jet.bail, jet.steer, jet.chop);
    v.jetWind.update(t, jet.speed, jet.air);
    v.board.update(t, snow.speed, snow.edge, snow.skid, snow.air, snow.wobble);
    v.snowWind.update(t, snow.speed, snow.air);

    // The other rider runs along x, `offset` m in front of a listener at the origin facing -z.
    const speed = other.speed * 30;
    if (other.flyBy) {
      other.x += speed * dt;
      if (other.x > 160) other.x = -160;
    }
    hearing.hear(other.x, 0, -other.offset, other.flyBy ? speed : 0, 0, 0, heard);
    revs = stepRevs(revs, dt, 1, other.speed, false, false);
    v.farJet.update(
      t,
      revs,
      1,
      other.speed,
      false,
      heard.doppler,
      other.sport === "jetski" ? heard.level : 0,
      heard.pan,
      heard.cutoff,
    );
    v.farBoard.update(t, other.speed, 0.5, 0, false, other.sport === "snow" ? heard.level : 0, heard.pan, heard.cutoff);
  };
  requestAnimationFrame(frame);
}
