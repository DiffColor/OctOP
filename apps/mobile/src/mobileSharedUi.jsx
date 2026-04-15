import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

function AutoSizingReadOnlyTextarea({ id, value, placeholder, className = "", maxHeight = 320 }) {
  const textareaRef = useRef(null);
  const syncHeight = useCallback(() => {
    const textarea = textareaRef.current;

    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [maxHeight]);

  useLayoutEffect(() => {
    syncHeight();
  }, [syncHeight, value]);

  useEffect(() => {
    const textarea = textareaRef.current;

    if (!textarea) {
      return undefined;
    }

    if (typeof window === "undefined" || typeof window.ResizeObserver !== "function") {
      window.addEventListener("resize", syncHeight);
      return () => {
        window.removeEventListener("resize", syncHeight);
      };
    }

    const resizeObserver = new window.ResizeObserver(() => {
      syncHeight();
    });

    resizeObserver.observe(textarea);

    return () => {
      resizeObserver.disconnect();
    };
  }, [syncHeight]);

  return (
    <textarea
      ref={textareaRef}
      id={id}
      rows="1"
      value={value}
      readOnly
      placeholder={placeholder}
      className={className}
    />
  );
}

function BottomSheet({
  open,
  title,
  description,
  onClose,
  children,
  variant = "bottom",
  headerActions = null,
  headerActionsLayout = "inline",
  panelTestId = ""
}) {
  const closeOnBackdropClickRef = useRef(false);

  if (!open) {
    return null;
  }

  const isCenterDialog = variant === "center";
  const shouldStackHeaderActions = headerActionsLayout === "stacked" && Boolean(headerActions);
  const containerClassName = isCenterDialog
    ? "fixed inset-0 z-50 flex items-center justify-center bg-slate-950/86 px-4 py-6 backdrop-blur-sm"
    : "fixed inset-0 z-50 flex items-end justify-center bg-slate-950/75 px-4 pb-4 pt-10 backdrop-blur-sm";
  const panelClassName = isCenterDialog
    ? "modal-enter relative z-10 flex w-full max-w-xl max-h-[min(720px,88dvh)] flex-col overflow-hidden rounded-[1.75rem] border border-white/15 bg-[#0b1622] shadow-[0_30px_90px_rgba(0,0,0,0.65)] ring-1 ring-white/8"
    : "sheet-enter relative z-10 w-full max-w-xl overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950 shadow-telegram-soft";

  const handleContainerPointerDown = (event) => {
    closeOnBackdropClickRef.current = event.target === event.currentTarget;
  };

  const handleContainerClick = (event) => {
    const shouldClose = closeOnBackdropClickRef.current && event.target === event.currentTarget;
    closeOnBackdropClickRef.current = false;

    if (shouldClose) {
      onClose();
    }
  };

  return (
    <div className={containerClassName} onPointerDown={handleContainerPointerDown} onClick={handleContainerClick}>
      <section
        className={panelClassName}
        onClick={(event) => event.stopPropagation()}
        data-testid={panelTestId || undefined}
      >
        <div className="border-b border-white/10 bg-white/5 px-5 py-4">
          {isCenterDialog ? null : <div className="mx-auto mb-4 h-1.5 w-14 rounded-full bg-white/15" />}
          {shouldStackHeaderActions ? (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-white">{title}</h2>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-black/20 text-slate-300 transition hover:bg-white/10 hover:text-white"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                  </svg>
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">{headerActions}</div>
            </div>
          ) : (
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-white">{title}</h2>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {headerActions}
                <button
                  type="button"
                  onClick={onClose}
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-black/20 text-slate-300 transition hover:bg-white/10 hover:text-white"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="telegram-scroll max-h-[80dvh] overflow-y-auto">{children}</div>
      </section>
    </div>
  );
}

const MobileFeedbackContext = createContext({
  alert: () => {},
  confirm: async () => false
});

function useMobileFeedback() {
  return useContext(MobileFeedbackContext);
}

function MobileNoticeCenter({ notices, onDismiss }) {
  if (typeof document === "undefined" || !Array.isArray(notices) || notices.length === 0) {
    return null;
  }

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[120] flex flex-col items-center gap-3 px-3 pt-[max(env(safe-area-inset-top),0px)]">
      {notices.map((notice) => {
        const isError = notice.tone === "error";
        const cardClassName = isError
          ? "border-rose-400/35 bg-[rgba(33,12,18,0.92)] text-rose-50 shadow-[0_18px_40px_rgba(127,29,29,0.28)]"
          : "border-white/15 bg-[rgba(15,23,42,0.88)] text-slate-50 shadow-[0_18px_40px_rgba(15,23,42,0.38)]";
        const iconClassName = isError
          ? "bg-rose-400/20 text-rose-100"
          : "bg-sky-400/18 text-sky-100";

        return (
          <div
            key={notice.id}
            className={`pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-[1.15rem] border px-4 py-3 backdrop-blur-xl ${cardClassName}`}
          >
            <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${iconClassName}`}>
              {isError ? (
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M12 9v4m0 4h.01M10.29 3.86l-8.09 14A2 2 0 004 21h16a2 2 0 001.8-3.14l-8.09-14a2 2 0 00-3.42 0z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                </svg>
              ) : (
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M12 8h.01M11 12h1v4h1m-6 4h10a2 2 0 002-2V6a2 2 0 00-2-2H7a2 2 0 00-2 2v12a2 2 0 002 2z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                </svg>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-semibold tracking-[0.04em] text-white/90">
                {notice.title || (isError ? "오류" : "알림")}
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-5 text-white/90">
                {notice.message}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onDismiss(notice.id)}
              aria-label="알림 닫기"
              title="닫기"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/75 transition hover:bg-white/10 hover:text-white"
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>,
    document.body
  );
}

function MobileConfirmDialog({ state, onResolve }) {
  if (!state?.open) {
    return null;
  }

  const isDanger = state.tone === "danger";

  return (
    <BottomSheet
      open={state.open}
      title={state.title || "확인"}
      description={state.message || ""}
      onClose={() => onResolve(false)}
      variant="center"
      panelTestId="mobile-confirm-dialog"
    >
      <div className="space-y-4 px-5 py-5">
        <div
          className={`rounded-[1.25rem] border px-4 py-4 text-sm leading-6 ${
            isDanger
              ? "border-rose-400/20 bg-rose-500/10 text-rose-50"
              : "border-white/10 bg-white/[0.04] text-slate-100"
          }`}
        >
          {state.message}
        </div>
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={() => onResolve(false)}
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10"
          >
            {state.cancelLabel || "취소"}
          </button>
          <button
            type="button"
            onClick={() => onResolve(true)}
            className={`rounded-full px-4 py-2 text-sm font-semibold text-white transition ${
              isDanger ? "bg-rose-500 hover:bg-rose-400" : "bg-telegram-500 hover:bg-telegram-400"
            }`}
          >
            {state.confirmLabel || "확인"}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}

function InstallPromptBanner({ visible, installing, onInstall, onDismiss }) {
  if (!visible) {
    return null;
  }

  return (
    <div className="border-b border-telegram-400/20 bg-telegram-500/10 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-telegram-500/20 text-telegram-100">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M12 3v12m0 0l4-4m-4 4l-4-4M5 19h14" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">앱으로 설치해서 바로 여시겠습니까?</p>
            <p className="truncate text-xs text-telegram-100/70">홈 화면에 추가하면 더 빠르게 접근하실 수 있습니다.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onInstall}
          disabled={installing}
          className="shrink-0 rounded-full bg-telegram-500 px-3 py-2 text-[11px] font-semibold text-white transition hover:bg-telegram-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {installing ? "설치 중" : "설치"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 text-[11px] text-slate-300 transition hover:text-white"
        >
          다시 보지 않음
        </button>
      </div>
    </div>
  );
}

function PwaUpdateDialog({ visible, busy, onConfirm }) {
  if (!visible) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center px-6 py-8">
      <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" />
      <div className="relative w-full max-w-sm rounded-3xl border border-white/10 bg-slate-900/95 px-6 py-7 text-center shadow-2xl">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-telegram-500/10 text-telegram-300">
          <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path d="M12 8v4l2.5 1.5M12 22a10 10 0 100-20 10 10 0 000 20z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
          </svg>
        </div>
        <h2 className="mt-4 text-base font-semibold text-white">업데이트가 준비되었습니다</h2>
        <p className="mt-2 text-sm leading-6 text-slate-300">최신 버전을 적용하려면 새로고침을 진행해 주세요.</p>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="mt-5 inline-flex w-full items-center justify-center rounded-full bg-white px-4 py-3 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? (
            <>
              <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-400 border-t-slate-900" />
              새로고침 중...
            </>
          ) : (
            "지금 새로고침"
          )}
        </button>
      </div>
    </div>
  );
}

function LoginPage({ initialLoginId, loading, error, onSubmit }) {
  const [loginId, setLoginId] = useState(initialLoginId ?? "");
  const [password, setPassword] = useState("");
  const [rememberDevice, setRememberDevice] = useState(Boolean(initialLoginId));

  useEffect(() => {
    setLoginId(initialLoginId ?? "");
  }, [initialLoginId]);

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!loginId.trim() || !password.trim()) {
      return;
    }

    await onSubmit({
      loginId: loginId.trim(),
      password,
      rememberDevice
    });
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-brand-dark text-slate-200">
      <div className="fixed inset-0 -z-10 overflow-hidden">
        <div className="bg-mesh absolute inset-0" />
        <div className="absolute left-[-6%] top-[-8%] h-[20rem] w-[20rem] rounded-full bg-sky-500/8 blur-[140px]" />
        <div className="absolute bottom-[-14%] right-[-10%] h-[22rem] w-[22rem] rounded-full bg-emerald-500/8 blur-[160px]" />
      </div>

      <div className="mx-auto flex min-h-screen max-w-md items-center justify-center px-5 py-8">
        <main className="relative z-10 w-full">
          <header className="mb-10 text-center">
            <div className="inline-flex h-14 w-14 items-center justify-center rounded-3xl border border-white/10 bg-slate-950/70">
              <img src="/octop-login-icon.png" alt="OctOP" className="h-full w-full rounded-3xl object-contain" />
            </div>
            <p className="mt-6 text-[11px] uppercase tracking-[0.34em] text-slate-500">OctOP Workspace</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">Sign in</h1>
            <p className="mt-3 text-sm leading-6 text-slate-400">
              Use your LicenseHub login ID to open the mobile workspace.
            </p>
          </header>

          <section className="rounded-[28px] border border-white/8 bg-slate-950/72 p-8 shadow-2xl shadow-slate-950/30 backdrop-blur">
            <form className="space-y-6" onSubmit={handleSubmit}>
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="loginId">
              Login ID
            </label>
            <input
              id="loginId"
              name="loginId"
              type="text"
              autoComplete="username"
              required
              value={loginId}
              onChange={(event) => setLoginId(event.target.value)}
              placeholder="LicenseHub 로그인 ID"
              className="w-full rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-white outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30"
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="block text-sm font-medium text-slate-300" htmlFor="password">
                Password
              </label>
              <span className="text-xs text-slate-500">LicenseHub password</span>
            </div>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              className="w-full rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-white outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30"
            />
          </div>

          <label className="flex items-center gap-3 text-sm text-slate-400">
            <input
              type="checkbox"
              checked={rememberDevice}
              onChange={(event) => setRememberDevice(event.target.checked)}
              className="h-4 w-4 rounded border-slate-700 bg-slate-950 text-sky-400 focus:ring-sky-400"
            />
            Keep me signed in on this device
          </label>

          {error ? (
            <div className="rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-sky-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <>
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-950/25 border-t-slate-950" />
                Signing in...
              </>
            ) : (
              "Sign in"
            )}
          </button>
            </form>

            <div className="mt-6 border-t border-slate-800 pt-4 text-xs leading-6 text-slate-500">
              After sign-in, your connected bridge, projects, and thread board sync automatically.
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

function BridgeDropdown({
  bridges,
  selectedBridgeId,
  bridgeSignal,
  onSelectBridge,
  onOpen = null,
  syncing = false
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const selectedBridge = useMemo(
    () => bridges.find((bridge) => bridge.bridge_id === selectedBridgeId) ?? null,
    [bridges, selectedBridgeId]
  );
  const statusLabel = bridgeSignal.label;

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handlePointerDown(event) {
      if (!containerRef.current) {
        return;
      }

      if (!containerRef.current.contains(event.target)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => {
            const nextOpen = !current;

            if (nextOpen && typeof onOpen === "function") {
              onOpen();
            }

            return nextOpen;
          });
        }}
        className="flex w-full items-center gap-2 text-left text-xs text-slate-400 transition hover:text-white focus:outline-none"
      >
        <span className="truncate">
          {selectedBridge?.device_name ?? selectedBridge?.bridge_id ?? "브릿지 없음"}
        </span>
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: bridgeSignal.dotColor }} />
        <span>{statusLabel}</span>
        <svg
          className={`h-3.5 w-3.5 shrink-0 text-slate-500 transition ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
        </svg>
      </button>

      {open ? (
        <div className="absolute left-0 z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/10 bg-slate-950/95 shadow-2xl shadow-black/40 backdrop-blur">
          <div className="border-b border-white/5 px-4 py-3">
            <p className="text-xs font-semibold text-white">브릿지 선택</p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {syncing ? "브릿지 목록을 동기화하는 중입니다." : "연결할 브릿지를 선택하세요."}
            </p>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {bridges.length === 0 ? (
              <p className="px-4 py-5 text-sm text-slate-400">연결된 브릿지가 없습니다.</p>
            ) : (
              bridges.map((bridge) => {
                const active = bridge.bridge_id === selectedBridgeId;

                return (
                  <button
                    key={bridge.bridge_id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      onSelectBridge(bridge.bridge_id);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition ${
                      active ? "bg-telegram-500/10 text-white" : "text-slate-200 hover:bg-white/[0.04]"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{bridge.device_name ?? bridge.bridge_id}</p>
                      <p className="truncate text-[11px] text-slate-400">{bridge.bridge_id}</p>
                    </div>
                    <div className="text-right text-[11px] text-slate-400">
                      <p>{formatRelativeTime(bridge.last_seen_at)}</p>
                      {active ? <p className="mt-0.5 text-telegram-200">선택됨</p> : null}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export {
  AutoSizingReadOnlyTextarea,
  BottomSheet,
  BridgeDropdown,
  InstallPromptBanner,
  LoginPage,
  MobileConfirmDialog,
  MobileFeedbackContext,
  MobileNoticeCenter,
  PwaUpdateDialog,
  useMobileFeedback
};
