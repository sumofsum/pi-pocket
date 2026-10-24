// The history's list on the browser's side, without a DOM: the prompts a tab has loaded, the server's summary of the
// whole session merged with them, and where the transcript's "Show earlier messages" line falls.
import assert from "node:assert/strict";
import { test } from "node:test";

type Row = {
    id: number;
    kind?: string;
    divider?: boolean;
    text?: string;
    author?: string;
    mine?: boolean;
    pickable?: boolean;
    attachments?: { image: boolean; file: boolean; label: string };
    attachmentsLabel?: string;
    image?: boolean;
    file?: boolean;
    took?: number;
    working?: boolean;
    tools?: number;
    files?: number;
    cost?: number;
    outcome?: string;
    model?: string;
    provider?: string;
    thinking?: string;
    summary?: string;
    compaction?: { id: number; summary: string };
};

type View = {
    order: number[];
    entries: Map<number, Record<string, unknown>>;
    authors: Record<string, string>;
    live: { busy: boolean };
    agent?: { reasoning: boolean; thinkingLevel: string };
    conversation?: { kind: string };
};

const list = (await import(new URL("../web/prompt-list.js", import.meta.url).href)) as {
    loadedPrompts(
        view: View,
        options: { meId: string; users: { id: string; name: string }[]; kind?: string },
    ): Row[];
    promptFromServer(row: Record<string, unknown>): Row;
    mergePrompts(full: Row[] | null | undefined, loaded: Row[]): Row[];
    promptIds(full: Row[] | null | undefined, loaded: Row[]): { id: number }[];
    windowStart(rows: { id: number }[], from: number | null, rowsShown: number): number;
    promptBoundary(rows: { id: number; kind?: string }[], start: number): number | null;
};

const users = [{ id: "u1", name: "Tanner" }];
const meId = "u1";
const view = (): View => ({
    order: [1, 2, 3, 4],
    entries: new Map<number, Record<string, unknown>>([
        [1, { id: 1, kind: "user", text: "first ask", images: 0, at: 1_000 }],
        [
            2,
            {
                id: 2,
                kind: "assistant",
                blocks: [
                    { type: "text", text: "looking" },
                    { type: "toolCall", id: "a", name: "read", args: { path: "a.ts" } },
                ],
                model: "faux-1",
                provider: "faux",
                cost: 0.02,
                at: 1_400,
            },
        ],
        [3, { id: 3, kind: "compaction", summary: "Earlier messages" }],
        [4, { id: 4, kind: "user", text: "now", images: 0, at: 2_000 }],
    ]),
    authors: { "1": "u1" },
    live: { busy: true },
    agent: { reasoning: true, thinkingLevel: "high" },
    conversation: { kind: "session" },
});

test("loaded rows carry the turn, the author, and the compaction divider", () => {
    const rows = list.loadedPrompts(view(), { meId, users, kind: "session" });

    assert.deepEqual(
        rows.map((row) => row.id),
        [1, 3, 4],
    );
    assert.equal(rows[0]!.author, "You");
    assert.equal(rows[0]!.mine, true);
    assert.equal(rows[0]!.pickable, true);
    assert.equal(rows[0]!.took, 400);
    assert.equal(rows[0]!.tools, 1);
    assert.equal(rows[0]!.files, 1);
    assert.equal(rows[0]!.cost, 0.02);
    assert.equal(rows[0]!.model, "faux-1");
    assert.equal(rows[0]!.thinking, "high");
    assert.equal(rows[1]!.divider, true);
    assert.equal(rows[1]!.summary, "Earlier messages");
    assert.equal(rows[2]!.working, true);
});

test("the server's whole list keeps its order, loaded rows replace their own, and new ones follow", () => {
    const loaded = list.loadedPrompts(view(), { meId, users, kind: "session" });
    const full: Row[] = [
        {
            id: 1,
            kind: "prompt",
            text: "first ask",
            author: "Someone",
            mine: false,
            pickable: false,
            attachments: { image: false, file: false, label: "No text" },
            took: 9_999,
            tools: 4,
            files: 2,
            cost: 0.5,
            working: false,
        },
        {
            id: 3,
            kind: "compaction",
            text: "Earlier messages",
            summary: "Earlier messages",
            compaction: { id: 3, summary: "Earlier messages" },
            attachments: { image: false, file: false, label: "No text" },
        },
        {
            id: 4,
            kind: "prompt",
            text: "now",
            author: "Someone",
            mine: false,
            pickable: false,
            attachments: { image: false, file: false, label: "No text" },
            working: false,
        },
        {
            id: 5,
            kind: "prompt",
            text: "an older one this tab never loaded",
            author: "Sam",
            mine: false,
            pickable: false,
            attachments: { image: true, file: false, label: "Image attached" },
            took: 700,
            tools: 1,
            files: 0,
            cost: 0,
            working: false,
        },
    ];

    const rows = list.mergePrompts(full, loaded);

    assert.deepEqual(
        rows.map((row) => row.id),
        [1, 3, 4, 5],
        "the server's order, and a prompt this tab has already sent after the list it fetched",
    );
    assert.equal(rows[0]!.took, 400, "the loaded turn is fresher than the server's");
    assert.equal(rows[0]!.author, "You");
    assert.equal(rows[0]!.working, false, "the first prompt is not the working one");
    assert.equal(rows[2]!.working, true, "the loaded row still says Pi works on it");
    assert.equal(rows[3]!.attachmentsLabel, "Image attached");
    assert.equal(rows[3]!.image, true, "a server row reads as the history draws it");

    assert.deepEqual(
        list.mergePrompts(null, loaded),
        loaded,
        "without the server's list the loaded rows are the list",
    );
});

test("the arrows step through every prompt, not the compactions, and include a new one", () => {
    const full: Row[] = [
        { id: 1, kind: "prompt" },
        { id: 3, kind: "compaction" },
        { id: 4, kind: "prompt" },
    ];
    const loaded = [{ id: 4 }, { id: 9 }];

    assert.deepEqual(list.promptIds(full, loaded), [{ id: 1 }, { id: 4 }, { id: 9 }]);

    // A stale list holds prompts a compaction removed from the context: the loaded rows still add the newest.
    assert.deepEqual(list.promptIds(null, loaded), [{ id: 4 }, { id: 9 }]);
});

test("the Earlier line falls on the first prompt the transcript shows", () => {
    const rows = [
        { id: 1, kind: "assistant" },
        { id: 2, kind: "user" },
        { id: 3, kind: "assistant" },
        { id: 4, kind: "compaction" },
        { id: 5, kind: "user" },
    ];

    assert.equal(list.windowStart(rows, null, 3), 2, "the newest rows when nothing is pinned");
    assert.equal(list.windowStart(rows, 2, 3), 1, "the row named");
    assert.equal(list.windowStart(rows, 99, 3), 2, "a row that is gone is the newest");
    assert.equal(list.promptBoundary(rows, 0), 2, "the first prompt of the window");
    assert.equal(list.promptBoundary(rows, 3), 5);
    assert.equal(
        list.promptBoundary([{ id: 1, kind: "assistant" }], 0),
        null,
        "no prompt in the window",
    );
});
