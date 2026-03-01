/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        g:    '#00ff41',      // matrix green
        gdim: '#00b32c',      // dimmed green
        gdark:'#003d10',      // dark green
        c:    '#00d4ff',      // cyan
        cdim: '#007a99',
        o:    '#ff8c00',      // orange/warning
        r:    '#ff3333',      // red/danger
        panel:'#050505',
        border:'#00ff4120',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Courier New', 'monospace'],
      },
      animation: {
        blink:   'blink 1s step-end infinite',
        flicker: 'flicker 0.1s ease-in-out infinite',
        scan:    'scan 6s linear infinite',
        glow:    'glow 2s ease-in-out infinite',
        flash:   'flash 0.3s ease-out',
      },
      keyframes: {
        blink: {
          '0%,100%': { opacity: '1' },
          '50%':     { opacity: '0' },
        },
        flicker: {
          '0%,100%': { opacity: '1' },
          '50%':     { opacity: '0.97' },
        },
        scan: {
          '0%':   { transform: 'translateY(0)' },
          '100%': { transform: 'translateY(100vh)' },
        },
        glow: {
          '0%,100%': { textShadow: '0 0 4px #00ff41' },
          '50%':     { textShadow: '0 0 12px #00ff41, 0 0 24px #00ff4166' },
        },
        flash: {
          '0%':   { backgroundColor: '#00ff4133' },
          '100%': { backgroundColor: 'transparent' },
        },
      },
      boxShadow: {
        green:  '0 0 8px #00ff4133',
        'green-lg': '0 0 20px #00ff4144',
        cyan:   '0 0 8px #00d4ff33',
        red:    '0 0 8px #ff333333',
      },
    },
  },
  plugins: [],
}
