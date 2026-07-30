// Find the byte that changed, in frame families whose payload is NOT TLV.
//
// LOCAL TOOL — not for upstream. Companion to tools/frame-diff.ts, which only helps when the
// payload decodes as TLV. Some appliances carry state in fixed-offset records instead: this
// appliance's 0xa8 telemetry (97 bytes) is one, and PAC_910604_WW's compressor-running flag
// was found at a fixed offset in exactly such a record.
//
// Method, which is the only honest one for a record with no schema: take two periods that
// differ in ONE named way (tank out / tank in), and report the offsets that are
//   * constant within period A, and
//   * constant within period B, and
//   * different between them.
// Offsets that wobble inside a period are noise (counters, temperatures, sequence numbers)
// and are counted but not reported. A candidate needs several frames on each side: with one
// frame per period every offset that happens to differ looks like a hit.
//
// Usage:
//   tsx tools/byte-diff.ts <capture.jsonl> --split <relSeconds> [--kind 0xa8] [--min-frames 2]
//   tsx tools/byte-diff.ts <capture.jsonl> --a 100:250 --b 260:400 [--kind 0xa8]
//
// Periods are relative seconds from the first record in the file, which is what
// tools/frame-diff.ts prints, so you can read the boundaries straight off its output.

import * as fs from 'node:fs'

type Rec = { ts: number; k?: string; dir?: string; hex?: string; text?: string }

const argv = process.argv.slice(2)
const files: string[] = []
let split: number | undefined
let rangeA: [number, number] | undefined
let rangeB: [number, number] | undefined
let kindFilter: number | undefined
let minFrames = 2

function parseRange(s: string): [number, number] {
    const [a, b] = s.split(':').map(Number)
    return [a, b]
}

for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--split') split = Number(argv[++i])
    else if (a === '--a') rangeA = parseRange(argv[++i])
    else if (a === '--b') rangeB = parseRange(argv[++i])
    else if (a === '--kind') kindFilter = Number(argv[++i])
    else if (a === '--min-frames') minFrames = Number(argv[++i])
    else files.push(a)
}
if (!files.length || (split === undefined && !(rangeA && rangeB))) {
    console.error('Usage: tsx tools/byte-diff.ts <capture.jsonl> --split <relSeconds> | --a x:y --b x:y [--kind 0xa8]')
    process.exit(1)
}

const records: Rec[] = []
for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
            records.push(JSON.parse(line) as Rec)
        } catch {
            /* skip */
        }
    }
}
records.sort((a, b) => a.ts - b.ts)
const t0 = records[0].ts
const rel = (r: Rec) => (r.ts - t0) / 1000

if (split !== undefined) {
    rangeA = [0, split]
    rangeB = [split, Number.POSITIVE_INFINITY]
}

type Frame = { rel: number; buf: Buffer }
const groups = new Map<string, { a: Frame[]; b: Frame[] }>()

for (const r of records) {
    if (r.k !== 'wire' || r.dir !== 'fromDevice' || typeof r.hex !== 'string') continue
    const buf = Buffer.from(r.hex, 'hex')
    if (kindFilter !== undefined && buf[6] !== kindFilter) continue
    const t = rel(r)
    const inA = t >= rangeA![0] && t < rangeA![1]
    const inB = t >= rangeB![0] && t < rangeB![1]
    if (!inA && !inB) continue

    const key = `kind=0x${buf[6].toString(16)} b5=0x${buf[7].toString(16)} b6=0x${buf[8].toString(16)} len=${buf.length}`
    const g = groups.get(key) ?? { a: [], b: [] }
    ;(inA ? g.a : g.b).push({ rel: t, buf })
    groups.set(key, g)
}

console.log(`period A = ${rangeA![0]}..${rangeA![1]}s, period B = ${rangeB![0]}..${rangeB![1]}s`)
for (const [key, g] of groups) {
    console.log(`\n=== ${key}   A:${g.a.length} frames  B:${g.b.length} frames`)
    if (g.a.length < minFrames || g.b.length < minFrames) {
        console.log(
            `    too few frames on one side (need ${minFrames}) - a single frame makes every wobble look like a hit`,
        )
        continue
    }
    const len = g.a[0].buf.length
    const stableA: number[] = []
    const noisy: number[] = []
    const hits: string[] = []
    for (let i = 0; i < len; i++) {
        const av = new Set(g.a.map((f) => f.buf[i]))
        const bv = new Set(g.b.map((f) => f.buf[i]))
        if (av.size !== 1 || bv.size !== 1) {
            noisy.push(i)
            continue
        }
        stableA.push(i)
        const a = [...av][0]
        const b = [...bv][0]
        if (a !== b) hits.push(`    @${i} : ${a} (0x${a.toString(16)}) -> ${b} (0x${b.toString(16)})`)
    }
    console.log(`    stable offsets: ${stableA.length}/${len}, noisy: ${noisy.length}`)
    if (hits.length) {
        console.log(`    CHANGED between the periods:`)
        hits.forEach((h) => console.log(h))
    } else {
        console.log(`    nothing changed that was stable on both sides`)
    }
}
