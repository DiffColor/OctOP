function compareSignatureEntries(left, right) {
  return left.localeCompare(right);
}

function normalizeInterfaceName(name = "") {
  return String(name ?? "").trim().toLowerCase();
}

function normalizeHostname(hostname = "") {
  const normalized = String(hostname ?? "").trim().toLowerCase();

  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }

  return normalized;
}

export function isLoopbackHostname(hostname = "") {
  const normalized = normalizeHostname(hostname);

  if (!normalized) {
    return false;
  }

  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "::" ||
    normalized === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

export function shouldResetAppServerForSystemNetworkRecovery(appServerUrl = "") {
  try {
    const parsed = new URL(String(appServerUrl ?? "").trim());
    return !isLoopbackHostname(parsed.hostname);
  } catch {
    return true;
  }
}

function normalizeSystemNetworkInterfaceSignatureEntries(interfaces = []) {
  if (!Array.isArray(interfaces)) {
    return [];
  }

  return interfaces
    .map((entry) => {
      const name = String(entry?.name ?? "").trim();
      const normalizedName = normalizeInterfaceName(name);
      const family = String(entry?.family ?? "").trim().toUpperCase();
      const address = String(entry?.address ?? "").trim().toLowerCase();

      if (!name || !address) {
        return null;
      }

      return {
        name,
        normalizedName,
        signature: family ? `${name}:${family}:${address}` : `${name}:${address}`
      };
    })
    .filter(Boolean)
    .sort((left, right) => compareSignatureEntries(left.signature, right.signature));
}

function selectSystemNetworkInterfaceSignatures(interfaceEntries = [], defaultRouteInterface = null) {
  if (!Array.isArray(interfaceEntries) || interfaceEntries.length === 0) {
    return [];
  }

  const normalizedDefaultRouteInterface = normalizeInterfaceName(defaultRouteInterface);

  if (!normalizedDefaultRouteInterface) {
    return interfaceEntries.map((entry) => entry.signature);
  }

  const primaryInterfaceEntries = interfaceEntries.filter(
    (entry) => entry.normalizedName === normalizedDefaultRouteInterface
  );

  return (primaryInterfaceEntries.length > 0 ? primaryInterfaceEntries : interfaceEntries).map(
    (entry) => entry.signature
  );
}

export function buildSystemNetworkStateSignature(networkState) {
  const defaultRouteInterface = String(networkState?.default_route?.interfaceName ?? "").trim() || null;
  const interfaceEntries = normalizeSystemNetworkInterfaceSignatureEntries(networkState?.interfaces);
  const interfaceSignatures = selectSystemNetworkInterfaceSignatures(interfaceEntries, defaultRouteInterface);

  return JSON.stringify({
    connected: Boolean(networkState?.connected),
    interface_signatures: interfaceSignatures,
    default_route_interface: defaultRouteInterface
  });
}

export function shouldAttemptSystemNetworkRecovery({
  previousConnected = null,
  previousStateSignature = null,
  nextStateSignature = null,
  recoveryPending = false,
  networkConnected = false
} = {}) {
  if (!networkConnected) {
    return false;
  }

  if (recoveryPending) {
    return true;
  }

  if (previousConnected === false) {
    return true;
  }

  return previousStateSignature !== nextStateSignature;
}
