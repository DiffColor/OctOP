import { useCallback, useEffect, useRef } from "react";
import { resolveApiBaseUrl } from "../../../packages/domain/src/index.js";

const API_BASE_URL = resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
const MESSAGE_BUBBLE_LONG_PRESS_DELAY_MS = 600;
const MESSAGE_BUBBLE_LONG_PRESS_MOVE_TOLERANCE_PX = 10;
const MESSAGE_BUBBLE_LONG_PRESS_IGNORE_SELECTOR =
  "[data-message-code-scroll='true'], [data-message-attachment-interactive='true']";

export function summarizeMessageContent(content, limit = 160) {
  const normalized = String(content ?? "").trim();

  if (!normalized) {
    return "내용 없음";
  }

  if (normalized.length <= limit) {
    return normalized;
  }

  const safeLimit = Math.max(0, limit - 3);
  return `${normalized.slice(0, safeLimit)}...`;
}

const FENCED_CODE_BLOCK_PATTERN = /```([^\n`]*)\n?([\s\S]*?)```/g;
const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;
const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)]+)\)/g;
const SHELL_CODE_LANGUAGES = new Set(["sh", "shell", "bash", "zsh", "console", "terminal", "shellscript"]);

function parseRichMessageContent(content) {
  const normalized = String(content ?? "");

  if (!normalized) {
    return [];
  }

  const segments = [];
  let lastIndex = 0;
  FENCED_CODE_BLOCK_PATTERN.lastIndex = 0;

  for (const match of normalized.matchAll(FENCED_CODE_BLOCK_PATTERN)) {
    const [raw, language = "", code = ""] = match;
    const matchIndex = match.index ?? 0;

    if (matchIndex > lastIndex) {
      segments.push({
        type: "text",
        value: normalized.slice(lastIndex, matchIndex)
      });
    }

    segments.push({
      type: "code",
      language: String(language ?? "").trim(),
      value: String(code ?? "").replace(/\n$/, "")
    });
    lastIndex = matchIndex + raw.length;
  }

  if (lastIndex < normalized.length) {
    segments.push({
      type: "text",
      value: normalized.slice(lastIndex)
    });
  }

  return segments;
}

export function normalizeAssistantMessageContent(content) {
  const normalized = String(content ?? "");

  if (!normalized) {
    return "";
  }

  const sectionHeadingPattern = /^\[[^\]]+\]$/;
  const repeatedProgressPrefixPattern = /^(\s*[-*]\s*)?\[진행 내역\](?:\s*[:：-]\s*)?(.*)$/;
  const singleInstanceSectionHeadings = new Set([
    "[목표]",
    "[계획]",
    "[작업 계획]",
    "[최종 보고]",
    "[최종 정리]"
  ]);
  const normalizeProgressHistoryLine = (line, insideProgressHistorySection) => {
    if (!insideProgressHistorySection) {
      return String(line ?? "");
    }

    const normalizedLine = String(line ?? "");
    const match = normalizedLine.match(repeatedProgressPrefixPattern);

    if (!match) {
      return normalizedLine;
    }

    const [, bullet = "", rest = ""] = match;
    const normalizedRest = String(rest ?? "").replace(/^\s+/, "");

    if (!normalizedRest.trim()) {
      return "";
    }

    return `${bullet}${normalizedRest}`;
  };
  const lines = normalized.split("\n");
  const result = [];
  const seenSingleInstanceSectionHeadings = new Set();
  let seenProgressHistoryHeading = false;
  let skippedDuplicateHeading = false;
  let insideProgressHistorySection = false;
  let insideSkippedSingleInstanceSection = false;

  for (const line of lines) {
    const trimmed = String(line ?? "").trim();
    const isSectionHeading = sectionHeadingPattern.test(trimmed);

    if (isSectionHeading && singleInstanceSectionHeadings.has(trimmed)) {
      insideProgressHistorySection = false;
      skippedDuplicateHeading = false;

      if (seenSingleInstanceSectionHeadings.has(trimmed)) {
        insideSkippedSingleInstanceSection = true;
        continue;
      }

      seenSingleInstanceSectionHeadings.add(trimmed);
      insideSkippedSingleInstanceSection = false;
      result.push(trimmed);
      continue;
    }

    if (trimmed === "[진행 내역]") {
      if (seenProgressHistoryHeading) {
        skippedDuplicateHeading = true;
        insideSkippedSingleInstanceSection = false;
        continue;
      }

      seenProgressHistoryHeading = true;
      skippedDuplicateHeading = false;
      insideProgressHistorySection = true;
      insideSkippedSingleInstanceSection = false;
      result.push("[진행 내역]");
      continue;
    }

    if (isSectionHeading) {
      insideProgressHistorySection = false;
      insideSkippedSingleInstanceSection = false;
    }

    if (insideSkippedSingleInstanceSection) {
      continue;
    }

    const normalizedLine = normalizeProgressHistoryLine(line, insideProgressHistorySection);
    const normalizedTrimmed = normalizedLine.trim();

    if (skippedDuplicateHeading && normalizedTrimmed === "" && String(result.at(-1) ?? "").trim() === "") {
      continue;
    }

    skippedDuplicateHeading = false;
    result.push(normalizedLine);
  }

  return result.join("\n");
}

function inferCodeBlockLabel(language, content) {
  const normalizedLanguage = String(language ?? "").trim().toLowerCase();

  if (normalizedLanguage) {
    if (SHELL_CODE_LANGUAGES.has(normalizedLanguage)) {
      return "shell";
    }

    return normalizedLanguage;
  }

  const normalizedContent = String(content ?? "").trim();
  const looksLikeShell =
    /(^|\n)\s*[$#>]\s/.test(normalizedContent) ||
    /(^|\n)\s*(pnpm|npm|yarn|bun|git|cd|ls|mkdir|rm|cp|mv|cat|sed|awk|curl|wget|ssh|docker|kubectl)\b/.test(
      normalizedContent
    );

  return looksLikeShell ? "shell" : "code";
}

function renderInlineCodeTokens(text, inlineCodeClassName, keyPrefix) {
  const normalized = String(text ?? "");

  if (!normalized) {
    return null;
  }

  INLINE_CODE_PATTERN.lastIndex = 0;
  const nodes = [];
  let lastIndex = 0;
  let tokenIndex = 0;

  for (const match of normalized.matchAll(INLINE_CODE_PATTERN)) {
    const [raw, codeText = ""] = match;
    const matchIndex = match.index ?? 0;

    if (matchIndex > lastIndex) {
      nodes.push(
        <span key={`${keyPrefix}-text-${tokenIndex}`}>{normalized.slice(lastIndex, matchIndex)}</span>
      );
    }

    nodes.push(
      <code
        key={`${keyPrefix}-code-${tokenIndex}`}
        className={`rounded-lg border px-1.5 py-0.5 font-mono text-[0.92em] ${inlineCodeClassName}`}
      >
        {codeText}
      </code>
    );

    lastIndex = matchIndex + raw.length;
    tokenIndex += 1;
  }

  if (lastIndex < normalized.length) {
    nodes.push(<span key={`${keyPrefix}-tail`}>{normalized.slice(lastIndex)}</span>);
  }

  return nodes.length > 0 ? nodes : normalized;
}

function extractMarkdownImageDestination(rawDestination) {
  const normalized = String(rawDestination ?? "").trim();

  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("<")) {
    const closingIndex = normalized.indexOf(">");

    if (closingIndex > 1) {
      return normalized.slice(1, closingIndex).trim();
    }
  }

  const firstWhitespaceIndex = normalized.search(/\s/);
  return firstWhitespaceIndex >= 0 ? normalized.slice(0, firstWhitespaceIndex).trim() : normalized;
}

function resolveRichMessageImageSource(rawDestination) {
  const destination = extractMarkdownImageDestination(rawDestination);

  if (!destination) {
    return null;
  }

  if (/^(?:blob:|data:image\/)/i.test(destination)) {
    return destination;
  }

  try {
    const baseUrl = typeof window !== "undefined" ? window.location.href : API_BASE_URL;
    const resolved = new URL(destination, baseUrl);

    if (!["http:", "https:"].includes(resolved.protocol)) {
      return null;
    }

    return resolved.toString();
  } catch {
    return null;
  }
}

function parseRichTextInlineTokens(text) {
  const normalized = String(text ?? "");

  if (!normalized) {
    return [];
  }

  const tokens = [];
  let lastIndex = 0;
  MARKDOWN_IMAGE_PATTERN.lastIndex = 0;

  for (const match of normalized.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    const [raw, alt = "", destination = ""] = match;
    const matchIndex = match.index ?? 0;
    const source = resolveRichMessageImageSource(destination);

    if (!source) {
      continue;
    }

    if (matchIndex > lastIndex) {
      tokens.push({
        type: "text",
        value: normalized.slice(lastIndex, matchIndex)
      });
    }

    tokens.push({
      type: "image",
      alt: String(alt ?? "").trim(),
      source
    });
    lastIndex = matchIndex + raw.length;
  }

  if (lastIndex < normalized.length) {
    tokens.push({
      type: "text",
      value: normalized.slice(lastIndex)
    });
  }

  return tokens;
}

function trimRichTextTokenValue(value) {
  return String(value ?? "").replace(/^\n+/, "").replace(/\n+$/, "");
}

export function RichMessageContent({ content, tone = "light" }) {
  const normalizedContent = tone === "brand" ? String(content ?? "") : normalizeAssistantMessageContent(content);
  const segments = parseRichMessageContent(normalizedContent);
  const inlineCodeClassName =
    tone === "brand"
      ? "border-slate-950/10 bg-slate-950/10 text-slate-950"
      : tone === "system"
        ? "border-white/10 bg-white/10 text-slate-50"
        : "border-slate-950/10 bg-slate-950/5 text-slate-950";
  const imageCardClassName =
    tone === "brand"
      ? "border-white/15 bg-slate-950/15"
      : tone === "system"
        ? "border-white/10 bg-white/10"
        : "border-slate-900/10 bg-slate-950/5";
  const imageCaptionClassName =
    tone === "brand" || tone === "system" ? "border-white/10" : "border-slate-900/10";

  if (segments.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {segments.map((segment, index) => {
        if (segment.type === "code") {
          const label = inferCodeBlockLabel(segment.language, segment.value);

          return (
            <div
              key={`code-${index}`}
              className="overflow-hidden rounded-2xl border border-slate-950/60 bg-[#0a0f1a] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
            >
              <div className="flex items-center justify-between gap-3 border-b border-white/5 bg-white/[0.03] px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-rose-400/90" />
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-300/90" />
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/90" />
                </div>
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                  {label}
                </span>
              </div>
              <div
                className="overflow-x-auto px-3 py-3"
                data-message-code-scroll="true"
                onPointerDownCapture={(event) => {
                  event.stopPropagation();
                }}
              >
                <pre className="m-0 w-max min-w-full font-mono text-[13px] leading-6 text-slate-100">
                  <code>{segment.value}</code>
                </pre>
              </div>
            </div>
          );
        }

        if (!String(segment.value ?? "").trim()) {
          return null;
        }

        const inlineTokens = parseRichTextInlineTokens(segment.value);
        const hasInlineImage = inlineTokens.some((token) => token.type === "image");

        if (!hasInlineImage) {
          return (
            <p
              key={`text-${index}`}
              className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-6"
            >
              {renderInlineCodeTokens(segment.value, inlineCodeClassName, `segment-${index}`)}
            </p>
          );
        }

        return (
          <div key={`text-${index}`} className="space-y-3">
            {inlineTokens.map((token, tokenIndex) => {
              if (token.type === "image") {
                const imageAlt = token.alt || "메시지 이미지";

                return (
                  <button
                    key={`image-${index}-${tokenIndex}`}
                    type="button"
                    data-message-attachment-interactive="true"
                    aria-label={`${imageAlt} 이미지 열기`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();

                      if (typeof window === "undefined") {
                        return;
                      }

                      const opened = window.open(token.source, "_blank", "noopener,noreferrer");

                      if (!opened) {
                        window.location.href = token.source;
                      }
                    }}
                    className={`group block w-full overflow-hidden rounded-2xl border text-left ${imageCardClassName}`}
                  >
                    <div className="overflow-hidden bg-black/10">
                      <img
                        src={token.source}
                        alt={imageAlt}
                        className="max-h-[22rem] w-full object-contain bg-black/5 transition duration-200 group-hover:scale-[1.01]"
                        loading="lazy"
                      />
                    </div>
                    {token.alt ? (
                      <p className={`border-t px-3 py-2 text-xs font-medium opacity-80 ${imageCaptionClassName}`}>
                        {token.alt}
                      </p>
                    ) : null}
                  </button>
                );
              }

              const tokenValue = trimRichTextTokenValue(token.value);

              if (!tokenValue.trim()) {
                return null;
              }

              return (
                <p
                  key={`text-${index}-${tokenIndex}`}
                  className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-6"
                >
                  {renderInlineCodeTokens(tokenValue, inlineCodeClassName, `segment-${index}-${tokenIndex}`)}
                </p>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export function MessageBubble({ align = "left", tone = "light", title, meta, children, onLongPress = null, longPressTitle = "" }) {
  const bubbleClassName =
    tone === "brand"
      ? "bg-telegram-500 text-white"
      : tone === "system"
        ? "border border-white/10 bg-white/[0.06] text-slate-200"
      : tone === "success"
        ? "bg-emerald-100 text-slate-900"
        : tone === "warn"
          ? "bg-amber-100 text-slate-900"
          : tone === "danger"
            ? "bg-rose-100 text-slate-900"
            : "bg-white text-slate-900";
  const wrapperClassName =
    align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start";
  const longPressTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);
  const pointerStartRef = useRef(null);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const resetLongPressState = useCallback(() => {
    clearLongPressTimer();
    pointerStartRef.current = null;
  }, [clearLongPressTimer]);

  useEffect(() => () => resetLongPressState(), [resetLongPressState]);

  const beginLongPress = useCallback(
    (event) => {
      if (!onLongPress) {
        return;
      }

      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }

      if (event.target instanceof Element && event.target.closest(MESSAGE_BUBBLE_LONG_PRESS_IGNORE_SELECTOR)) {
        return;
      }

      longPressTriggeredRef.current = false;
      resetLongPressState();
      pointerStartRef.current = {
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId
      };
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTriggeredRef.current = true;
        onLongPress();
      }, MESSAGE_BUBBLE_LONG_PRESS_DELAY_MS);
    },
    [onLongPress, resetLongPressState]
  );

  const cancelLongPress = useCallback(() => {
    resetLongPressState();
  }, [resetLongPressState]);

  const handlePointerMove = useCallback(
    (event) => {
      if (!onLongPress || !pointerStartRef.current) {
        return;
      }

      if (pointerStartRef.current.pointerId !== event.pointerId) {
        return;
      }

      const deltaX = event.clientX - pointerStartRef.current.x;
      const deltaY = event.clientY - pointerStartRef.current.y;

      if (Math.hypot(deltaX, deltaY) > MESSAGE_BUBBLE_LONG_PRESS_MOVE_TOLERANCE_PX) {
        resetLongPressState();
      }
    },
    [onLongPress, resetLongPressState]
  );

  const handleContextMenu = useCallback(
    (event) => {
      if (!onLongPress) {
        return;
      }

      event.preventDefault();
    },
    [onLongPress]
  );

  const handleClickCapture = useCallback((event) => {
    if (!longPressTriggeredRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    longPressTriggeredRef.current = false;
  }, []);

  return (
    <div className={`message-enter flex min-w-0 ${wrapperClassName}`} data-testid={`message-bubble-${tone}`}>
      <article
        className={`min-w-0 max-w-[86%] overflow-hidden rounded-[1.35rem] px-4 py-3 ${bubbleClassName} ${onLongPress ? "select-none" : ""}`}
        title={longPressTitle || undefined}
        onPointerDown={beginLongPress}
        onPointerUp={cancelLongPress}
        onPointerLeave={cancelLongPress}
        onPointerCancel={cancelLongPress}
        onPointerMove={handlePointerMove}
        onContextMenu={handleContextMenu}
        onClickCapture={handleClickCapture}
      >
        {title ? <p className="text-xs font-semibold uppercase tracking-[0.16em] opacity-70">{title}</p> : null}
        <div className={title ? "mt-2" : ""}>{children}</div>
        {meta ? <p className="mt-3 text-right text-[11px] opacity-60">{meta}</p> : null}
      </article>
    </div>
  );
}
