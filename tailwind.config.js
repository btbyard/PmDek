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
          50:  '#eef2ff',
          100: '#e0e7ff',
          500: '#6366f1',  // primary interactive
          600: '#4f46e5',  // hover
          700: '#4338ca',  // active / focus ring
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
