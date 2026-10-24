/**
 * A conversation's prompts and compactions as small rows for the message history and the arrows over it: no reply text,
 * only what the popup shows. Every row carries who sent it, what Pi did with it, and how the turn ended.
 */
import { splitAttachments } from "./entry-format.ts";
import type { ClientEntry } from "./projection.ts";

/** What was sent along with a prompt, as the history row shows it. */
export type PromptAttachments = {
    image: boolean;
    file: boolean;
    /** "Image attached", "File attached", "Image and file attached", or "No text". */
    label: string;
};

/** One prompt, or one compaction, in the message history: oldest first. */
export type PromptSummary = {
    id: number;
    /** `prompt` for a message someone sent; `compaction` for the line where the context was compacted. */
    kind: "prompt" | "compaction";
    at?: number;
    text: string;
    /** "You", the person's name, or Pi's: what the row shows. */
    author: string;
    /** The asking person wrote this prompt. */
    mine: boolean;
    /** It can go back in this person's message box: theirs, with words in it. */
    pickable: boolean;
    attachments: PromptAttachments;
    /** A compaction line: its summary, and never a prompt. */
    compaction?: { id: number; summary: string };
    /** The compaction's summary, on a compaction row. */
    summary?: string;
    took?: number;
    tools: number;
    files: number;
    cost: number;
    outcome?: "stopped" | "failed" | "cut off";
    outcomeDetail?: string;
    model?: string;
    provider?: string;
    thinking?: string;
    /** Pi is answering this prompt now: the newest prompt, while the session is busy. */
    working: boolean;
};

/** What a turn did after its prompt: its replies' calls, files, cost, model, and how it ended. */
type Turn = {
    id: number;
    tools: number;
    files: Set<string>;
    cost: number;
    replies: number;
    outcome?: PromptSummary["outcome"];
    detail?: string;
    model?: string;
    provider?: string;
    first?: number;
    last?: number;
};

const ATTACHED_IMAGE = /,\s*image\//i;
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|avif|bmp|heic|heif|svg)$/i;
const VIA = /^\[via [^\]\n]{1,300}\] /;
const SCHEDULED = "[scheduled] ";

/** A prompt's words without the app's prefixes, and what was sent with it. */
function textOf(entry: Extract<ClientEntry, { kind: "user" }>): {
    text: string;
    attachments: PromptAttachments;
} {
    const [written, attached = ""] = splitAttachments(entry.text);
    let text = written.trim();

    const via = VIA.exec(text);

    if (via) {
        text = text.slice(via[0].length);
    }

    if (text.startsWith(SCHEDULED)) {
        text = text.slice(SCHEDULED.length);
    }

    const lines = attached.split("\n").filter((line) => line.trim() !== "");
    const image =
        entry.images > 0 ||
        lines.some((line) => ATTACHED_IMAGE.test(line)) ||
        (entry.files?.some((path) => IMAGE_FILE.test(path)) ?? false);
    const file =
        lines.some((line) => !ATTACHED_IMAGE.test(line)) ||
        (entry.files?.some((path) => !IMAGE_FILE.test(path)) ?? false);
    const label =
        image && file
            ? "Image and file attached"
            : image
              ? "Image attached"
              : file
                ? "File attached"
                : "No text";

    return { text, attachments: { image, file, label } };
}

/**
 * Every prompt and compaction in `entries`, oldest first, as the message history shows them: prompts with the turn
 * that followed each, and one row where the context was compacted.
 */
export function promptSummaries(
    entries: readonly ClientEntry[],
    options: {
        /** Entry id → the person's user id, as the conversation's authors document keeps it. */
        authors: Readonly<Record<string, string>>;
        /** A user id's name, or "Someone" for one no longer here. */
        nameOf: (userId: string) => string;
        /** The asking person's user id. */
        me: string;
        /** What Pi is called here when nobody wrote the prompt: "Pi", or "Main agent". */
        from: string;
        /** The newest prompt is being answered now. */
        busy: boolean;
        thinking?: string;
    },
): PromptSummary[] {
    const turns = new Map<number, Turn>();
    let turn: Turn | undefined;

    for (const entry of entries) {
        if (entry.kind === "user") {
            turn = {
                id: entry.id,
                tools: 0,
                files: new Set(),
                cost: 0,
                replies: 0,
                first: entry.at,
            };
            turns.set(entry.id, turn);

            continue;
        }

        if (turn === undefined || entry.kind !== "assistant") {
            continue;
        }

        turn.replies += 1;

        if (entry.at !== undefined) {
            turn.last = entry.at;
        }

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

    const lastUser = entries.findLast((entry) => entry.kind === "user");
    const workingId = options.busy ? lastUser?.id : undefined;

    for (const each of turns.values()) {
        if (each.replies === 0 && each.id !== workingId) {
            each.outcome = "stopped";
        }
    }

    const out: PromptSummary[] = [];

    for (const entry of entries) {
        if (entry.kind === "compaction") {
            out.push({
                id: entry.id,
                kind: "compaction",
                text: entry.summary,
                author: "",
                mine: false,
                pickable: false,
                attachments: { image: false, file: false, label: "No text" },
                compaction: { id: entry.id, summary: entry.summary },
                summary: entry.summary,
                tools: 0,
                files: 0,
                cost: 0,
                working: false,
            });

            continue;
        }

        if (entry.kind !== "user") {
            continue;
        }

        const authorId = options.authors[String(entry.id)];
        const mine = authorId !== undefined && authorId === options.me;
        const named = authorId ? options.nameOf(authorId) : (entry.from ?? options.from);
        const { text, attachments } = textOf(entry);
        const info = turns.get(entry.id);
        const took =
            info?.first !== undefined && info.last !== undefined
                ? info.last - info.first
                : undefined;

        out.push({
            id: entry.id,
            kind: "prompt",
            ...(entry.at === undefined ? {} : { at: entry.at }),
            text,
            author: mine ? "You" : named,
            mine,
            pickable: mine && text !== "",
            attachments,
            ...(took === undefined || took < 0 ? {} : { took }),
            tools: info?.tools ?? 0,
            files: info?.files.size ?? 0,
            cost: info?.cost ?? 0,
            ...(info?.outcome === undefined ? {} : { outcome: info.outcome }),
            ...(info?.detail === undefined ? {} : { outcomeDetail: info.detail }),
            ...(info?.model === undefined ? {} : { model: info.model }),
            ...(info?.provider === undefined ? {} : { provider: info.provider }),
            ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
            working: entry.id === workingId,
        });
    }

    return out;
}
