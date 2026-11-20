/** Small rolling windows with hysteresis, including time spent on slow frames. */
export class WeatherBudget {
  quality: 0 | 1 | 2 = 2;
  private seconds = 0;
  private frames = 0;
  private recovery = 0;

  sample(delta: number): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.seconds += delta;
    this.frames++;
    if (this.seconds < 2) return;
    const fps = this.frames / this.seconds;
    if (fps < 18) {
      this.quality = 0;
      this.recovery = 0;
    } else if (fps < 32) {
      this.quality = Math.min(this.quality, 1) as 0 | 1;
      this.recovery = 0;
    } else if (fps >= 48) {
      this.recovery += this.seconds;
      if (this.recovery >= 8) {
        this.quality = Math.min(2, this.quality + 1) as 1 | 2;
        this.recovery = 0;
      }
    } else this.recovery = 0;
    this.seconds = 0;
    this.frames = 0;
  }
}
