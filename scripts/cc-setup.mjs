#!/usr/bin/env node
/**
 * Prepara la máquina y levanta el editor.
 * Sin llave de DeepSeek no hay corrección ni traducción, así que se pide antes de instalar.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backend = path.join(root, "backend");
const frontend = path.join(root, "frontend");
const venvPython = path.join(backend, ".venv", "Scripts", "python.exe");
const envFile = path.join(backend, ".env");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true, ...options });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} terminó con código ${code}`));
    });
  });
}

function capture(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let text = "";
    child.stdout?.on("data", (chunk) => {
      text += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      text += chunk.toString();
    });
    child.on("error", () => resolve(""));
    child.on("exit", () => resolve(text));
  });
}

function portBusy(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port, "127.0.0.1");
  });
}

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function requireNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) {
    fail(`Hace falta Node.js 18 o más reciente. Esta máquina tiene ${process.versions.node}.`);
  }
}

async function requirePython() {
  const fromLauncher = (await capture("py", ["-3.11", "-c", "import sys; print(sys.executable)"])).trim();
  const executable = fromLauncher.split(/\r?\n/).filter(Boolean).pop() || "";
  if (executable && existsSync(executable)) {
    return executable;
  }
  const version = await capture("python", ["-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}|{sys.executable}')"]);
  const [numbers, found] = version.trim().split("|");
  if (numbers === "3.11" && found) {
    return found.trim();
  }
  fail("Hace falta Python 3.11. Instálalo y vuelve a correr npx cc-setup.");
}

async function requireGpu() {
  const report = await capture("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
  const line = report.trim().split(/\r?\n/).find((row) => row.includes(","));
  if (!line) {
    fail("No hay una GPU NVIDIA visible. Este editor transcribe en CUDA y quema con NVENC. Sin esa GPU la cadena no termina.");
  }
  const [name, memory] = line.split(",").map((part) => part.trim());
  const mib = Number(memory);
  if (!Number.isFinite(mib) || mib < 8192) {
    fail(`La GPU ${name || "NVIDIA"} no llega a 8 GB de VRAM. Hacen falta para Whisper medium y el quemado.`);
  }
  console.log(`GPU: ${name} (${Math.round(mib / 1024)} GB)`);
}

function findFfmpeg() {
  const rootDir = path.join(backend, "tools", "ffmpeg8");
  if (!existsSync(rootDir)) {
    return "ffmpeg";
  }
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        stack.push(full);
      } else if (entry.toLowerCase() === "ffmpeg.exe") {
        return full;
      }
    }
  }
  return "ffmpeg";
}

async function requireFfmpeg() {
  const binary = findFfmpeg();
  const version = await capture(binary, ["-version"]);
  const header = version.split(/\r?\n/)[0] || "";
  if (!/ffmpeg version/i.test(header)) {
    fail("No está FFmpeg. Coloca FFmpeg 8 en backend/tools/ffmpeg8 o deja ffmpeg en el PATH. FFmpeg 9 no abre NVENC con el driver de la serie 591.");
  }
  if (!/ffmpeg version 8\./i.test(header)) {
    fail(`Hace falta FFmpeg 8. Se encontró: ${header}. FFmpeg 9 pide un driver NVIDIA más nuevo del que usa este quemado.`);
  }
  console.log(header);
}

function currentKey() {
  if (!existsSync(envFile)) {
    return "";
  }
  const match = readFileSync(envFile, "utf8").match(/^DEEPSEEK_API_KEY=(.*)$/m);
  return match ? match[1].trim() : "";
}

async function requireKey() {
  if (currentKey()) {
    console.log("La llave de DeepSeek ya está en backend/.env. No se vuelve a pedir.");
    return;
  }
  if (!input.isTTY) {
    fail("Falta DEEPSEEK_API_KEY. Corre npx cc-setup en una terminal para guardarla en backend/.env.");
  }
  const prompt = createInterface({ input, output });
  const key = (await prompt.question("Llave de DeepSeek (DEEPSEEK_API_KEY). Sin ella no se corrige ni se traduce: ")).trim();
  prompt.close();
  if (!key) {
    fail("Sin la llave de DeepSeek no se pueden gastar los tokens de corrección y traducción.");
  }
  const example = path.join(backend, ".env.example");
  const base = existsSync(envFile) ? readFileSync(envFile, "utf8") : readFileSync(example, "utf8");
  const next = /^DEEPSEEK_API_KEY=.*$/m.test(base)
    ? base.replace(/^DEEPSEEK_API_KEY=.*$/m, `DEEPSEEK_API_KEY=${key}`)
    : `DEEPSEEK_API_KEY=${key}\n${base}`;
  writeFileSync(envFile, next.endsWith("\n") ? next : `${next}\n`, "utf8");
  console.log("Llave guardada en backend/.env. Ese archivo no se sube al repositorio.");
}

async function installBackend(python) {
  if (!existsSync(venvPython)) {
    await run(python, ["-m", "venv", path.join(backend, ".venv")]);
  }
  await run(venvPython, ["-m", "pip", "install", "-r", path.join(backend, "requirements.txt")], { cwd: backend });
  await run(venvPython, ["-m", "playwright", "install", "chromium"], { cwd: backend });
}

async function installFrontend() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await run(npm, ["install"], { cwd: frontend, shell: true });
}

function startDetached(command, args, cwd) {
  const child = spawn(command, args, { cwd, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

async function startApps() {
  if (!(await portBusy(8001))) {
    startDetached(venvPython, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8001"], backend);
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  for (const port of [3001, 3002]) {
    if (await portBusy(port)) {
      continue;
    }
    startDetached(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `$env:NEXT_DIST_DIR='.next-${port}'; & '${npm}' run dev -- -p ${port}`],
      frontend,
    );
  }
  console.log("Automático: http://localhost:3001");
  console.log("Revisión:   http://localhost:3002");
  console.log("API:        http://127.0.0.1:8001");
}

requireNode();
const python = await requirePython();
await requireGpu();
await requireFfmpeg();
await requireKey();
await installBackend(python);
await installFrontend();
await startApps();
