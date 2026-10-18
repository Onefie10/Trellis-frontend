/** Limits UI work from a telemetry peer that sends a burst of events. */
export class TelemetryEventSampler {
  private windowStart = Number.NaN;
  private accepted = 0;

  constructor(
    private readonly maxEvents = 30,
    private readonly windowMs = 1_000
  ) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new RangeError('maxEvents must be positive');
    if (!Number.isFinite(windowMs) || windowMs < 1) throw new RangeError('windowMs must be positive');
  }

  /** Keep the first events in each window; reset on clock rollback or window expiry. */
  shouldAccept(now = Date.now()): boolean {
    if (!Number.isFinite(now)) return false;
    if (!Number.isFinite(this.windowStart) || now < this.windowStart || now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.accepted = 0;
    }
    if (this.accepted >= this.maxEvents) return false;
    this.accepted += 1;
    return true;
  }
}
