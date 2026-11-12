/** @type {import('tailwindcss').Config} */
// Sistema de diseño de SMI: azul institucional #1C42BA, superficies planas y neutras, sin degradados ni brillos.
const brand = {
  50: '#f3f5fc',
  100: '#e2e8f8',
  200: '#c2cef0',
  300: '#8ea4e1',
  400: '#5073d3',
  500: '#2754ce',
  600: '#1c42ba',
  700: '#153899',
  800: '#0f2a76',
  900: '#091d53',
  950: '#051133',
};

// Verde, rojo y ámbar sobrios, solo para estados (correcto / error / advertencia)
const green = {
  50: '#f2f8f5',
  100: '#e1efe8',
  200: '#c1e1d1',
  300: '#95cbb0',
  400: '#59b185',
  500: '#3a8861',
  600: '#29704d',
  700: '#215e40',
  800: '#194d33',
  900: '#143d29',
  950: '#0c271a',
};
const red = {
  50: '#fcf4f3',
  100: '#f8e4e3',
  200: '#f2cdca',
  300: '#e9a5a0',
  400: '#da6a62',
  500: '#cc3d33',
  600: '#ae3229',
  700: '#922820',
  800: '#7b2019',
  900: '#661a15',
  950: '#3c0f0b',
};
const amber = {
  50: '#fcf6ee',
  100: '#f8e8d3',
  200: '#f2d1a6',
  300: '#e8b168',
  400: '#db8c24',
  500: '#b47018',
  600: '#9c6011',
  700: '#824f0d',
  800: '#6a410c',
  900: '#55350c',
  950: '#301f08',
};

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Archivo', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      colors: {
        brand,
        // Todo lo que antes era azul/celeste/turquesa/violeta usa ahora el azul de la marca
        blue: brand,
        indigo: brand,
        sky: brand,
        cyan: brand,
        teal: brand,
        violet: brand,
        purple: brand,
        // Colores de estado sobrios (en lugar de los tonos brillantes por defecto)
        emerald: green,
        green,
        rose: red,
        red,
        amber,
        yellow: amber,
        orange: amber,
      },
      // Radios pequeños en celular; en computadora se anulan por completo (ver index.css)
      borderRadius: {
        sm: '2px',
        DEFAULT: '2px',
        md: '3px',
        lg: '4px',
        xl: '4px',
        '2xl': '6px',
        '3xl': '6px',
      },
      // Sombras discretas y neutras (sin resplandores de color)
      boxShadow: {
        sm: '0 1px 2px rgba(15, 23, 42, 0.06)',
        DEFAULT: '0 1px 2px rgba(15, 23, 42, 0.08)',
        md: '0 1px 3px rgba(15, 23, 42, 0.10)',
        lg: '0 2px 6px rgba(15, 23, 42, 0.12)',
        xl: '0 4px 10px rgba(15, 23, 42, 0.14)',
        '2xl': '0 6px 16px rgba(15, 23, 42, 0.16)',
      },
    },
  },
  plugins: [],
};
