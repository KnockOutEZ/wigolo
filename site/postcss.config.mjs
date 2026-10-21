// Tailwind only exists for the docs UI; its stylesheet is imported by the
// docs layout alone, so marketing pages never load it. transformAssetUrls is
// off because its url() rewriting corrupts next/font's generated font CSS
// ("next/font/google queries have exactly one entry" under Turbopack).
const config = { plugins: { "@tailwindcss/postcss": { transformAssetUrls: false } } };

export default config;
