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
        /* ─── 页面 & 内容入场 ─── */
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'fade-in-scale': {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        /* ─── 滑入 ─── */
        'slide-in-right': {
          '0%': { transform: 'translateX(100%)' },
          '100%': { transform: 'translateX(0)' },
        },
        'slide-in-left': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(0)' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(24px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        /* ─── 气泡弹入 ─── */
        'pop-in': {
          '0%': { opacity: '0', transform: 'scale(0.8)' },
          '60%': { transform: 'scale(1.04)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        /* ─── 错误抖动 ─── */
        'shake': {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%': { transform: 'translateX(-6px)' },
          '40%': { transform: 'translateX(6px)' },
          '60%': { transform: 'translateX(-4px)' },
          '80%': { transform: 'translateX(4px)' },
        },
        /* ─── 空状态呼吸 ─── */
        'breathe': {
          '0%, 100%': { transform: 'scale(1)', opacity: '0.5' },
          '50%': { transform: 'scale(1.05)', opacity: '0.7' },
        },
        /* ─── 列表项交错 ─── */
        'list-item-in': {
          '0%': { opacity: '0', transform: 'translateX(-8px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        /* ─── 聊天消息 ─── */
        'chat-bubble-left': {
          '0%': { opacity: '0', transform: 'translateX(-12px) scale(0.95)' },
          '100%': { opacity: '1', transform: 'translateX(0) scale(1)' },
        },
        'chat-bubble-right': {
          '0%': { opacity: '0', transform: 'translateX(12px) scale(0.95)' },
          '100%': { opacity: '1', transform: 'translateX(0) scale(1)' },
        },
        /* ─── 标签弹入 ─── */
        'tag-pop': {
          '0%': { opacity: '0', transform: 'scale(0.6)' },
          '70%': { transform: 'scale(1.08)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        /* ─── 统计数字计数效果 ─── */
        'count-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        /* ─── 导出弹窗区块展开 ─── */
        'fade-slide-in': {
          '0%': { opacity: '0', transform: 'translateY(-6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'modal-enter': 'modal-enter 0.2s ease-out',
        'backdrop-enter': 'backdrop-enter 0.15s ease-out',
        'toolbar-in': 'toolbar-in 0.18s ease-out forwards',
        'toolbar-out': 'toolbar-out 0.12s ease-in forwards',
        'ctx-menu-in': 'ctx-menu-in 0.12s ease-out forwards',
        'fade-in-up': 'fade-in-up 0.4s ease-out both',
        'fade-in': 'fade-in 0.3s ease-out both',
        'fade-in-scale': 'fade-in-scale 0.35s ease-out both',
        'slide-in-right': 'slide-in-right 0.3s cubic-bezier(0.16, 1, 0.3, 1) both',
        'slide-in-left': 'slide-in-left 0.3s cubic-bezier(0.16, 1, 0.3, 1) both',
        'slide-up': 'slide-up 0.4s ease-out both',
        'pop-in': 'pop-in 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both',
        'shake': 'shake 0.4s ease-in-out',
        'breathe': 'breathe 3s ease-in-out infinite',
        'list-item-in': 'list-item-in 0.3s ease-out both',
        'chat-bubble-left': 'chat-bubble-left 0.25s ease-out both',
        'chat-bubble-right': 'chat-bubble-right 0.25s ease-out both',
        'tag-pop': 'tag-pop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both',
        'count-up': 'count-up 0.5s ease-out both',
        'fade-slide-in': 'fade-slide-in 0.25s ease-out both',
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
