// Which prompt the conversation's message arrows are on, for the message history's first focus. Kept by
// conversation so a reload or a switch to another session cannot pick up the last one's place.
let current = { conversationId: null, id: null };
const listeners = new Set();

export function currentPrompt(conversationId) {
    return current.conversationId === conversationId ? current.id : null;
}

/** Hear each change while the message history is open, so its highlight follows the conversation. */
export function subscribeCurrentPrompt(listener) {
    listeners.add(listener);

    return () => listeners.delete(listener);
}

/** Leaving a session forgets its place, so coming back cannot open the history on an old prompt. */
export function clearCurrentPrompt(conversationId) {
    if (current.conversationId !== conversationId || current.id === null) {
        return;
    }

    current = { conversationId, id: null };

    for (const listener of listeners) {
        listener(conversationId, null);
    }
}

export function setCurrentPrompt(conversationId, id) {
    const next = id ?? null;

    if (current.conversationId === conversationId && current.id === next) {
        return;
    }

    current = { conversationId, id: next };

    for (const listener of listeners) {
        listener(conversationId, next);
    }
}
