// The prompts sent in this session, oldest first: pick one of yours to put it back in the box, or jump to it.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { fromServer } from "./seen.js";
import { notify } from "./store.js";
import { APPLE, copyText, html, Icon, Marked } from "./ui.js";

/** When a prompt was sent: the time, and the date on its own line when it is not today. */
function clock(at) {
    if (!at) {
        return { date: "", time: "" };
    }

    const date = new Date(fromServer(at));
    const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

    return date.toDateString() === new Date().toDateString()
        ? { date: "", time }
        : { date: date.toLocaleDateString([], { month: "short", day: "numeric" }), time };
}

function Clock({ at }) {
    const { date, time } = clock(at);

    return html`<span class="message-history-time">
        ${date && html`<span class="message-history-date">${date}</span>`}
        <span>${time}</span>
    </span>`;
}

function Compaction({ message }) {
    return html`<div class="message-history-compaction" role="listitem">
        <span class="message-history-compaction-label">
            <${Icon} name="compact" size=${13} />
            Context compacted
        </span>
        ${
            message.summary &&
            html`<details class="message-history-compaction-details">
                <summary>Summary</summary>
                <div class="message-history-compaction-body">
                    <${Marked} text=${message.summary} />
                </div>
            </details>`
        }
    </div>`;
}

/** How long Pi took to answer: 0.4s, 1.2s, 12s, 2m 04s. */
function elapsed(ms) {
    if (!(ms >= 0)) {
        return "";
    }

    if (ms < 100) {
        return "<0.1s";
    }

    if (ms < 10_000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }

    const seconds = Math.round(ms / 1000);

    if (seconds < 60) {
        return `${seconds}s`;
    }

    if (seconds < 3600) {
        return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
    }

    return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`;
}

/** The working clock counts whole seconds; the final took keeps its precise size. */
function liveElapsed(ms) {
    if (!(ms >= 0)) {
        return "";
    }

    const seconds = Math.floor(ms / 1000);

    if (seconds < 1) {
        return "<1s";
    }

    if (seconds < 60) {
        return `${seconds}s`;
    }

    if (seconds < 3600) {
        return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
    }

    return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`;
}

/** The filter's matches inside a row's words or author, with the rest of the text as it was. */
function Highlighted({ text, query }) {
    const value = String(text ?? "");

    if (!query) {
        return value;
    }

    const lower = value.toLowerCase();
    const parts = [];
    let start = 0;
    let at = lower.indexOf(query);

    while (at !== -1) {
        if (at > start) {
            parts.push(value.slice(start, at));
        }

        parts.push(
            html`<mark class="message-history-hit">${value.slice(at, at + query.length)}</mark>`,
        );
        start = at + query.length;
        at = lower.indexOf(query, start);
    }

    if (start < value.length) {
        parts.push(value.slice(start));
    }

    return parts;
}

const OUTCOME_LABELS = { stopped: "Stopped", failed: "Failed", "cut off": "Cut off" };

function outcomeLabel(outcome) {
    return OUTCOME_LABELS[outcome] ?? outcome;
}

function outcomeClass(outcome) {
    return outcome === "failed" || outcome === "cut off" ? outcome.replace(" ", "") : "stopped";
}

function shortModel(model) {
    return String(model ?? "").replace(/-\d{8}$/, "");
}

/** The row's hover/long-press detail: outcome, duration, cost, work, and model. */
function replyDetail(message) {
    const parts = [];

    if (message.outcome) {
        parts.push(
            message.outcomeDetail
                ? `${outcomeLabel(message.outcome)}: ${message.outcomeDetail}`
                : outcomeLabel(message.outcome),
        );
    }

    if (message.took !== undefined) {
        parts.push(`Pi took ${elapsed(message.took)} to reply`);
    }

    if (message.cost > 0) {
        parts.push(`$${message.cost.toFixed(3)} this turn`);
    }

    if (message.tools > 0) {
        parts.push(`${message.tools} tool${message.tools === 1 ? "" : "s"}`);
    }

    if (message.files > 0) {
        parts.push(`${message.files} file${message.files === 1 ? "" : "s"}`);
    }

    if (message.model) {
        parts.push(
            `${message.provider ? `${message.provider}/` : ""}${shortModel(message.model)}${message.thinking ? ` · thinking ${message.thinking}` : ""}`,
        );
    }

    return parts.join(" · ");
}

function TurnMeta({ message, open }) {
    const [now, setNow] = useState(() => Date.now());

    // While the row works, its clock counts from the prompt: one tick a second, only while the list shows it.
    useEffect(() => {
        if (!open || !message.working) {
            return undefined;
        }

        setNow(Date.now());

        const timer = setInterval(() => setNow(Date.now()), 1000);

        return () => clearInterval(timer);
    }, [open, message.working]);

    const started = message.at ? fromServer(message.at) : NaN;
    const live =
        open && message.working && Number.isFinite(started)
            ? Math.max(0, now - started)
            : undefined;
    const final = message.took !== undefined;
    const took = message.took ?? live;
    const work = message.tools > 0 || message.files > 0;
    const show = work || !message.pickable || took !== undefined || message.outcome;

    if (!show) {
        return null;
    }

    return html`<span class="message-history-meta">
        <span class="message-history-meta-left">
            ${
                work &&
                html`<span class="message-history-work">
                    <span class="message-history-counts">
                        ${
                            message.tools > 0 &&
                            html`<span
                                >${message.tools}tool${message.tools === 1 ? "" : "s"}</span
                            >`
                        }
                        ${message.tools > 0 && message.files > 0 && " · "}
                        ${
                            message.files > 0 &&
                            html`<span
                                >${message.files}file${message.files === 1 ? "" : "s"}</span
                            >`
                        }
                    </span>
                </span>`
            }
            ${!message.pickable && html`<span class="message-history-only">jump only</span>`}
        </span>
        ${
            (took !== undefined || message.outcome) &&
            html`<span
                class=${`message-history-took ${message.outcome ? "with-outcome" : ""}`}
                title=${replyDetail(message)}
                aria-label=${replyDetail(message)}
            >
                ${
                    message.outcome &&
                    html`<span
                        class=${`message-history-outcome ${outcomeClass(message.outcome)}`}
                        >${outcomeLabel(message.outcome)}</span
                    >`
                }
                ${took !== undefined && html`<${Icon} name="clock" size=${11} />`}
                ${took !== undefined && (final ? elapsed(took) : liveElapsed(took))}
            </span>`
        }
    </span>`;
}

/**
 * The message box's history popover: every prompt sent here, oldest first, with who sent it when others are here. The
 * first time it opens it starts at the newest (the bottom); after that it reopens where it was left. Tapping one of
 * yours replaces the box's text; the target button jumps to the message in the conversation.
 */
export function MessageHistory({ open, focusId, messages, onClose, onPick, onJump }) {
    const popover = useRef(null);
    const [copied, setCopied] = useState(null);
    const [filter, setFilter] = useState("");
    const [filterOpen, setFilterOpen] = useState(false);
    const [announcement, setAnnouncement] = useState("");
    const [canBack, setCanBack] = useState(false);
    const copyTimer = useRef(0);
    const filterInput = useRef(null);
    const filterButton = useRef(null);
    const list = useRef(null);
    const saved = useRef(0);
    const first = useRef(true);
    const close = useRef(onClose);

    close.current = onClose;

    // Keep the popover between the top bar and the message box, also when the keyboard takes the screen.
    useLayoutEffect(() => {
        if (!open) {
            return undefined;
        }

        const element = popover.current;

        if (!element) {
            return undefined;
        }

        const fit = () => {
            const bottom = element.getBoundingClientRect().bottom;
            const room = Math.max(180, Math.min(480, bottom - 64));

            element.style.maxHeight = `${room}px`;
        };

        fit();

        const view = window.visualViewport;

        view?.addEventListener("resize", fit);
        view?.addEventListener("scroll", fit);
        window.addEventListener("resize", fit);

        return () => {
            view?.removeEventListener("resize", fit);
            view?.removeEventListener("scroll", fit);
            window.removeEventListener("resize", fit);
            element.style.maxHeight = "";
        };
    }, [open]);

    useLayoutEffect(() => {
        if (!open) {
            return undefined;
        }

        const element = list.current;

        if (!element) {
            return undefined;
        }

        // Open on the prompt the conversation's arrows are on: centered, lit, and focused.
        const row = focusId
            ? element.querySelector(`[data-message-id="${CSS.escape(String(focusId))}"]`)
            : null;

        if (row) {
            first.current = false;

            // The newest prompt is the bottom, not the middle: leave no half row short of it.
            const lastPrompt = messages.findLast((message) => !message.divider);
            const last = lastPrompt !== undefined && String(lastPrompt.id) === String(focusId);

            if (last) {
                element.scrollTop = element.scrollHeight;
            } else {
                const box = element.getBoundingClientRect();
                const rowBox = row.getBoundingClientRect();

                element.scrollTop += rowBox.top - box.top - (box.height - rowBox.height) / 2;
            }

            saved.current = element.scrollTop;

            // Keep typing in the filter while its arrows move the highlight.
            if (document.activeElement !== filterInput.current) {
                row.querySelector(".message-history-pick")?.focus({ preventScroll: true });
            }

            const frame = requestAnimationFrame(() => {
                if (last) {
                    element.scrollTop = element.scrollHeight;
                    saved.current = element.scrollTop;
                }
            });

            return () => cancelAnimationFrame(frame);
        }

        const initial = first.current;

        first.current = false;

        if (initial) {
            saved.current = element.scrollHeight;
        }

        element.scrollTop = saved.current;
        element.focus({ preventScroll: true });
        element.scrollTop = saved.current;

        const frame = requestAnimationFrame(() => {
            if (initial) {
                element.scrollTop = element.scrollHeight;
                saved.current = element.scrollTop;
            } else {
                element.scrollTop = saved.current;
            }
        });

        return () => cancelAnimationFrame(frame);
    }, [open, focusId]);

    useEffect(() => {
        if (!open) {
            return undefined;
        }

        const outside = (event) => {
            if (
                // The message arrows stay usable while the list is open: they move its highlight.
                event.target.closest?.(".scroll-tools") ||
                popover.current?.contains(event.target)
            ) {
                return;
            }

            close.current(false);
        };

        const escape = (event) => {
            if (event.key !== "Escape") {
                return;
            }

            // Escape in the filter closes the filter, not the whole list.
            if (event.target === filterInput.current) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            close.current(true);
        };

        // Find in the open history: focus the filter before the app's session find, or the browser's find, sees it.
        const find = (event) => {
            if (
                event.isComposing ||
                event.altKey ||
                event.shiftKey ||
                !(event.ctrlKey || event.metaKey) ||
                event.key.toLowerCase() !== "f"
            ) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            setFilterOpen(true);
            filterInput.current?.focus();
        };

        document.addEventListener("pointerdown", outside);
        document.addEventListener("keydown", escape, true);
        document.addEventListener("keydown", find, true);

        return () => {
            document.removeEventListener("pointerdown", outside);
            document.removeEventListener("keydown", escape, true);
            document.removeEventListener("keydown", find, true);
        };
    }, [open]);

    // The list has its own arrows; the conversation's counter and arrows step aside while it is open.
    useEffect(() => {
        document.body.classList.toggle("history-open", open);

        return () => document.body.classList.remove("history-open");
    }, [open]);

    useEffect(() => {
        if (!open) {
            setFilter("");
            setFilterOpen(false);
        }
    }, [open]);

    useLayoutEffect(() => {
        if (filterOpen) {
            filterInput.current?.focus();
        }
    }, [filterOpen]);

    useEffect(() => () => clearTimeout(copyTimer.current), []);

    useEffect(() => {
        const update = (event) => setCanBack(Boolean(event.detail));

        document.addEventListener("pocket:back-available", update);

        return () => document.removeEventListener("pocket:back-available", update);
    }, []);

    const copy = (message) => {
        copyText(message.text).then(
            () => {
                setCopied(message.id);
                clearTimeout(copyTimer.current);
                copyTimer.current = setTimeout(() => setCopied(null), 1400);
                notify("info", "Copied.");
            },
            () => notify("error", "Could not copy."),
        );
    };

    const promptMessages = messages.filter((message) => !message.divider);
    const count = promptMessages.length;
    const query = filter.trim().toLowerCase();
    const shown =
        query === ""
            ? promptMessages
            : promptMessages.filter((message) =>
                  [message.text, message.author, message.attachmentsLabel].some((part) =>
                      part?.toLowerCase().includes(query),
                  ),
              );
    const shownAt = shown.findIndex((message) => String(message.id) === String(focusId));
    const canPrev = shown.length > 0 && (shownAt === -1 || shownAt > 0);
    const canNext = shown.length > 0 && (shownAt === -1 || shownAt < shown.length - 1);
    const focused = focusId
        ? promptMessages.find((message) => String(message.id) === String(focusId))
        : null;
    const shared = promptMessages.some((message) => !message.mine);
    const title = shared ? "Messages" : "Your messages";
    const hint = focused?.working
        ? focused.mine
            ? "Pi is working · tap to put it back"
            : "Pi is working · tap to jump"
        : focused && !focused.pickable
          ? !focused.mine
              ? "Not yours · tap to jump"
              : focused.text === ""
                ? focused.attachmentsLabel && focused.attachmentsLabel !== "No text"
                    ? "Attachment only · tap to jump"
                    : "No text · tap to jump"
                : "Jump only · tap to jump"
          : shared
            ? "Tap yours to put it back · ◎ to jump"
            : "Tap to put it back · ◎ to jump";
    const countText = query === "" ? String(count) : `${shown.length} of ${count}`;
    const countTitle =
        query === ""
            ? `${count} ${count === 1 ? "message" : "messages"}`
            : `${shown.length} of ${count} messages`;
    const rows = query === "" ? messages : shown;

    useEffect(() => {
        if (!open || query === "") {
            setAnnouncement("");

            return;
        }

        setAnnouncement(
            shown.length === 0
                ? "No messages match."
                : `${shown.length} ${shown.length === 1 ? "message matches" : "messages match"}.`,
        );
    }, [open, query, shown.length]);

    const closeFilter = () => {
        setFilterOpen(false);
        setFilter("");
    };

    const toggleFilter = () => {
        if (filterOpen) {
            closeFilter();
        } else {
            setFilterOpen(true);
        }
    };

    const jumpTo = (message) => {
        if (message) {
            document.dispatchEvent(new CustomEvent("pocket:jump-prompt", { detail: message.id }));
        }
    };

    const step = (by) => {
        const target =
            shownAt === -1 ? (by > 0 ? shown[0] : shown[shown.length - 1]) : shown[shownAt + by];

        jumpTo(target);
    };

    // While the list is open: Up/Down step, Home/End go to the ends, Ctrl+Up/Down page it. They work from the
    // filter too, which keeps the focus while the highlight moves.
    useEffect(() => {
        if (!open) {
            return undefined;
        }

        const keys = (event) => {
            if (event.isComposing) {
                return;
            }

            const key = event.key;
            const modified = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;

            if (
                ((event.ctrlKey || event.metaKey) &&
                    !event.altKey &&
                    !event.shiftKey &&
                    (key === "ArrowUp" || key === "ArrowDown")) ||
                (!modified && (key === "PageUp" || key === "PageDown"))
            ) {
                event.preventDefault();
                event.stopPropagation();

                const element = list.current;
                let page = 1;

                if (element) {
                    const box = element.getBoundingClientRect();
                    const visible = [...element.querySelectorAll(".message-history-item")].filter(
                        (row) => {
                            const rect = row.getBoundingClientRect();

                            return rect.top >= box.top - 1 && rect.top < box.bottom;
                        },
                    ).length;

                    page = Math.max(1, visible);
                }

                const up = key === "ArrowUp" || key === "PageUp";
                const by = up ? -page : page;
                const index =
                    shownAt === -1
                        ? by > 0
                            ? 0
                            : shown.length - 1
                        : Math.min(shown.length - 1, Math.max(0, shownAt + by));

                jumpTo(shown[index]);

                return;
            }

            if (!modified && (key === "ArrowUp" || key === "ArrowDown")) {
                event.preventDefault();
                event.stopPropagation();
                step(key === "ArrowUp" ? -1 : 1);

                return;
            }

            if (!modified && (key === "Home" || key === "End")) {
                event.preventDefault();
                event.stopPropagation();
                jumpTo(key === "Home" ? shown[0] : shown[shown.length - 1]);
            }
        };

        document.addEventListener("keydown", keys, true);

        return () => document.removeEventListener("keydown", keys, true);
    }, [open, step, jumpTo, shown]);

    return html`<div
        class="message-history"
        data-no-swipe=""
        role="dialog"
        aria-label=${title}
        hidden=${!open}
        ref=${popover}
    >
        <div class="message-history-head">
            <span class="message-history-title">${title}</span>
            <span class="message-history-count" title=${countTitle}>${countText}</span>
            <button
                class="message-history-close"
                type="button"
                aria-label="Close message history"
                onClick=${() => close.current(true)}
            >
                <${Icon} name="close" size=${15} />
            </button>
        </div>
        <div
            class="message-history-list"
            role="list"
            tabIndex="-1"
            ref=${list}
            onScroll=${(event) => {
                saved.current = event.currentTarget.scrollTop;
            }}
        >
            ${
                count === 0
                    ? html`<p class="message-history-empty">
                          Nothing has been sent in this session yet.
                      </p>`
                    : shown.length === 0
                      ? html`<p class="message-history-empty">No messages match.</p>`
                      : rows.map((message) =>
                            message.divider
                                ? html`<${Compaction}
                                      key=${message.id}
                                      message=${message}
                                  />`
                                : html`<div
                                class=${[
                                    "message-history-item",
                                    String(message.id) === String(focusId) ? "current" : "",
                                    message.working ? "working" : "",
                                ]
                                    .filter(Boolean)
                                    .join(" ")}
                                key=${message.id}
                                data-message-id=${message.id}
                                role="listitem"
                            >
                                <button
                                    class="message-history-pick"
                                    type="button"
                                    title=${
                                        message.pickable
                                            ? "Put this message in the box"
                                            : "Jump to this message"
                                    }
                                    aria-current=${
                                        String(message.id) === String(focusId) ? "true" : undefined
                                    }
                                    onClick=${() =>
                                        message.pickable ? onPick(message) : onJump(message)}
                                >
                                    <span class="message-history-when">
                                        <${Clock} at=${message.at} />
                                    </span>
                                    <span class="message-history-body">
                                        ${
                                            shared &&
                                            html`<span
                                                class="message-history-author"
                                                data-mine=${message.mine ? "" : undefined}
                                            >
                                                <${Highlighted}
                                                    text=${message.author}
                                                    query=${query}
                                                />
                                            </span>`
                                        }
                                        <span class="message-history-text">
                                            ${
                                                (message.image || message.file) &&
                                                html`<span class="message-history-attachments">
                                                    ${
                                                        message.image &&
                                                        html`<span
                                                            class="message-history-attachment"
                                                            role="img"
                                                            aria-label="Image attached"
                                                            title="Image attached"
                                                        >
                                                            <${Icon} name="photo" size=${13} />
                                                        </span>`
                                                    }
                                                    ${
                                                        message.file &&
                                                        html`<span
                                                            class="message-history-attachment"
                                                            role="img"
                                                            aria-label="File attached"
                                                            title="File attached"
                                                        >
                                                            <${Icon} name="file" size=${13} />
                                                        </span>`
                                                    }
                                                </span>`
                                            }
                                            <span
                                                class=${`message-history-words ${message.text ? "" : "placeholder"}`}
                                            >
                                                <${Highlighted}
                                                    text=${message.text || message.attachmentsLabel}
                                                    query=${query}
                                                />
                                            </span>
                                        </span>
                                        <${TurnMeta} message=${message} open=${open} />
                                    </span>
                                </button>
                                ${
                                    message.text !== "" &&
                                    html`<button
                                        class="message-history-copy"
                                        type="button"
                                        title=${
                                            copied === message.id ? "Copied" : "Copy this message"
                                        }
                                        aria-label="Copy this message"
                                        onClick=${() => copy(message)}
                                    >
                                        <${Icon}
                                            name=${copied === message.id ? "check" : "copy"}
                                            size=${16}
                                        />
                                    </button>`
                                }
                                ${
                                    message.working
                                        ? html`<button
                                              class="message-history-work-slot"
                                              type="button"
                                              title="Scroll to this message"
                                              aria-label="Scroll to this message"
                                              onClick=${() => onJump(message)}
                                          >
                                              <span
                                                  class="message-history-working"
                                                  role="img"
                                                  aria-label="Pi is working"
                                                  title="Pi is working"
                                              ></span>
                                          </button>`
                                        : html`<button
                                              class="message-history-jump"
                                              type="button"
                                              title="Scroll to this message"
                                              aria-label="Scroll to this message"
                                              onClick=${() => onJump(message)}
                                          >
                                              <${Icon} name="locate" size=${16} />
                                          </button>`
                                }
                            </div>`,
                        )
            }
        </div>
        <div class="message-history-foot">
            ${
                filterOpen && count > 0
                    ? html`<input
                          class="message-history-filter"
                          ref=${filterInput}
                          type="search"
                          value=${filter}
                          placeholder="Filter messages"
                          aria-label="Filter messages"
                          autocomplete="off"
                          spellcheck="false"
                          onKeyDown=${(event) => {
                              if (event.key === "Enter") {
                                  event.preventDefault();
                                  event.stopPropagation();

                                  const message = shownAt === -1 ? shown[0] : shown[shownAt];

                                  if (message) {
                                      if (message.pickable) {
                                          onPick(message);
                                      } else {
                                          onJump(message);
                                      }
                                  }

                                  return;
                              }

                              if (event.key !== "Escape") {
                                  return;
                              }

                              event.preventDefault();
                              event.stopPropagation();
                              closeFilter();
                              requestAnimationFrame(() =>
                                  filterButton.current?.focus({ preventScroll: true }),
                              );
                          }}
                          onInput=${(event) => {
                              setFilter(event.currentTarget.value);

                              if (list.current) {
                                  list.current.scrollTop = 0;
                                  saved.current = 0;
                              }
                          }}
                      />`
                    : html`<span class="message-history-hint">${hint}</span>`
            }
            ${
                count > 0 &&
                html`<div class="message-history-tools">
                    ${
                        canBack &&
                        html`<button
                            class="message-history-back"
                            type="button"
                            title="Back to where I was"
                            aria-label="Back to where I was"
                            onClick=${() =>
                                document.dispatchEvent(new CustomEvent("pocket:restore-back"))}
                        >
                            <${Icon} name="back" size=${13} />
                            <span>Back</span>
                        </button>`
                    }
                    <button
                        class="message-history-filter-button"
                        ref=${filterButton}
                        type="button"
                        title=${filterOpen ? "Hide filter" : `Filter messages (${APPLE ? "⌘" : "Ctrl"}+F)`}
                        aria-label="Filter messages"
                        aria-pressed=${filterOpen}
                        onClick=${toggleFilter}
                    >
                        <${Icon} name="filter" size=${15} />
                    </button>
                    <div
                        class="message-history-nav"
                        role="group"
                        aria-label=${
                            query
                                ? "Move between matching messages"
                                : shared
                                  ? "Move between messages"
                                  : "Move between your messages"
                        }
                    >
                        <button
                            type="button"
                            title=${query ? "Previous match" : "Previous message"}
                            aria-label=${query ? "Previous match" : "Previous message"}
                            disabled=${!canPrev}
                            onClick=${() => step(-1)}
                        >
                            <${Icon} name="up" size=${15} />
                        </button>
                        <button
                            type="button"
                            title=${query ? "Next match" : "Next message"}
                            aria-label=${query ? "Next match" : "Next message"}
                            disabled=${!canNext}
                            onClick=${() => step(1)}
                        >
                            <${Icon} name="arrow-down" size=${15} />
                        </button>
                    </div>
                </div>`
            }
        </div>
        <span class="sr-only" role="status" aria-live="polite">${announcement}</span>
    </div>`;
}
