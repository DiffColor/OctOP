function normalizeBridgeAppServerStatus(health = {}, runtimeSnapshot = null) {
  const status = health?.status?.app_server ?? null;
  const runtimeSource = (
    status?.runtime && typeof status.runtime === "object"
      ? status.runtime
      : runtimeSnapshot?.runtime && typeof runtimeSnapshot.runtime === "object"
        ? runtimeSnapshot.runtime
        : null
  );
  const activitySource = (
    status?.activity_beacon && typeof status.activity_beacon === "object"
      ? status.activity_beacon
      : runtimeSnapshot?.activityBeacon && typeof runtimeSnapshot.activityBeacon === "object"
        ? runtimeSnapshot.activityBeacon
        : null
  );

  if (!status || typeof status !== "object") {
    return {
      available: false,
      connected: false,
      initialized: false,
      lastError: "",
      lastSilentStateCheckError: "",
      runtimeProcessAlive: runtimeSource?.processAlive === true,
      runtimeHeartbeatFresh: runtimeSource?.heartbeatFresh === true,
      runtimeState: String(runtimeSource?.state ?? "").trim(),
      runtimeLastError: String(runtimeSource?.lastError ?? "").trim(),
      activityBeaconFresh: activitySource?.fresh === true || activitySource?.active === true,
      activityBeaconActive: activitySource?.active === true,
      activityBeaconCount: Number(activitySource?.activeCount ?? 0) || 0,
      activityBeaconLabel: String(activitySource?.lastLabel ?? "").trim(),
      protectedFromRestart: false,
      protectedFromRestartReason: ""
    };
  }

  const runtimeProcessAlive =
    status.runtime?.process_alive === true ||
    runtimeSource?.processAlive === true;
  const runtimeHeartbeatFresh =
    status.runtime?.heartbeat_fresh === true ||
    runtimeSource?.heartbeatFresh === true;
  const activityBeaconFresh =
    status.activity_beacon?.fresh === true ||
    status.activity_beacon?.active === true ||
    activitySource?.fresh === true ||
    activitySource?.active === true;
  const activityBeaconActive =
    status.activity_beacon?.active === true ||
    activitySource?.active === true;
  const activityBeaconCount = Number(
    status.activity_beacon?.active_count ??
    activitySource?.activeCount ??
    0
  ) || 0;
  const activityBeaconLabel = String(
    status.activity_beacon?.last_label ??
    activitySource?.lastLabel ??
    ""
  ).trim();
  const protectedFromRestartReason = String(
    status.protected_from_restart_reason ??
    (activityBeaconFresh
      ? "activity_beacon"
      : runtimeProcessAlive && runtimeHeartbeatFresh
        ? "runtime_heartbeat"
        : "")
  ).trim();

  return {
    available: true,
    connected: status.connected === true,
    initialized: status.initialized === true,
    lastError: String(status.last_error ?? "").trim(),
    lastSilentStateCheckError: String(status.last_silent_state_check_error ?? "").trim(),
    runtimeProcessAlive,
    runtimeHeartbeatFresh,
    runtimeState: String(
      status.runtime?.state ??
      runtimeSource?.state ??
      ""
    ).trim(),
    runtimeLastError: String(
      status.runtime?.last_error ??
      runtimeSource?.lastError ??
      ""
    ).trim(),
    activityBeaconFresh,
    activityBeaconActive,
    activityBeaconCount,
    activityBeaconLabel,
    protectedFromRestart:
      status.protected_from_restart === true ||
      Boolean(protectedFromRestartReason),
    protectedFromRestartReason
  };
}

export function isBridgeAppServerAuthenticationError(message = "") {
  const normalized = String(message ?? "").trim();

  if (!normalized) {
    return false;
  }

  return /인증이 필요합니다|requires authentication|codex login/i.test(normalized);
}

export function describeBridgeAppServerHealth(health = {}, runtimeSnapshot = null) {
  const status = normalizeBridgeAppServerStatus(health, runtimeSnapshot);

  if (!status.available) {
    if (status.activityBeaconFresh) {
      return `bridge health unavailable, activity_beacon=active${status.activityBeaconLabel ? `:${status.activityBeaconLabel}` : ""}`;
    }

    if (status.runtimeProcessAlive && status.runtimeHeartbeatFresh) {
      return "bridge health unavailable, runtime_process_alive=true";
    }

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

  if (status.activityBeaconFresh) {
    segments.push(
      `activity_beacon=active${status.activityBeaconLabel ? `:${status.activityBeaconLabel}` : ""}`
    );
  } else if (status.runtimeProcessAlive && status.runtimeHeartbeatFresh) {
    segments.push("runtime_process_alive=true");
  }

  return segments.join(", ");
}

export function evaluateBridgeAppServerRecovery({
  health = null,
  runtimeSnapshot = null,
  consecutiveFailures = 0,
  failureThreshold = 3
} = {}) {
  const threshold = Number.isFinite(Number(failureThreshold)) && Number(failureThreshold) > 0
    ? Number(failureThreshold)
    : 3;
  const status = normalizeBridgeAppServerStatus(health, runtimeSnapshot);
  const protectedFromRestartReason = status.protectedFromRestartReason ||
    (status.activityBeaconFresh
      ? `activity_beacon${status.activityBeaconLabel ? `:${status.activityBeaconLabel}` : ""}`
      : status.runtimeProcessAlive && status.runtimeHeartbeatFresh
        ? "runtime_heartbeat"
        : "");
  const fatalRuntimeError =
    status.runtimeState === "error" && status.runtimeProcessAlive && status.runtimeLastError
      ? status.runtimeLastError
      : "";

  if (!status.available) {
    if (protectedFromRestartReason) {
      return {
        usable: true,
        healthy: true,
        protected: true,
        recoverable: false,
        nextConsecutiveFailures: 0,
        shouldRestart: false,
        reason: "",
        summary: describeBridgeAppServerHealth(health, runtimeSnapshot)
      };
    }

    return {
      usable: false,
      healthy: null,
      protected: false,
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
      protected: false,
      recoverable: false,
      nextConsecutiveFailures: 0,
      shouldRestart: false,
      reason: "",
      summary: describeBridgeAppServerHealth(health, runtimeSnapshot)
    };
  }

  if (fatalRuntimeError) {
    return {
      usable: true,
      healthy: false,
      protected: false,
      recoverable: false,
      nextConsecutiveFailures: threshold,
      shouldRestart: true,
      reason: fatalRuntimeError,
      summary: describeBridgeAppServerHealth(health, runtimeSnapshot)
    };
  }

  if (protectedFromRestartReason) {
    return {
      usable: true,
      healthy: true,
      protected: true,
      recoverable: false,
      nextConsecutiveFailures: 0,
      shouldRestart: false,
      reason: "",
      summary: describeBridgeAppServerHealth(health, runtimeSnapshot)
    };
  }

  if (!bridgeConnectionReady) {
    return {
      usable: true,
      healthy: false,
      protected: false,
      recoverable: false,
      nextConsecutiveFailures: 0,
      shouldRestart: false,
      reason: status.lastError || (!status.connected ? "app-server bridge disconnected" : "app-server bridge uninitialized"),
      summary: describeBridgeAppServerHealth(health, runtimeSnapshot)
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
    protected: false,
    recoverable,
    nextConsecutiveFailures,
    shouldRestart: false,
    reason,
    summary: describeBridgeAppServerHealth(health, runtimeSnapshot)
  };
}
