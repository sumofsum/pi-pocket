// The message history's whole list: each prompt and compaction of a conversation as a small row (who sent it, what came
// with it, how its turn ended), and the route that gives a browser every row without Pi's replies.
import { type App, cleanUp, newSession, openApp, owner, scriptedModel, say } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";
import type { ClientEntry } from "../src/server/projection.ts";
import { promptSummaries } from "../src/server/prompt-summaries.ts";

const options = {
    authors: { "1": "u1" } as Record<string, string>,
    nameOf: (userId: string) => (userId === "u1" ? "Tanner" : "Someone"),
    me: "u1",
    from: "Pi",
    busy: false,
};

test("every prompt and compaction is a row, in order, with its turn", () => {
    const entries = [
        {
            id: 1,
            kind: "user",
            text: "[via linked session 3] first ask",
            images: 0,
            at: 1_000,
        },
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
            at: 1_500,
        },
        { id: 3, kind: "assistant", blocks: [], stopReason: "length", at: 1_800 },
        { id: 4, kind: "compaction", summary: "Earlier messages" },
        {
            id: 5,
            kind: "user",
            text: "second ask\n\nAttached files (saved on the server):\n/tmp/shot.png\nnotes.md\n",
            images: 0,
            files: ["/tmp/shot.png", "notes.md"],
            from: "Sam",
            at: 2_000,
        },
        { id: 6, kind: "user", text: "[scheduled] later ask", images: 0, at: 3_000 },
    ] as ClientEntry[];

    const rows = promptSummaries(entries, options);

    assert.deepEqual(
        rows.map((row) => [row.id, row.kind, row.text]),
        [
            [1, "prompt", "first ask"],
            [4, "compaction", "Earlier messages"],
            [5, "prompt", "second ask"],
            [6, "prompt", "later ask"],
        ],
        "oldest first, prefixes off, and one row where the context was compacted",
    );

    const [first, compaction, second, later] = rows;

    assert.equal(first!.author, "You");
    assert.equal(first!.mine, true);
    assert.equal(first!.pickable, true, "its words go back in the box");
    assert.equal(first!.took, 800, "from the prompt to Pi's last answer");
    assert.equal(first!.tools, 1);
    assert.equal(first!.files, 1);
    assert.equal(first!.cost, 0.02);
    assert.equal(first!.model, "faux-1");
    assert.equal(first!.provider, "faux");
    assert.equal(first!.outcome, "cut off");
    assert.equal(first!.working, false);

    assert.equal(compaction!.compaction?.summary, "Earlier messages");
    assert.equal(compaction!.summary, "Earlier messages");
    assert.equal(compaction!.pickable, false);

    assert.equal(second!.author, "Sam", "no author noted: who the message says");
    assert.equal(second!.mine, false);
    assert.equal(second!.pickable, false);
    assert.deepEqual(second!.attachments, {
        image: true,
        file: true,
        label: "Image and file attached",
    });
    assert.equal(later!.author, "Pi");
    assert.equal(later!.outcome, "stopped", "Pi never answered it");
});

test("the newest prompt works while the session does, and thinking comes with a turn", () => {
    const entries = [
        { id: 1, kind: "user", text: "older", images: 0, at: 1_000 },
        { id: 2, kind: "assistant", blocks: [], stopReason: "stop", at: 1_100 },
        { id: 3, kind: "user", text: "now", images: 0, at: 2_000 },
    ] as ClientEntry[];

    const rows = promptSummaries(entries, { ...options, busy: true, thinking: "high" });

    assert.equal(rows[0]!.working, false);
    assert.equal(rows[0]!.outcome, undefined);
    assert.equal(rows[1]!.working, true);
    assert.equal(rows[1]!.outcome, undefined, "no answer yet is not a stop while Pi works");
    assert.equal(rows[1]!.thinking, "high");
});

test("an attachment alone is not pickable, and its row still says what came with it", () => {
    const entries = [
        {
            id: 1,
            kind: "user",
            text: "Attached files (saved on the server):\nreport.pdf\n",
            images: 0,
            at: 1_000,
        },
    ] as ClientEntry[];

    const [row] = promptSummaries(entries, options);

    assert.equal(row!.pickable, false, "nothing to put in the box");
    assert.equal(row!.attachments.label, "File attached");
});

let app: App;
let server: Server;
let port = 0;
let id: ConversationId;
let other: ConversationId;

before(async () => {
    app = await openApp(scriptedModel());
    id = await newSession(app);
    other = await newSession(app);

    for (const text of ["first", "second", "third"]) {
        await say(app, id, text);
    }

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

type Answer = { prompts: Record<string, unknown>[] };

const call = (token: string | undefined, session = id) =>
    fetch(`http://127.0.0.1:${port}/api/c/${session}/prompt-history`, {
        ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
    });

test("a browser gets every prompt as a summary, in order, as its own person", async () => {
    const response = await call(app.config.ownerToken);

    assert.equal(response.status, 200);
    const { prompts } = (await response.json()) as Answer;

    assert.deepEqual(
        prompts.map((row) => row.text),
        ["first", "second", "third"],
    );
    assert.deepEqual(
        prompts.map((row) => row.author),
        ["You", "You", "You"],
    );
    assert.ok(prompts.every((row) => row.mine === true));
    assert.ok(prompts.every((row) => row.kind === "prompt"));
    assert.ok(prompts.every((row) => row.working === false));
    assert.ok(prompts.every((row) => typeof row.id === "number" && typeof row.at === "number"));
    assert.ok(prompts.every((row) => typeof row.took === "number" && row.took >= 0));
    // The rows are summaries: no reply text comes with them.
    assert.ok(prompts.every((row) => row.blocks === undefined));
});

test("someone shared the session sees its prompts, never as theirs", async () => {
    const guest = app.config.addUser("Sam", "guest", [String(id)]);

    try {
        const response = await call(guest.token);

        assert.equal(response.status, 200);
        const { prompts } = (await response.json()) as Answer;

        assert.equal(prompts.length, 3);
        assert.deepEqual(
            prompts.map((row) => row.author),
            [owner(app).name, owner(app).name, owner(app).name],
        );
        assert.ok(prompts.every((row) => row.mine === false));
        assert.ok(prompts.every((row) => row.pickable === false));
        assert.equal((await call(guest.token, other)).status, 404, "not a session of theirs");
        assert.equal((await call(undefined)).status, 401, "signed out");
    } finally {
        app.config.removeUser(guest.user.id);
    }
});
