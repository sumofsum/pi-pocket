// The arrows over the conversation: step between a session's prompts, and the way back to the bottom. The counter
// above them says which prompt of how many. Faint until a scroll or a tap, then asleep again after a moment.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { jumpToEntry } from "./chat.js";
import { clearCurrentPrompt, setCurrentPrompt } from "./nav-current.js";
import { revealEntry, store } from "./store.js";
import { html, Icon } from "./ui.js";

const SLEEP_MS = 1250;
const WAKE_MS = 1100;
const BACK_MS = 8000;

export function TranscriptNav({ scroller, prompts, showJump, onJump, conversationId }) {
    const [currentId, setCurrentId] = useState(null);
    const [awake, setAwake] = useState(false);
    const [backing, setBacking] = useState(false);
    const [announcement, setAnnouncement] = useState("");
    const lock = useRef(0);
    const timer = useRef(0);
    const back = useRef(null);
    const backTimer = useRef(0);
    const current = useRef(null);
    const awakeNow = useRef(false);
    const list = useRef(prompts);
    const ids = useRef(new Set());

    list.current = prompts;
    ids.current = new Set(prompts.map((prompt) => String(prompt.id)));

    const total = prompts.length;
    const at = prompts.findIndex((prompt) => prompt.id === currentId);
    const index = at === -1 ? total - 1 : at;

    const wake = (hold = SLEEP_MS) => {
        if (!awakeNow.current) {
            awakeNow.current = true;
            setAwake(true);
        }

        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            awakeNow.current = false;
            setAwake(false);
        }, hold);
    };

    const select = (id) => {
        setCurrentPrompt(conversationId, id);

        if (id === current.current) {
            return;
        }

        current.current = id;
        setCurrentId(id);
    };

    /** Remember where a jump starts, so a short Back can return there. */
    const rememberBack = () => {
        const element = scroller.current;

        if (!element) {
            return;
        }

        back.current = {
            atBottom: element.scrollHeight - element.scrollTop - element.clientHeight <= 24,
            current: current.current,
            from: store.state.transcriptFrom,
            top: element.scrollTop,
        };
        setBacking(true);
        clearTimeout(backTimer.current);
        backTimer.current = setTimeout(() => {
            back.current = null;
            setBacking(false);
        }, BACK_MS);
    };

    const announceMessage = (id) => {
        const at = list.current.findIndex((prompt) => String(prompt.id) === String(id));

        if (at !== -1) {
            setAnnouncement(`Message ${at + 1} of ${list.current.length}.`);
        }
    };

    const restoreBack = () => {
        const target = back.current;
        const element = scroller.current;

        if (!target || !element) {
            return;
        }

        clearTimeout(backTimer.current);
        back.current = null;
        setBacking(false);
        wake();
        lock.current = performance.now() + WAKE_MS;

        const last = list.current[list.current.length - 1];
        const atNewest = last && String(target.current) === String(last.id);

        // A jump may have loaded earlier messages, and moved the window to the prompt it went to: put the window back
        // before restoring the place, so the rows the reader was on are the ones shown again.
        if (store.state.transcriptFrom !== target.from) {
            store.set({ transcriptFrom: target.from });
        }

        const place = () => {
            if (!scroller.current) {
                return;
            }

            if (target.atBottom && atNewest) {
                scroller.current.scrollTop = scroller.current.scrollHeight;
            } else {
                scroller.current.scrollTop = target.top;
            }
        };

        select(target.current);
        announceMessage(target.current);
        place();

        if (target.atBottom && atNewest) {
            onJump();
        }

        // The window's rows are drawn again after the state change: restore the place once they are.
        requestAnimationFrame(place);
    };

    /** The prompt at the top of the view, or the newest at the bottom. */
    const sync = () => {
        const element = scroller.current;
        const prompts = list.current;

        if (!element) {
            return;
        }

        if (prompts.length === 0) {
            select(null);

            return;
        }

        if (element.scrollHeight - element.scrollTop - element.clientHeight <= 24) {
            select(prompts[prompts.length - 1].id);

            return;
        }

        // Only the rows on screen; the earlier history a compaction shows is not in `prompts`.
        const rendered = [...document.querySelectorAll(".transcript .user-row")].filter((node) =>
            ids.current.has(node.id.slice(6)),
        );
        const edge = element.getBoundingClientRect().top + 40;
        let found = null;
        let low = 0;
        let high = rendered.length - 1;

        while (low <= high) {
            const middle = (low + high) >> 1;
            const node = rendered[middle];

            if (node.getBoundingClientRect().top <= edge) {
                found = node;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }

        const row = found ?? rendered[0] ?? null;
        const near = row ? prompts.find((prompt) => String(prompt.id) === row.id.slice(6)) : null;

        select(near ? near.id : prompts[prompts.length - 1].id);
    };

    useLayoutEffect(() => {
        wake();

        const frame = requestAnimationFrame(() => {
            if (performance.now() >= lock.current) {
                sync();
            }
        });

        return () => cancelAnimationFrame(frame);
    }, [conversationId, prompts.length]);

    useEffect(() => {
        const element = scroller.current;

        if (!element) {
            return undefined;
        }

        const onScroll = () => {
            wake();

            if (performance.now() >= lock.current) {
                sync();
            }
        };

        element.addEventListener("scroll", onScroll, { passive: true });

        return () => element.removeEventListener("scroll", onScroll);
    }, [conversationId, scroller]);

    useEffect(
        () => () => {
            clearTimeout(timer.current);
            clearTimeout(backTimer.current);
        },
        [],
    );

    useEffect(() => {
        clearTimeout(backTimer.current);
        back.current = null;
        setBacking(false);
        setAnnouncement("");
    }, [conversationId]);

    useEffect(() => () => clearCurrentPrompt(conversationId), [conversationId]);

    const go = (id) => {
        const target = list.current.find((prompt) => String(prompt.id) === String(id));

        if (!target) {
            return;
        }

        rememberBack();
        wake();
        select(target.id);
        announceMessage(target.id);
        lock.current = performance.now() + WAKE_MS;
        // A prompt above the rows on screen: show from it down, then bring it to the top and ring it. One this tab has
        // not loaded yet loads first (jumpToEntry), so the lock holds until the jump settles, however long that takes.
        revealEntry(target.id);
        requestAnimationFrame(() => {
            Promise.resolve(jumpToEntry(target.id, { top: true })).finally(() => {
                lock.current = performance.now() + WAKE_MS;
            });
        });
    };

    const goRef = useRef(go);

    goRef.current = go;

    // The popup can show its own Back while it covers the nav's.
    const restoreRef = useRef(restoreBack);

    restoreRef.current = restoreBack;

    useEffect(() => {
        document.dispatchEvent(new CustomEvent("pocket:back-available", { detail: backing }));
    }, [backing]);

    useEffect(() => {
        const restore = () => restoreRef.current();

        document.addEventListener("pocket:restore-back", restore);

        return () => document.removeEventListener("pocket:restore-back", restore);
    }, []);

    // A history row's target button: jump from wherever it is, and let the list follow (composer.js).
    useEffect(() => {
        const jump = (event) => goRef.current(event.detail);

        document.addEventListener("pocket:jump-prompt", jump);

        return () => document.removeEventListener("pocket:jump-prompt", jump);
    }, []);

    const move = (step) => {
        const target = prompts[index + step];

        if (target) {
            go(target.id);
        }
    };

    const goBottom = () => {
        const last = prompts[prompts.length - 1];

        rememberBack();
        wake();
        lock.current = performance.now() + 900;
        select(last?.id ?? null);
        onJump();

        if (last) {
            setAnnouncement(`Message ${prompts.length} of ${prompts.length}.`);
        }
    };

    const goTop = () => {
        const first = prompts[0];

        if (first) {
            go(first.id);
        }
    };

    return html`<div
        class=${awake ? "scroll-tools awake" : "scroll-tools"}
        onPointerDown=${() => wake()}
        onClick=${() => wake()}
    >
        ${
            total > 0 &&
            html`<button
                class="nav-count"
                type="button"
                title="Message history"
                aria-label=${`Message history: message ${index + 1} of ${total}`}
                aria-haspopup="dialog"
                onClick=${() => document.dispatchEvent(new CustomEvent("pocket:open-history"))}
            >
                <${Icon} name="history" size=${13} />
                <span>${index + 1}/${total}</span>
            </button>`
        }
        ${
            total > 0 &&
            html`<button
                class="jump"
                type="button"
                title="To the first message"
                aria-label="To the first message"
                onClick=${goTop}
            >
                <${Icon} name="top" />
            </button>`
        }
        ${
            total > 0 &&
            html`<div class="nav-stepper" role="group" aria-label="Navigate between messages">
                <button
                    type="button"
                    title="Previous message"
                    aria-label="Previous message"
                    disabled=${index <= 0}
                    onClick=${() => move(-1)}
                >
                    <${Icon} name="up" size=${17} />
                </button>
                <button
                    type="button"
                    title="Next message"
                    aria-label="Next message"
                    disabled=${index >= total - 1}
                    onClick=${() => move(1)}
                >
                    <${Icon} name="arrow-down" size=${17} />
                </button>
            </div>`
        }
        <button
            class="jump"
            type="button"
            title="To the bottom"
            aria-label="To the bottom"
            hidden=${!showJump}
            onClick=${goBottom}
        >
            <${Icon} name="down" />
        </button>
        <span class="sr-only" role="status" aria-live="polite">${announcement}</span>
    </div>`;
}
