/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0b1020',
        panel: '#121a2a',
        accent: '#1dd1a1',
        accentSoft: '#1abc9c',
        purpleGlow: '#7c3aed',
      },
      boxShadow: {
        soft: '0 10px 30px rgba(16, 24, 40, 0.35)',
      },
    },
  },
  plugins: [],
}
