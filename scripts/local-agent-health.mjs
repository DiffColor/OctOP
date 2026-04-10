function normalizeBridgeAppServerStatus(health = {}) {
  const status = health?.status?.app_server ?? null;

  if (!status || typeof status !== "object") {
    return {
      available: false,
      connected: false,
      initialized: false,
      lastError: "",
      lastSilentStateCheckError: ""
    };
  }

  return {
    available: true,
    connected: status.connected === true,
    initialized: status.initialized === true,
    lastError: String(status.last_error ?? "").trim(),
    lastSilentStateCheckError: String(status.last_silent_state_check_error ?? "").trim()
  };
}

export function isBridgeAppServerAuthenticationError(message = "") {
  const normalized = String(message ?? "").trim();

  if (!normalized) {
    return false;
  }

  return /인증이 필요합니다|requires authentication|codex login/i.test(normalized);
}

export function describeBridgeAppServerHealth(health = {}) {
  const status = normalizeBridgeAppServerStatus(health);

  if (!status.available) {
    return "bridge health unavailable";
  }

  const segments = [
    `connected=${status.connected}`,
    `initialized=${status.initialized}`
  ];

  if (status.lastError) {
    segments.push(`last_error=${status.lastError}`);
  }

  if (status.lastSilentStateCheckError) {
    segments.push(`last_silent_state_check_error=${status.lastSilentStateCheckError}`);
  }

  return segments.join(", ");
}

export function evaluateBridgeAppServerRecovery({
  health = null,
  consecutiveFailures = 0,
  failureThreshold = 3
} = {}) {
  const threshold = Number.isFinite(Number(failureThreshold)) && Number(failureThreshold) > 0
    ? Number(failureThreshold)
    : 3;
  const status = normalizeBridgeAppServerStatus(health);

  if (!status.available) {
    return {
      usable: false,
      healthy: null,
      recoverable: false,
      nextConsecutiveFailures: 0,
      shouldRestart: false,
      reason: "",
      summary: "bridge health unavailable"
    };
  }

  const authenticationError =
    isBridgeAppServerAuthenticationError(status.lastError) ||
    isBridgeAppServerAuthenticationError(status.lastSilentStateCheckError);
  const healthCheckError = status.lastSilentStateCheckError;
  const bridgeConnectionReady = status.connected && status.initialized;
  const healthy =
    bridgeConnectionReady &&
    !authenticationError &&
    !healthCheckError;

  if (healthy) {
    return {
      usable: true,
      healthy: true,
      recoverable: false,
      nextConsecutiveFailures: 0,
      shouldRestart: false,
      reason: "",
      summary: describeBridgeAppServerHealth(health)
    };
  }

  if (!bridgeConnectionReady) {
    return {
      usable: true,
      healthy: false,
      recoverable: false,
      nextConsecutiveFailures: 0,
      shouldRestart: false,
      reason: status.lastError || (!status.connected ? "app-server bridge disconnected" : "app-server bridge uninitialized"),
      summary: describeBridgeAppServerHealth(health)
    };
  }

  const recoverable =
    !authenticationError &&
    Boolean(healthCheckError);
  const nextConsecutiveFailures = recoverable
    ? Math.max(0, Number(consecutiveFailures) || 0) + 1
    : 0;
  const reason =
    healthCheckError ||
    status.lastError ||
    (!status.connected ? "app-server bridge disconnected" : "") ||
    (!status.initialized ? "app-server bridge uninitialized" : "") ||
    "app-server bridge unhealthy";

  return {
    usable: true,
    healthy: false,
    recoverable,
    nextConsecutiveFailures,
    shouldRestart: recoverable && nextConsecutiveFailures >= threshold,
    reason,
    summary: describeBridgeAppServerHealth(health)
  };
}
