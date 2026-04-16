const VOICE_CAPABILITY_CACHE_STORAGE_KEY = "octop.mobile.voiceCapability.v1";

export const VOICE_CAPABILITY_STATUS_UNKNOWN = "unknown";
export const VOICE_CAPABILITY_STATUS_AVAILABLE = "available";
export const VOICE_CAPABILITY_STATUS_BLOCKED = "blocked";

const VALID_CAPABILITY_STATUSES = new Set([
  VOICE_CAPABILITY_STATUS_UNKNOWN,
  VOICE_CAPABILITY_STATUS_AVAILABLE,
  VOICE_CAPABILITY_STATUS_BLOCKED
]);

function normalizeCapabilityStatus(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return VALID_CAPABILITY_STATUSES.has(normalized) ? normalized : VOICE_CAPABILITY_STATUS_UNKNOWN;
}

function buildVoiceCapabilityOwnerKey({ loginId = "", bridgeId = "" } = {}) {
  const normalizedLoginId = String(loginId ?? "").trim();
  const normalizedBridgeId = String(bridgeId ?? "").trim();

  if (!normalizedLoginId || !normalizedBridgeId) {
    return "";
  }

  return `${normalizedLoginId}::${normalizedBridgeId}`;
}

function createDefaultVoiceCapabilityStore() {
  return {
    version: 1,
    scopes: {}
  };
}

export function getVoiceCapabilityDateKey(dateInput = new Date()) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function createVoiceCapabilitySnapshot(overrides = {}) {
  const resolvedDateKey = String(overrides?.dateKey ?? "").trim() || getVoiceCapabilityDateKey();

  return {
    dateKey: resolvedDateKey,
    realtime: normalizeCapabilityStatus(overrides?.realtime),
    tts: normalizeCapabilityStatus(overrides?.tts),
    realtimeCheckedAt: String(overrides?.realtimeCheckedAt ?? "").trim(),
    ttsCheckedAt: String(overrides?.ttsCheckedAt ?? "").trim(),
    realtimeError: String(overrides?.realtimeError ?? "").trim(),
    ttsError: String(overrides?.ttsError ?? "").trim()
  };
}

function normalizeStoredVoiceCapabilitySnapshot(entry, expectedDateKey = getVoiceCapabilityDateKey()) {
  const normalizedEntry = createVoiceCapabilitySnapshot(entry);

  if (!expectedDateKey || normalizedEntry.dateKey === expectedDateKey) {
    return normalizedEntry;
  }

  return createVoiceCapabilitySnapshot({
    dateKey: expectedDateKey
  });
}

export function readStoredVoiceCapabilitySnapshot(scope, expectedDateKey = getVoiceCapabilityDateKey()) {
  const ownerKey = buildVoiceCapabilityOwnerKey(scope);

  if (!ownerKey || typeof window === "undefined") {
    return createVoiceCapabilitySnapshot({
      dateKey: expectedDateKey
    });
  }

  try {
    const raw = window.localStorage.getItem(VOICE_CAPABILITY_CACHE_STORAGE_KEY);

    if (!raw) {
      return createVoiceCapabilitySnapshot({
        dateKey: expectedDateKey
      });
    }

    const parsed = JSON.parse(raw);
    const storedEntry = parsed?.scopes?.[ownerKey] ?? null;
    return normalizeStoredVoiceCapabilitySnapshot(storedEntry, expectedDateKey);
  } catch {
    return createVoiceCapabilitySnapshot({
      dateKey: expectedDateKey
    });
  }
}

export function updateStoredVoiceCapabilitySnapshot(scope, updater, expectedDateKey = getVoiceCapabilityDateKey()) {
  const ownerKey = buildVoiceCapabilityOwnerKey(scope);
  const fallbackSnapshot = createVoiceCapabilitySnapshot({
    dateKey: expectedDateKey
  });

  if (!ownerKey || typeof window === "undefined") {
    const nextSnapshot = typeof updater === "function" ? updater(fallbackSnapshot) : updater;
    return createVoiceCapabilitySnapshot({
      ...fallbackSnapshot,
      ...(nextSnapshot && typeof nextSnapshot === "object" ? nextSnapshot : {})
    });
  }

  try {
    const raw = window.localStorage.getItem(VOICE_CAPABILITY_CACHE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const nextStore = {
      ...createDefaultVoiceCapabilityStore(),
      ...(parsed && typeof parsed === "object" ? parsed : {}),
      scopes: {
        ...(parsed?.scopes ?? {})
      }
    };
    const currentSnapshot = normalizeStoredVoiceCapabilitySnapshot(nextStore.scopes[ownerKey], expectedDateKey);
    const updatedValue = typeof updater === "function" ? updater(currentSnapshot) : updater;
    const nextSnapshot = createVoiceCapabilitySnapshot({
      ...currentSnapshot,
      ...(updatedValue && typeof updatedValue === "object" ? updatedValue : {})
    });

    nextStore.scopes[ownerKey] = nextSnapshot;
    window.localStorage.setItem(VOICE_CAPABILITY_CACHE_STORAGE_KEY, JSON.stringify(nextStore));

    return nextSnapshot;
  } catch {
    return fallbackSnapshot;
  }
}
