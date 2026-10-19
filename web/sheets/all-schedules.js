// Every scheduled message, across the sessions you can see: what is coming, where, and how to cancel one.
import { useEffect, useState } from "preact/hooks";
import { folderColor } from "../avatar.js";
import { actions, attempt, canSteer, closeSheet, navigate, notify, store } from "../store.js";
import { formatWhen, html, Loader, Sheet } from "../ui.js";

/** How often the page asks again while it is open. */
const REFRESH_MS = 10_000;
const filters = [
    ["all", "All"],
    ["repeats", "Repeats"],
    ["one-off", "One-off"],
];

/** Scheduled messages in every session: filter them, group them by session or order them by time, and cancel one. */
export function AllSchedulesSheet() {
    const { users, me, sessions } = store.state;
    const [filter, setFilter] = useState("all");
    const [grouped, setGrouped] = useState(true);
    const [all, setAll] = useState(null);
    const [revision, setRevision] = useState(0);
    const [when, setWhen] = useState("");
    const [chosen, setChosen] = useState(null);
    const steer = canSteer();
    const here = store.state.conversationId;
    const target = chosen ?? (sessions.some((each) => each.id === here) ? here : sessions[0]?.id);

    useEffect(() => {
        let open = true;
        const load = () =>
            actions.schedules().then(
                (list) => open && setAll(list),
                (error) => open && notify("error", error.message),
            );

        load();
        const timer = setInterval(load, REFRESH_MS);

        return () => {
            open = false;
            clearInterval(timer);
        };
    }, [revision]);

    const setBy = (id) =>
        id === undefined
            ? "Pi"
            : id === me?.id
              ? "you"
              : (users.find((user) => user.id === id)?.name ?? "someone");
    const cwdOf = (id) => sessions.find((entry) => entry.id === id)?.cwd;
    const add = () =>
        attempt(async () => {
            await actions.schedule(when, target);
            setWhen("");
            setRevision((each) => each + 1);
        });
    const cancel = (schedule) =>
        attempt(async () => {
            await actions.cancelSchedule(schedule.id, schedule.conversationId);
            setRevision((each) => each + 1);
        });

    const go = (id) => {
        closeSheet();
        navigate(id);
    };

    const shown = (all ?? []).filter((schedule) =>
        filter === "repeats"
            ? schedule.every !== undefined
            : filter === "one-off"
              ? schedule.every === undefined
              : true,
    );
    // By time, the list is already soonest first. By session, the sessions come in the order their soonest message
    // does, and each session's messages keep the time order.
    const groups = [];

    if (grouped) {
        const bySession = new Map();

        for (const schedule of shown) {
            let group = bySession.get(schedule.conversationId);

            if (group === undefined) {
                group = {
                    id: schedule.conversationId,
                    title: schedule.title,
                    items: [],
                };
                bySession.set(schedule.conversationId, group);
                groups.push(group);
            }

            group.items.push(schedule);
        }
    } else {
        groups.push({ id: "all", title: null, items: shown });
    }

    const whenLine = (schedule) =>
        schedule.repeat === undefined
            ? formatWhen(schedule.next)
            : `${schedule.repeat} · next ${formatWhen(schedule.next)}`;
    const row = (schedule) =>
        html`<div class="schedule" key=${`${schedule.conversationId}:${schedule.id}`}>
            <div class="grow">
                <div class="schedule-text">${schedule.text}</div>
                <div class="schedule-meta">
                    <span class="muted small">
                        ${whenLine(schedule)} · set by ${setBy(schedule.by)}
                    </span>
                    <div class="schedule-tags">
                        <button
                            class="chip schedule-session"
                            title=${schedule.title}
                            onClick=${() => go(schedule.conversationId)}
                        >
                            <span
                                class="folder-mark"
                                style=${`--folder:${folderColor(cwdOf(schedule.conversationId))}`}
                                aria-hidden="true"
                            ></span>
                            <span class="schedule-session-name">${schedule.title}</span>
                        </button>
                        ${
                            steer &&
                            html`<button
                                class="button small ghost"
                                onClick=${() => cancel(schedule)}
                            >
                                Cancel
                            </button>`
                        }
                    </div>
                </div>
            </div>
        </div>`;

    return html`<${Sheet} title="All scheduled messages" onClose=${closeSheet} wide=${true}>
        <p class="muted small">
            Every scheduled message in the sessions you can see. Tap its session to go there.
        </p>
        ${
            steer &&
            sessions.length > 0 &&
            html`<div class="schedules-create">
                <select
                    aria-label="Session"
                    value=${target}
                    onChange=${(event) => setChosen(Number(event.currentTarget.value))}
                >
                    ${sessions.map(
                        (session) => html`<option value=${session.id}>
                            ${session.title ?? "New session"}
                        </option>`,
                    )}
                </select>
                <div class="row">
                    <input
                        placeholder="in 2h check the deploy"
                        value=${when}
                        onInput=${(event) => setWhen(event.currentTarget.value)}
                        onKeyDown=${(event) => event.key === "Enter" && add()}
                    />
                    <button
                        class="button primary"
                        disabled=${when.trim() === "" || target === undefined}
                        onClick=${add}
                    >
                        Add
                    </button>
                </div>
                <p class="muted small">
                    Start with when: in 30m, 7:00, tomorrow 9am, fri 17:30, every 2h, every weekday 8:00. Then what Pi gets.
                </p>
            </div>`
        }
        <div class="schedules-controls">
            ${filters.map(
                ([value, label]) => html`<button
                    class=${`chip toggle ${filter === value ? "on" : ""}`}
                    aria-pressed=${filter === value}
                    onClick=${() => setFilter(value)}
                >
                    ${label}
                </button>`,
            )}
            <div class="segmented schedules-view" role="group" aria-label="Order">
                <button
                    class=${grouped ? "" : "on"}
                    aria-pressed=${!grouped}
                    onClick=${() => setGrouped(false)}
                >
                    Sort by time
                </button>
                <button
                    class=${grouped ? "on" : ""}
                    aria-pressed=${grouped}
                    onClick=${() => setGrouped(true)}
                >
                    Group by session
                </button>
            </div>
        </div>
        ${all === null && html`<${Loader} label="Looking for scheduled messages" />`}
        ${all !== null && all.length === 0 && html`<p class="muted">No scheduled messages in any session.</p>`}
        ${
            all !== null &&
            all.length > 0 &&
            shown.length === 0 &&
            html`<p class="muted">Nothing matches this filter.</p>`
        }
        ${
            shown.length > 0 &&
            html`<div class="sheet-list">
                ${groups.map((group) => [
                    group.title !== null &&
                        html`<div class="schedule-group" key=${`group:${group.id}`}>
                            <span
                                class="folder-mark"
                                style=${`--folder:${folderColor(cwdOf(group.id))}`}
                                aria-hidden="true"
                            ></span>
                            <span class="grow">${group.title}</span>
                            <span class="muted small">${group.items.length}</span>
                        </div>`,
                    group.items.map(row),
                ])}
            </div>`
        }
    <//>`;
}
