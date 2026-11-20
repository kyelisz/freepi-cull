// Paint-equality smoke test: culling must never change what is drawn.
// Usage: node test/cull.test.mjs   (run install.py first)
import { findTuiDist, reporter } from "./resolve.mjs";

const P = findTuiDist();
const { Container, ScrollView, Text, VStack } = await import(P + "/index.js");
const { renderLayoutFrame } = await import(P + "/layout.js");
const cull = await import(P + "/cull.js");
const { compare, ok, fail, finish } = reporter();

const W = 80, H = 30;

function buildTranscript(messages) {
    const chat = new Container();
    for (let i = 0; i < messages; i++) {
        const lines = [];
        const n = 1 + ((i * 7) % 9);
        for (let l = 0; l < n; l++) lines.push(`msg ${i} line ${l} ` + "x".repeat(i % 30));
        chat.addChild(new Text(lines.join("\n"), 1, 0));
        if (i % 5 === 0) chat.addChild(new Text("---", 0, 0));
    }
    const tail = new Text("streaming 0", 1, 0);
    chat.addChild(tail);
    const header = new Container();
    header.addChild(new Text("HEADER\nsecond line", 0, 0));
    const doc = new Container();
    doc.addChild(header);
    doc.addChild(chat);
    const sv = new ScrollView(doc, { follow: "end", primary: true });
    const dock = new VStack([{ component: new Text("input", 1, 0), shrink: 1, minSize: 3 }]);
    const root = new VStack([
        { component: sv, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
    ]);
    return { root, sv, tail, chat };
}

const t = buildTranscript(300);
const render = () => renderLayoutFrame(t.root, W, H, () => {});
const screen = (frame) => frame.lines.join("\n");

// Snapshot the reference (culling off) and assert the culled render is identical.
function compareScreens(label, culling) {
    cull.setCullEnabled(!culling);
    for (let i = 0; i < 3; i++) render();
    const reference = screen(render());
    cull.setCullEnabled(culling);
    for (let i = 0; i < 3; i++) render();
    compare(label, reference, screen(render()));
}

compareScreens("follow end", true);
t.sv.scrollTo(0, { disableFollow: true });
compareScreens("scroll top", true);
t.sv.scrollTo(150, { disableFollow: true });
compareScreens("scroll middle", true);
t.sv.scrollTo(t.sv.contentHeight - H - 5, { disableFollow: true });
compareScreens("scroll near end", true);
t.sv.scrollToEnd();
render();
t.sv.scrollTo(400, { disableFollow: true });
compareScreens("big jump up", true);

// Tail growth while following the end: culled and plain must converge.
t.sv.scrollToEnd();
cull.setCullEnabled(false);
for (let i = 0; i < 3; i++) { t.tail.setText("streaming g" + i); render(); }
const refGrowth = screen(render());
cull.setCullEnabled(true);
for (let i = 0; i < 3; i++) { t.tail.setText("streaming g" + i); render(); }
compare("tail growth", refGrowth, screen(render()));

// New messages appended while scrolled up: rows above must not shift.
t.sv.scrollToEnd();
render();
t.sv.scrollTo(200, { disableFollow: true });
cull.setCullEnabled(true);
for (let i = 0; i < 3; i++) render();
const scrolledUpCulled = screen(render());
cull.setCullEnabled(false);
for (let i = 0; i < 3; i++) render();
compare("scrolled up stability", screen(render()), scrolledUpCulled);

// invalidate() on an off-screen message must drop its cached height.
cull.setCullEnabled(true);
for (let i = 0; i < 3; i++) render();
const target = t.chat.children[3];
target.setText("a much longer message\n".repeat(12));
t.chat.invalidate();
cull.setCullEnabled(false);
for (let i = 0; i < 3; i++) render();
const refAfterInvalidate = screen(render());
cull.setCullEnabled(true);
for (let i = 0; i < 3; i++) render();
compare("invalidate height", refAfterInvalidate, screen(render()));

// Growth of a middle message without invalidate is transiently wrong, but it
// must settle exactly once the end is reached again.
target.setText("a much longer message\n".repeat(20));
for (let i = 0; i < 5; i++) render();
t.sv.scrollToEnd();
for (let i = 0; i < 5; i++) render();
cull.setCullEnabled(false);
for (let i = 0; i < 3; i++) render();
const refEnd = screen(render());
cull.setCullEnabled(true);
for (let i = 0; i < 3; i++) render();
compare("settle at end", refEnd, screen(render()));

// The escape hatch must win over an explicit enable.
const locked = await import(P + "/cull.js");
if (process.env.FREEPI_NO_CULL) {
    locked.setCullEnabled(true);
    locked.isCullEnabled() ? fail("FREEPI_NO_CULL lock") : ok("FREEPI_NO_CULL lock");
}

finish();