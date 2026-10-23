import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type {
  OrderArrivalPromiseRealtimeEvent,
  OrderOfferRealtimeEvent,
  OrderPriceRealtimeEvent,
  OrderSearchWaveRealtimeEvent,
  OrderTransitionRealtimeEvent,
} from '@tezusta/types';

import { OrderNotificationsRegistry } from '../orders/order-notifications.registry';
import type {
  OrderBroadcastEvent,
  OrderTransitionEvent,
} from '../orders/order-notifications.registry';
import { ArrivalPromisesRegistry } from '../orders/arrival-promises.registry';
import type { ArrivalPromiseWritten } from '../orders/arrival-promises.registry';
import { OrderPriceEventsRegistry } from '../orders/order-price-events.registry';
import type { OrderPriceEvent } from '../orders/order-price-events.registry';
import { OrderSearchWavesRegistry } from '../orders/order-search-waves.registry';
import type { OrderSearchWave } from '../orders/order-search-waves.registry';
import {
  ORDER_ARRIVAL_PROMISE_EVENT,
  ORDER_OFFER_EVENT,
  ORDER_PRICE_EVENT,
  ORDER_SEARCH_WAVE_EVENT,
  ORDER_TRANSITION_EVENT,
} from './realtime.events';
import { RealtimeGateway } from './realtime.gateway';
import { masterRoom, orderRoom, userRoom } from './room.types';

/**
 * What puts a committed order event on the socket (issue #168).
 *
 * **It fills a slot rather than being called**, subscribing to
 * `OrderNotificationsRegistry` from its own `onModuleInit` — the same shape
 * `OrderNotificationsService` uses, and the same reason: a push and a socket
 * frame are two deliveries of one fact, so the second consumer arrives the way
 * the first did rather than teaching `modules/orders` what a socket is. The
 * registry admits both, isolates their failures from each other, and swallows
 * them, which is where "a publish may never fail a transition" already lives.
 *
 * **Nothing here reads the database.** The committed row's ids and changed
 * fields arrive on the event; turning them into a payload is arithmetic. The
 * authorization question — who is in the room — was settled on join and is
 * re-settled on every transition by `RoomsService.revalidate`, which
 * `OrdersService` runs *before* this raise for exactly that reason. Asking it
 * again here would be a cluster round trip on the publish path.
 */
@Injectable()
export class OrderEventsPublisher implements OnModuleInit {
  private readonly logger = new Logger(OrderEventsPublisher.name);

  constructor(
    private readonly registry: OrderNotificationsRegistry,
    private readonly searchWaves: OrderSearchWavesRegistry,
    private readonly arrivalPromises: ArrivalPromisesRegistry,
    private readonly prices: OrderPriceEventsRegistry,
    private readonly gateway: RealtimeGateway,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      'realtime events',
      (event) => this.onTransition(event),
      (event) => this.onBroadcast(event),
    );
    this.searchWaves.register((wave) => this.onSearchWave(wave));
    this.arrivalPromises.register((promise) => this.onArrivalPromise(promise));
    this.prices.register('realtime events', (event) => this.onPrice(event));
  }

  /**
   * A quote or an approval becomes one frame in `order:{orderId}`, to the
   * other party (ADR-0060). The actor is told by the response to their own
   * request, as with a transition.
   */
  private onPrice(event: OrderPriceEvent): Promise<void> {
    const payload: OrderPriceRealtimeEvent = {
      orderId: event.orderId,
      priceMinor: event.priceMinor,
      priceApprovedAt: event.priceApprovedAt === null ? null : event.priceApprovedAt.toISOString(),
      at: Date.now(),
    };

    this.to(orderRoom(event.orderId), event.actorUserId)?.emit(ORDER_PRICE_EVENT, payload);

    return Promise.resolve();
  }

  /**
   * A fixed arrival promise becomes one frame in `order:{orderId}`, to both
   * parties (#396, ADR-0055 § 13). The system acted, so nobody is excluded.
   *
   * `at` is this instance's clock, taken now: with `promisedArrivalAt` it is
   * the time left measured on server clocks, which is what the phone anchors
   * its countdown to instead of its own wall clock.
   */
  private onArrivalPromise(promise: ArrivalPromiseWritten): Promise<void> {
    const payload: OrderArrivalPromiseRealtimeEvent = {
      orderId: promise.orderId,
      promisedArrivalAt: promise.promisedArrivalAt.toISOString(),
      source: promise.source,
      at: Date.now(),
    };

    this.to(orderRoom(promise.orderId))?.emit(ORDER_ARRIVAL_PROMISE_EVENT, payload);

    return Promise.resolve();
  }

  /**
   * One wave becomes one frame in `order:{orderId}`, for the customer's radar
   * (issue #397, ADR-0055 § 5).
   *
   * **The order's room, and only its customer is in it while it searches**:
   * the room admits the order's customer at every non-terminal status and a
   * master only once `orders.master_id` names them (#167). An offered master
   * hears about the order in their own room, never this one.
   *
   * No cell and no coordinate: the frame tells the app to re-read
   * `GET /orders/:id/search`, the one place positions are coarsened. Nobody
   * acted, so nobody is excluded.
   */
  private onSearchWave(wave: OrderSearchWave): Promise<void> {
    const payload: OrderSearchWaveRealtimeEvent = {
      orderId: wave.orderId,
      round: wave.round,
      radiusM: wave.radiusM,
      offeredCount: wave.offeredCount,
      at: Date.now(),
    };

    this.to(orderRoom(wave.orderId))?.emit(ORDER_SEARCH_WAVE_EVENT, payload);

    return Promise.resolve();
  }

  /**
   * One committed transition becomes one frame in `order:{orderId}`.
   *
   * **The actor is subtracted, not skipped.** Both parties sit in the same
   * room, so "nobody is told of their own action" cannot be a choice of
   * recipients the way it is for a push — it is `except(userRoom(...))` on the
   * broadcast, which the adapter carries to every instance. The master who
   * tapped "arrived" learns the outcome from their own HTTP response; a socket
   * frame racing that response is how a client ends up applying its own change
   * twice.
   *
   * An admin override and anything the system did carry no actor, so nothing
   * is excluded — an admin is not in the room to begin with (#167), and
   * `NO_MASTER_FOUND` at the end of a search is nobody's action.
   */
  private onTransition(event: OrderTransitionEvent): Promise<void> {
    const payload: OrderTransitionRealtimeEvent = {
      orderId: event.orderId,
      status: event.to,
      masterId: event.masterId,
      priceMinor: event.priceMinor,
      at: Date.now(),
    };

    const room = this.to(orderRoom(event.orderId), event.actorUserId);
    room?.emit(ORDER_TRANSITION_EVENT, payload);

    return Promise.resolve();
  }

  /**
   * One wave becomes one frame per master it reached, in that master's own
   * room.
   *
   * **`master:{masterId}`, never `order:{orderId}`.** A master who has been
   * offered an order is not a party to it and may not join its room (#167), so
   * an offer published there would be a room nobody is in — or, worse, a
   * reason to weaken the room.
   *
   * One emit per master rather than one to a list of rooms: socket.io
   * de-duplicates a socket that is in two of the rooms named in a single
   * broadcast, and a master holding two devices must reach both, so the loop
   * is what keeps "per master" from quietly becoming "per socket, once".
   */
  private onBroadcast(event: OrderBroadcastEvent): Promise<void> {
    const payload: OrderOfferRealtimeEvent = { orderId: event.orderId, at: Date.now() };

    for (const masterId of event.masterIds) {
      this.to(masterRoom(masterId))?.emit(ORDER_OFFER_EVENT, payload);
    }

    return Promise.resolve();
  }

  /**
   * The broadcast this event goes to, or `undefined` when there is no server
   * to publish through.
   *
   * **`server` is assigned by Nest when socket.io attaches, which only happens
   * once the application listens.** A transition committed before that — a
   * queue worker started ahead of the HTTP server, a test that builds the
   * module without listening — would otherwise throw on a property of
   * `undefined` inside a raise whose whole contract is that it cannot cost the
   * transition anything. The registry would swallow it, so this guard buys
   * clarity rather than safety: `debug`, because a publish with nobody
   * listening is not a fault.
   */
  private to(room: string, exceptUserId?: string) {
    const server = this.gateway.server as typeof this.gateway.server | undefined;

    if (server === undefined) {
      this.logger.debug(`nothing published to ${room}: the socket server is not attached yet`);
      return undefined;
    }

    const broadcast = server.to(room);
    return exceptUserId === undefined ? broadcast : broadcast.except(userRoom(exceptUserId));
  }
}
