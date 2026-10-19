// The Git status panel: every folder the sessions on screen work in, grouped by folder. Each row says its branch and
// newest commit, and what is uncommitted; opening one shows the last three commits and the changed files. A Commit
// button starts a new session in that folder and asks Pi to commit the changes. Alt+G, the rail's git mark, or Esc.
import { useEffect, useRef, useState } from "preact/hooks";
import { folderColor } from "./avatar.js";
import { useBack } from "./back.js";
import { api, canSteer, navigate, notify, scoped, store, uid } from "./store.js";
import { html, Icon, Loader, railState, shortPath, timeAgo } from "./ui.js";

const OPEN_KEY = "pocket.gitOpenFolders";
const REFRESH_MS = 20_000;
const COMMIT_PROMPT =
    "Commit the uncommitted changes in this folder: review the diff, write a clear commit message, and commit them. Do not push.";

/** A changed file's kind as the letter the app uses for it. */
const KIND_LETTERS = { modified: "M", added: "A", deleted: "D", renamed: "R", new: "N" };

function readOpen() {
    try {
        const saved = JSON.parse(sessionStorage.getItem(OPEN_KEY) ?? "[]");

        return new Set(
            Array.isArray(saved) ? saved.filter((each) => typeof each === "string") : [],
        );
    } catch {
        return new Set();
    }
}

function saveOpen(open) {
    sessionStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
}

/** Show or hide the Git status panel. Opening it puts the subagents board and an extension's page away. */
export function setGitOpen(open) {
    store.set({
        gitOpen: open,
        ...(open ? { board: false, boardAgents: null, page: null, drawer: false } : {}),
    });
}

export function toggleGit() {
    setGitOpen(!store.state.gitOpen);
}

export const closeGit = () => setGitOpen(false);

/** The rail's git mark, with how many folders have something uncommitted once the panel has looked. */
export function GitRailButton() {
    const { gitOpen, gitStatus } = store.state;
    const changed = gitStatus?.folders.filter((folder) => folder.state === "changed").length ?? 0;

    return html`<button
        class=${`rail-button rail-git ${gitOpen ? "open" : ""}`}
        data-part="rail-button"
        data-state=${railState(gitOpen)}
        title="Git status in every session (Alt+G)"
        aria-label=${changed > 0 ? `Git status, ${changed} folders with changes` : "Git status"}
        aria-pressed=${gitOpen}
        onClick=${toggleGit}
    >
        <${Icon} name="git" size=${19} />
        ${changed > 0 && html`<span class="rail-count">${changed}</span>`}
    </button>`;
}

/** A folder's branch as the row says it. */
const branchOf = (repo) =>
    repo.branch ?? (repo.detached ? "detached" : repo.head === undefined ? "no commits" : "HEAD");

/** The branch's distance from its remote branch, when it has one. */
function Ahead({ upstream }) {
    if (
        upstream === undefined ||
        (upstream.ahead === 0 && upstream.behind === 0 && !upstream.gone)
    ) {
        return null;
    }

    return html`<span class="git-ahead" title=${`${upstream.name}${upstream.gone ? " is gone" : ""}`}>
        ${upstream.ahead > 0 && `↑${upstream.ahead}`}
        ${upstream.behind > 0 && `↓${upstream.behind}`}
        ${upstream.gone && html`<span class="git-gone">gone</span>`}
    </span>`;
}

/** What the row says about uncommitted changes, or that there are none. */
function Delta({ repo }) {
    if (repo === undefined) {
        return null;
    }

    if (repo.changes.files === 0) {
        return html`<span class="git-delta clean">
            <${Icon} name="check" size=${12} />
            <span>Clean</span>
        </span>`;
    }

    return html`<span class="git-delta">
        ${repo.changes.added > 0 && html`<span class="add">+${repo.changes.added}</span>`}
        ${repo.changes.removed > 0 && html`<span class="del">−${repo.changes.removed}</span>`}
        <span class="git-files">${repo.changes.files} ${repo.changes.files === 1 ? "file" : "files"}</span>
    </span>`;
}

/** One commit, in the expanded folder: its hash, what it says, and when. */
function CommitRow({ commit }) {
    return html`<div class="git-commit">
        <span class="git-hash">${commit.hash}</span>
        <span class="git-subject">${commit.subject}</span>
        <span class="git-when">${timeAgo(commit.at)}</span>
    </div>`;
}

/** One changed file, in the expanded folder. */
function FileRow({ file }) {
    return html`<div class="git-file">
        <span class=${`git-kind ${file.kind}`}>${KIND_LETTERS[file.kind] ?? "M"}</span>
        <span class="git-pathname" title=${file.path}>${file.path}</span>
        ${file.added !== undefined && html`<span class="git-num add">+${file.added}</span>`}
        ${file.removed !== undefined && html`<span class="git-num del">−${file.removed}</span>`}
    </div>`;
}

/** The folder a Commit press is starting a session for, so a fast second press makes no second session. */
let committing = null;

/** Start a session in the folder and ask Pi to commit what is uncommitted there. */
async function startCommit(folder, setSpawning) {
    if (setSpawning === undefined || committing !== null || !canSteer() || scoped()) {
        return;
    }

    committing = folder.cwd;
    setSpawning(folder.cwd);

    try {
        let created;

        try {
            created = await api("sessions", {
                cwd: folder.cwd,
                title: `Commit ${folder.name}`,
            });
        } catch (error) {
            notify("error", `Could not start a session in ${folder.name}: ${error.message}`);

            return;
        }

        try {
            await api(`c/${created.id}/submit`, {
                text: COMMIT_PROMPT,
                mode: "steer",
                requestId: uid(),
            });
            notify("info", `Started a session in ${folder.name} to commit its changes.`);
        } catch (error) {
            notify("error", `The session started, but Pi was not asked: ${error.message}`);
        }

        setGitOpen(false);
        navigate(created.id);
    } finally {
        committing = null;
        setSpawning(null);
    }
}

/** A folder's row and, while it is open, its commits and changed files. */
function Folder({ folder, open, onToggle, spawning, setSpawning }) {
    const repo = folder.repo;
    const changed = folder.state === "changed";
    const branch = repo ? branchOf(repo) : "";
    const path = shortPath(folder.cwd, store.state.server?.home);
    const canCommit = changed && canSteer() && !scoped();

    const start = (event) => {
        event.stopPropagation();
        startCommit(folder, setSpawning);
    };

    return html`<article class=${`git-folder ${folder.state} ${open ? "open" : ""}`}>
        <div
            class="git-folder-head"
            role="button"
            tabindex="0"
            aria-expanded=${open}
            onClick=${() => onToggle(folder.cwd)}
            onKeyDown=${(event) => {
                if (event.target.closest("button")) {
                    return;
                }

                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onToggle(folder.cwd);
                }
            }}
        >
            <span class="git-chev"><${Icon} name="chevron" size=${12} /></span>
            <span
                class="git-folder-mark"
                style=${`--folder:${folderColor(folder.cwd)}`}
                aria-hidden="true"
            ></span>
            <span class="git-folder-name">
                <strong>${folder.name}</strong>
                <span class="git-folder-path" title=${folder.cwd}>${path}</span>
            </span>
            <span class="git-badge">${folder.sessions} ${folder.sessions === 1 ? "session" : "sessions"}</span>
            ${folder.worktree && html`<span class="git-badge worktree">worktree</span>`}
            <div class="git-line">
                ${
                    repo
                        ? html`<span class=${`git-branch ${repo.branch ? "" : "plain"}`}>${branch}</span>
                          <span class="git-hash">${repo.head?.hash ?? "—"}</span>
                          <span class="git-message" title=${repo.head?.subject ?? ""}>
                              ${repo.head?.subject ?? "No commits yet"}
                          </span>
                          <${Ahead} upstream=${repo.upstream} />`
                        : html`<span class="git-message">
                          ${folder.state === "none" ? "Not a Git repository" : "Could not read this folder"}
                      </span>`
                }
                ${
                    canCommit &&
                    html`<button
                    class=${`git-commit-button ${spawning === folder.cwd ? "starting" : ""}`}
                    title="Start a session in this folder and ask Pi to commit its changes"
                    disabled=${spawning === folder.cwd}
                    onClick=${start}
                >
                    <${Icon} name=${spawning === folder.cwd ? "reload" : "commit"} size=${13} />
                    <span>${spawning === folder.cwd ? "Starting…" : "Commit"}</span>
                </button>`
                }
            </div>
            ${
                repo
                    ? html`<${Delta} repo=${repo} />`
                    : html`<span class="git-delta ${folder.state}">
                      ${folder.state === "none" ? "No repo" : "Error"}
                  </span>`
            }
        </div>
        ${
            open &&
            html`<div class="git-folder-body">
            ${
                repo
                    ? html`<div class="git-section">
                          <div class="git-section-label">Last 3 commits</div>
                          <div class="git-commits">
                              ${
                                  repo.commits.length === 0
                                      ? html`<div class="git-none">No commits yet</div>`
                                      : repo.commits.map(
                                            (commit) =>
                                                html`<${CommitRow} key=${commit.hash} commit=${commit} />`,
                                        )
                              }
                          </div>
                      </div>
                      <div class="git-section git-changes">
                          <div class="git-section-label">
                              Working tree
                              <span class="git-count">
                                  ${repo.changes.files} ${repo.changes.files === 1 ? "file" : "files"}
                              </span>
                          </div>
                          ${
                              repo.changes.files === 0
                                  ? html`<div class="git-none">Nothing uncommitted</div>`
                                  : html`<div class="git-files-list">
                                    ${repo.changes.list.map((file) => html`<${FileRow} key=${file.path} file=${file} />`)}
                                    ${
                                        repo.changes.more > 0 &&
                                        html`<div class="git-none">${repo.changes.more} more files</div>`
                                    }
                                </div>`
                          }
                      </div>`
                    : html`<div class="git-section">
                          <div class="git-section-label">Why</div>
                          <div class="git-none">
                              ${
                                  folder.state === "none"
                                      ? "No session here is in a Git repository yet."
                                      : (folder.error ?? "Git could not read this folder.")
                              }
                          </div>
                      </div>`
            }
        </div>`
        }
    </article>`;
}

/** The Git status panel, in the conversation's place. */
export function GitPanel() {
    const { gitStatus } = store.state;
    const [open, setOpen] = useState(readOpen);
    const [filter, setFilter] = useState("all");
    const [loading, setLoading] = useState(gitStatus === null);
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState(null);
    const [spawning, setSpawning] = useState(null);
    const abort = useRef(null);
    const loadRef = useRef(null);

    useBack(true, closeGit);

    loadRef.current = async (refresh, quiet = false) => {
        abort.current?.abort();

        const controller = new AbortController();

        abort.current = controller;

        if (!quiet) {
            setChecking(true);
        }

        try {
            const data = await api(`git/status${refresh ? "?refresh=1" : ""}`, undefined, {
                signal: controller.signal,
            });

            store.set({ gitStatus: data });
            setError(null);
        } catch (failure) {
            if (failure?.name !== "AbortError") {
                // A page loaded before the server route was added says why nothing came back.
                setError(
                    failure.status === 404
                        ? "The server needs a restart to add Git status."
                        : failure.message,
                );
            }
        } finally {
            if (!controller.signal.aborted) {
                setLoading(false);
                setChecking(false);
            }
        }
    };

    useEffect(() => {
        const onKey = (event) => {
            if (event.key !== "Escape" || event.defaultPrevented) {
                return;
            }

            // A sheet or the launcher over the panel takes its own Esc first.
            if (store.state.sheet || store.state.launcher) {
                return;
            }

            event.preventDefault();
            closeGit();
        };

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, []);

    useEffect(() => {
        // A status kept from the last time the panel was open shows at once; a look now checks it.
        void loadRef.current(false, gitStatus !== null);

        const timer = setInterval(() => {
            if (document.visibilityState === "visible") {
                void loadRef.current(false, true);
            }
        }, REFRESH_MS);

        return () => {
            clearInterval(timer);
            abort.current?.abort();
        };
    }, []);

    const toggle = (cwd) => {
        setOpen((current) => {
            const next = new Set(current);

            if (next.has(cwd)) {
                next.delete(cwd);
            } else {
                next.add(cwd);
            }

            saveOpen(next);

            return next;
        });
    };

    const folders = gitStatus?.folders ?? [];
    const counts = { changed: 0, clean: 0, none: 0 };
    let sessionCount = 0;

    for (const folder of folders) {
        counts[
            folder.state === "changed" ? "changed" : folder.state === "clean" ? "clean" : "none"
        ]++;
        sessionCount += folder.sessions;
    }

    const shown = folders.filter(
        (folder) =>
            filter === "all" ||
            (filter === "none"
                ? folder.state === "none" || folder.state === "error"
                : folder.state === filter),
    );
    const checked = gitStatus === null ? "" : `checked ${timeAgo(gitStatus.checkedAt)}`;
    const filters = [
        ["all", "All", folders.length, null],
        ["changed", "Changed", counts.changed, "changed"],
        ["clean", "Clean", counts.clean, "clean"],
        ["none", "No repo", counts.none, "none"],
    ];

    return html`<section class="git-panel" data-part="git-panel" aria-label="Git status in every session">
        <header class="board-head git-head">
            <span class="git-mark"><${Icon} name="git" size=${19} /></span>
            <div class="board-title">
                <h2>Git status</h2>
                <div class="board-sub">
                    ${folders.length} ${folders.length === 1 ? "folder" : "folders"} · ${counts.changed} with changes · ${sessionCount} ${sessionCount === 1 ? "session" : "sessions"}
                </div>
            </div>
            <button
                class="git-refresh"
                title="Check every folder again"
                disabled=${checking}
                onClick=${() => loadRef.current(true)}
            >
                <${Icon} name="reload" size=${14} />
                <span>${checking ? "Checking…" : "Refresh"}</span>
            </button>
            <button
                class="icon-button"
                title="Back to the conversation (Esc)"
                aria-label="Close"
                onClick=${closeGit}
            >
                <${Icon} name="close" />
            </button>
        </header>
        <div class="git-tools" role="group" aria-label="Show only">
            ${filters.map(
                ([key, label, count, tone]) => html`<button
                    class=${`git-filter ${filter === key ? "on" : ""}`}
                    aria-pressed=${filter === key}
                    onClick=${() => setFilter(key)}
                >
                    ${tone && html`<span class=${`git-filter-dot ${tone}`} aria-hidden="true"></span>`}
                    ${label}
                    <span class="git-filter-count">${count}</span>
                </button>`,
            )}
            <span class="git-tools-fill"></span>
            <span class="git-checked">
                ${error && html`<span class="git-error" title=${error}>could not check</span>`}
                ${!error && checked && html`<span class="git-dot"></span>${checked}`}
            </span>
        </div>
        <div class="git-folders">
            ${
                loading && folders.length === 0
                    ? html`<${Loader} label="Checking every folder" />`
                    : shown.length === 0
                      ? html`<div class="git-empty">
                        ${
                            folders.length === 0
                                ? "No session is open in a folder yet."
                                : filter === "all"
                                  ? "No folders to show."
                                  : `No folder is ${filter === "none" ? "outside a repository" : filter}.`
                        }
                    </div>`
                      : shown.map(
                            (folder) => html`<${Folder}
                            key=${folder.cwd}
                            folder=${folder}
                            open=${open.has(folder.cwd)}
                            onToggle=${toggle}
                            spawning=${spawning}
                            setSpawning=${setSpawning}
                        />`,
                        )
            }
        </div>
        <footer class="git-foot">
            <span>Read-only status</span>
            <span class="git-foot-more">·</span>
            <span class="git-foot-more">refreshes every 20 s while this panel is open</span>
            <span class="git-foot-more">·</span>
            <span class="git-foot-more">Commit starts a new session in that folder</span>
            <span class="git-tools-fill"></span>
            <span class="git-keys"><kbd>Alt</kbd>+<kbd>G</kbd> toggles · <kbd>Esc</kbd> closes</span>
        </footer>
    </section>`;
}
