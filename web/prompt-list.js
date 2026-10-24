// The session's prompts for the message history and the arrows over it: the rows a tab has loaded, the session's whole
// list as the server summarizes it, and where the transcript's "Show earlier messages" line falls.
//
// Older prompts come as summaries from `GET c/:id/prompt-history` (no reply text), so the history shows and jumps to
// every prompt before this tab has loaded it. Loaded rows carry the fresher turn (Pi working, a time just taken), so
// they replace the server's row for the same prompt.
import { splitAttachments } from "./attachments.js";

const ATTACHED_IMAGE = /,\s*image\//i;
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|avif|bmp|heic|heif|svg)$/i;
const VIA = /^\[via [^\]\n]{1,300}\] /;
/** Transcript rows, as `isRow` in store.js: tool results show inside their call's card. */
const ROW_KINDS = new Set([
    "user",
    "assistant",
    "compaction",
    "reset",
    "shell",
    "command",
    "note",
    "fromPi",
]);

/**
 * The prompts this tab has loaded, oldest first, with who sent each, what was sent with it, and how its turn ended:
 * the same rows the server summarizes for the whole session. A compaction shows as a divider row.
 */
export function loadedPrompts(view, { meId, users = [], kind } = {}) {
    if (!meId) {
        return [];
    }

    const found = [];
    const finished = new Map();
    const rows = view.order
        .map((id) => view.entries.get(id))
        .filter((entry) => entry && ROW_KINDS.has(entry.kind));
    let asked = null;
    let answered = null;

    const remember = () => {
        if (asked?.at === undefined || answered?.at === undefined) {
            return;
        }

        const took = answered.at - asked.at;

        if (Number.isFinite(took) && took >= 0) {
            finished.set(asked.id, took);
        }
    };

    for (const entry of rows) {
        if (entry.kind === "user") {
            remember();
            asked = entry;
            answered = null;
        } else if (entry.kind === "assistant" && asked) {
            answered = entry;
        }
    }

    // A turn still running has only its start: wait for Pi to finish before showing a time.
    if (!view.live?.busy) {
        remember();
    }

    const lastUser = rows.findLast((entry) => entry.kind === "user");
    const workingId = view.live?.busy ? lastUser?.id : undefined;

    // What each turn did after its prompt: tools and files, model, outcome, and what its replies cost.
    const turns = new Map();
    let turn = null;

    for (const id of view.order) {
        const entry = view.entries.get(id);

        if (!entry) {
            continue;
        }

        if (entry.kind === "user") {
            turn = {
                tools: 0,
                files: new Set(),
                cost: 0,
                outcome: undefined,
                detail: undefined,
                model: undefined,
                provider: undefined,
                replies: 0,
            };
            turns.set(entry.id, turn);
            continue;
        }

        if (!turn || entry.kind !== "assistant") {
            continue;
        }

        turn.replies += 1;

        if (typeof entry.model === "string") {
            turn.model = entry.model;
            turn.provider = entry.provider;
        }

        if (typeof entry.cost === "number" && Number.isFinite(entry.cost)) {
            turn.cost += entry.cost;
        }

        for (const block of entry.blocks ?? []) {
            if (block?.type !== "toolCall") {
                continue;
            }

            turn.tools += 1;
            const path = block.args?.path;

            if (typeof path === "string" && path.trim() !== "") {
                turn.files.add(path);
            }
        }

        if (entry.stopReason === "error") {
            turn.outcome = "failed";
            turn.detail = entry.error;
        } else if (entry.stopReason === "aborted") {
            turn.outcome = "stopped";
        } else if (entry.stopReason === "length") {
            turn.outcome = "cut off";
        }
    }

    for (const [id, info] of turns) {
        if (info.replies === 0 && !(view.live?.busy && id === workingId)) {
            info.outcome = "stopped";
        }
    }

    const thinking =
        view.agent?.reasoning && view.agent?.thinkingLevel !== "off"
            ? view.agent.thinkingLevel
            : undefined;

    for (const id of view.order) {
        const entry = view.entries.get(id);

        if (!entry) {
            continue;
        }

        if (entry.kind === "compaction") {
            found.push({
                id: entry.id,
                at: entry.at,
                divider: true,
                summary: entry.summary ?? "",
            });
            continue;
        }

        if (!ROW_KINDS.has(entry.kind) || entry.kind !== "user") {
            continue;
        }

        const authorId = view.authors?.[entry.id];
        const mine = authorId !== undefined && authorId === meId;
        const named = authorId
            ? (users.find((user) => user.id === authorId)?.name ?? "Someone")
            : (entry.from ?? (kind === "subagent" ? "Main agent" : "Pi"));
        const author = mine ? "You" : named;
        const [written, attached = ""] = splitAttachments(entry.text);
        let text = written.trim();
        const via = VIA.exec(text);

        if (via) {
            text = text.slice(via[0].length);
        }

        if (text.startsWith("[scheduled] ")) {
            text = text.slice("[scheduled] ".length);
        }

        const lines = attached.split("\n").filter((line) => line.trim() !== "");
        const image =
            entry.images > 0 ||
            lines.some((line) => ATTACHED_IMAGE.test(line)) ||
            (entry.files?.some((path) => IMAGE_FILE.test(path)) ?? false);
        const file =
            lines.some((line) => !ATTACHED_IMAGE.test(line)) ||
            (entry.files?.some((path) => !IMAGE_FILE.test(path)) ?? false);
        const attachmentsLabel =
            image && file
                ? "Image and file attached"
                : image
                  ? "Image attached"
                  : file
                    ? "File attached"
                    : "No text";

        const info = turns.get(entry.id);

        found.push({
            id: entry.id,
            at: entry.at,
            text,
            author,
            mine,
            pickable: mine && text !== "",
            attachmentsLabel,
            image,
            file,
            took: finished.get(entry.id),
            working: workingId !== undefined && entry.id === workingId,
            tools: info?.tools ?? 0,
            files: info?.files.size ?? 0,
            cost: info?.cost ?? 0,
            outcome: info?.outcome,
            outcomeDetail: info?.detail,
            model: info?.model,
            provider: info?.provider,
            thinking,
        });
    }

    return found;
}

/** One row of `GET c/:id/prompt-history` as the history and the arrows use it. */
export function promptFromServer(row) {
    if (row.kind === "compaction" || row.divider) {
        return {
            id: row.id,
            at: row.at,
            divider: true,
            summary: row.summary ?? row.compaction?.summary ?? "",
        };
    }

    const attachments = row.attachments ?? {};

    return {
        id: row.id,
        at: row.at,
        text: String(row.text ?? ""),
        author: String(row.author ?? ""),
        mine: row.mine === true,
        pickable: row.pickable === true,
        attachmentsLabel: attachments.label ?? "No text",
        image: attachments.image === true,
        file: attachments.file === true,
        took: row.took,
        working: row.working === true,
        tools: row.tools ?? 0,
        files: row.files ?? 0,
        cost: row.cost ?? 0,
        outcome: row.outcome,
        outcomeDetail: row.outcomeDetail,
        model: row.model,
        provider: row.provider,
        thinking: row.thinking,
    };
}

/**
 * The whole session's rows: the server's list in its order, with each prompt this tab has loaded in the server's
 * place, and prompts newer than that list added after it. Without a list (not fetched, or another session's), the
 * loaded rows are the list.
 */
export function mergePrompts(full, loaded) {
    if (!Array.isArray(full) || full.length === 0) {
        return loaded;
    }

    const mine = new Map(loaded.map((row) => [String(row.id), row]));
    const out = [];
    const seen = new Set();

    for (const row of full) {
        const id = String(row.id);
        const known = mine.get(id);

        seen.add(id);
        out.push(known ?? promptFromServer(row));
    }

    for (const row of loaded) {
        if (!seen.has(String(row.id))) {
            out.push(row);
        }
    }

    return out;
}

/**
 * The session's prompt ids for the arrows: the server's list, and any loaded prompt it does not have yet (a message
 * sent since it was fetched). Compactions are not prompts, and the arrows do not stop at them.
 */
export function promptIds(full, loaded) {
    const out = [];
    const seen = new Set();

    const add = (row) => {
        if (row.divider || row.kind === "compaction" || seen.has(String(row.id))) {
            return;
        }

        seen.add(String(row.id));
        out.push({ id: row.id });
    };

    for (const row of Array.isArray(full) ? full : []) {
        add(row);
    }

    for (const row of loaded) {
        add(row);
    }

    return out;
}

/** Where the transcript's rows start: `transcriptFrom`'s row, or the newest `rowsShown` (as `windowStart` there). */
export function windowStart(rows, from, rowsShown) {
    const at = from === null ? -1 : rows.findIndex((row) => row.id === from);

    return at === -1 ? Math.max(0, rows.length - rowsShown) : at;
}

/**
 * The first prompt the transcript shows: every prompt before it is above "Show earlier messages", so the history
 * fades those rows and puts its Earlier line here. Null when there is no prompt in the window.
 */
export function promptBoundary(rows, start) {
    for (let at = Math.max(0, start); at < rows.length; at++) {
        if (rows[at].kind === "user") {
            return rows[at].id;
        }
    }

    return null;
}
