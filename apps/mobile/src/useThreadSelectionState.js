import { useCallback, useEffect, useState } from "react";

export default function useThreadSelectionState({
  activeView,
  filteredThreads,
  isTodoScope,
  onDeleteThreads,
  selectedProjectThreadIds
}) {
  const [threadSelectionMode, setThreadSelectionMode] = useState(false);
  const [selectedThreadIds, setSelectedThreadIds] = useState([]);

  const resetThreadSelection = useCallback(() => {
    setThreadSelectionMode(false);
    setSelectedThreadIds([]);
  }, []);

  useEffect(() => {
    setSelectedThreadIds((current) => current.filter((threadId) => selectedProjectThreadIds.has(threadId)));
  }, [selectedProjectThreadIds]);

  useEffect(() => {
    if (activeView !== "inbox" || isTodoScope) {
      resetThreadSelection();
    }
  }, [activeView, isTodoScope, resetThreadSelection]);

  useEffect(() => {
    if (!threadSelectionMode) {
      return;
    }

    if (filteredThreads.length === 0) {
      setThreadSelectionMode(false);
    }
  }, [filteredThreads.length, threadSelectionMode]);

  useEffect(() => {
    if (threadSelectionMode && selectedThreadIds.length === 0) {
      setThreadSelectionMode(false);
    }
  }, [selectedThreadIds.length, threadSelectionMode]);

  const handleEnterThreadSelectionMode = useCallback(
    (threadId = "") => {
      const normalizedThreadId = String(threadId ?? "").trim();

      if (filteredThreads.length === 0) {
        return;
      }

      setThreadSelectionMode(true);
      setSelectedThreadIds((current) => {
        if (!normalizedThreadId || current.includes(normalizedThreadId)) {
          return current;
        }

        return [...current, normalizedThreadId];
      });
    },
    [filteredThreads.length]
  );

  const handleCancelThreadSelection = useCallback(() => {
    resetThreadSelection();
  }, [resetThreadSelection]);

  const handleToggleThreadSelection = useCallback((threadId) => {
    const normalizedThreadId = String(threadId ?? "").trim();

    if (!normalizedThreadId) {
      return;
    }

    setThreadSelectionMode(true);
    setSelectedThreadIds((current) =>
      current.includes(normalizedThreadId)
        ? current.filter((currentThreadId) => currentThreadId !== normalizedThreadId)
        : [...current, normalizedThreadId]
    );
  }, []);

  const handleDeleteSelectedThreads = useCallback(async () => {
    if (selectedThreadIds.length === 0 || typeof onDeleteThreads !== "function") {
      return;
    }

    const result = await onDeleteThreads(selectedThreadIds);
    const deletedThreadIds = Array.isArray(result?.deletedThreadIds)
      ? result.deletedThreadIds.map((threadId) => String(threadId ?? "").trim()).filter(Boolean)
      : [];

    if (deletedThreadIds.length > 0) {
      setSelectedThreadIds((current) =>
        current.filter((threadId) => !deletedThreadIds.includes(String(threadId ?? "").trim()))
      );
    }

    if (result?.accepted !== false && result !== false) {
      resetThreadSelection();
    }
  }, [onDeleteThreads, resetThreadSelection, selectedThreadIds]);

  return {
    threadSelectionMode,
    selectedThreadIds,
    resetThreadSelection,
    handleEnterThreadSelectionMode,
    handleCancelThreadSelection,
    handleToggleThreadSelection,
    handleDeleteSelectedThreads
  };
}
