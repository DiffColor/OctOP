import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export default function useWideThreadSplitResize({
  selectedBridgeId,
  sessionLoginId,
  showWideSplitLayout,
  viewportWidth,
  resizeMinWidthPx,
  utils
}) {
  const { clampWideThreadSplitRatio, readStoredMobileWorkspaceLayout, storeMobileWorkspaceLayout } = utils;
  const [wideThreadSplitRatio, setWideThreadSplitRatio] = useState(() =>
    readStoredMobileWorkspaceLayout({
      loginId: sessionLoginId,
      bridgeId: selectedBridgeId
    }).wideThreadSplitRatio
  );
  const wideThreadSplitLayoutRef = useRef(null);
  const wideThreadSplitResizePointerIdRef = useRef(null);
  const wideThreadSplitResizeStartXRef = useRef(0);
  const wideThreadSplitResizeStartRatioRef = useRef(0.5);
  const wideThreadSplitResizeEnabled = viewportWidth >= resizeMinWidthPx;
  const wideThreadSplitLeftWeight = useMemo(
    () => Math.max(1, Math.round(wideThreadSplitRatio * 100)),
    [wideThreadSplitRatio]
  );
  const wideThreadSplitRightWeight = useMemo(
    () => Math.max(1, 100 - wideThreadSplitLeftWeight),
    [wideThreadSplitLeftWeight]
  );

  useEffect(() => {
    const storedRatio = readStoredMobileWorkspaceLayout({
      loginId: sessionLoginId,
      bridgeId: selectedBridgeId
    }).wideThreadSplitRatio;

    setWideThreadSplitRatio(storedRatio);
  }, [readStoredMobileWorkspaceLayout, selectedBridgeId, sessionLoginId]);

  useEffect(() => {
    if (!sessionLoginId || !selectedBridgeId) {
      return;
    }

    storeMobileWorkspaceLayout(
      {
        wideThreadSplitRatio
      },
      {
        loginId: sessionLoginId,
        bridgeId: selectedBridgeId
      }
    );
  }, [selectedBridgeId, sessionLoginId, storeMobileWorkspaceLayout, wideThreadSplitRatio]);

  useEffect(() => {
    if (!showWideSplitLayout || !wideThreadSplitResizeEnabled) {
      return;
    }

    const containerWidth = wideThreadSplitLayoutRef.current?.clientWidth ?? viewportWidth ?? 0;
    setWideThreadSplitRatio((current) => clampWideThreadSplitRatio(current, containerWidth));
  }, [clampWideThreadSplitRatio, showWideSplitLayout, viewportWidth, wideThreadSplitResizeEnabled]);

  const updateWideThreadSplitRatioFromClientX = useCallback(
    (clientX) => {
      const container = wideThreadSplitLayoutRef.current;

      if (!container) {
        return;
      }

      const rect = container.getBoundingClientRect();

      if (rect.width <= 0) {
        return;
      }

      const deltaX = clientX - wideThreadSplitResizeStartXRef.current;
      const nextRatio = clampWideThreadSplitRatio(
        wideThreadSplitResizeStartRatioRef.current + deltaX / rect.width,
        rect.width
      );

      setWideThreadSplitRatio(nextRatio);
    },
    [clampWideThreadSplitRatio]
  );

  const handleWideThreadSplitResizePointerDown = useCallback(
    (event) => {
      if (!wideThreadSplitResizeEnabled) {
        return;
      }

      wideThreadSplitResizePointerIdRef.current = event.pointerId;
      wideThreadSplitResizeStartXRef.current = event.clientX;
      wideThreadSplitResizeStartRatioRef.current = wideThreadSplitRatio;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    },
    [wideThreadSplitRatio, wideThreadSplitResizeEnabled]
  );

  const handleWideThreadSplitResizePointerMove = useCallback(
    (event) => {
      if (
        !wideThreadSplitResizeEnabled ||
        wideThreadSplitResizePointerIdRef.current === null ||
        event.pointerId !== wideThreadSplitResizePointerIdRef.current
      ) {
        return;
      }

      updateWideThreadSplitRatioFromClientX(event.clientX);
      event.preventDefault();
    },
    [updateWideThreadSplitRatioFromClientX, wideThreadSplitResizeEnabled]
  );

  const handleWideThreadSplitResizePointerUp = useCallback((event) => {
    if (
      wideThreadSplitResizePointerIdRef.current === null ||
      event.pointerId !== wideThreadSplitResizePointerIdRef.current
    ) {
      return;
    }

    wideThreadSplitResizePointerIdRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  useEffect(() => {
    if (!wideThreadSplitResizeEnabled || typeof window === "undefined") {
      return undefined;
    }

    const handleWindowPointerMove = (event) => {
      if (
        wideThreadSplitResizePointerIdRef.current === null ||
        event.pointerId !== wideThreadSplitResizePointerIdRef.current
      ) {
        return;
      }

      updateWideThreadSplitRatioFromClientX(event.clientX);
      event.preventDefault();
    };

    const handleWindowPointerUp = (event) => {
      if (
        wideThreadSplitResizePointerIdRef.current === null ||
        event.pointerId !== wideThreadSplitResizePointerIdRef.current
      ) {
        return;
      }

      wideThreadSplitResizePointerIdRef.current = null;
    };

    window.addEventListener("pointermove", handleWindowPointerMove, { passive: false });
    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("pointercancel", handleWindowPointerUp);

    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("pointercancel", handleWindowPointerUp);
    };
  }, [updateWideThreadSplitRatioFromClientX, wideThreadSplitResizeEnabled]);

  return {
    wideThreadSplitLayoutRef,
    wideThreadSplitResizeEnabled,
    wideThreadSplitLeftWeight,
    wideThreadSplitRightWeight,
    handleWideThreadSplitResizePointerDown,
    handleWideThreadSplitResizePointerMove,
    handleWideThreadSplitResizePointerUp
  };
}
