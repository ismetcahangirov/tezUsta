/** Falls back to Azerbaijani, which is what the API falls back to (ADR-0019). */
const FALLBACK_LOCALE = 'az';

/**
 * The locale the phone is set to, as a BCP 47 tag.
 *
 * Read from `Intl` rather than from a dependency. `expo-localization` would
 * answer the same question and ship a native module to do it, and CLAUDE.md
 * §10 asks first whether a package is necessary — this is one expression.
 * Hermes ships with Intl enabled on both platforms in `react-native@0.86.3`
 * (`ReactAndroid/hermes-engine/build.gradle.kts` passes
 * `-DHERMES_ENABLE_INTL=True` for every build type, and
 * `sdks/hermes-engine/utils/build-hermes-xcode.sh` hardcodes the same for
 * Apple), so this needs no polyfill and no configuration.
 *
 * Wrapped anyway: the whole point of reading a locale is to render something,
 * and a screen that throws because the engine surprised us is worse than a
 * screen in the fallback language.
 */
export function deviceLocale(): string {
  try {
    return new Intl.NumberFormat().resolvedOptions().locale;
  } catch {
    return FALLBACK_LOCALE;
  }
}
