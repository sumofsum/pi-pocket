// The prompts sent in this session, oldest first: pick one of yours to put it back in the box, or jump to it.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { fromServer } from "./seen.js";
import { notify } from "./store.js";
import { copyText, html, Icon } from "./ui.js";

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
            const last =
                messages.length > 0 && String(messages[messages.length - 1].id) === String(focusId);

            if (last) {
                element.scrollTop = element.scrollHeight;
            } else {
                const box = element.getBoundingClientRect();
                const rowBox = row.getBoundingClientRect();

                element.scrollTop += rowBox.top - box.top - (box.height - rowBox.height) / 2;
            }

            saved.current = element.scrollTop;
            row.querySelector(".message-history-pick")?.focus({ preventScroll: true });

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

        document.addEventListener("pointerdown", outside);
        document.addEventListener("keydown", escape, true);

        return () => {
            document.removeEventListener("pointerdown", outside);
            document.removeEventListener("keydown", escape, true);
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

    const count = messages.length;
    const query = filter.trim().toLowerCase();
    const shown =
        query === ""
            ? messages
            : messages.filter((message) =>
                  [message.text, message.author, message.attachmentsLabel].some((part) =>
                      part?.toLowerCase().includes(query),
                  ),
              );
    const shownAt = shown.findIndex((message) => String(message.id) === String(focusId));
    const canPrev = shown.length > 0 && (shownAt === -1 || shownAt > 0);
    const canNext = shown.length > 0 && (shownAt === -1 || shownAt < shown.length - 1);
    const focused = focusId
        ? messages.find((message) => String(message.id) === String(focusId))
        : null;
    const shared = messages.some((message) => !message.mine);
    const title = shared ? "Messages" : "Your messages";
    const hint =
        focused && !focused.pickable
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

    const step = (by) => {
        const target =
            shownAt === -1 ? (by > 0 ? shown[0] : shown[shown.length - 1]) : shown[shownAt + by];

        if (target) {
            document.dispatchEvent(new CustomEvent("pocket:jump-prompt", { detail: target.id }));
        }
    };

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
                      : shown.map(
                            (message) => html`<div
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
                                        ${
                                            message.working &&
                                            html`<span
                                                class="message-history-working"
                                                role="img"
                                                aria-label="Pi is working"
                                                title="Pi is working"
                                            ></span>`
                                        }
                                    </span>
                                    <span class="message-history-body">
                                        ${
                                            shared &&
                                            html`<span
                                                class="message-history-author"
                                                data-mine=${message.mine ? "" : undefined}
                                            >${message.author}</span>`
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
                                            >${message.text || message.attachmentsLabel}</span>
                                        </span>
                                        ${
                                            !message.pickable &&
                                            html`<span class="message-history-only">jump only</span>`
                                        }
                                        ${
                                            message.took !== undefined &&
                                            html`<span
                                                class="message-history-took"
                                                title=${`Pi took ${elapsed(message.took)} to reply`}
                                                aria-label=${`Pi took ${elapsed(message.took)} to reply`}
                                            >
                                                <${Icon} name="clock" size=${11} />
                                                ${elapsed(message.took)}
                                            </span>`
                                        }
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
                                <button
                                    class="message-history-jump"
                                    type="button"
                                    title="Scroll to this message"
                                    aria-label="Scroll to this message"
                                    onClick=${() => onJump(message)}
                                >
                                    <${Icon} name="locate" size=${16} />
                                </button>
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
                        title=${filterOpen ? "Hide filter" : "Filter messages"}
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
