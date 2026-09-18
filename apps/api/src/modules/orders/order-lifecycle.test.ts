import type { OrderStatus } from '@tezusta/types';
import { describe, expect, it } from 'vitest';

import {
  allowedNextStatuses,
  assertOrderTransition,
  InvalidOrderTransitionError,
  isTerminalOrderStatus,
  ORDER_STATUSES,
  OrderTransitionNotPermittedError,
  type OrderTransitionActor,
} from './order-lifecycle';

/**
 * The transition table, restated here **from the ADR rather than from the
 * implementation**.
 *
 * Copying it out of `order-lifecycle.ts` would only prove the file equals
 * itself. Transcribing
 * [ADR-0015](docs/decisions/ADR-0015-order-lifecycle-states.md) by hand is what
 * makes this test able to catch the one defect that matters here — an edge
 * typed wrongly into the implementation — because the two transcriptions have
 * to agree.
 */
const ADR_0015_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  DRAFT: ['SEARCHING', 'CANCELLED'],
  SEARCHING: ['ACCEPTED', 'NO_MASTER_FOUND', 'CANCELLED'],
  ACCEPTED: ['MASTER_ON_THE_WAY', 'SEARCHING', 'CANCELLED'],
  MASTER_ON_THE_WAY: ['MASTER_ARRIVED', 'SEARCHING', 'CANCELLED'],
  MASTER_ARRIVED: ['IN_PROGRESS', 'SEARCHING', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: ['PAYMENT_PENDING', 'PAID', 'DISPUTED'],
  PAYMENT_PENDING: ['PAID', 'DISPUTED'],
  PAID: ['DISPUTED'],
  DISPUTED: ['RESOLVED', 'REFUNDED'],
  RESOLVED: [],
  REFUNDED: [],
  NO_MASTER_FOUND: [],
  CANCELLED: [],
};

const ADMIN: OrderTransitionActor = { kind: 'admin' };
const SYSTEM: OrderTransitionActor = { kind: 'system' };
const OWNING_CUSTOMER: OrderTransitionActor = { kind: 'customer', isOrderCustomer: true };
const OTHER_CUSTOMER: OrderTransitionActor = { kind: 'customer', isOrderCustomer: false };
const ASSIGNED_MASTER: OrderTransitionActor = { kind: 'master', isAssignedMaster: true };
const UNASSIGNED_MASTER: OrderTransitionActor = { kind: 'master', isAssignedMaster: false };

function everyStatusPair(): { from: OrderStatus; to: OrderStatus }[] {
  return ORDER_STATUSES.flatMap((from) => ORDER_STATUSES.map((to) => ({ from, to })));
}

function isLegalEdge(from: OrderStatus, to: OrderStatus): boolean {
  return ADR_0015_TRANSITIONS[from].includes(to);
}

describe('the order status set (ADR-0015)', () => {
  it('holds exactly the fourteen statuses the ADR names', () => {
    expect([...ORDER_STATUSES].sort()).toEqual([...Object.keys(ADR_0015_TRANSITIONS)].sort());
    expect(ORDER_STATUSES).toHaveLength(14);
  });

  it('reports exactly the ADR-0015 successors for every status', () => {
    for (const status of ORDER_STATUSES) {
      expect([...allowedNextStatuses(status)].sort()).toEqual(
        [...ADR_0015_TRANSITIONS[status]].sort(),
      );
    }
  });

  it('treats the four dead ends as terminal and nothing else', () => {
    const terminal = ORDER_STATUSES.filter((status) => isTerminalOrderStatus(status));
    expect([...terminal].sort()).toEqual(
      ['CANCELLED', 'NO_MASTER_FOUND', 'REFUNDED', 'RESOLVED'].sort(),
    );
  });
});

describe('assertOrderTransition — the edge table', () => {
  it('accepts every legal edge for an admin, who may drive any edge the table permits', () => {
    for (const { from, to } of everyStatusPair()) {
      if (!isLegalEdge(from, to)) continue;
      expect(() => {
        assertOrderTransition(from, to, ADMIN);
      }).not.toThrow();
    }
  });

  /**
   * The whole matrix, not a sample. 196 pairs minus the legal ones is where a
   * transposed row in the table would hide — a `SEARCHING → IN_PROGRESS` that
   * nobody thought to write a case for is exactly the edge that lets an order
   * skip a master ever arriving.
   */
  it('rejects every edge absent from the table, for an admin as much as anyone', () => {
    for (const { from, to } of everyStatusPair()) {
      if (isLegalEdge(from, to)) continue;
      expect(() => {
        assertOrderTransition(from, to, ADMIN);
      }).toThrow(InvalidOrderTransitionError);
    }
  });

  it('rejects a status moving to itself', () => {
    for (const status of ORDER_STATUSES) {
      expect(() => {
        assertOrderTransition(status, status, ADMIN);
      }).toThrow(InvalidOrderTransitionError);
    }
  });

  it('lets no actor move an order out of a terminal status', () => {
    const terminal = ORDER_STATUSES.filter((status) => isTerminalOrderStatus(status));
    for (const from of terminal) {
      for (const to of ORDER_STATUSES) {
        for (const actor of [ADMIN, SYSTEM, OWNING_CUSTOMER, ASSIGNED_MASTER]) {
          expect(() => {
            assertOrderTransition(from, to, actor);
          }).toThrow(InvalidOrderTransitionError);
        }
      }
    }
  });

  it('answers a rejected edge with a 409 and the pair that was refused', () => {
    try {
      assertOrderTransition('SEARCHING', 'IN_PROGRESS', ADMIN);
      expect.unreachable('the transition should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidOrderTransitionError);
      const refused = error as InvalidOrderTransitionError;
      expect(refused.status).toBe(409);
      expect(refused.details).toMatchObject({ from: 'SEARCHING', to: 'IN_PROGRESS' });
    }
  });
});

describe('assertOrderTransition — who may drive which edge', () => {
  it('lets the customer abandon their own order, at every stage the table allows', () => {
    for (const from of ORDER_STATUSES) {
      if (!isLegalEdge(from, 'CANCELLED')) continue;
      expect(() => {
        assertOrderTransition(from, 'CANCELLED', OWNING_CUSTOMER);
      }).not.toThrow();
    }
  });

  it('refuses a customer who is not this order’s customer', () => {
    expect(() => {
      assertOrderTransition('SEARCHING', 'CANCELLED', OTHER_CUSTOMER);
    }).toThrow(OrderTransitionNotPermittedError);
  });

  it('refuses the customer the edges that belong to the master', () => {
    const masterEdges: [OrderStatus, OrderStatus][] = [
      ['ACCEPTED', 'MASTER_ON_THE_WAY'],
      ['MASTER_ON_THE_WAY', 'MASTER_ARRIVED'],
      ['MASTER_ARRIVED', 'IN_PROGRESS'],
      ['IN_PROGRESS', 'COMPLETED'],
    ];
    for (const [from, to] of masterEdges) {
      expect(() => {
        assertOrderTransition(from, to, OWNING_CUSTOMER);
      }).toThrow(OrderTransitionNotPermittedError);
    }
  });

  it('lets an unassigned master claim a searching order, and nobody else', () => {
    expect(() => {
      assertOrderTransition('SEARCHING', 'ACCEPTED', UNASSIGNED_MASTER);
    }).not.toThrow();

    expect(() => {
      assertOrderTransition('SEARCHING', 'ACCEPTED', OWNING_CUSTOMER);
    }).toThrow(OrderTransitionNotPermittedError);

    expect(() => {
      assertOrderTransition('SEARCHING', 'ACCEPTED', SYSTEM);
    }).toThrow(OrderTransitionNotPermittedError);
  });

  it('refuses a master who is not the one assigned to the order', () => {
    const assignedMasterEdges: [OrderStatus, OrderStatus][] = [
      ['ACCEPTED', 'MASTER_ON_THE_WAY'],
      ['MASTER_ON_THE_WAY', 'MASTER_ARRIVED'],
      ['MASTER_ARRIVED', 'IN_PROGRESS'],
      ['IN_PROGRESS', 'COMPLETED'],
      ['ACCEPTED', 'SEARCHING'],
    ];
    for (const [from, to] of assignedMasterEdges) {
      expect(() => {
        assertOrderTransition(from, to, ASSIGNED_MASTER);
      }).not.toThrow();
      expect(() => {
        assertOrderTransition(from, to, UNASSIGNED_MASTER);
      }).toThrow(OrderTransitionNotPermittedError);
    }
  });

  /**
   * The customer cancels to `CANCELLED`; only the assigned master or an admin
   * sends an order back out to `SEARCHING` (ADR-0015 § Re-dispatch). If the
   * customer could do it, "I changed my mind" and "this master fell through"
   * would be the same event, and the cancellation rate would stop meaning
   * anything.
   */
  it('keeps re-dispatch away from the customer', () => {
    for (const from of ['ACCEPTED', 'MASTER_ON_THE_WAY', 'MASTER_ARRIVED'] as const) {
      expect(() => {
        assertOrderTransition(from, 'SEARCHING', OWNING_CUSTOMER);
      }).toThrow(OrderTransitionNotPermittedError);
      expect(() => {
        assertOrderTransition(from, 'SEARCHING', ADMIN);
      }).not.toThrow();
    }
  });

  it('gives the system the edges nobody chooses, and withholds the ones people do', () => {
    expect(() => {
      assertOrderTransition('DRAFT', 'SEARCHING', SYSTEM);
    }).not.toThrow();
    expect(() => {
      assertOrderTransition('SEARCHING', 'NO_MASTER_FOUND', SYSTEM);
    }).not.toThrow();

    expect(() => {
      assertOrderTransition('SEARCHING', 'CANCELLED', SYSTEM);
    }).toThrow(OrderTransitionNotPermittedError);
    expect(() => {
      assertOrderTransition('IN_PROGRESS', 'COMPLETED', SYSTEM);
    }).toThrow(OrderTransitionNotPermittedError);
  });

  it('reserves the dispute outcomes for an admin', () => {
    for (const to of ['RESOLVED', 'REFUNDED'] as const) {
      expect(() => {
        assertOrderTransition('DISPUTED', to, ADMIN);
      }).not.toThrow();
      for (const actor of [OWNING_CUSTOMER, ASSIGNED_MASTER, SYSTEM]) {
        expect(() => {
          assertOrderTransition('DISPUTED', to, actor);
        }).toThrow(OrderTransitionNotPermittedError);
      }
    }
  });

  it('answers a refused actor with a 403 rather than a conflict', () => {
    try {
      assertOrderTransition('IN_PROGRESS', 'COMPLETED', OWNING_CUSTOMER);
      expect.unreachable('the transition should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(OrderTransitionNotPermittedError);
      expect((error as OrderTransitionNotPermittedError).status).toBe(403);
    }
  });
});
