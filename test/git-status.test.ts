// Git status: every session folder's branch, its newest commits, and its uncommitted changes, grouped by folder.
import { root } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gitStatuses } from "../src/server/git-status.ts";

const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" });

function repoIn(name: string): string {
    const cwd = join(root, name);

    mkdirSync(cwd, { recursive: true });
    gitIn(cwd, "init", "-q", "-b", "main");
    gitIn(cwd, "config", "user.email", "t@example.com");
    gitIn(cwd, "config", "user.name", "T");

    return cwd;
}

test("a folder's branch, commits, and uncommitted line counts", async () => {
    const repo = repoIn("git-status-changed");

    writeFileSync(join(repo, "keep.txt"), "a\nb\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-qm", "init");
    gitIn(repo, "checkout", "-qb", "feature");
    writeFileSync(join(repo, "keep.txt"), "a\nc\n");
    writeFileSync(join(repo, "new.txt"), "one\ntwo\n");

    const status = await gitStatuses([{ cwd: repo }, { cwd: repo, archived: true }, { cwd: repo }]);
    const [folder] = status.folders;

    assert.equal(status.folders.length, 1);
    assert.equal(folder?.cwd, repo);
    assert.equal(folder?.name, "git-status-changed");
    assert.equal(folder?.sessions, 2);
    assert.equal(folder?.archived, 1);
    assert.equal(folder?.state, "changed");
    assert.equal(folder?.repo?.branch, "feature");
    assert.equal(folder?.repo?.head?.subject, "init");
    assert.equal(folder?.repo?.commits.length, 1);
    assert.equal(folder?.repo?.changes.files, 2);
    assert.equal(folder?.repo?.changes.added, 3);
    assert.equal(folder?.repo?.changes.removed, 1);
    assert.deepEqual(
        folder?.repo?.changes.list.map((file) => [file.path, file.kind, file.added, file.removed]),
        [
            ["keep.txt", "modified", 1, 1],
            ["new.txt", "new", 2, 0],
        ],
    );
    assert.ok(status.checkedAt > 0);
});

test("a clean repository, a folder in none, and one with no commits", async () => {
    const clean = repoIn("git-status-clean");

    writeFileSync(join(clean, "keep.txt"), "a\n");
    gitIn(clean, "add", "-A");
    gitIn(clean, "commit", "-qm", "first");

    const bare = join(root, "git-status-bare");

    mkdirSync(bare, { recursive: true });

    const unborn = repoIn("git-status-unborn");

    writeFileSync(join(unborn, "one.txt"), "one\n");

    const status = await gitStatuses([{ cwd: clean }, { cwd: bare }, { cwd: unborn }], {
        refresh: true,
    });
    const byName = new Map(status.folders.map((folder) => [folder.name, folder]));

    assert.deepEqual(
        status.folders.map((folder) => folder.name),
        ["git-status-unborn", "git-status-clean", "git-status-bare"],
    );
    assert.equal(byName.get("git-status-clean")?.state, "clean");
    assert.equal(byName.get("git-status-clean")?.repo?.branch, "main");
    assert.equal(byName.get("git-status-clean")?.repo?.changes.files, 0);
    assert.equal(byName.get("git-status-bare")?.state, "none");
    assert.equal(byName.get("git-status-bare")?.repo, undefined);
    assert.equal(byName.get("git-status-unborn")?.state, "changed");
    assert.equal(byName.get("git-status-unborn")?.repo?.branch, "main");
    assert.equal(byName.get("git-status-unborn")?.repo?.head, undefined);
    assert.equal(byName.get("git-status-unborn")?.repo?.changes.added, 1);
});

test("a session invited to one folder sees only that folder's changes", async () => {
    const repo = repoIn("git-status-scoped");
    const inside = join(repo, "inside");

    mkdirSync(inside);
    writeFileSync(join(repo, "root.txt"), "root\n");
    writeFileSync(join(inside, "keep.txt"), "keep\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-qm", "first");
    writeFileSync(join(repo, "root.txt"), "root changed\n");
    writeFileSync(join(inside, "keep.txt"), "keep changed\n");
    writeFileSync(join(inside, "new.txt"), "new\n");

    const status = await gitStatuses([{ cwd: inside }], { refresh: true, onlyHere: true });
    const [folder] = status.folders;

    assert.equal(folder?.cwd, inside);
    assert.equal(folder?.state, "changed");
    assert.equal(folder?.repo?.changes.files, 2);
    assert.deepEqual(
        folder?.repo?.changes.list.map((file) => file.path),
        ["inside/keep.txt", "inside/new.txt"],
    );
});

test("a folder only archived sessions use is not listed", async () => {
    const archived = repoIn("git-status-archived");

    writeFileSync(join(archived, "keep.txt"), "a\n");
    gitIn(archived, "add", "-A");
    gitIn(archived, "commit", "-qm", "first");

    const status = await gitStatuses([{ cwd: archived, archived: true }], { refresh: true });

    assert.equal(status.folders.length, 0);
});

test("a folder shows at most its ten newest commits", async () => {
    const repo = repoIn("git-status-history");

    for (let number = 1; number <= 12; number++) {
        writeFileSync(join(repo, `file-${number}.txt`), `${number}\n`.repeat(number));
        gitIn(repo, "add", "-A");
        gitIn(repo, "commit", "-qm", `commit ${number}`);
    }

    const status = await gitStatuses([{ cwd: repo }], { refresh: true });
    const commits = status.folders[0]?.repo?.commits ?? [];

    assert.equal(commits.length, 10);
    assert.equal(commits[0]?.subject, "commit 12");
    assert.equal(commits[9]?.subject, "commit 3");
});
