/** @type {import('tailwindcss').Config} */
export default {
  // Scan all JS and HTML files for class names to purge unused styles in production.
  content: [
    './index.html',
    './src/**/*.js',
  ],
  theme: {
    extend: {
      // Brand tokens — centralised so contributors only change one place.
      colors: {
        brand: {
          50:  '#fdf6e3',
          100: '#f5e4a8',
          200: '#e8c84e',
          400: '#d4a017',
          500: '#c48a00',  // primary interactive gold
          600: '#a06e00',  // hover
          700: '#7a5200',  // active / dark accent
          900: '#090806',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [
    // @tailwindcss/forms gives sensible default resets for inputs, textareas, and selects.
    require('@tailwindcss/forms'),
  ],
};
