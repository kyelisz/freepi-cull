// Frame-time benchmark: how long one transcript frame costs with and without
// culling. Both configurations render the same transcript, alternating in
// short blocks so CPU drift and GC pauses hit both sides equally.
// Usage: node bench/frame-bench.mjs [messages] [--frames N]
import { findTuiDist } from "../test/resolve.mjs";

const P = findTuiDist();
const { Container, ScrollView, Text, VStack } = await import(P + "/index.js");
const { renderLayoutFrame } = await import(P + "/layout.js");
const cull = await import(P + "/cull.js");

const args = process.argv.slice(2);
const N = Number(args.find((a) => /^\d+$/.test(a)) ?? 400);
const frameArg = args.indexOf("--frames");
const FRAMES = frameArg === -1 ? 120 : Number(args[frameArg + 1] ?? 120);
const W = 100, H = 40;

function buildTranscript(count) {
    const header = new Container();
    header.addChild(new Text("header line one\nheader line two\nheader line three", 0, 0));
    const chat = new Container();
    const filler = Array.from({ length: 20 }, (_, i) => `line ${i} of a fairly long assistant answer with some *markdown* styling and words`).join("\n");
    for (let i = 0; i < count; i++) {
        chat.addChild(new Text(filler, 1, 0));
        chat.addChild(new Text("---", 0, 0));
    }
    const tail = new Text("streaming", 1, 0);
    chat.addChild(tail);
    const doc = new Container();
    doc.addChild(header);
    doc.addChild(chat);
    const transcript = new ScrollView(doc, { follow: "end", primary: true });
    const dock = new VStack([
        { component: new Text("input box", 1, 0), shrink: 1, minSize: 3 },
        { component: new Text("footer", 0, 0), shrink: 1, minSize: 1 },
    ]);
    const root = new VStack([
        { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
    ]);
    return { root, chat, transcript, tail };
}

const t = buildTranscript(N);

function block(enabled, frames, samples) {
    cull.setCullEnabled(enabled);
    // settle: the first frames fill (or drop) the height cache
    for (let i = 0; i < 3; i++) renderLayoutFrame(t.root, W, H, () => {});
    for (let i = 0; i < frames; i++) {
        t.tail.setText("streaming " + i);
        const t0 = process.hrtime.bigint();
        renderLayoutFrame(t.root, W, H, () => {});
        samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
}

const onSamples = [];
const offSamples = [];
const blockSize = Math.max(10, Math.floor(FRAMES / 4));
while (onSamples.length < FRAMES) {
    block(true, blockSize, onSamples);
    block(false, blockSize, offSamples);
}

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};
const on = median(onSamples);
const off = median(offSamples);
const pct = ((1 - on / off) * 100).toFixed(0);
console.log(`messages   ${N}`);
console.log(`rows       ${t.transcript.contentHeight}`);
console.log(`cull on    ${on.toFixed(2)} ms/frame`);
console.log(`cull off   ${off.toFixed(2)} ms/frame`);
console.log(`saved      ${pct}%  (${(off / on).toFixed(1)}x faster)`);
