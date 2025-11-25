#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const useProfile = process.argv[2] === "--profile";
const HOME = os.homedir();
const defaultProfileDir = path.join(HOME, ".cache", "scraping");

const isWSL = () =>
  process.platform === "linux" &&
  os.release().toLowerCase().includes("microsoft");

const usage = () => {
  console.log("Usage: browser-start.js [--profile]");
  console.log("\nOptions:");
  console.log(
    "  --profile  Copy your default Chrome profile (cookies, logins)"
  );
  console.log("\nExamples:");
  console.log("  browser-start.js            # Start with fresh profile");
  console.log("  browser-start.js --profile  # Start with your Chrome profile");
};

if (process.argv[2] && process.argv[2] !== "--profile") {
  usage();
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const killExistingBrowsers = () => {
  const commands = [];

  // Only target browsers already started with remote debugging on :9222
  if (process.platform === "darwin" || process.platform === "linux") {
    commands.push("pkill -f 'remote-debugging-port=9222'");
  }

  if (process.platform === "win32") {
    commands.push(
      "powershell.exe -NoProfile -Command \"Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'remote-debugging-port=9222' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }\""
    );
  }

  if (isWSL()) {
    commands.push(
      "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command \"Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'remote-debugging-port=9222' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }\"",
      "pkill -f 'remote-debugging-port=9222'"
    );
  }

  for (const cmd of commands) {
    try {
      execSync(cmd, { stdio: "ignore" });
    } catch {}
  }
};

const getChromePath = () => {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return {
      path: process.env.CHROME_PATH,
      isWindows: process.env.CHROME_PATH.endsWith(".exe"),
    };
  }

  const candidates = [];

  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    );
  }

  if (process.platform === "linux") {
    for (const bin of [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "microsoft-edge",
    ])
      try {
        const p = execSync(`command -v ${bin}`, { stdio: "pipe" })
          .toString()
          .trim();
        if (p) candidates.push(p);
      } catch {}
  }

  if (process.platform === "win32") {
    candidates.push(
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
    );
  }

  if (isWSL()) {
    candidates.push(
      "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
      "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
      "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
    );
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return { path: candidate, isWindows: candidate.endsWith(".exe") };
    }
  }

  return null;
};

const getProfileSource = () => {
  const sources = [];

  if (process.platform === "darwin") {
    sources.push(
      path.join(HOME, "Library", "Application Support", "Google", "Chrome")
    );
  }

  if (process.platform === "linux" && !isWSL()) {
    sources.push(path.join(HOME, ".config", "google-chrome"));
    sources.push(path.join(HOME, ".config", "chromium"));
  }

  if (process.platform === "win32" || isWSL()) {
    let winHome;
    try {
      winHome = execSync("cmd.exe /C echo %USERPROFILE%", { stdio: "pipe" })
        .toString()
        .trim();
    } catch {}

    if (winHome) {
      if (isWSL()) {
        try {
          const winHomeWsl = execSync(`wslpath -u "${winHome}"`, {
            stdio: "pipe",
          })
            .toString()
            .trim();
          sources.push(
            path.join(
              winHomeWsl,
              "AppData",
              "Local",
              "Google",
              "Chrome",
              "User Data"
            )
          );
        } catch {}
      } else {
        sources.push(
          path.join(
            winHome,
            "AppData",
            "Local",
            "Google",
            "Chrome",
            "User Data"
          )
        );
      }
    }

    const userForFallback = process.env.USER || process.env.USERNAME || "";
    sources.push(
      "/mnt/c/Users/" +
        userForFallback +
        "/AppData/Local/Google/Chrome/User Data",
      "/mnt/c/Users/" +
        userForFallback +
        "/AppData/Local/Microsoft/Edge/User Data"
    );
  }

  return sources.find((s) => s && fs.existsSync(s)) || null;
};

const getWindowsHomeWsl = () => {
  try {
    const winHome = execSync("cmd.exe /C echo %USERPROFILE%", { stdio: "pipe" })
      .toString()
      .trim();
    if (!winHome) return null;
    return execSync(`wslpath -u "${winHome}"`, { stdio: "pipe" })
      .toString()
      .trim();
  } catch {
    return null;
  }
};

const getProfileDirs = (chrome) => {
  // hostDir: path used by this script for copying/creation (WSL path if applicable)
  // chromeDir: path passed to Chrome via --user-data-dir (Windows path for Windows Chrome)

  if (isWSL() && chrome.isWindows) {
    const winHomeWsl = getWindowsHomeWsl();
    if (winHomeWsl) {
      const hostDir = path.join(
        winHomeWsl,
        "AppData",
        "Local",
        "agent-scraping"
      );
      const chromeDir = execSync(`wslpath -w "${hostDir}"`, { stdio: "pipe" })
        .toString()
        .trim();
      return { hostDir, chromeDir };
    }
  }

  // Default for macOS/Linux (and WSL when using Linux Chrome)
  return { hostDir: defaultProfileDir, chromeDir: defaultProfileDir };
};

const ensureProfileDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
};

const syncProfile = (source, target) => {
  if (!source) {
    console.log(
      "! Could not find an existing Chrome profile to copy. Starting fresh."
    );
    return;
  }

  try {
    execSync(`rsync -a --delete "${source}/" "${target}/"`, {
      stdio: "inherit",
    });
    console.log(`✓ Copied profile from ${source}`);
  } catch (e) {
    console.log("! Failed to copy profile, continuing with empty profile.");
  }
};

const chrome = getChromePath();

if (!chrome) {
  console.error(
    "✗ Could not find Chrome/Chromium. Install Chrome or set CHROME_PATH."
  );
  process.exit(1);
}

if (isWSL() && chrome.isWindows) {
  console.log(
    "Info: WSL detected; ensure Windows .wslconfig has [wsl2] networkingMode=mirrored so localhost:9222 works."
  );
}

const { hostDir: profileDir, chromeDir: userDataDir } = getProfileDirs(chrome);

// Kill existing Chrome and give it a moment to release the debugging port
killExistingBrowsers();
await sleep(1000);

ensureProfileDir(profileDir);

if (useProfile) {
  syncProfile(getProfileSource(), profileDir);
}

const chromeArgs = [
  "--remote-debugging-port=9222",
  "--remote-debugging-address=0.0.0.0",
  `--user-data-dir=${userDataDir}`,
  "--no-first-run",
  "--no-default-browser-check",
];

// Start Chrome in background (detached so Node can exit)
spawn(chrome.path, chromeArgs, { detached: true, stdio: "ignore" }).unref();

// With WSL2 mirrored networking (required), localhost hits Windows host.
const browserURL = "http://localhost:9222";

// Wait for Chrome to be ready by attempting to connect
let connected = false;
for (let i = 0; i < 60; i++) {
  try {
    const browser = await puppeteer.connect({
      browserURL,
      defaultViewport: null,
      ignoreHTTPSErrors: true,
    });
    await browser.disconnect();
    connected = true;
    break;
  } catch {
    await sleep(500);
  }
}

if (!connected) {
  console.error(
    `✗ Failed to connect to Chrome on ${browserURL.replace("http://", "")}`
  );
  process.exit(1);
}

console.log(
  `✓ Chrome started on ${browserURL}${useProfile ? " with your profile" : ""}`
);
