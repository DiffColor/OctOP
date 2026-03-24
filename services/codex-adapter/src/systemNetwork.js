function compareSignatureEntries(left, right) {
  return left.localeCompare(right);
}

function normalizeSystemNetworkInterfaceSignatureEntries(interfaces = []) {
  if (!Array.isArray(interfaces)) {
    return [];
  }

  return interfaces
    .map((entry) => {
      const name = String(entry?.name ?? "").trim();
      const family = String(entry?.family ?? "").trim().toUpperCase();
      const address = String(entry?.address ?? "").trim().toLowerCase();

      if (!name || !address) {
        return null;
      }

      return family ? `${name}:${family}:${address}` : `${name}:${address}`;
    })
    .filter(Boolean)
    .sort(compareSignatureEntries);
}

export function buildSystemNetworkStateSignature(networkState) {
  const defaultRouteInterface = String(networkState?.default_route?.interfaceName ?? "").trim() || null;
  const interfaceSignatures = normalizeSystemNetworkInterfaceSignatureEntries(networkState?.interfaces);

  return JSON.stringify({
    connected: Boolean(networkState?.connected),
    interface_signatures: interfaceSignatures,
    default_route_interface: defaultRouteInterface
  });
}
