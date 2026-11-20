/**
 * free-pi tweak: viewport culling for long transcripts.
 *
 * A scroll view lays its whole child out every frame, so a long session keeps
 * re-building every line it has ever printed even though only the viewport rows
 * are painted. That is why the TUI starts to lag once the transcript grows.
 *
 * This module lets containers skip children that sit completely outside the
 * visible window. A skipped child only contributes its height (and its OSC 133
 * prompt markers) from a cache filled the last time it was really rendered, so
 * the result stays a sparse line array: layout height, scrollbar geometry,
 * text selection and jump-to-prompt keep working, and no line is copied.
 *
 * Children can opt out at any time by calling invalidate(); the cached height is
 * dropped and the child renders again on the next frame.
 */
const OSC133_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

/** Rows kept live on each side of the viewport so a scroll step never exposes a placeholder. */
const MIN_OVERSCAN = 24;

/**
 * Trailing children are always measured, even when scrolled away: that is where new
 * output lands, and a stale height there would make the content shorter than it is.
 */
const ALWAYS_MEASURE_TAIL = 4;

/** component -> { width, start, height, marks } */
const HEIGHT = Symbol.for("@earendil-works/pi-tui/cull-height");

/** line array -> { kept: [{ start, lines }], pinned?: number[] } for nested culled containers */
const SEGMENTS = Symbol.for("@earendil-works/pi-tui/cull-segments");

const state = {
    active: false,
    enabled: true,
    top: 0,
    bottom: 0,
    offset: 0,
};

/** Escape hatch: FREEPI_NO_CULL=1 turns culling off without touching the code. */
const lockDisabled = typeof process !== "undefined" &&
    process.env !== undefined &&
    /^(1|true|on|yes)$/i.test(process.env.FREEPI_NO_CULL ?? "");
if (lockDisabled)
    state.enabled = false;

let forceFullRender = false;

export function setCullEnabled(enabled) {
    state.enabled = !lockDisabled && enabled !== false;
}

export function isCullEnabled() {
    return state.enabled;
}

/** Live rows kept on each side of the viewport. */
export function cullOverscan(viewportHeight) {
    return Math.max(MIN_OVERSCAN, Math.ceil(Math.max(0, viewportHeight) / 2));
}

/** Drop culling for the next frame, e.g. after the scroll position jumped. */
export function requestFullRender() {
    forceFullRender = true;
}

/**
 * Open a cull window in scroll-content rows for one layout pass.
 * `followEnd` leaves the window open below, because a followed tail only ever grows downwards.
 * Returns the previous state so nested scroll views can restore it.
 */
export function beginCull(scrollTop, viewportHeight, followEnd) {
    if (forceFullRender) {
        forceFullRender = false;
        return undefined;
    }
    const height = Math.max(0, Math.floor(viewportHeight));
    if (!state.enabled || height <= 0)
        return undefined;
    const previous = { active: state.active, top: state.top, bottom: state.bottom, offset: state.offset };
    const overscan = cullOverscan(height);
    const top = Math.max(0, Math.floor(scrollTop));
    state.active = true;
    state.top = Math.max(0, top - overscan);
    state.bottom = followEnd === true ? Infinity : top + height + overscan;
    state.offset = 0;
    return previous;
}

export function endCull(previous) {
    if (previous === undefined) {
        state.active = false;
        return;
    }
    state.active = previous.active;
    state.top = previous.top;
    state.bottom = previous.bottom;
    state.offset = previous.offset;
}

export function forgetContainerHeight(component) {
    component[HEIGHT] = undefined;
}

/**
 * Rows of a culled child segment as they currently read. A parent may rewrite rows of an
 * array after it was returned (pi adds OSC 133 markers by replacing lines[0]), so the array's
 * own values win over the segment the metadata points at.
 */
function segmentRows(lines, start, source) {
    const length = source.length;
    for (let index = 0; index < length; index++) {
        if (lines[start + index] !== source[index])
            return lines.slice(start, start + length);
    }
    return source;
}

/** Append [row, marker] pairs for every OSC 133 marker line of an array, offset by `base`. */
function pushMarks(lines, base, out) {
    const meta = lines[SEGMENTS];
    if (meta !== undefined) {
        const pinned = meta.pinned;
        if (pinned !== undefined) {
            for (let index = 0; index < pinned.length; index += 2)
                out.push(base + pinned[index], pinned[index + 1]);
        }
        const segments = meta.kept;
        for (let index = 0; index < segments.length; index++) {
            const entry = segments[index];
            pushMarks(segmentRows(lines, entry.start, entry.lines), base + entry.start, out);
        }
        return;
    }
    const length = lines.length;
    for (let row = 0; row < length; row++) {
        const line = lines[row];
        if (typeof line !== "string" || line.charCodeAt(0) !== 0x1b)
            continue;
        const match = OSC133_PREFIX.exec(line);
        if (match !== null)
            out.push(base + row, match[0]);
    }
}

function rememberHeight(component, width, start, lines) {
    const collected = [];
    pushMarks(lines, 0, collected);
    const marks = collected.length === 0 ? undefined : collected;
    const cached = component[HEIGHT];
    // Reuse the record so a streaming child does not allocate one every frame.
    if (cached !== undefined) {
        cached.width = width;
        cached.start = start;
        cached.height = lines.length;
        cached.marks = marks;
        return;
    }
    component[HEIGHT] = { width, start, height: lines.length, marks };
}

/**
 * Queue one child's rows for the merged array. A child that culled itself only contributes
 * its own kept segments, in O(visible rows) instead of O(content rows).
 */
function mergeChild(lines, base, kept, pinned) {
    const meta = lines[SEGMENTS];
    if (meta !== undefined) {
        const segments = meta.kept;
        for (let index = 0; index < segments.length; index++) {
            const entry = segments[index];
            kept.push({ start: base + entry.start, lines: segmentRows(lines, entry.start, entry.lines) });
        }
        const marks = meta.pinned;
        if (marks !== undefined) {
            for (let index = 0; index < marks.length; index += 2)
                pinned.push(base + marks[index], marks[index + 1]);
        }
        return;
    }
    kept.push({ start: base, lines });
}

function mouseEntries(container, count) {
    let entries = container.cullMouseEntries;
    if (entries === undefined) {
        entries = [];
        container.cullMouseEntries = entries;
    }
    while (entries.length < count)
        entries.push({ component: undefined, height: 0 });
    entries.length = count;
    return entries;
}

/** Container.render, with off-screen children served from the height cache. */
export function renderContainerLines(container, width) {
    const children = container.children;
    const count = children.length;
    const entries = mouseEntries(container, count);
    const culling = state.active && state.enabled;
    if (!culling) {
        const lines = [];
        for (let index = 0; index < count; index++) {
            const child = children[index];
            const childLines = child.render(width) ?? [];
            const entry = entries[index];
            if (entry.component !== child) {
                entry.component = child;
                entry.height = childLines.length;
            }
            else if (entry.height !== childLines.length) {
                entry.height = childLines.length;
            }
            for (let lineIndex = 0; lineIndex < childLines.length; lineIndex++)
                lines.push(childLines[lineIndex]);
        }
        container.mouseLayout = { width, children: entries };
        return lines;
    }
    const top = state.top;
    const bottom = state.bottom;
    const start = state.offset;
    const tailFrom = count - ALWAYS_MEASURE_TAIL;
    const kept = [];
    const pinned = [];
    let offset = start;
    for (let index = 0; index < count; index++) {
        const child = children[index];
        const mouseEntry = entries[index];
        const cached = child[HEIGHT];
        if (index < tailFrom &&
            cached !== undefined &&
            cached.width === width &&
            (cached.start + cached.height <= top || cached.start >= bottom)) {
            // Keep OSC 133 prompt markers so jump-to-prompt still sees the whole history.
            const marks = cached.marks;
            if (marks !== undefined) {
                for (let markIndex = 0; markIndex < marks.length; markIndex += 2) {
                    if (marks[markIndex] < cached.height)
                        pinned.push(offset + marks[markIndex], marks[markIndex + 1]);
                }
            }
            offset += cached.height;
            if (mouseEntry.component !== child || mouseEntry.height !== cached.height) {
                mouseEntry.component = child;
                mouseEntry.height = cached.height;
            }
            continue;
        }
        state.offset = offset;
        const childLines = child.render(width) ?? [];
        rememberHeight(child, width, offset, childLines);
        mergeChild(childLines, offset, kept, pinned);
        offset += childLines.length;
        if (mouseEntry.component !== child || mouseEntry.height !== childLines.length) {
            mouseEntry.component = child;
            mouseEntry.height = childLines.length;
        }
    }
    container.mouseLayout = { width, children: entries };
    const total = offset - start;
    if (total === 0)
        return [];
    if (kept.length === 1 && kept[0].start === start && kept[0].lines.length === total)
        return kept[0].lines;
    const lines = new Array(total);
    for (let keptIndex = 0; keptIndex < kept.length; keptIndex++) {
        const segment = kept[keptIndex];
        const segmentLines = segment.lines;
        let target = segment.start - start;
        for (let lineIndex = 0; lineIndex < segmentLines.length; lineIndex++, target++) {
            const line = segmentLines[lineIndex];
            if (line !== undefined)
                lines[target] = line;
        }
    }
    for (let pinnedIndex = 0; pinnedIndex < pinned.length; pinnedIndex += 2)
        lines[pinned[pinnedIndex] - start] = pinned[pinnedIndex + 1];
    const relative = [];
    for (let index = 0; index < kept.length; index++)
        relative.push({ start: kept[index].start - start, lines: kept[index].lines });
    const relativeMarks = [];
    for (let index = 0; index < pinned.length; index += 2)
        relativeMarks.push(pinned[index] - start, pinned[index + 1]);
    lines[SEGMENTS] = { kept: relative, pinned: relativeMarks.length === 0 ? undefined : relativeMarks };
    return lines;
}
