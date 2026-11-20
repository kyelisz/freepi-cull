// The same paint-equality check with free-pi's real transcript components, plus
// the two things a sparse line array can break: scrollbar geometry and the
// OSC 133 prompt markers used by jump-to-prompt.
// Usage: node test/transcript.test.mjs
import { findAgentDist, findTuiDist, reporter } from "./resolve.mjs";

const P = findTuiDist();
const A = findAgentDist(P);
const { compare, ok, fail, finish } = reporter();

if (A === undefined) {
    console.log("skip: pi-coding-agent components not found (set PI_AGENT_DIST)");
    process.exit(0);
}

const { Container, Text } = await import(P + "/index.js");
const { renderLayoutFrame, getScrollViewBox } = await import(P + "/layout.js");
const cull = await import(P + "/cull.js");
const { AssistantMessageComponent } = await import(A + "/components/assistant-message.js");
const { createChatViewport } = await import(A + "/chat-viewport.js");
const { initTheme } = await import(A + "/theme/theme.js");
initTheme("dark", false);

const W = 90, H = 32;
const message = (i) => ({
    role: "assistant",
    content: [{ type: "text", text: `# Answer ${i}\n\nSome **bold** text and a list:\n\n- one\n- two\n- three\n\n${"filler words ".repeat(i % 20)}` }],
});

const chat = new Container();
for (let i = 0; i < 250; i++) chat.addChild(new AssistantMessageComponent(message(i)));
const tail = new AssistantMessageComponent(message(999));
chat.addChild(tail);
const doc = new Container();
doc.addChild(new Text("header", 0, 0));
doc.addChild(chat);
const vp = createChatViewport({
    document: doc,
    pendingMessages: new Container(),
    status: new Container(),
    editor: new Text("input", 1, 0),
    footer: new Text("footer", 0, 0),
});
const sv = vp.transcript;
const render = () => renderLayoutFrame(vp.root, W, H, () => {});
const screen = () => render().lines.join("\n");

function compareScreens(label, culling) {
    cull.setCullEnabled(!culling);
    for (let i = 0; i < 3; i++) render();
    const reference = screen();
    cull.setCullEnabled(culling);
    for (let i = 0; i < 3; i++) render();
    compare(label, reference, screen());
}

cull.setCullEnabled(true);
for (let i = 0; i < 3; i++) render();

compareScreens("follow end", true);
sv.scrollTo(0, { disableFollow: true });
compareScreens("scroll top", true);
sv.scrollTo(500, { disableFollow: true });
compareScreens("scroll middle", true);
sv.scrollTo(sv.contentHeight - 40, { disableFollow: true });
compareScreens("scroll near end", true);
sv.scrollTo(120, { disableFollow: true });
compareScreens("big jump up", true);

// Streaming growth, then settle at the end.
sv.scrollTo(300, { disableFollow: true });
render();
for (let i = 0; i < 4; i++) {
    tail.updateContent({ content: [{ type: "text", text: `# Streaming\n\n${"word ".repeat(40 + i * 30)}` }] }, true);
    render();
}
sv.scrollToEnd();
for (let i = 0; i < 3; i++) render();
compareScreens("settle after stream at end", true);

// OSC 133 prompt markers: every message start must stay reachable off-window.
for (let i = 0; i < 2; i++) render();
const lines = getScrollViewBox(render(), sv).scrollContentLines;
const isPrompt = (line) => typeof line === "string" && line.startsWith("\x1b]133;A");
const culledCount = lines.filter(isPrompt).length;
cull.setCullEnabled(false);
for (let i = 0; i < 3; i++) render();
const plain = getScrollViewBox(render(), sv).scrollContentLines;
const plainCount = plain.filter(isPrompt).length;
if (culledCount === plainCount) {
    ok(`markers preserved (${plainCount})`);
}
else {
    const missing = [];
    for (let i = 0; i < plain.length; i++) if (isPrompt(plain[i]) && !isPrompt(lines[i])) missing.push(i);
    fail("markers preserved", `culled=${culledCount} plain=${plainCount} rows=${missing.slice(0, 8)}`);
}

// The sparse array must keep its full height, or the scrollbar and scrollTo break.
if (lines.length === plain.length) {
    ok(`content height kept (${lines.length} rows)`);
}
else {
    fail("content height kept", `culled=${lines.length} plain=${plain.length}`);
}

finish();
