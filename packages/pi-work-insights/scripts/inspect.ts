import { inspect } from "../src/storage.js";
const file = process.argv[2];
if (!file) throw new Error("Usage: npm run inspect -- /absolute/path/to/observation.json (or project/latest.json)");
try { console.log(JSON.stringify(inspect(file), null, 2)); }
catch { console.error("Invalid or unreadable observation JSON"); process.exitCode = 1; }
