module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    // `jsxImportSource: 'nativewind'` is what lets `className` reach a React
    // Native component. Without it NativeWind silently does nothing.
    presets: [['babel-preset-expo', { jsxImportSource: 'nativewind' }], 'nativewind/babel'],
  };
};
