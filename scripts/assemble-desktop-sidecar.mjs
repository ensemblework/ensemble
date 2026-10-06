/**
 * Pack hub-api, its worker, and a Node binary into the Tauri resources folder.
 * Dev builds skip this and run `node --import tsx` from the workspace.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./desktop-spawn.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = parseArgs(process.argv.slice(2));
const appDir = join(dest, "app");

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const generate = run("pnpm", ["--filter", "@ensemble/hub-api", "exec", "prisma", "generate"], { cwd: root });
if (generate !== 0) process.exit(generate);

const deploy = run("pnpm", ["--filter", "@ensemble/hub-api", "deploy", appDir], { cwd: root });
if (deploy !== 0) process.exit(deploy);

// pnpm's node_modules is a symlink farm into .pnpm. Tauri's bundler drops
// symlinks, so the installed app cannot resolve its packages. Hoist one real
// copy of each package and nest only the versions that would collide.
console.log("materializing sidecar node_modules");
materializeNodeModules(appDir);

const nodeName = process.platform === "win32" ? "node.exe" : "node";
const nodeSrc = realpathSync(process.execPath);
const nodeDest = join(dest, nodeName);
cpSync(nodeSrc, nodeDest);
if (process.platform !== "win32") chmodSync(nodeDest, 0o755);
// Homebrew Node is a small stub that loads libnode and other cellar libraries
// by absolute path. A packaged sidecar has to carry those libraries and point
// the binary at the copies, or dyld aborts before the import check.
bundleNodeLibraries(nodeSrc, nodeDest);

const imported = run(
  nodeDest,
  ["--import", "tsx", "-e", "await import('fastify'); await import('@prisma/client'); await import('@electric-sql/pglite'); console.log('sidecar-import-ok')"],
  { cwd: appDir, encoding: "utf8", stdio: "pipe" },
);
if (imported !== 0) {
  console.error("The bundled sidecar cannot import tsx.");
  process.exit(imported);
}

console.log(`sidecar assembled at ${dest}`);

function parseArgs(args) {
  const defaultDest = join(root, "apps/desktop/src-tauri/resources/sidecar");
  let output = defaultDest;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dest") {
      const value = args[i + 1];
      if (!value) {
        console.error("--dest requires a directory.");
        process.exit(1);
      }
      output = resolve(root, value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--dest=")) {
      output = resolve(root, arg.slice("--dest=".length));
      continue;
    }
    console.error(`Unknown option for assemble-desktop-sidecar.mjs: ${arg}`);
    process.exit(1);
  }
  return output;
}

function bundleNodeLibraries(nodeSrc, nodeDest) {
  if (process.platform === "darwin") {
    bundleDarwinLibraries(nodeSrc, nodeDest);
    return;
  }
  if (process.platform !== "linux") return;
  const ldd = spawnSync("ldd", [nodeSrc], { encoding: "utf8" });
  for (const line of (ldd.stdout ?? "").split("\n")) {
    const match = line.match(/=>\s+(\S+)/);
    if (!match) continue;
    const lib = match[1];
    if (lib.startsWith("/lib") || lib.startsWith("/usr/lib") || lib.startsWith("/lib64")) continue;
    cpSync(lib, join(dirname(nodeDest), basename(lib)));
    console.log(`copied ${lib}`);
  }
}

function bundleDarwinLibraries(nodeSrc, nodeDest) {
  const destDir = dirname(nodeDest);
  const executableDir = dirname(nodeSrc);
  const files = new Map();
  const queue = [nodeSrc];
  const seen = new Set();
  while (queue.length) {
    const binary = queue.shift();
    const real = realpathSync(binary);
    if (seen.has(real)) continue;
    seen.add(real);
    const { deps, id } = machOLoadCommands(real);
    const bundledDeps = [];
    const seenDep = new Set();
    for (const dep of deps) {
      if (seenDep.has(dep) || isSystemLibrary(dep) || dep === id) continue;
      seenDep.add(dep);
      const found = resolveMachODep(real, dep, executableDir);
      if (!found) {
        console.error(`Sidecar node depends on ${dep}, which was not found next to ${basename(real)}.`);
        process.exit(1);
      }
      const depReal = realpathSync(found);
      if (depReal === real) continue;
      bundledDeps.push({ from: dep, name: basename(depReal) });
      queue.push(depReal);
    }
    files.set(real, { deps: bundledDeps, id, name: basename(real) });
  }

  const nodeReal = realpathSync(nodeSrc);
  const copiedNames = new Set();
  for (const [real, info] of files) {
    if (real === nodeReal) continue;
    if (copiedNames.has(info.name)) {
      console.error(`Two libraries linked by the sidecar node share the file name ${info.name}.`);
      process.exit(1);
    }
    copiedNames.add(info.name);
    const target = join(destDir, info.name);
    cpSync(real, target);
    chmodSync(target, 0o755);
    console.log(`copied ${real}`);
  }

  for (const [real, info] of files) {
    const target = real === nodeReal ? nodeDest : join(destDir, info.name);
    const args = [];
    if (info.id && !isSystemLibrary(info.id)) args.push("-id", `@loader_path/${info.name}`);
    for (const dep of info.deps) args.push("-change", dep.from, `@loader_path/${dep.name}`);
    if (!args.length) continue;
    runTool("install_name_tool", [...args, target]);
    // Rewriting load commands invalidates the existing signature. An ad-hoc
    // signature is enough for this unsigned disk image.
    runTool("codesign", ["--force", "--sign", "-", target]);
  }
}

function machOLoadCommands(file) {
  const listed = spawnSync("otool", ["-L", file], { encoding: "utf8" });
  if (listed.status !== 0) {
    if (listed.stdout) console.error(listed.stdout);
    if (listed.stderr) console.error(listed.stderr);
    console.error("otool could not read the sidecar node.");
    process.exit(listed.status ?? 1);
  }
  const deps = [];
  for (const line of listed.stdout.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const dep = trimmed.split(" (")[0].trim();
    if (dep) deps.push(dep);
  }
  const idResult = spawnSync("otool", ["-D", file], { encoding: "utf8" });
  const lines = (idResult.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  return { deps, id: lines[1] ?? "" };
}

function machORpaths(file) {
  const listed = spawnSync("otool", ["-l", file], { encoding: "utf8" });
  const rpaths = [];
  const lines = (listed.stdout ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("LC_RPATH")) continue;
    for (let j = i; j < Math.min(i + 8, lines.length); j++) {
      const match = lines[j].match(/\bpath\s+(\S+)/);
      if (match) {
        rpaths.push(match[1]);
        break;
      }
    }
  }
  return rpaths;
}

function resolveMachODep(binary, dep, executableDir) {
  if (dep.startsWith("/")) return existsSync(dep) ? dep : null;
  const expanded = expandMachOPath(dep, dirname(binary), executableDir);
  if (expanded !== dep && existsSync(expanded)) return expanded;
  if (!dep.startsWith("@rpath/")) return null;
  const rest = dep.slice("@rpath/".length);
  for (const rpath of machORpaths(binary)) {
    const cand = join(expandMachOPath(rpath, dirname(binary), executableDir), rest);
    if (existsSync(cand)) return cand;
  }
  return null;
}

function expandMachOPath(token, origin, executableDir) {
  if (token.startsWith("@loader_path")) return normalize(join(origin, token.slice("@loader_path".length).replace(/^[/]/, "")));
  if (token.startsWith("@executable_path")) return normalize(join(executableDir, token.slice("@executable_path".length).replace(/^[/]/, "")));
  return token;
}

function isSystemLibrary(dep) {
  return dep.startsWith("/usr/lib/") || dep.startsWith("/System/");
}

function runTool(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    console.error(`Could not start ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    if (result.stdout) console.error(result.stdout);
    if (result.stderr) console.error(result.stderr);
    console.error(`${command} failed while packing the sidecar node.`);
    process.exit(result.status ?? 1);
  }
}

function materializeNodeModules(appDir) {
  const nodeModules = join(appDir, "node_modules");
  const store = readPnpmStore(join(nodeModules, ".pnpm"));
  const manifest = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
  const roots = [...Object.keys(manifest.dependencies ?? {}), "tsx"];
  const hoisted = new Map();
  const queue = [];
  for (const name of roots) {
    const linked = join(nodeModules, ...name.split("/"));
    const version = JSON.parse(readFileSync(join(realpathSync(linked), "package.json"), "utf8")).version;
    hoisted.set(name, version);
    queue.push(`${name}@${version}`);
  }
  const seen = new Set();
  while (queue.length) {
    const key = queue.shift();
    if (seen.has(key)) continue;
    seen.add(key);
    const pkg = store.get(key);
    if (!pkg) {
      console.error(`Sidecar store is missing ${key}`);
      process.exit(1);
    }
    if (!hoisted.has(pkg.name)) hoisted.set(pkg.name, pkg.version);
    for (const dep of pkg.deps) {
      if (!seen.has(`${dep.name}@${dep.version}`)) queue.push(`${dep.name}@${dep.version}`);
    }
  }

  for (const [name, version] of hoisted) {
    const pkg = store.get(`${name}@${version}`);
    const dest = join(nodeModules, ...name.split("/"));
    removeEntry(dest);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(pkg.dir, dest, { recursive: true, dereference: true });
    for (const extra of pkg.extras) {
      const extraDest = join(nodeModules, basename(extra));
      if (!existsSync(extraDest)) cpSync(extra, extraDest, { recursive: true, dereference: true });
    }
  }

  const seenEdge = new Set();
  const nest = [];
  for (const [name, version] of hoisted) {
    nest.push({ key: `${name}@${version}`, dir: join(nodeModules, ...name.split("/")) });
  }
  while (nest.length) {
    const { key, dir } = nest.shift();
    const pkg = store.get(key);
    for (const dep of pkg.deps) {
      if (hoisted.get(dep.name) === dep.version) continue;
      const edge = `${dir}->${dep.name}@${dep.version}`;
      if (seenEdge.has(edge)) continue;
      seenEdge.add(edge);
      const dest = join(dir, "node_modules", ...dep.name.split("/"));
      if (!existsSync(join(dest, "package.json"))) {
        const depPkg = store.get(`${dep.name}@${dep.version}`);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(depPkg.dir, dest, { recursive: true, dereference: true });
      }
      nest.push({ key: `${dep.name}@${dep.version}`, dir: dest });
    }
  }

  rmSync(join(nodeModules, ".pnpm"), { recursive: true, force: true });
  rmSync(join(nodeModules, ".bin"), { recursive: true, force: true });
  // Drop dev tooling the sidecar does not launch with. tsx stays; it runs the TypeScript entry.
  for (const extra of ["typescript", "prisma", "@types"]) {
    rmSync(join(nodeModules, extra), { recursive: true, force: true });
  }
  const left = symlinksUnder(nodeModules);
  if (left.length) {
    console.error(`Sidecar node_modules still has symlinks, for example ${left[0]}`);
    process.exit(1);
  }
}

function readPnpmStore(pnpmDir) {
  const store = new Map();
  for (const id of readdirSync(pnpmDir)) {
    if (id === "node_modules" || id.startsWith(".")) continue;
    const idDir = join(pnpmDir, id);
    const nm = join(idDir, "node_modules");
    if (!existsSync(nm)) continue;
    const owned = [];
    const siblings = [];
    const extras = [];
    collectStoreEntries(nm, realpathSync(idDir), owned, siblings, extras);
    const resolved = new Map();
    for (const sibling of siblings) {
      const meta = JSON.parse(readFileSync(join(realpathSync(sibling.path), "package.json"), "utf8"));
      resolved.set(sibling.name, { name: meta.name || sibling.name, version: meta.version });
    }
    for (const pkg of owned) {
      const meta = JSON.parse(readFileSync(join(pkg.dir, "package.json"), "utf8"));
      const name = meta.name || pkg.name;
      const version = meta.version;
      const deps = [];
      for (const sibling of siblings) {
        if (sibling.name === name) continue;
        const dep = resolved.get(sibling.name);
        if (dep) deps.push(dep);
      }
      store.set(`${name}@${version}`, { name, version, dir: pkg.dir, deps, extras });
    }
  }
  return store;
}

function collectStoreEntries(dir, idDir, owned, siblings, extras, scope = "") {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".bin") continue;
    const path = join(dir, entry.name);
    if (!scope && entry.name.startsWith(".") && entry.isDirectory()) {
      extras.push(path);
      continue;
    }
    const name = scope ? `${scope}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      siblings.push({ name, path });
      continue;
    }
    if (entry.isDirectory() && entry.name.startsWith("@") && !existsSync(join(path, "package.json"))) {
      collectStoreEntries(path, idDir, owned, siblings, extras, entry.name);
      continue;
    }
    if (!existsSync(join(path, "package.json"))) continue;
    const real = realpathSync(path);
    if (insideDir(idDir, real)) owned.push({ name, dir: real });
    else siblings.push({ name, path });
  }
}

/** Remove a symlink or Windows junction without deleting the package it points at. */
function removeEntry(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(path);
    return;
  }
  if (process.platform === "win32" && stat.isDirectory()) {
    try {
      rmdirSync(path);
      return;
    } catch (error) {
      if (error.code !== "ENOTEMPTY" && error.code !== "EPERM" && error.code !== "ENOENT") throw error;
    }
  }
  rmSync(path, { recursive: true, force: true });
}

function insideDir(dir, file) {
  const root = normalize(dir).replace(/[\\/]+$/, "");
  const target = normalize(file).replace(/[\\/]+$/, "");
  const prefix = root + sep;
  if (process.platform === "win32") {
    return target.toLowerCase() === root.toLowerCase() || target.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return target === root || target.startsWith(prefix);
}

function symlinksUnder(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) found.push(path);
    else if (entry.isDirectory()) symlinksUnder(path, found);
    if (found.length > 5) return found;
  }
  return found;
}
