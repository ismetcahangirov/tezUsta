import type { StorybookConfig } from '@storybook/react-native-web-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],

  framework: {
    name: '@storybook/react-native-web-vite',
    options: {
      // Without this the `className` prop never reaches a React Native
      // component and every story renders unstyled. Same setting as
      // apps/mobile/babel.config.js — Metro and Vite have to agree.
      pluginReactOptions: {
        jsxImportSource: 'nativewind',
      },
    },
  },

  async viteFinal(viteConfig) {
    const { default: tailwind } = await import('tailwindcss');

    // Scoped to Vite on purpose: a root postcss.config.js would also be picked
    // up by NativeWind's Metro transformer, which runs Tailwind itself.
    viteConfig.css = {
      ...viteConfig.css,
      postcss: {
        plugins: [tailwind({ config: './tailwind.config.js' })],
      },
    };

    return viteConfig;
  },
};

export default config;
