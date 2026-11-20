// Locates the patched pi-tui bundle so the tests can run against whatever
// install the user has: PI_TUI_DIST, a local node_modules, or an npx cache.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const exists = (p) => {
    try {
        fs.accessSync(p);
        return true;
    }
    catch {
        return false;
    }
};

function npxCandidates() {
    const root = path.join(os.homedir(), ".npm/_npx");
    if (!exists(root))
        return [];
    const out = [];
    for (const entry of fs.readdirSync(root)) {
        const d = path.join(root, entry, "node_modules/free-pi-cli/node_modules/@earendil-works/pi-tui/dist");
        if (exists(path.join(d, "cull.js")))
            out.push(d);
    }
    // newest first: package fresh installs beat stale ones
    return out.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

export function findTuiDist() {
    const candidates = [
        process.env.PI_TUI_DIST,
        path.resolve("node_modules/@earendil-works/pi-tui/dist"),
        ...npxCandidates(),
    ].filter(Boolean);
    for (const dir of candidates) {
        if (exists(path.join(dir, "layout.js")) && exists(path.join(dir, "cull.js")))
            return dir;
    }
    throw new Error("no patched pi-tui bundle found - run install.py first, or set PI_TUI_DIST");
}

/** pi-coding-agent's interactive components (only needed by the transcript test). */
export function findAgentDist(tuiDist) {
    const candidates = [
        process.env.PI_AGENT_DIST,
        path.resolve(tuiDist, "../../pi-coding-agent/dist/modes/interactive"),
        path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive"),
    ].filter(Boolean);
    for (const dir of candidates) {
        if (exists(path.join(dir, "components/assistant-message.js")))
            return dir;
    }
    return undefined;
}

export function reporter() {
    let failures = 0;
    return {
        compare(label, reference, actual, rows) {
            const a = rows ? reference : reference.split("\n");
            const b = rows ? actual : actual.split("\n");
            const bad = a.findIndex((line, i) => line !== b[i]);
            if (bad !== -1 || a.length !== b.length) {
                failures++;
                console.log(`FAIL ${label}: row ${bad} differs`);
                console.log(`  ref : ${JSON.stringify(a[bad])}`);
                console.log(`  cull: ${JSON.stringify(b[bad])}`);
                return;
            }
            console.log(`ok   ${label}`);
        },
        fail(label, detail) {
            failures++;
            console.log(`FAIL ${label}${detail ? ": " + detail : ""}`);
        },
        ok(label) {
            console.log(`ok   ${label}`);
        },
        finish() {
            console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURES`);
            process.exitCode = failures === 0 ? 0 : 1;
        },
    };
}
