import { execFileSync } from "node:child_process";

const versionArg = process.argv[2];

if (!versionArg) {
  throw new Error("사용법: node scripts/create-release-tag.mjs 1.0.0");
}

const version = String(versionArg).trim().startsWith("v")
  ? String(versionArg).trim().slice(1)
  : String(versionArg).trim();

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`지원하지 않는 버전 형식입니다: ${versionArg}`);
}

const tagName = `v${version}`;

execFileSync("git", ["tag", "-a", tagName, "-m", `Release ${tagName}`], {
  stdio: "inherit"
});

console.log(`[release] created tag ${tagName}`);
