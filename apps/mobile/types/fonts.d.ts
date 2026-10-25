/**
 * A font file imported from source. Under Metro the import yields an asset id
 * and under Storybook's Vite it yields the served URL; `useFonts` accepts the
 * first and an `@font-face` rule the second.
 */
declare module '*.ttf' {
  const source: string | number;
  export default source;
}
