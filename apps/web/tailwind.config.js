/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: '#8BC53D',
        'primary-dark': '#476E2C',
        secondary: '#6D6E71',
        'secondary-light': '#A5A5A5',
        negative: '#C62026',
        'bg-page': '#F7F8FA',
        'bg-card': '#FFFFFF',
        border: '#E5E7EB',
        'border-light': '#F0F1F3',
        'text-primary': '#1A1A2E',
        'text-muted': '#9CA3AF',
        green: {
          light: '#C9E4A4',
          DEFAULT: '#8BC53D',
          dark: '#476E2C',
        },
        orange: {
          light: '#FAC086',
          DEFAULT: '#F68C1F',
          dark: '#b45e08',
        },
        purple: {
          light: '#DAAAE4',
          DEFAULT: '#742982',
        },
        navy: {
          DEFAULT: '#05164D',
        },
        blue: {
          light: '#A7DCF7',
          DEFAULT: '#00B0F0',
          dark: '#00648F',
        },
        pink: {
          light: '#ED9397',
          DEFAULT: '#C62026',
          dark: '#81151A',
        },
        neutral: {
          light: '#A5A5A5',
          DEFAULT: '#6D6E71',
          dark: '#050505',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui'],
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        hover: '0 4px 16px rgba(0,0,0,0.12)',
        sidebar: '2px 0 8px rgba(0,0,0,0.04)',
      },
      borderRadius: {
        card: '12px',
      },
    },
  },
  plugins: [],
}
