// What a message to Pi carries besides its words: the list of files the server saves beside it, as `ui.js` and the
// history's prompt list split it. No DOM: tests import this as it is.

/** What separates a message to Pi from the list of files attached to it, which the server adds. */
export const ATTACHMENTS_HEADING = "\n\nAttached files (saved on the server):\n";

/**
 * A message to Pi in two: what the person wrote, and the list of attached files if any. One with files alone, sent
 * before 0.14.0, has the heading without the blank line before it.
 */
export function splitAttachments(text) {
    return (text.startsWith(ATTACHMENTS_HEADING.trimStart()) ? `\n\n${text}` : text).split(
        ATTACHMENTS_HEADING,
    );
}
