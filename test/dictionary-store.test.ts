import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import {
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  mkdir,
  rm,
  rmdir,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { releaseDictionaryLock } from "../src/dictionary/lock.ts";
import { PersonalDictionaryStore } from "../src/dictionary/store.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "ghost-dictionary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "personal-v1.json");
}
const options = {
  common: [] as [string, number][],
  now: () => 1_800_000_000_000,
  debounceMs: 60_000,
};

function writer(t: TestContext, path: string, word: string, mode = "write") {
  const child = fork(
    new URL("./fixtures/dictionary-writer.ts", import.meta.url),
    [path, word, mode],
    {
      execArgv: ["--experimental-strip-types"],
    },
  );
  const exit = once(child, "exit");
  t.after(async () => {
    child.kill();
    await exit;
  });
  const message = (expected: string) =>
    Promise.race([
      once(child, "message").then(([actual]) => assert.equal(actual, expected)),
      exit.then(([code, signal]) =>
        assert.fail(`Writer exited before ${expected}: ${code ?? signal}`),
      ),
    ]);
  return { child, exit, message };
}

test(
  "live writers keep their lock and competing writers recover it after a crash",
  { timeout: 10_000 },
  async (t) => {
    const path = await fixture(t);
    const seed = new PersonalDictionaryStore(path, options);
    seed.recordPrompt("capricorn");
    await seed.close();

    const holder = writer(t, path, "octopus", "hold");
    await holder.message("ready");
    const locked = holder.message("locked");
    holder.child.send("start");
    await locked;

    const contender = new PersonalDictionaryStore(path, {
      ...options,
      lockTimeoutMs: 40,
    });
    contender.recordPrompt("elephant");
    await assert.rejects(contender.persist(), /Dictionary lock timeout/);
    assert.deepEqual(
      JSON.parse(await readFile(path, "utf8")).words.map(
        (entry: { word: string }) => entry.word,
      ),
      ["capricorn"],
    );
    assert.ok(holder.child.kill("SIGKILL"));
    await holder.exit;

    const first = writer(t, path, "elephant");
    const second = writer(t, path, "elephant");
    await Promise.all([first.message("ready"), second.message("ready")]);
    first.child.send("start");
    second.child.send("start");
    for (const [code, signal] of await Promise.all([first.exit, second.exit])) {
      assert.equal(code, 0, `Recovery writer exited with ${code ?? signal}`);
    }
    await contender.close();
    const { words } = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(
      Object.fromEntries(
        words.map(
          ({ word, promptCount }: { word: string; promptCount: number }) => [
            word,
            promptCount,
          ],
        ),
      ),
      {
        capricorn: 1,
        elephant: 3,
      },
    );
  },
);

test("a late recovery cannot remove a new owner's lock", async (t) => {
  const path = await fixture(t);
  const lock = `${path}.lock-v2`;
  await mkdir(join(lock, "new-owner"), { recursive: true });
  await releaseDictionaryLock(lock, "previous-owner");
  assert.deepEqual(await readdir(lock), ["new-owner"]);
  await releaseDictionaryLock(lock, "new-owner");
  await assert.rejects(readdir(lock), { code: "ENOENT" });
});

test("an empty v2 lock directory is recovered after interrupted cleanup", async (t) => {
  const path = await fixture(t);
  await mkdir(`${path}.lock-v2`);
  const store = new PersonalDictionaryStore(path, options);
  store.recordAcceptance("capric", "orn");
  await store.persist();
  assert.equal(
    JSON.parse(await readFile(path, "utf8")).pairs[0].word,
    "capricorn",
  );
  await assert.rejects(readdir(`${path}.lock-v2`), { code: "ENOENT" });
  await store.close();
});

test("store merges concurrent writers without double counting and survives restart", async (t) => {
  const path = await fixture(t);
  const a = new PersonalDictionaryStore(path, options),
    b = new PersonalDictionaryStore(path, options);
  await Promise.all([a.load(), b.load()]);
  a.recordPrompt("capricorn capricorn");
  b.recordPrompt("capricorn again");
  await Promise.all([a.persist(), b.persist()]);
  await a.persist();
  const state = JSON.parse(await readFile(path, "utf8"));
  assert.equal(
    state.words.find((w: { word: string }) => w.word === "capricorn")
      .promptCount,
    2,
  );
  const c = new PersonalDictionaryStore(path, options);
  await c.load();
  assert.equal(c.lookup("capric")?.suffix, "orn");
  await Promise.all([a.close(), b.close(), c.close()]);
});

test("observations before load and during deferred reads survive load and close", async (t) => {
  const path = await fixture(t);
  let release!: (text: string) => void;
  let first = true;
  const store = new PersonalDictionaryStore(path, {
    ...options,
    read: (p) => {
      if (first) {
        first = false;
        return new Promise<string>((r) => {
          release = r;
        });
      }
      return readFile(p, "utf8");
    },
  });
  store.recordPrompt("capricorn");
  const loading = store.load();
  await new Promise((r) => setImmediate(r));
  store.recordPrompt("capricorn");
  release('{"version":1,"words":[],"pairs":[]}');
  await loading;
  assert.equal(store.lookup("capric")?.suffix, "orn");
  await store.close();
  const before = await readFile(path, "utf8");
  store.recordPrompt("ignoredword");
  await store.persist();
  assert.equal(await readFile(path, "utf8"), before);
});

test("corrupt and unsupported states recover with common dictionary and diagnostics", async (t) => {
  const path = await fixture(t);
  for (const data of [
    "{",
    '{"version":8}',
    '{"version":1,"words":[{"word":"poison","promptCount":-1,"updatedAt":0}],"pairs":[]}',
  ]) {
    await writeFile(path, data);
    const warnings: string[] = [];
    const s = new PersonalDictionaryStore(path, {
      ...options,
      common: [["because", 0.001]],
      onDiagnostic: (m) => warnings.push(m),
    });
    await s.load();
    assert.equal(s.lookup("becau")?.suffix, "se");
    assert.equal(s.lookup("pois"), undefined);
    if (!data.includes("poison")) assert.equal(warnings.length, 1);
    await s.close();
  }
});

test("legacy lock requires offline cleanup and old writers cannot resume after migration", async (t) => {
  const path = await fixture(t),
    warnings: string[] = [];
  const s = new PersonalDictionaryStore(path, {
    ...options,
    lockTimeoutMs: 30,
    onDiagnostic: (m) => warnings.push(m),
  });
  await s.load();
  s.recordAcceptance("capric", "orn");
  await mkdir(path + ".lock");
  await assert.rejects(s.persist(), (error: Error) => {
    assert.ok(error.message.includes(`${path}.lock`));
    assert.match(error.message, /close all Pi sessions/i);
    return true;
  });
  assert.equal(s.lookup("capric")?.suffix, "orn");
  assert.deepEqual(await readdir(path + ".lock"), []);
  await rmdir(path + ".lock");
  await s.persist();
  await assert.rejects(mkdir(path + ".lock"), { code: "EEXIST" });
  assert.equal(await readFile(path + ".lock", "utf8"), "");
  assert.equal(JSON.parse(await readFile(path, "utf8")).pairs.length, 1);
  await s.clear();
  assert.equal(s.lookup("capric"), undefined);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    version: 1,
    words: [],
    pairs: [],
  });
  await s.close();
});

test("a failed atomic replacement releases the lock and retries the observations once", async (t) => {
  const path = await fixture(t);
  const store = new PersonalDictionaryStore(path, {
    ...options,
    read: async () => '{"version":1,"words":[],"pairs":[]}',
  });
  store.recordPrompt("capricorn");
  await mkdir(path);
  await assert.rejects(store.persist());
  assert.deepEqual((await readdir(dirname(path))).sort(), [
    "personal-v1.json",
    "personal-v1.json.lock",
  ]);
  await rmdir(path);
  await store.persist();
  await store.close();
  assert.equal(
    JSON.parse(await readFile(path, "utf8")).words[0].promptCount,
    1,
  );
});

test("lock cleanup failure warns after a successful replacement without retrying it", async (t) => {
  const path = await fixture(t);
  const lock = `${path}.lock-v2`;
  const warnings: string[] = [];
  let obstruction: string | undefined;
  const store = new PersonalDictionaryStore(path, {
    ...options,
    async read(file) {
      if (!obstruction) {
        const [owner] = await readdir(lock).catch(() => []);
        if (owner) {
          obstruction = join(lock, owner, "obstruction");
          await mkdir(obstruction);
        }
      }
      return readFile(file, "utf8");
    },
    onDiagnostic: (message) => warnings.push(message),
  });
  store.recordPrompt("capricorn");
  await store.persist();
  assert.match(warnings[0], /lock cleanup failed/i);
  assert.ok(obstruction);
  await rmdir(obstruction);
  const [owner] = await readdir(lock);
  await releaseDictionaryLock(lock, owner);
  await store.close();
  assert.equal(
    JSON.parse(await readFile(path, "utf8")).words[0].promptCount,
    1,
  );
});

test("failed writes retain pending observations and close reports unsaved data", async (t) => {
  const path = await fixture(t),
    warnings: string[] = [];
  const s = new PersonalDictionaryStore(path, {
    ...options,
    onDiagnostic: (m) => warnings.push(m),
  });
  await s.load();
  s.recordPrompt("capricorn");
  s.recordPrompt("capricorn");
  await mkdir(path);
  await assert.rejects(s.persist());
  assert.equal(s.lookup("capric")?.suffix, "orn");
  await s.close();
  assert.ok(warnings.some((w) => /unsaved/i.test(w)));
});

// Keep Cyrillic vocabulary available across sessions without adding language configuration.
test("Cyrillic prompts and accepted words survive a dictionary restart", async (t) => {
  const path = await fixture(t);
  const entries = [
    ["працювати", "прац", "ювати"],
    ["разработка", "разр", "аботка"],
    ["прывітанне", "прыв", "ітанне"],
    ["съобщение", "съоб", "щение"],
    ["љубав", "љуб", "ав"],
    ["ѕвезда", "ѕве", "зда"],
    ["пам’ятати", "пам’", "ятати"],
  ];
  const store = new PersonalDictionaryStore(path, options);
  t.after(() => store.close());
  await store.load();
  const prompt = entries.map(([word]) => word).join(" ") + " implementation";
  store.recordPrompt(prompt + " " + prompt);
  for (const [, prefix] of entries)
    assert.equal(store.lookup(prefix), undefined, prefix);
  store.recordPrompt(prompt);
  store.recordAcceptance("перев", "іряти");
  await store.close();

  const state = JSON.parse(await readFile(path, "utf8"));
  for (const [word] of entries) {
    const saved = state.words.find(
      (entry: { word: string }) => entry.word === word.replaceAll("’", "'"),
    );
    assert.equal(saved?.promptCount, 2, word);
  }
  const reopened = new PersonalDictionaryStore(path, options);
  t.after(() => reopened.close());
  await reopened.load();
  for (const [, prefix, suffix] of entries) {
    assert.equal(reopened.lookup(prefix)?.suffix, suffix, prefix);
    assert.equal(
      reopened.lookup(prefix.toUpperCase())?.suffix,
      suffix.toUpperCase(),
      prefix,
    );
  }
  assert.equal(reopened.lookup("перев")?.suffix, "іряти");
  assert.equal(reopened.lookup("imple")?.suffix, "mentation");
  assert.equal(reopened.lookup("ghfw"), undefined);
});
