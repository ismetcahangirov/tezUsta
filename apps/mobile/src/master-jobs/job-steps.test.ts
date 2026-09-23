import type { OrderStatus } from '@tezusta/types';

import { jobStepFor, reportingStateFor } from './job-steps';

describe('jobStepFor', () => {
  it('walks the job forward one status at a time, ending at completed', () => {
    const walked: OrderStatus[] = [];
    let status: OrderStatus | null = 'ACCEPTED';

    while (status !== null) {
      walked.push(status);
      status = jobStepFor(status)?.next ?? null;
    }

    expect(walked).toEqual([
      'ACCEPTED',
      'MASTER_ON_THE_WAY',
      'MASTER_ARRIVED',
      'IN_PROGRESS',
      'COMPLETED',
    ]);
  });

  it('offers a hand-back before work starts, and never once it has (ADR-0015)', () => {
    expect(jobStepFor('ACCEPTED')?.canHandBack).toBe(true);
    expect(jobStepFor('MASTER_ON_THE_WAY')?.canHandBack).toBe(true);
    expect(jobStepFor('MASTER_ARRIVED')?.canHandBack).toBe(true);
    expect(jobStepFor('IN_PROGRESS')?.canHandBack).toBe(false);
  });

  it.each<OrderStatus>([
    'SEARCHING',
    'COMPLETED',
    'CANCELLED',
    'NO_MASTER_FOUND',
    'PAID',
    'DISPUTED',
  ])('has no step for %s, which is not a job a master is on', (status) => {
    expect(jobStepFor(status)).toBeNull();
  });
});

describe('reportingStateFor', () => {
  it('reports nothing while the master is unavailable, even with a job', () => {
    expect(reportingStateFor(false, null)).toBe('offline');
    expect(reportingStateFor(false, 'MASTER_ON_THE_WAY')).toBe('offline');
  });

  it('reports at the idle floor while available with no job', () => {
    expect(reportingStateFor(true, null)).toBe('online');
  });

  it('reports at the travelling cadence from accept until arrival', () => {
    expect(reportingStateFor(true, 'ACCEPTED')).toBe('travelling');
    expect(reportingStateFor(true, 'MASTER_ON_THE_WAY')).toBe('travelling');
  });

  it('drops to the working floor once the master has arrived', () => {
    expect(reportingStateFor(true, 'MASTER_ARRIVED')).toBe('working');
    expect(reportingStateFor(true, 'IN_PROGRESS')).toBe('working');
  });

  it('goes back to idle for a status that is no longer a job', () => {
    expect(reportingStateFor(true, 'COMPLETED')).toBe('online');
  });
});
