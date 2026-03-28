import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Academic warm palette inspired by the reference designs
        cream: {
          50: '#FDFCFA',
          100: '#FAF7F2',
          200: '#F3EDE3',
          300: '#E8DFD0',
          400: '#D4C5AD',
        },
        rust: {
          50: '#FEF3EE',
          100: '#FBDECF',
          200: '#F7BA9E',
          300: '#F08C63',
          400: '#E8683A',
          500: '#C44B20',
          600: '#A53A18',
          700: '#842D14',
          800: '#6B2512',
        },
        charcoal: {
          50: '#F5F5F5',
          100: '#E5E5E5',
          200: '#D4D4D4',
          300: '#A3A3A3',
          400: '#737373',
          500: '#525252',
          600: '#404040',
          700: '#303030',
          800: '#1A1A1A',
          900: '#0F0F0F',
        },
      },
      keyframes: {
        'modal-enter': {
          '0%': { opacity: '0', transform: 'scale(0.95) translateY(10px)' },
          '100%': { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        'backdrop-enter': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'toolbar-in': {
          '0%': { opacity: '0', transform: 'translateY(4px) scale(0.95)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'toolbar-out': {
          '0%': { opacity: '1', transform: 'translateY(0) scale(1)' },
          '100%': { opacity: '0', transform: 'translateY(4px) scale(0.95)' },
        },
        'ctx-menu-in': {
          '0%': { opacity: '0', transform: 'scale(0.92)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        'modal-enter': 'modal-enter 0.2s ease-out',
        'backdrop-enter': 'backdrop-enter 0.15s ease-out',
        'toolbar-in': 'toolbar-in 0.18s ease-out forwards',
        'toolbar-out': 'toolbar-out 0.12s ease-in forwards',
        'ctx-menu-in': 'ctx-menu-in 0.12s ease-out forwards',
      },
      fontFamily: {
        serif: ['Georgia', 'Cambria', '"Times New Roman"', 'Times', 'serif'],
        sans: [
          '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto',
          '"Helvetica Neue"', 'Arial', 'sans-serif',
        ],
        mono: ['"SF Mono"', 'Monaco', 'Consolas', '"Liberation Mono"', '"Courier New"', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
