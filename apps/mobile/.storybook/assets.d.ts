/**
 * Storybook runs on Vite, where importing a font file yields its served URL.
 * (Under Metro the same import yields an asset id — but the app never imports a
 * font file directly; it goes through `@expo-google-fonts/anybody`.)
 */
declare module '*.ttf' {
  const url: string;
  export default url;
}
