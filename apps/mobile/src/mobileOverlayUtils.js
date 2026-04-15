function getPathLabel(value) {
  if (!value) {
    return "";
  }

  const normalized = String(value).replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.at(-1) ?? normalized;
}

function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function getDisplayPathFromStartFolder(value, depth = 2) {
  const normalized = normalizePath(value);

  if (!normalized) {
    return "";
  }

  const segments = normalized.split("/").filter(Boolean);
  return segments.slice(-depth).join("/");
}

function getRelativeWorkspacePath(value, roots = []) {
  const normalizedValue = normalizePath(value);

  if (!normalizedValue) {
    return "";
  }

  const matchingRoot = [...roots]
    .map((root) => normalizePath(root?.path))
    .filter(Boolean)
    .filter((rootPath) => normalizedValue === rootPath || normalizedValue.startsWith(`${rootPath}/`))
    .sort((left, right) => right.length - left.length)[0];

  if (!matchingRoot) {
    return getDisplayPathFromStartFolder(normalizedValue);
  }

  const relativePath = normalizedValue.slice(matchingRoot.length).replace(/^\/+/, "");
  const rootLabel = getPathLabel(matchingRoot);

  return relativePath ? `${rootLabel}/${relativePath}` : rootLabel;
}

function createThreadTitleFromPrompt(prompt) {
  const normalized = String(prompt ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "";
  }

  return normalized.length <= 34 ? normalized : `${normalized.slice(0, 34)}...`;
}

export { createThreadTitleFromPrompt, getPathLabel, getRelativeWorkspacePath };
