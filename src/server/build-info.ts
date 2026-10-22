/**
 * Which build of Pi Pocket this is: the branch its folder is checked out on, and its newest commit. The rail shows
 * both under the version, so someone can tell two checkouts apart at a glance.
 */
import { APP_ROOT } from "./config.ts";
import { git } from "./git.ts";

/** The branch and commit this Pi Pocket runs from; either is absent outside a repository or before a first commit. */
export type BuildInfo = { branch?: string; commit?: string };

let read: Promise<BuildInfo> | undefined;

async function readBuild(): Promise<BuildInfo> {
    const [branch, commit] = await Promise.all([
        git(APP_ROOT, ["rev-parse", "--abbrev-ref", "HEAD"]).then(
            (name) => name.trim() || undefined,
            () => undefined,
        ),
        git(APP_ROOT, ["rev-parse", "--short", "HEAD"]).then(
            (id) => id.trim() || undefined,
            () => undefined,
        ),
    ]);

    return { branch, commit };
}

/** The build this server runs, read once: a restart after an update reads it again. */
export function buildInfo(): Promise<BuildInfo> {
    read ??= readBuild().catch(() => ({}));

    return read;
}
