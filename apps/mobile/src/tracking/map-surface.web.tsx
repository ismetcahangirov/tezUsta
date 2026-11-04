/**
 * The web stand-in for `map-surface.tsx` (issue #172).
 *
 * `react-native-maps` has no web implementation — its own `MapView.web.ts` is
 * React Native Web's `UnimplementedView` — and its native components cannot be
 * bundled by Vite at all. Storybook runs on React Native Web
 * ([ADR-0012](../../../../docs/decisions/ADR-0012-component-workshop.md)), so
 * without this file every story that reaches the order screen would fail to
 * build. Vite and Metro both resolve `.web.tsx` ahead of `.tsx`
 * (`vite-plugin-rnw`'s extension list), which is the whole of the wiring.
 *
 * It is the same placeholder a keyless Android build draws
 * (`map-surface-placeholder.tsx`, #500). The app ships no web build of the
 * customer screens, so this never reaches a customer.
 */
export { MapSurfacePlaceholder as MapSurface } from './map-surface-placeholder';
