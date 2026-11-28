import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, mkdtemp, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const project = resolve(fileURLToPath(new URL("../", import.meta.url)));
const parent = JSON.parse(
  await readFile(join(project, "package.json"), "utf8"),
);
const version = parent.version;
const root = await mkdtemp(join(tmpdir(), "pi-ghost-install-"));
const cwd = join(root, "project"),
  agentDir = join(root, "agent");
await mkdir(cwd, { recursive: true });
await mkdir(agentDir, { recursive: true });
const target = {
  "win32-x64": "win32-x64-msvc",
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "darwin-arm64": "darwin-arm64",
}[`${process.platform}-${process.arch}`];
assert.ok(target, "unsupported install smoke target");
const names = [parent.name, `@sheethappiness/pi-ghost-autocomplete-${target}`];
const packages = new Map();
for (const name of names) {
  const isParent = name === names[0];
  const filename = isParent
    ? `${parent.name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`
    : `sheethappiness-pi-ghost-autocomplete-${target}-${version}.tgz`;
  const data = await readFile(join(project, "artifacts", filename));
  const manifest = JSON.parse(
    await readFile(
      isParent
        ? join(project, "package.json")
        : join(project, "platforms", target, "package.json"),
      "utf8",
    ),
  );
  packages.set(name, {
    manifest,
    filename,
    data,
    integrity: "sha512-" + createHash("sha512").update(data).digest("base64"),
  });
}
const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split("?")[0]).slice(1);
  if (path.startsWith("tarballs/")) {
    const p = [...packages.values()].find((p) => p.filename === path.slice(9));
    if (p) {
      res.end(p.data);
      return;
    }
  }
  const p = packages.get(path);
  if (p) {
    const address = server.address();
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        name: path,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            ...p.manifest,
            dist: {
              tarball: `http://127.0.0.1:${address.port}/tarballs/${p.filename}`,
              integrity: p.integrity,
            },
          },
        },
      }),
    );
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "fixture package unavailable" }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const address = server.address();
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET/.test(name),
  ),
);
Object.assign(env, {
  PI_CODING_AGENT_DIR: agentDir,
  npm_config_registry: `http://127.0.0.1:${address.port}`,
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_ignore_scripts: "true",
  npm_config_cache: join(root, "npm-cache"),
  PI_GHOST_STATE_DIR: join(root, "state"),
});
delete env.PI_GHOST_NATIVE_PATH;
const cli = join(
  project,
  "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
);
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`pi ${args.join(" ")} exited ${code}: ${output}`)),
    );
  });
}
async function assertNoInstalledHostPeers(...roots) {
  for (const root of roots) {
    for (const peer of Object.keys(parent.peerDependencies)) {
      const path = join(root, "node_modules", peer);
      await assert.rejects(
        access(path),
        { code: "ENOENT" },
        `Unexpected installed host peer: ${path}`,
      );
    }
  }
}
try {
  const source = `npm:${parent.name}@${version}`;
  const installed = await run(["install", source]);
  const listed = await run(["list"]);
  assert.ok(listed.includes(parent.name));
  const installedRoot = join(agentDir, "npm/node_modules", parent.name);
  const inventory = JSON.parse(
    await readFile(
      join(installedRoot, "licenses/rust-dependencies.json"),
      "utf8",
    ),
  );
  assert.ok(inventory.length >= 60);
  // Host-provided peers must not get installed into the managed package root.
  await assertNoInstalledHostPeers(join(agentDir, "npm"), installedRoot);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    disabledBuiltinExtensions: ["mcp"],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.ok(loaded.extensions.some((e) => e.commands.has("ghost")));
  const nativePath = join(
    agentDir,
    `npm/node_modules/@sheethappiness/pi-ghost-autocomplete-${target}/ghost-native.node`,
  );
  await access(nativePath);
  // Exercise installed native resolution without the development override.
  const require = createRequire(join(installedRoot, "src/native/load.ts"));
  const { TextPredictor } = require(
    `@sheethappiness/pi-ghost-autocomplete-${target}`,
  );
  const engine = new TextPredictor({
    modelDir: join(root, "absent"),
    stateDir: join(root, "state"),
  });
  await assert.rejects(engine.ready());
  await engine.close();
  await run(["remove", source]);
  assert.ok(!(await run(["list"])).includes(source));
  await run(["install", project]);
  assert.ok((await run(["list"])).includes(project));
  await run(["remove", project]);

  // CI also installs this exact source revision through Pi's GitHub package
  // manager. The local fixture registry serves the candidate native tarball,
  // so this can run before the version is published to public npm.
  const gitSource = process.env.PI_GHOST_GIT_SOURCE;
  if (gitSource) {
    const match = /^git:github\.com\/([^/@]+)\/([^/@]+)@([a-f0-9]{40})$/i.exec(gitSource);
    assert.ok(match, "PI_GHOST_GIT_SOURCE must be an exact GitHub commit");
    const [, owner, repo, commit] = match;
    const gitInstalled = await run(["install", gitSource]);
    const gitListed = await run(["list"]);
    assert.ok(gitListed.includes(gitSource), "Pi did not register the GitHub source");

    const gitRoot = join(agentDir, "git", "github.com", owner, repo);
    const gitManifest = JSON.parse(await readFile(join(gitRoot, "package.json"), "utf8"));
    assert.equal(gitManifest.version, version, "GitHub checkout has the wrong package version");
    assert.deepEqual(gitManifest.pi.extensions, parent.pi.extensions);
    await assertNoInstalledHostPeers(gitRoot);

    const nativeName = names[1];
    const gitNativePath = join(gitRoot, "node_modules", nativeName, "ghost-native.node");
    await access(gitNativePath);
    const gitRequire = createRequire(join(gitRoot, "src/native/load.ts"));
    const { TextPredictor: GitTextPredictor } = gitRequire(nativeName);
    assert.equal(typeof GitTextPredictor, "function");
    const gitEngine = new GitTextPredictor({
      modelDir: join(root, "absent"),
      stateDir: join(root, "git-state"),
    });
    // Missing weights must fail after native loading, not at require()/startup.
    await assert.rejects(gitEngine.ready());
    await gitEngine.close();

    const gitLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      disabledBuiltinExtensions: ["mcp"],
    });
    await gitLoader.reload();
    const gitExtensions = gitLoader.getExtensions();
    assert.deepEqual(gitExtensions.errors, []);
    assert.ok(
      gitExtensions.extensions.some(
        (extension) =>
          extension.commands.has("ghost") &&
          resolve(extension.path) ===
            resolve(gitRoot, gitManifest.pi.extensions[0]),
      ),
      "Installed GitHub extension was not discovered by Pi",
    );
    console.log(
      `PASS ${target}: Pi installed ${gitSource}, discovered the extension and loaded the native predictor`,
    );
    // Do not remove the checkout here: a loaded .node can remain locked on Windows.
    // The isolated temporary profile is discarded after CI.
  }
  await writeFile(
    join(root, "result.json"),
    JSON.stringify(
      {
        target,
        installed,
        listed,
        extensionPaths: loaded.extensions.map((e) => e.path),
        nativePath,
        source: "local fixture registry; not public npm",
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS ${target}: actual Pi install/list/discovery/native resolution/remove plus local path. Evidence: ${root}`,
  );
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
