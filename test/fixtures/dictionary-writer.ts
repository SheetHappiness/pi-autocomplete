import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { PersonalDictionaryStore } from "../../src/dictionary/store.ts";

const [path, word, mode] = process.argv.slice(2);
let reads = 0;
const store = new PersonalDictionaryStore(path, {
  common: [],
  now: () => 1_800_000_000_000,
  debounceMs: 60_000,
  async read(file) {
    if (mode === "hold" && ++reads === 2) {
      process.send!("locked");
      await once(process, "message");
    }
    return readFile(file, "utf8");
  },
});
await store.load();
store.recordPrompt(word);
const start = once(process, "message");
process.send!("ready");
await start;
await store.persist();
await store.close();
process.disconnect!();
