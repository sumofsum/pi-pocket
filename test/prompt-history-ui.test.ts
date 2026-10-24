// The message history in a real Chromium: every prompt of the session, the older ones faded above the transcript's
// window, the Earlier line, a filter across all of them, a jump to one this tab has not loaded, and Back.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
/** More prompts than the transcript window (60 rows) and the newest rows a session opens with (80) show. */
const PROMPTS = 45;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const open = () =>
    inPage<boolean>(
        `return JSON.stringify(document.querySelector(".message-history:not([hidden])") !== null)`,
    );
const rowCount = () =>
    inPage<number>(
        `return JSON.stringify(document.querySelectorAll(".message-history-item").length)`,
    );
const earlierCount = () =>
    inPage<number>(
        `return JSON.stringify(document.querySelectorAll(".message-history-item.earlier").length)`,
    );
const countText = () =>
    inPage<string>(
        `return JSON.stringify(document.querySelector(".message-history-count").innerText)`,
    );

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    session = await newSession(app);

    for (let index = 1; index <= PROMPTS; index++) {
        await say(app, session, `message ${index}`);
    }

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "prompt-history-ui-")),
        load: async () => undefined,
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "the popup lists every prompt, fades the earlier ones, and filters across all",
    real,
    async () => {
        await page.navigate(`${base}/s/${Number(session)}`);
        await until(
            () =>
                inPage<boolean>(`
                const { store } = await import("/store.js");

                return JSON.stringify(
                    store.state.promptList?.conversationId === ${Number(session)} &&
                        store.state.promptList.prompts.length === ${PROMPTS} &&
                        document.querySelector(".nav-count") !== null,
                );
            `),
            "the whole prompt list",
        );
        await page.click({ selector: ".nav-count" });
        await until(open, "the history popup");

        assert.equal(await rowCount(), PROMPTS, "every prompt of the session, loaded or not");
        assert.equal(await countText(), String(PROMPTS));

        const earlier = await earlierCount();

        assert.ok(earlier > 0, "prompts above the transcript's window");
        assert.equal(earlier + 30, PROMPTS, "the window shows the newest 60 rows: 30 prompts");
        assert.deepEqual(
            await inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".message-history-item.earlier")].map((row) => row.dataset.messageId))`,
            ),
            await inPage<string[]>(`
            const { store } = await import("/store.js");
            const prompts = store.state.promptList.prompts.filter((row) => row.kind === "prompt");

            return JSON.stringify(prompts.slice(0, ${earlier}).map((row) => String(row.id)));
        `),
            "the faded rows are the session's oldest prompts",
        );
        assert.deepEqual(
            await inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".message-history-item.earlier .message-history-words")].map((row) => row.textContent.trim()))`,
            ),
            Array.from({ length: earlier }, (_, index) => `message ${index + 1}`),
        );

        // The Earlier line sits between the faded rows and the row the transcript shows first.
        const order = await inPage<string[]>(`
        const rows = [...document.querySelectorAll(".message-history-list > *")];

        return JSON.stringify(
            rows.map((row) => (row.classList.contains("message-history-earlier") ? "earlier" : row.dataset.messageId)),
        );
    `);
        const boundary = order.indexOf("earlier");

        assert.equal(boundary, earlier, "after every faded prompt and before the loaded ones");
        assert.equal(
            await inPage<boolean>(`
            const rows = [...document.querySelectorAll(".transcript .user-row")];

            return JSON.stringify(rows[0]?.id === "entry-" + ${JSON.stringify(order[boundary + 1])});
        `),
            true,
            "the transcript's first prompt is the one below the Earlier line",
        );

        // Filtering searches every prompt, faded ones too, and puts the lines aside for the matches.
        await page.click({ selector: ".message-history-filter-button" });
        await page.type({ selector: ".message-history-filter" }, "message 1");
        await until(async () => (await countText()) === `11 of ${PROMPTS}`, "11 matches of 45");

        assert.equal(
            await inPage<number>(
                `return JSON.stringify(document.querySelectorAll(".message-history-earlier").length)`,
            ),
            0,
            "the Earlier line steps aside while filtering",
        );
        assert.equal(await rowCount(), 11);
        const firstPromptId = await inPage<string>(`
        const { store } = await import("/store.js");

        return JSON.stringify(String(store.state.promptList.prompts.find((row) => row.kind === "prompt").id));
    `);

        assert.ok(
            await inPage<boolean>(
                `return JSON.stringify([...document.querySelectorAll(".message-history-item")].some((row) => row.dataset.messageId === ${JSON.stringify(firstPromptId)}))`,
            ),
            "a prompt this tab never loaded is found too",
        );

        await page.press("Escape");
        await until(
            async () => (await countText()) === String(PROMPTS) && (await earlierCount()) > 0,
            "the whole list again",
        );
        await page.press("Escape");
        await until(async () => !(await open()), "the popup closed");
    },
);

test("a jump to a prompt this tab has not loaded shows it, and Back returns", real, async () => {
    await page.navigate(`${base}/s/${Number(session)}`);
    await until(
        () =>
            inPage<boolean>(`
                const { store } = await import("/store.js");

                return JSON.stringify(
                    store.state.promptList?.prompts.length === ${PROMPTS} &&
                        document.querySelector(".nav-count") !== null,
                );
            `),
        "the whole prompt list",
    );
    await page.click({ selector: ".nav-count" });
    await until(open, "the history popup");

    const first = await inPage<number>(
        `return JSON.stringify(Number(document.querySelector(".message-history-item").dataset.messageId))`,
    );
    const before = await inPage<number>(
        `return JSON.stringify(document.querySelector(".scroller").scrollTop)`,
    );

    await page.click({ selector: ".message-history-item .message-history-pick" });
    await until(
        () =>
            inPage<boolean>(`
                const { store } = await import("/store.js");

                return JSON.stringify(
                    document.getElementById("entry-${first}") !== null &&
                        store.state.view.entries.has(${first}) &&
                        document.querySelector(".nav-count span")?.textContent === "1/${PROMPTS}",
                );
            `),
        "the first prompt shown and counted",
    );

    const near = await inPage<boolean>(`
        const pane = document.querySelector(".scroller").getBoundingClientRect();
        const row = document.getElementById("entry-${first}").getBoundingClientRect();

        return JSON.stringify(row.top - pane.top < 120);
    `);

    assert.equal(near, true, "the jump puts it at the top of the conversation");

    await until(
        () =>
            inPage<boolean>(
                `return JSON.stringify(document.querySelector(".message-history-back") !== null)`,
            ),
        "Back",
    );
    await page.click({ selector: ".message-history-back" });
    await until(
        () =>
            inPage<boolean>(`
                return JSON.stringify(
                    document.querySelector(".nav-count span")?.textContent === "${PROMPTS}/${PROMPTS}",
                );
            `),
        "back at the newest prompt",
    );

    const after = await inPage<number>(
        `return JSON.stringify(document.querySelector(".scroller").scrollTop)`,
    );

    assert.ok(Math.abs(after - before) < 60, "the place before the jump is back");

    // The window is back too: the transcript's first prompt is the one below the Earlier line again.
    const boundary = await inPage<string>(`
        const { store } = await import("/store.js");
        const rows = store.state.view.order
            .slice((() => {
                let at = store.state.view.order.length;
                while (at > 0 && store.state.view.entries.has(store.state.view.order[at - 1])) at--;
                return at;
            })())
            .map((id) => store.state.view.entries.get(id))
            .filter((entry) => entry && entry.kind !== "toolResult");
        const from = store.state.transcriptFrom;
        const start = from === null ? Math.max(0, rows.length - 60) : rows.findIndex((row) => row.id === from);
        const shown = rows.slice(start < 0 ? Math.max(0, rows.length - 60) : start);
        const prompt = shown.find((row) => row.kind === "user");

        return JSON.stringify(prompt === undefined ? "" : prompt.id);
    `);

    assert.ok(boundary !== "", "a prompt shows below the Earlier line");
    assert.equal(
        await inPage<boolean>(`
            const rows = [...document.querySelectorAll(".transcript .user-row")];

            return JSON.stringify(rows[0]?.id === "entry-" + ${JSON.stringify(boundary)});
        `),
        true,
    );

    // Paste: the last prompt's button puts its words back in the box and closes the list.
    await page.click({
        selector: ".message-history-item:last-child .message-history-jump",
    });
    await until(
        () =>
            inPage<boolean>(
                `return JSON.stringify(document.querySelector(".composer textarea")?.value === "message ${PROMPTS}")`,
            ),
        "the prompt back in the box",
    );
});

test("switching from a short session to a long one shows every prompt", real, async () => {
    const short = await newSession(app);

    await say(app, short, "short one");
    await say(app, short, "short two");

    await page.navigate(`${base}/s/${Number(short)}`);
    await until(
        () =>
            inPage<boolean>(`
                const { store } = await import("/store.js");

                return JSON.stringify(
                    store.state.promptList?.conversationId === ${Number(short)} &&
                        store.state.promptList.prompts.length === 2,
                );
            `),
        "the short session's prompts",
    );

    await page.navigate(`${base}/s/${Number(session)}`);
    await until(
        () =>
            inPage<boolean>(`
                const { store } = await import("/store.js");

                return JSON.stringify(
                    store.state.promptList?.conversationId === ${Number(session)} &&
                        store.state.promptList.prompts.filter((row) => row.kind === "prompt").length === ${PROMPTS} &&
                        document.querySelector(".nav-count") !== null,
                );
            `),
        "the long session's whole prompt list",
    );

    await page.click({ selector: ".nav-count" });
    await until(open, "the long session's history");
    assert.equal(await rowCount(), PROMPTS, "every prompt appears after the switch");
    assert.equal(await countText(), String(PROMPTS));
    assert.ok((await earlierCount()) > 0, "the earlier rows appear after the switch");
});
