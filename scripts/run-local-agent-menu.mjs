import { spawn } from "node:child_process";

const workspaceRoot = process.cwd();
const args = process.argv.slice(2);

const launchConfig = resolveLaunchConfig(process.platform);

if (!launchConfig) {
  console.error(`[OctOP] local-agent 메뉴 앱은 현재 플랫폼(${process.platform})을 지원하지 않습니다.`);
  process.exit(1);
}

const child = spawn(launchConfig.command, [...launchConfig.args, ...args], {
  cwd: workspaceRoot,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

function resolveLaunchConfig(platform) {
  if (platform === "darwin") {
    return {
      command: "swift",
      args: ["run", "--package-path", "apps/macos-agent-menu"]
    };
  }

  if (platform === "win32") {
    return {
      command: "dotnet",
      args: ["run", "--project", "apps/windows-agent-menu/OctOP.WindowsAgentMenu.csproj"]
    };
  }

  return null;
}
