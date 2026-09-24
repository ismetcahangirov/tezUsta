import type { ImperativeRouter } from 'expo-router';

/**
 * Closes a call screen: back to whatever it was presented over (ADR-0040
 * § 5), or — on the cold start a tapped ring produces, when there is nothing
 * underneath — to the root junction, which sends the person to their role's
 * home.
 */
export function closeCall(router: Pick<ImperativeRouter, 'back' | 'canGoBack' | 'replace'>): void {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace('/');
  }
}
