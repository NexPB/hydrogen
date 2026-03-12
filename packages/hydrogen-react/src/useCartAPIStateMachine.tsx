import {createMachine, state, transition, reduce, action} from 'robot3';
import {useMachine} from 'react-robot';
import {
  Cart,
  CartMachineActionEvent,
  CartMachineCompatState,
  CartMachineContext,
  CartMachineEvent,
  CartMachineFetchResultEvent,
  CartMachineTypeState,
  CartSetEvent,
} from './cart-types.js';
import {flattenConnection} from './flatten-connection.js';
import {useCartActions} from './useCartActions.js';
import {useMemo, useRef} from 'react';
import {
  CountryCode,
  Cart as CartType,
  LanguageCode,
} from './storefront-api-types.js';

import type {PartialDeep} from 'type-fest';

type ActionImpl = (ctx: CartMachineContext, ev: CartMachineEvent) => unknown;

/**
 * Single mutable bridge between Robot3 (created once via useMemo) and React
 * (closures refresh every render). Machine action/reduce callbacks read from
 * this ref at invocation time so they always see the latest `send` and impls.
 */
type CartRuntime = {
  send: (event: CartMachineEvent) => void;
  impls: Record<string, ActionImpl>;
};

function entryPipeline(
  apiActionKey: string,
  ref: React.RefObject<CartRuntime>,
): any[] {
  return [
    reduce(
      (ctx: CartMachineContext, _ev: CartMachineActionEvent) =>
        ({...ctx, lastValidCart: ctx.cart}) as CartMachineContext,
    ),
    action((ctx: CartMachineContext, ev: CartMachineActionEvent) => {
      ref.current?.impls['onCartActionEntry']?.(ctx, ev);
    }),
    reduce((ctx: CartMachineContext, ev: CartMachineActionEvent) => {
      const fn = ref.current?.impls['onCartActionOptimisticUI'];
      if (!fn) return ctx;
      const result = fn(ctx, ev);
      return result ? ({...ctx, ...result} as CartMachineContext) : ctx;
    }),
    action((ctx: CartMachineContext, ev: CartMachineActionEvent) => {
      ref.current?.impls[apiActionKey]?.(ctx, ev);
    }),
  ];
}

function resultTransitions(
  ref: React.RefObject<CartRuntime>,
  errorTarget = 'error',
): any[] {
  return [
    transition(
      'RESOLVE',
      'idle',
      reduce(
        (ctx: CartMachineContext, ev: any) =>
          ({
            ...ctx,
            prevCart: ctx.lastValidCart,
            cart: ev?.payload?.cart,
            rawCartResult: ev?.payload?.rawCartResult,
            errors: undefined,
          }) as CartMachineContext,
      ),
      action((ctx: CartMachineContext, ev: any) => {
        ref.current?.impls['onCartActionComplete']?.(ctx, ev);
      }),
    ),
    transition(
      'ERROR',
      errorTarget,
      reduce(
        (ctx: CartMachineContext, ev: any) =>
          ({
            ...ctx,
            prevCart: ctx.lastValidCart,
            cart: ctx.lastValidCart,
            errors: ev?.payload?.errors,
          }) as CartMachineContext,
      ),
      action((ctx: CartMachineContext, ev: any) => {
        ref.current?.impls['onCartActionComplete']?.(ctx, ev);
      }),
    ),
    transition(
      'CART_COMPLETED',
      'cartCompleted',
      reduce(
        () =>
          ({
            prevCart: undefined,
            cart: undefined,
            lastValidCart: undefined,
            rawCartResult: undefined,
            errors: undefined,
          }) as unknown as CartMachineContext,
      ),
      action((ctx: CartMachineContext, ev: any) => {
        ref.current?.impls['onCartActionComplete']?.(ctx, ev);
      }),
    ),
  ];
}

function initTransitions(ref: React.RefObject<CartRuntime>): any[] {
  return [
    transition(
      'CART_FETCH',
      'cartFetching',
      ...entryPipeline('cartFetchAction', ref),
    ),
    transition(
      'CART_CREATE',
      'cartCreating',
      ...entryPipeline('cartCreateAction', ref),
    ),
    transition(
      'CART_SET',
      'idle',
      reduce(
        (_ctx: CartMachineContext, ev: CartSetEvent) =>
          ({
            ..._ctx,
            rawCartResult: ev.payload.cart,
            cart: cartFromGraphQL(ev.payload.cart),
          }) as CartMachineContext,
      ),
    ),
  ];
}

function updateTransitions(ref: React.RefObject<CartRuntime>): any[] {
  return [
    transition(
      'CARTLINE_ADD',
      'cartLineAdding',
      ...entryPipeline('cartLineAddAction', ref),
    ),
    transition(
      'CARTLINE_UPDATE',
      'cartLineUpdating',
      ...entryPipeline('cartLineUpdateAction', ref),
    ),
    transition(
      'CARTLINE_REMOVE',
      'cartLineRemoving',
      ...entryPipeline('cartLineRemoveAction', ref),
    ),
    transition(
      'NOTE_UPDATE',
      'noteUpdating',
      ...entryPipeline('noteUpdateAction', ref),
    ),
    transition(
      'BUYER_IDENTITY_UPDATE',
      'buyerIdentityUpdating',
      ...entryPipeline('buyerIdentityUpdateAction', ref),
    ),
    transition(
      'CART_ATTRIBUTES_UPDATE',
      'cartAttributesUpdating',
      ...entryPipeline('cartAttributesUpdateAction', ref),
    ),
    transition(
      'DISCOUNT_CODES_UPDATE',
      'discountCodesUpdating',
      ...entryPipeline('discountCodesUpdateAction', ref),
    ),
  ];
}

function buildCartMachine(
  ref: React.RefObject<CartRuntime>,
  initialCart?: PartialDeep<CartType, {recurseIntoArrays: true}>,
) {
  const initialState = initialCart ? 'idle' : 'uninitialized';
  const initialContext: CartMachineContext = {
    cart: initialCart ? cartFromGraphQL(initialCart) : undefined,
  };

  const states = {
    uninitialized: state(...initTransitions(ref)),
    cartCompleted: state(...initTransitions(ref)),
    initializationError: state(...initTransitions(ref)),
    idle: state(
      ...initTransitions(ref),
      ...updateTransitions(ref),
    ),
    error: state(
      ...initTransitions(ref),
      ...updateTransitions(ref),
    ),
    cartFetching: state(
      ...resultTransitions(ref, 'initializationError'),
    ),
    cartCreating: state(
      ...resultTransitions(ref, 'initializationError'),
    ),
    cartLineRemoving: state(...resultTransitions(ref)),
    cartLineUpdating: state(...resultTransitions(ref)),
    cartLineAdding: state(...resultTransitions(ref)),
    noteUpdating: state(...resultTransitions(ref)),
    buyerIdentityUpdating: state(...resultTransitions(ref)),
    cartAttributesUpdating: state(...resultTransitions(ref)),
    discountCodesUpdating: state(...resultTransitions(ref)),
  };

  return createMachine(initialState, states, () => initialContext);
}

function createActionImpls(
  cartActions: ReturnType<typeof useCartActions>,
  runtime: React.RefObject<CartRuntime>,
  callbacks: {
    onCartActionEntry?: (
      context: CartMachineContext,
      event: CartMachineActionEvent,
    ) => void;
    onCartActionOptimisticUI?: (
      context: CartMachineContext,
      event: CartMachineEvent,
    ) => Partial<CartMachineContext>;
    onCartActionComplete?: (
      context: CartMachineContext,
      event: CartMachineFetchResultEvent,
    ) => void;
  },
): Record<string, ActionImpl> {
  const {
    cartFetch,
    cartCreate,
    cartLineAdd,
    cartLineUpdate,
    cartLineRemove,
    noteUpdate,
    buyerIdentityUpdate,
    cartAttributesUpdate,
    discountCodesUpdate,
  } = cartActions;

  const send = (ev: CartMachineEvent) => runtime.current?.send(ev);

  return {
    cartFetchAction: async (
      _: CartMachineContext,
      event: CartMachineEvent,
    ) => {
      if (event.type !== 'CART_FETCH') return;
      const {data, errors} = await cartFetch(event.payload.cartId);
      send(eventFromFetchResult(event, data?.cart, errors));
    },
    cartCreateAction: async (
      _: CartMachineContext,
      event: CartMachineEvent,
    ) => {
      if (event.type !== 'CART_CREATE') return;
      const {data, errors} = await cartCreate(event.payload);
      send(eventFromFetchResult(event, data?.cartCreate?.cart, errors));
    },
    cartLineAddAction: async (
      context: CartMachineContext,
      event: CartMachineEvent,
    ) => {
      if (event.type !== 'CARTLINE_ADD' || !context?.cart?.id) return;
      const {data, errors} = await cartLineAdd(
        context.cart.id,
        event.payload.lines,
      );
      send(eventFromFetchResult(event, data?.cartLinesAdd?.cart, errors));
    },
    cartLineUpdateAction: async (
      context: CartMachineContext,
      event: CartMachineEvent,
    ) => {
      if (event.type !== 'CARTLINE_UPDATE' || !context?.cart?.id) return;
      const {data, errors} = await cartLineUpdate(
        context.cart.id,
        event.payload.lines,
      );
      send(eventFromFetchResult(event, data?.cartLinesUpdate?.cart, errors));
    },
    cartLineRemoveAction: async (
      context: CartMachineContext,
      event: CartMachineEvent,
    ) => {
      if (event.type !== 'CARTLINE_REMOVE' || !context?.cart?.id) return;
      const {data, errors} = await cartLineRemove(
        context.cart.id,
        event.payload.lines,
      );
      send(eventFromFetchResult(event, data?.cartLinesRemove?.cart, errors));
    },
    noteUpdateAction: async (
      context: CartMachineContext,
      event: CartMachineEvent,
    ) => {
      if (event.type !== 'NOTE_UPDATE' || !context?.cart?.id) return;
      const {data, errors} = await noteUpdate(
        context.cart.id,
        event.payload.note,
      );
      send(eventFromFetchResult(event, data?.cartNoteUpdate?.cart, errors));
    },
    buyerIdentityUpdateAction: async (
      context: CartMachineContext,
      event: CartMachineEvent,
    ) => {
      if (event.type !== 'BUYER_IDENTITY_UPDATE' || !context?.cart?.id) return;
      const {data, errors} = await buyerIdentityUpdate(
        context.cart.id,
        event.payload.buyerIdentity,
      );
      send(
        eventFromFetchResult(
          event,
          data?.cartBuyerIdentityUpdate?.cart,
          errors,
        ),
      );
    },
    cartAttributesUpdateAction: async (
      context: CartMachineContext,
      event: CartMachineEvent,
    ) => {
      if (event.type !== 'CART_ATTRIBUTES_UPDATE' || !context?.cart?.id) return;
      const {data, errors} = await cartAttributesUpdate(
        context.cart.id,
        event.payload.attributes,
      );
      send(
        eventFromFetchResult(event, data?.cartAttributesUpdate?.cart, errors),
      );
    },
    discountCodesUpdateAction: async (
      context: CartMachineContext,
      event: CartMachineEvent,
    ) => {
      if (event.type !== 'DISCOUNT_CODES_UPDATE' || !context?.cart?.id) return;
      const {data, errors} = await discountCodesUpdate(
        context.cart.id,
        event.payload.discountCodes,
      );
      send(
        eventFromFetchResult(
          event,
          data?.cartDiscountCodesUpdate?.cart,
          errors,
        ),
      );
    },
    ...(callbacks.onCartActionEntry && {
      onCartActionEntry: (
        context: CartMachineContext,
        event: CartMachineEvent,
      ): void => {
        if (isCartActionEvent(event)) {
          callbacks.onCartActionEntry!(context, event);
        }
      },
    }),
    ...(callbacks.onCartActionOptimisticUI && {
      onCartActionOptimisticUI: (
        context: CartMachineContext,
        event: CartMachineEvent,
      ): Partial<CartMachineContext> | undefined => {
        return callbacks.onCartActionOptimisticUI!(context, event);
      },
    }),
    ...(callbacks.onCartActionComplete && {
      onCartActionComplete: (
        context: CartMachineContext,
        event: CartMachineEvent,
      ): void => {
        if (isCartFetchResultEvent(event)) {
          callbacks.onCartActionComplete!(context, event);
        }
      },
    }),
  };
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function useCartAPIStateMachine({
  numCartLines,
  onCartActionEntry,
  onCartActionOptimisticUI,
  onCartActionComplete,
  data: cart,
  cartFragment,
  countryCode,
  languageCode,
}: {
  /**  Maximum number of cart lines to fetch. Defaults to 250 cart lines. */
  numCartLines?: number;
  /** A callback that is invoked just before a Cart API action executes. */
  onCartActionEntry?: (
    context: CartMachineContext,
    event: CartMachineActionEvent,
  ) => void;
  /** A callback that is invoked after executing the entry actions for optimistic UI changes.  */
  onCartActionOptimisticUI?: (
    context: CartMachineContext,
    event: CartMachineEvent,
  ) => Partial<CartMachineContext>;
  /** A callback that is invoked after a Cart API completes. */
  onCartActionComplete?: (
    context: CartMachineContext,
    event: CartMachineFetchResultEvent,
  ) => void;
  /** An object with fields that correspond to the Storefront API's [Cart object](https://shopify.dev/api/storefront/2026-01/objects/cart). */
  data?: PartialDeep<CartType, {recurseIntoArrays: true}>;
  /** A fragment used to query the Storefront API's [Cart object](https://shopify.dev/api/storefront/2026-01/objects/cart) for all queries and mutations. A default value is used if no argument is provided. */
  cartFragment: string;
  /** The ISO country code for i18n. */
  countryCode?: CountryCode;
  /** The ISO language code for i18n. */
  languageCode?: LanguageCode;
}) {
  const cartActions = useCartActions({
    numCartLines,
    cartFragment,
    countryCode,
    languageCode,
  });

  const runtimeRef = useRef<CartRuntime>({send: () => {}, impls: {}});
  runtimeRef.current.impls = createActionImpls(cartActions, runtimeRef, {
    onCartActionEntry,
    onCartActionOptimisticUI,
    onCartActionComplete,
  });

  const cartMachine = useMemo(
    () => buildCartMachine(runtimeRef, cart),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cart],
  );

  const [current, send, service] = useMachine(cartMachine);
  runtimeRef.current.send = send;

  const memoizedState: CartMachineCompatState = useMemo(
    () => ({
      value: current.name as CartMachineTypeState['value'],
      context: current.context as CartMachineContext,
      matches: (s: CartMachineTypeState['value']) =>
        current.name === s,
    }),
    [current],
  );

  return useMemo(
    () => [memoizedState, send, service] as const,
    [memoizedState, send, service],
  );
}

export function cartFromGraphQL(
  cart: PartialDeep<CartType, {recurseIntoArrays: true}>,
): Cart {
  return {
    ...cart,
    lines: flattenConnection(cart?.lines),
    note: cart.note ?? undefined,
  };
}

function eventFromFetchResult(
  cartActionEvent: CartMachineActionEvent,
  cart?: PartialDeep<CartType, {recurseIntoArrays: true}> | null,
  errors?: unknown,
): CartMachineFetchResultEvent {
  if (errors) {
    return {type: 'ERROR', payload: {errors, cartActionEvent}};
  }

  if (!cart) {
    return {
      type: 'CART_COMPLETED',
      payload: {
        cartActionEvent,
      },
    };
  }

  return {
    type: 'RESOLVE',
    payload: {
      cart: cartFromGraphQL(cart),
      rawCartResult: cart,
      cartActionEvent,
    },
  };
}

function isCartActionEvent(
  event: CartMachineEvent,
): event is CartMachineActionEvent {
  return (
    event.type === 'CART_FETCH' ||
    event.type === 'CART_CREATE' ||
    event.type === 'CART_SET' ||
    event.type === 'CARTLINE_ADD' ||
    event.type === 'CARTLINE_UPDATE' ||
    event.type === 'CARTLINE_REMOVE' ||
    event.type === 'NOTE_UPDATE' ||
    event.type === 'BUYER_IDENTITY_UPDATE' ||
    event.type === 'CART_ATTRIBUTES_UPDATE' ||
    event.type === 'DISCOUNT_CODES_UPDATE'
  );
}

function isCartFetchResultEvent(
  event: CartMachineEvent,
): event is CartMachineFetchResultEvent {
  return (
    event.type === 'RESOLVE' ||
    event.type === 'ERROR' ||
    event.type === 'CART_COMPLETED'
  );
}
