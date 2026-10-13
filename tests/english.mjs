// Imported first by tests that call shared or server code directly: it makes
// t() speak English from the locale files, whatever this computer's language,
// so the English those tests expect is what they get.
process.env.PUNCHBOARD_LOCALE = "en"
await import("../src/server/i18n.ts")
