import { TelemetryEventSampler } from '@/lib/telemetry/sampler';

describe('TelemetryEventSampler', () => {
  it('caps accepted events per time window and resumes after the window', () => {
    const sampler = new TelemetryEventSampler(2, 1_000);
    expect(sampler.shouldAccept(10)).toBe(true);
    expect(sampler.shouldAccept(11)).toBe(true);
    expect(sampler.shouldAccept(12)).toBe(false);
    expect(sampler.shouldAccept(1_010)).toBe(true);
  });

  it('resets after the clock moves backward', () => {
    const sampler = new TelemetryEventSampler(1, 1_000);
    expect(sampler.shouldAccept(2_000)).toBe(true);
    expect(sampler.shouldAccept(2_001)).toBe(false);
    expect(sampler.shouldAccept(1_000)).toBe(true);
  });
});
