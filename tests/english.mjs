// Imported first by tests that call shared code directly: it makes t() speak
// English from the locale file, whatever this computer's language, so the
// English those tests expect is what they get.
import fs from "node:fs"
import { createTranslator, FALLBACK_LANGUAGE, setTranslator } from "../src/shared/i18n.ts"

const english = JSON.parse(fs.readFileSync(new URL("../public/locales/en.json", import.meta.url), "utf8")).messages
setTranslator(FALLBACK_LANGUAGE, createTranslator(FALLBACK_LANGUAGE, english, english))
