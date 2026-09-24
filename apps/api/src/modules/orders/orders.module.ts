import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infra/database/database.module';
import { StorageModule } from '../../infra/storage/storage.module';
import { AddressesModule } from '../addresses/addresses.module';
import { CustomersModule } from '../customers/customers.module';
import { MastersModule } from '../masters/masters.module';
import { ServicesModule } from '../services/services.module';
import { ConversationEventsRegistry } from './conversation-events.registry';
import { ConversationsController } from './conversations.controller';
import { ConversationsRepository } from './conversations.repository';
import { ConversationsService } from './conversations.service';
import { MessageAttachmentsController } from './message-attachments.controller';
import { MessageAttachmentsReader } from './message-attachments.reader';
import { MessageAttachmentsRepository } from './message-attachments.repository';
import { MessageAttachmentsService } from './message-attachments.service';
import { OrderDispatchRegistry } from './order-dispatch.registry';
import { OrderNotificationsRegistry } from './order-notifications.registry';
import { OrderRoomsRegistry } from './order-rooms.registry';
import { OrderOffersRepository } from './order-offers.repository';
import { OrderPhotosController } from './order-photos.controller';
import { OrderPhotosRepository } from './order-photos.repository';
import { OrderPhotosService } from './order-photos.service';
import { OrdersController } from './orders.controller';
import { OrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';

/**
 * Orders (EPIC 6, issue #81) and their problem photos (issue #83).
 *
 * Imports the modules that own what an order (or an order photo) references,
 * rather than reading their tables: `CustomersModule` answers "which customer
 * is this actor?", `AddressesModule` answers "is this address theirs?",
 * `ServicesModule` answers "is this service still offered?", and
 * `MastersModule` answers "is this actor the master assigned to this order?"
 * — needed only for a photo read, since order creation carries no master yet
 * (`docs/architecture/backend-architecture.md` § Module rules). `StorageModule`
 * arrives with issue #83 the same way it arrived in `MastersModule` for issue
 * #38: photos are uploaded straight to object storage through a presigned
 * URL, so this module needs the provider that mints one — and never the bytes
 * (ADR-0005).
 *
 * `OrdersService`, `OrdersRepository` and `OrderPhotosService` are all
 * exported: EPIC 7 dispatches these orders and EPIC 8 transitions them, every
 * one of those writes has to append to the audit trail this module owns, and
 * `admin-order-photos.service.ts` reads a photo through `OrderPhotosService`
 * rather than importing this module's repository directly
 * (`docs/architecture/backend-architecture.md` § Module rules).
 *
 * EPIC 7 (issue #103) adds two more exports and one table. `order_offers`
 * hangs off an order, so this module owns it and `OrderOffersRepository` is
 * the dispatch engine's write side of it. `OrderDispatchRegistry` is the slot
 * the engine fills at boot, and it is the reason this module knows nothing
 * about dispatch: creation announces "this order is searching" into the
 * registry, and what happens next is `DispatchModule`'s business — an arrow
 * that points only one way, so the two modules never import each other.
 *
 * EPIC 18 (issues #177, #178) adds `conversations` and `messages`. They live
 * here rather than in a module of their own because a conversation is a
 * property of an order ([ADR-0033](docs/decisions/ADR-0033-in-order-messaging.md)),
 * the same way `order_photos` and `order_offers` are — and because that is
 * what keeps the graph acyclic. The conversation is opened inside the accept
 * transaction in `MasterOffersModule`, which already imports this one; a
 * `ConversationsModule` would have had to import `OrdersModule` to ask who is
 * party to an order while `OrdersModule` imported it back to close a
 * conversation on re-dispatch, and `no-circular` does not survive that
 * (CLAUDE.md §14). `ConversationsRepository` is exported for the accept path;
 * `ConversationsService` is not, because nothing outside this module has an
 * actor to authorize.
 */
@Module({
  imports: [
    DatabaseModule,
    CustomersModule,
    AddressesModule,
    ServicesModule,
    MastersModule,
    StorageModule,
  ],
  controllers: [
    OrdersController,
    OrderPhotosController,
    ConversationsController,
    MessageAttachmentsController,
  ],
  providers: [
    OrdersRepository,
    OrdersService,
    OrderOffersRepository,
    OrderPhotosRepository,
    OrderPhotosService,
    OrderDispatchRegistry,
    OrderNotificationsRegistry,
    OrderRoomsRegistry,
    ConversationsRepository,
    ConversationsService,
    ConversationEventsRegistry,
    MessageAttachmentsRepository,
    MessageAttachmentsReader,
    MessageAttachmentsService,
  ],
  exports: [
    OrdersService,
    OrdersRepository,
    OrderOffersRepository,
    OrderPhotosService,
    // For `MaintenanceModule` (#92), which sweeps confirmed-but-never-attached
    // photos. The repository rather than the service: the sweep is not a
    // customer's request and has no actor to authorize.
    OrderPhotosRepository,
    OrderDispatchRegistry,
    // Exported for the same reason `OrderDispatchRegistry` is: the module that
    // fills the slot has to reach it, and every module that raises an event
    // already imports this one (#144).
    OrderNotificationsRegistry,
    OrderRoomsRegistry,
    // For the accept path (`master-offers.repository.ts`), which opens the
    // conversation inside the transaction that claims the order. The
    // repository rather than the service: that caller has already resolved
    // who the master is and has no actor to authorize.
    ConversationsRepository,
    // The slot `modules/realtime` (#179) and `modules/notifications` (#180)
    // fill, exported for the reason `OrderNotificationsRegistry` is: the arrow
    // points from them to here, never back.
    ConversationEventsRegistry,
    // For calls (#185), which ask the conversation's own party rule rather
    // than a second copy of it: a call may be placed exactly when the
    // conversation is open and writable (ADR-0034 § 6, ADR-0033 § 2).
    ConversationsService,
    // For `MaintenanceModule`, which sweeps message photos presigned or
    // confirmed and never sent (#181) inside the order-photo sweep. The
    // repository, for `OrderPhotosRepository`'s reason: a sweep has no actor.
    MessageAttachmentsRepository,
  ],
})
export class OrdersModule {}
