import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const workspaceRoot = process.cwd();
const args = process.argv.slice(2);
const options = parseArgs(args);
const releaseVersion = resolveReleaseVersion(options.version);
const versionTag = releaseVersion.tag;
const numericVersion = releaseVersion.numeric;
const outputRoot = resolve(workspaceRoot, "dist", "releases", versionTag);
const stageRoot = resolve(workspaceRoot, ".release-stage", versionTag);

rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageRoot, { recursive: true });
mkdirSync(outputRoot, { recursive: true });

const manifest = {
  version: versionTag,
  numericVersion,
  gitCommit: resolveGitCommit(),
  createdAt: new Date().toISOString(),
  artifacts: []
};

const requestedPlatform = options.platform ?? "all";

if (requestedPlatform === "all" || requestedPlatform === "windows") {
  const artifact = buildWindowsRelease({
    workspaceRoot,
    stageRoot,
    outputRoot,
    versionTag,
    numericVersion
  });
  manifest.artifacts.push(artifact);
}

if (requestedPlatform === "all" || requestedPlatform === "macos") {
  const artifacts = buildMacRelease({
    workspaceRoot,
    stageRoot,
    outputRoot,
    versionTag,
    numericVersion
  });
  manifest.artifacts.push(...artifacts);
}

writeFileSync(
  resolve(outputRoot, `release-manifest-${versionTag}.json`),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);

for (const artifact of manifest.artifacts) {
  console.log(`[release] ${artifact.platform}: ${artifact.path}`);
}

function buildWindowsRelease({ workspaceRoot, stageRoot, outputRoot, versionTag, numericVersion }) {
  const publishDir = resolve(stageRoot, "windows");
  rmSync(publishDir, { recursive: true, force: true });
  mkdirSync(publishDir, { recursive: true });

  run("dotnet", [
    "publish",
    "apps/windows-agent-menu/OctOP.WindowsAgentMenu.csproj",
    "-c",
    "Release",
    "-r",
    "win-x64",
    "--output",
    publishDir,
    "/p:PublishSingleFile=true",
    "/p:SelfContained=true",
    "/p:IncludeAllContentForSelfExtract=true",
    "/p:IncludeNativeLibrariesForSelfExtract=true",
    "/p:DebugType=None",
    "/p:DebugSymbols=false",
    `/p:Version=${numericVersion}`,
    `/p:AssemblyVersion=${normalizeAssemblyVersion(numericVersion)}`,
    `/p:FileVersion=${normalizeAssemblyVersion(numericVersion)}`
  ], workspaceRoot);

  const sourceExe = resolve(publishDir, "OctOP.WindowsAgentMenu.exe");
  if (!existsSync(sourceExe)) {
    throw new Error(`Windows publish output not found: ${sourceExe}`);
  }

  const outputName = `OctOP.WindowsAgentMenu-win-x64-${versionTag}.exe`;
  const outputPath = resolve(outputRoot, outputName);
  cpSync(sourceExe, outputPath);

  return {
    platform: "windows",
    path: outputPath,
    kind: "single-file-exe"
  };
}

function buildMacRelease({ workspaceRoot, stageRoot, outputRoot, versionTag, numericVersion }) {
  if (process.platform !== "darwin") {
    throw new Error("macOS 릴리즈 빌드는 macOS 호스트에서만 실행할 수 있습니다.");
  }

  run("swift", [
    "build",
    "--package-path",
    "apps/macos-agent-menu",
    "-c",
    "release"
  ], workspaceRoot);

  const binPath = exec("swift", [
    "build",
    "--package-path",
    "apps/macos-agent-menu",
    "-c",
    "release",
    "--show-bin-path"
  ], workspaceRoot).trim();

  const executablePath = resolve(binPath, "OctOPAgentMenu");
  const resourceBundlePath = resolve(binPath, "OctOPAgentMenu_OctOPAgentMenu.bundle");

  if (!existsSync(executablePath)) {
    throw new Error(`macOS executable not found: ${executablePath}`);
  }

  if (!existsSync(resourceBundlePath)) {
    throw new Error(`macOS resource bundle not found: ${resourceBundlePath}`);
  }

  const arch = exec("uname", ["-m"], workspaceRoot).trim();
  const appRoot = resolve(stageRoot, "macos", "OctOP.app");
  const contentsRoot = resolve(appRoot, "Contents");
  const macOsRoot = resolve(contentsRoot, "MacOS");
  const resourcesRoot = resolve(contentsRoot, "Resources");
  const hiResIconPath = resolve(workspaceRoot, "design", "large_icon2.png");
  const fallbackIconPath = resolve(workspaceRoot, "apps", "macos-agent-menu", "Sources", "Resources", "icon.png");
  const iconSourcePath = existsSync(hiResIconPath) ? hiResIconPath : fallbackIconPath;
  const iconPath = resolve(resourcesRoot, "AppIcon.icns");
  const standaloneAppName = `OctOP-macos-${arch}-${versionTag}.app`;
  const standaloneAppPath = resolve(outputRoot, standaloneAppName);
  rmSync(resolve(stageRoot, "macos"), { recursive: true, force: true });
  rmSync(standaloneAppPath, { recursive: true, force: true });
  mkdirSync(macOsRoot, { recursive: true });
  mkdirSync(resourcesRoot, { recursive: true });

  cpSync(executablePath, resolve(macOsRoot, "OctOPAgentMenu"));
  cpSync(resourceBundlePath, resolve(appRoot, basename(resourceBundlePath)), { recursive: true });
  buildMacIcon(iconSourcePath, iconPath, resolve(stageRoot, "macos", "AppIcon.iconset"));

  writeFileSync(
    resolve(contentsRoot, "Info.plist"),
    createMacInfoPlist({ versionTag, numericVersion }),
    "utf8"
  );

  cpSync(appRoot, standaloneAppPath, { recursive: true });

  const archiveName = `OctOPAgentMenu-macos-${arch}-${versionTag}.zip`;
  const archivePath = resolve(outputRoot, archiveName);
  rmSync(archivePath, { force: true });

  run("ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    appRoot,
    archivePath
  ], dirname(appRoot));

  return [
    {
      platform: "macos",
      path: standaloneAppPath,
      kind: "app-bundle"
    },
    {
      platform: "macos",
      path: archivePath,
      kind: "zip-app-bundle"
    }
  ];
}

function resolveReleaseVersion(explicitVersion) {
  const rawVersion = explicitVersion ?? resolveTagFromHead();

  if (!rawVersion) {
    throw new Error(
      "릴리즈 버전을 찾지 못했습니다. `--version 1.0.0`으로 직접 지정하거나 현재 HEAD에 `v1.0.0` 같은 git 태그를 붙여 주세요."
    );
  }

  const normalized = String(rawVersion).trim();
  const tag = normalized.startsWith("v") ? normalized : `v${normalized}`;
  const numeric = normalized.startsWith("v") ? normalized.slice(1) : normalized;

  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(numeric)) {
    throw new Error(`지원하지 않는 버전 형식입니다: ${rawVersion}`);
  }

  return { tag, numeric };
}

function resolveTagFromHead() {
  try {
    const tagOutput = exec("git", ["tag", "--points-at", "HEAD"], workspaceRoot)
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean);

    return tagOutput.find((value) => /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) ?? null;
  } catch {
    return null;
  }
}

function resolveGitCommit() {
  try {
    return exec("git", ["rev-parse", "HEAD"], workspaceRoot).trim();
  } catch {
    return "unknown";
  }
}

function normalizeAssemblyVersion(version) {
  const stablePart = version.split("-", 1)[0].split("+", 1)[0];
  const parts = stablePart.split(".").map((value) => Number.parseInt(value, 10)).filter(Number.isFinite);
  while (parts.length < 4) {
    parts.push(0);
  }

  return parts.slice(0, 4).join(".");
}

function createMacInfoPlist({ versionTag, numericVersion }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>OctOP</string>
  <key>CFBundleExecutable</key>
  <string>OctOPAgentMenu</string>
  <key>CFBundleIdentifier</key>
  <string>app.diffcolor.octop.agentmenu</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleName</key>
  <string>OctOP</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${versionTag}</string>
  <key>CFBundleVersion</key>
  <string>${normalizeAssemblyVersion(numericVersion)}</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;
}

function buildMacIcon(sourceIconPath, outputIconPath, iconsetPath) {
  if (!existsSync(sourceIconPath)) {
    throw new Error(`macOS icon source not found: ${sourceIconPath}`);
  }

  rmSync(iconsetPath, { recursive: true, force: true });
  rmSync(outputIconPath, { force: true });
  mkdirSync(iconsetPath, { recursive: true });

  const iconVariants = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024]
  ];

  for (const [fileName, size] of iconVariants) {
    run("sips", [
      "-z",
      String(size),
      String(size),
      sourceIconPath,
      "--out",
      resolve(iconsetPath, fileName)
    ], workspaceRoot);
  }

  run("iconutil", [
    "-c",
    "icns",
    iconsetPath,
    "-o",
    outputIconPath
  ], workspaceRoot);
}

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--version") {
      options.version = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === "--platform") {
      options.platform = argv[index + 1];
      index += 1;
    }
  }

  if (options.platform && !["all", "windows", "macos"].includes(options.platform)) {
    throw new Error(`지원하지 않는 플랫폼 옵션입니다: ${options.platform}`);
  }

  return options;
}

function exec(command, commandArgs, cwd) {
  return execFileSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function run(command, commandArgs, cwd) {
  execFileSync(command, commandArgs, {
    cwd,
    stdio: "inherit"
  });
}
