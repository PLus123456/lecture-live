// src/lib/audioLevelMonitor.ts
// v2.1 §B.3: Real-time audio level monitor using Web Audio API

export class AudioLevelMonitor {
  private analyser: AnalyserNode | null = null;
  private audioCtx: AudioContext | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private dataArray: any = null;
  private animationId: number | null = null;
  private onLevel: (level: number) => void;

  constructor(onLevel: (level: number) => void) {
    this.onLevel = onLevel;
  }

  /**
   * Connect to an audio stream and start monitoring levels
   */
  start(stream: MediaStream) {
    this.stop(); // clean up any existing monitor

    this.audioCtx = new AudioContext();
    const source = this.audioCtx.createMediaStreamSource(stream);

    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.7;
    source.connect(this.analyser);

    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.tick();
  }

  private tick() {
    if (!this.analyser || !this.dataArray) return;

    this.analyser.getByteFrequencyData(this.dataArray);

    // RMS calculation
    let sum = 0;
    for (let i = 0; i < this.dataArray.length; i++) {
      sum += this.dataArray[i] * this.dataArray[i];
    }
    const rms = Math.sqrt(sum / this.dataArray.length);
    const level = Math.min(rms / 128, 1.0); // normalize to 0~1

    this.onLevel(level);
    this.animationId = requestAnimationFrame(() => this.tick());
  }

  stop() {
    if (this.animationId) cancelAnimationFrame(this.animationId);
    this.audioCtx?.close().catch(() => {});
    this.analyser = null;
    this.audioCtx = null;
    this.dataArray = null;
    this.animationId = null;
  }
}
