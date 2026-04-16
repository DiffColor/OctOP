import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const INITIAL_MOBILE_CONFIRM_STATE = {
  open: false,
  title: "",
  message: "",
  confirmLabel: "확인",
  cancelLabel: "취소",
  tone: "default"
};

export default function useMobileFeedbackState({
  createId,
  noticeAutoDismissMs,
  noticeErrorDismissMs
}) {
  const [mobileNotices, setMobileNotices] = useState([]);
  const [mobileConfirmState, setMobileConfirmState] = useState(INITIAL_MOBILE_CONFIRM_STATE);
  const mobileNoticeTimersRef = useRef(new Map());
  const mobileConfirmResolverRef = useRef(null);

  const dismissMobileNotice = useCallback((noticeId) => {
    const normalizedNoticeId = String(noticeId ?? "").trim();

    if (!normalizedNoticeId) {
      return;
    }

    const timer = mobileNoticeTimersRef.current.get(normalizedNoticeId);

    if (timer) {
      window.clearTimeout(timer);
      mobileNoticeTimersRef.current.delete(normalizedNoticeId);
    }

    setMobileNotices((current) => current.filter((notice) => notice.id !== normalizedNoticeId));
  }, []);

  const showMobileAlert = useCallback(
    (message, options = {}) => {
      const normalizedMessage = String(message ?? "").trim();

      if (!normalizedMessage || typeof createId !== "function") {
        return "";
      }

      const tone = options.tone === "error" ? "error" : "info";
      const noticeId = createId();
      const durationMs =
        Number(options.durationMs) > 0
          ? Number(options.durationMs)
          : tone === "error"
            ? noticeErrorDismissMs
            : noticeAutoDismissMs;

      setMobileNotices((current) => [
        ...current,
        {
          id: noticeId,
          title: String(options.title ?? "").trim(),
          message: normalizedMessage,
          tone
        }
      ]);

      const timer = window.setTimeout(() => {
        dismissMobileNotice(noticeId);
      }, durationMs);

      mobileNoticeTimersRef.current.set(noticeId, timer);
      return noticeId;
    },
    [createId, dismissMobileNotice, noticeAutoDismissMs, noticeErrorDismissMs]
  );

  const resolveMobileConfirm = useCallback((accepted) => {
    const resolver = mobileConfirmResolverRef.current;
    mobileConfirmResolverRef.current = null;
    setMobileConfirmState((current) => ({
      ...current,
      open: false
    }));
    resolver?.(accepted === true);
  }, []);

  const confirmMobileAction = useCallback((options = {}) => {
    const message = String(options.message ?? "").trim();

    if (!message) {
      return Promise.resolve(false);
    }

    if (mobileConfirmResolverRef.current) {
      mobileConfirmResolverRef.current(false);
      mobileConfirmResolverRef.current = null;
    }

    setMobileConfirmState({
      open: true,
      title: String(options.title ?? "확인").trim() || "확인",
      message,
      confirmLabel: String(options.confirmLabel ?? "확인").trim() || "확인",
      cancelLabel: String(options.cancelLabel ?? "취소").trim() || "취소",
      tone: options.tone === "danger" ? "danger" : "default"
    });

    return new Promise((resolve) => {
      mobileConfirmResolverRef.current = resolve;
    });
  }, []);

  const mobileFeedbackValue = useMemo(
    () => ({
      alert: showMobileAlert,
      confirm: confirmMobileAction
    }),
    [confirmMobileAction, showMobileAlert]
  );

  const notifyError = useCallback(
    (error, fallbackMessage = "요청을 처리하지 못했습니다.") => {
      showMobileAlert(error?.message ?? fallbackMessage, {
        tone: "error",
        title: "오류"
      });
    },
    [showMobileAlert]
  );

  useEffect(
    () => () => {
      mobileNoticeTimersRef.current.forEach((timer) => {
        window.clearTimeout(timer);
      });
      mobileNoticeTimersRef.current.clear();

      if (mobileConfirmResolverRef.current) {
        mobileConfirmResolverRef.current(false);
        mobileConfirmResolverRef.current = null;
      }
    },
    []
  );

  return {
    mobileNotices,
    mobileConfirmState,
    dismissMobileNotice,
    resolveMobileConfirm,
    showMobileAlert,
    confirmMobileAction,
    mobileFeedbackValue,
    notifyError
  };
}
