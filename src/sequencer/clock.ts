// Lookahead transport clock. Fires step callbacks with *audio-context time*
// so scheduling is sample-accurate even though JS timers jitter.

export type StepCallback = (step: number, time: number, stepDur: number) => void;

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12; // seconds

export class Clock {
  bpm = 100;
  swing = 0;               // 0..1, delays every odd 16th
  stepsPerBar = 16;

  private nextStepTime = 0;
  private step = 0;        // global step counter (16ths)
  private timer: number | null = null;
  private callbacks: StepCallback[] = [];

  constructor(private ctx: AudioContext) {}

  get running() { return this.timer !== null; }
  get currentStep() { return this.step; }
  get stepDur() { return 60 / this.bpm / 4; } // one 16th

  onStep(cb: StepCallback) { this.callbacks.push(cb); }

  start() {
    if (this.timer !== null) return;
    this.step = 0;
    this.nextStepTime = this.ctx.currentTime + 0.06;
    this.timer = window.setInterval(() => this.tick(), LOOKAHEAD_MS);
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.step = 0;
  }

  /** Audio time of the next bar boundary (for quantized loop punch-in). */
  nextBarTime(): number {
    if (!this.running) return this.ctx.currentTime;
    const stepsToBar = (this.stepsPerBar - (this.step % this.stepsPerBar)) % this.stepsPerBar;
    return this.nextStepTime + stepsToBar * this.stepDur;
  }

  barDur(): number { return this.stepDur * this.stepsPerBar; }

  /** Map an event happening "now" onto the nearest step index (live-record quantize). */
  quantizeNow(): number {
    const t = this.ctx.currentTime;
    const rel = (t - this.nextStepTime) / this.stepDur; // negative = before next step
    const nearest = rel > -0.5 ? this.step : this.step - 1;
    return ((nearest % this.stepsPerBar) + this.stepsPerBar) % this.stepsPerBar;
  }

  private tick() {
    while (this.nextStepTime < this.ctx.currentTime + SCHEDULE_AHEAD) {
      const dur = this.stepDur;
      let t = this.nextStepTime;
      if (this.step % 2 === 1) t += this.swing * dur * 0.45; // swing odd 16ths
      for (const cb of this.callbacks) cb(this.step, t, dur);
      this.step++;
      this.nextStepTime += dur;
    }
  }
}
