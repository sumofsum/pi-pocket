/**
 * Every folder the sessions a person can see work in, as git has it: the branch and its last commits, and the
 * uncommitted changes with their line counts. Read-only, for the Git status panel. Each folder is kept a few seconds,
 * and looked at a few at a time, so the panel's regular refresh never floods the machine with git processes.
 */
import { lstat, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { gitDirOf } from "./branches.ts";
import { type ChangeKind, kindOf, parseNumstat, parseStatus } from "./changes.ts";
import { git as runGit } from "./git.ts";

export type GitCommit = { hash: string; subject: string; at: number };

export type GitFileChange = {
    /** Relative to the repository's top folder. */
    path: string;
    kind: ChangeKind;
    /** Lines added and removed; absent for binary files or when a count was not read. */
    added?: number;
    removed?: number;
};

export type GitFolder = {
    /** The folder a session works in, as its session metadata says. */
    cwd: string;
    /** The folder's own name, as a session list shows it. */
    name: string;
    /** How many active sessions people can see work here; archived ones are counted apart. */
    sessions: number;
    /** Archived sessions in this folder, which add no folder of their own. */
    archived: number;
    /** An active session here works in a git worktree of its own. */
    worktree: boolean;
    state: "changed" | "clean" | "none" | "error";
    /** Why git could not read the folder, for `state: "error"`. */
    error?: string;
    repo?: {
        root: string;
        /** The branch checked out; absent when HEAD is detached or has no commits yet. */
        branch?: string;
        detached?: true;
        /** The newest commit, the one before the changes. */
        head?: GitCommit;
        /** The newest commits, newest first, at most `MAX_COMMITS`. */
        commits: GitCommit[];
        /** The branch's remote branch, and how far apart they are. */
        upstream?: { name: string; ahead: number; behind: number; gone?: true };
        changes: {
            /** Every file with a change, including the ones `list` leaves out. */
            files: number;
            added: number;
            removed: number;
            /** Files past the most `list` shows. */
            more: number;
            list: GitFileChange[];
        };
    };
};

export type GitStatus = { folders: GitFolder[]; checkedAt: number };

/** A folder in a repository, which a status keeps. */
type Repo = NonNullable<GitFolder["repo"]>;

/** A folder's git status as the panel reads it, as much as a session contributes to it. */
type SessionFolder = {
    cwd: string;
    archived?: boolean;
    worktree?: unknown;
};

/** The most commits the panel shows for one folder. */
const MAX_COMMITS = 10;
/** The most changed files the panel lists for one folder; the rest are counted. */
const MAX_FILES = 100;
/** The most untracked files whose lines are counted; the rest keep their count unknown. */
const MAX_UNTRACKED = 200;
/** Files past this size are not read to count their lines. */
const MAX_COUNTED_BYTES = 2_000_000;
/** How many folders are looked at at once. */
const AT_ONCE = 4;
const GIT_TIMEOUT_MS = 15_000;
/** How long a folder's status is reused when nothing asks for a fresh one. */
const CACHE_MS = 15_000;
/** Folders past this many are left out of the cache, oldest first. */
const CACHE_KEPT = 400;

const git = (cwd: string, args: string[]) => runGit(cwd, args, { timeoutMs: GIT_TIMEOUT_MS });

type Branch = {
    branch?: string;
    detached?: true;
    upstream?: { name: string; ahead: number; behind: number; gone?: true };
};

/** The `## …` line of `git status --porcelain=v1 -b`, as a branch, or a detached HEAD. */
function parseBranch(line: string): Branch {
    const text = line.slice(3);

    if (text.startsWith("No commits yet on ")) {
        return { branch: text.slice("No commits yet on ".length) };
    }

    if (text === "HEAD (no branch)") {
        return { detached: true };
    }

    const [names = "", track = ""] = text.split(" [");
    const [branch = "", upstream] = names.split("...");

    if (branch === "") {
        return {};
    }

    if (upstream === undefined) {
        return { branch };
    }

    return {
        branch,
        upstream: {
            name: upstream,
            ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
            behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
            ...(track === "gone" ? { gone: true } : {}),
        },
    };
}

/** `git status --porcelain=v1 -b -z`: the branch line and the changed files, separately. */
function parseStatusWithBranch(output: string): {
    branch: Branch;
    changes: ReturnType<typeof parseStatus>;
} {
    const fields = output.split("\0");
    const first = fields[0] ?? "";

    if (first.startsWith("## ")) {
        fields.shift();

        return { branch: parseBranch(first), changes: parseStatus(fields.join("\0")) };
    }

    return { branch: {}, changes: parseStatus(output) };
}

/** The newest commits, newest first, from `git log --format=%h%x00%s%x00%ct%x00`. */
function parseCommits(output: string): GitCommit[] {
    const fields = output.split("\0");
    const commits: GitCommit[] = [];

    for (let at = 0; at + 2 < fields.length; at += 3) {
        // Git ends each record's line with a newline, which starts the next one's hash.
        const hash = (fields[at] ?? "").replace(/^\n/, "");
        const when = Number(fields[at + 2]);

        if (hash === "" || !Number.isFinite(when)) {
            continue;
        }

        commits.push({ hash, subject: fields[at + 1] ?? "", at: when * 1000 });
    }

    return commits;
}

/** How many lines a file has; undefined for a binary or very large one. */
async function lineCount(file: string): Promise<number | undefined> {
    try {
        const info = await lstat(file);

        if (!info.isFile() || info.size > MAX_COUNTED_BYTES) {
            return undefined;
        }

        const content = await readFile(file);

        if (content.includes(0)) {
            return undefined;
        }

        if (content.length === 0) {
            return 0;
        }

        const lines = content.toString("utf8").split("\n").length;

        return content[content.length - 1] === 10 ? lines - 1 : lines;
    } catch {
        return undefined;
    }
}

/** Count the lines a new file adds, a few at a time, into `counts`. */
async function countUntracked(
    root: string,
    changes: ReturnType<typeof parseStatus>,
    counts: Map<string, { added?: number; removed?: number }>,
): Promise<void> {
    const pending = changes.filter((change) => change.code === "??").slice(0, MAX_UNTRACKED);
    let next = 0;

    await Promise.all(
        Array.from({ length: Math.min(AT_ONCE, pending.length) }, async () => {
            while (next < pending.length) {
                const change = pending[next++]!;
                const added = await lineCount(join(root, change.path));

                if (added !== undefined) {
                    counts.set(change.path, { added, removed: 0 });
                }
            }
        }),
    );
}

/** A folder in a repository, or the reason git could not read it. */
async function inspect(cwd: string, onlyHere: boolean): Promise<"none" | { error: string } | Repo> {
    if (gitDirOf(cwd) === undefined) {
        return "none";
    }

    let root: string;

    try {
        root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }

    if (root === "") {
        return "none";
    }

    const [statusOut, commitsOut] = await Promise.all([
        git(root, ["status", "--porcelain=v1", "-b", "-z", "--untracked-files=normal"]),
        git(root, ["log", `-${MAX_COMMITS}`, "--format=%h%x00%s%x00%ct%x00"]).catch(() => ""),
    ]);
    const { branch, changes: allChanges } = parseStatusWithBranch(statusOut);
    // Someone invited to one session sees its folder's files only, as Changes does for them.
    const prefix = onlyHere ? (await git(cwd, ["rev-parse", "--show-prefix"])).trim() : "";
    const changes =
        prefix === "" ? allChanges : allChanges.filter((change) => change.path.startsWith(prefix));
    const commits = parseCommits(commitsOut);
    const counts =
        changes.length === 0
            ? new Map<string, { added?: number; removed?: number }>()
            : parseNumstat(
                  await git(root, [
                      "diff",
                      "HEAD",
                      "--numstat",
                      "-z",
                      "--no-ext-diff",
                      "--no-textconv",
                      "--no-color",
                  ]).catch(() => ""),
              );

    await countUntracked(root, changes, counts);

    // A repository with no commit has nothing for `diff HEAD` to compare against: every file is new, so count it.
    if (commits.length === 0) {
        const pending = changes.filter((change) => change.code !== "??").slice(0, MAX_UNTRACKED);
        let next = 0;

        await Promise.all(
            Array.from({ length: Math.min(AT_ONCE, pending.length) }, async () => {
                while (next < pending.length) {
                    const change = pending[next++]!;
                    const added = await lineCount(join(root, change.path));

                    if (added !== undefined) {
                        counts.set(change.path, { added, removed: 0 });
                    }
                }
            }),
        );
    }

    const list: GitFileChange[] = changes.slice(0, MAX_FILES).map(({ code, path }) => ({
        path,
        kind: kindOf(code),
        ...counts.get(path),
    }));
    const added = changes.reduce((sum, change) => sum + (counts.get(change.path)?.added ?? 0), 0);
    const removed = changes.reduce(
        (sum, change) => sum + (counts.get(change.path)?.removed ?? 0),
        0,
    );

    return {
        root,
        ...branch,
        ...(commits[0] === undefined ? {} : { head: commits[0] }),
        commits,
        changes: {
            files: changes.length,
            added,
            removed,
            more: Math.max(0, changes.length - list.length),
            list,
        },
    };
}

const cache = new Map<string, { at: number; folder: GitFolder }>();
const inFlight = new Map<string, Promise<GitFolder>>();

function prune(): void {
    while (cache.size > CACHE_KEPT) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];

        if (oldest === undefined) {
            return;
        }

        cache.delete(oldest[0]);
    }
}

/** A folder's status, from the cache unless `refresh` asks for a fresh look. */
function statusOf(
    cwd: string,
    folder: Omit<GitFolder, "state" | "error" | "repo">,
    refresh: boolean,
    onlyHere: boolean,
): Promise<GitFolder> {
    const key = `${cwd}\0${onlyHere ? "here" : "all"}`;
    const kept = cache.get(key);

    if (!refresh && kept !== undefined && Date.now() - kept.at < CACHE_MS) {
        return Promise.resolve({ ...kept.folder, ...countsOf(folder) });
    }

    const running = inFlight.get(key);

    if (!refresh && running !== undefined) {
        return running.then((each) => ({ ...each, ...countsOf(folder) }));
    }

    const started = Date.now();
    const looking = inspect(cwd, onlyHere).then((repo): GitFolder => {
        const status =
            repo === "none"
                ? { ...folder, state: "none" as const }
                : "error" in repo
                  ? { ...folder, state: "error" as const, error: repo.error }
                  : {
                        ...folder,
                        state: repo.changes.files === 0 ? ("clean" as const) : ("changed" as const),
                        repo,
                    };

        // A slower look that began before a newer one must not put its older answer back.
        if ((cache.get(key)?.at ?? 0) <= started) {
            cache.set(key, { at: Date.now(), folder: status });
            prune();
        }

        return status;
    });

    inFlight.set(key, looking);
    looking
        .finally(() => {
            if (inFlight.get(key) === looking) {
                inFlight.delete(key);
            }
        })
        .catch(() => {});

    return looking;
}

/** How many sessions use a folder: they can change while a status it kept does not. */
function countsOf(folder: Omit<GitFolder, "state" | "error" | "repo">) {
    return {
        sessions: folder.sessions,
        archived: folder.archived,
        worktree: folder.worktree,
    };
}

/**
 * Every folder in `sessions`, grouped by the folder itself, and each one's git status. A person sees the folders of
 * the sessions they can see, and nothing else.
 */
export async function gitStatuses(
    sessions: readonly SessionFolder[],
    { refresh = false, onlyHere = false }: { refresh?: boolean; onlyHere?: boolean } = {},
): Promise<GitStatus> {
    const folders = new Map<string, Omit<GitFolder, "state" | "error" | "repo">>();

    for (const session of sessions) {
        const cwd = resolve(session.cwd);
        const known = folders.get(cwd);

        if (known === undefined) {
            folders.set(cwd, {
                cwd,
                name: basename(cwd) || cwd,
                sessions: session.archived === true ? 0 : 1,
                archived: session.archived === true ? 1 : 0,
                worktree: session.archived !== true && session.worktree !== undefined,
            });
        } else if (session.archived === true) {
            known.archived++;
        } else {
            known.sessions++;
            known.worktree ||= session.worktree !== undefined;
        }
    }

    // A folder only archived sessions use is not a working folder: it would only show work nobody is in.
    const entries = [...folders.values()].filter((folder) => folder.sessions > 0);
    const listed = new Array<GitFolder>(entries.length);
    let next = 0;

    await Promise.all(
        Array.from({ length: Math.min(AT_ONCE, entries.length) }, async () => {
            while (next < entries.length) {
                const index = next++;
                const folder = entries[index]!;

                listed[index] = await statusOf(folder.cwd, folder, refresh, onlyHere).catch(
                    (error): GitFolder => ({
                        ...folder,
                        state: "error",
                        error: error instanceof Error ? error.message : String(error),
                    }),
                );
            }
        }),
    );

    const rank = { changed: 0, clean: 1, none: 2, error: 3 };

    listed.sort(
        (a, b) =>
            rank[a.state] - rank[b.state] ||
            b.sessions - a.sessions ||
            a.name.localeCompare(b.name),
    );

    return { folders: listed, checkedAt: Date.now() };
}
