/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
    "./postcss-text-scale.cjs": {},
  },
};

export default config;
