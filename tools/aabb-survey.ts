// Survey the AA..BB message types an appliance sends, and show which bytes of each actually move.
//
// LOCAL TOOL — not for upstream. The AA..BB counterpart to tools/unmapped-tags.ts, which only
// understands TLV appliances.
//
// Why it exists: FX___S decodes three message types and the appliance sends thirteen. Before
// operating the washer to hunt for a feature, it is worth seeing what it is already volunteering
// - how often, how long, and which byte positions carry something that changes. A type whose
// every byte is constant across a whole day is a declaration; one with a byte that moves with
// the cycle is state nobody is reading.
//
// Framing, taken from AABBDevice.processData rather than assumed: the length byte is IGNORED on
// receive (it saturates at 0xff for long frames), and inner = everything between `aa <len>` and
// `<checksum> bb`. inner[0] is the address, inner[1] the type, inner[2..] the payload.
//
// The handler column is a regex over `0x__` literals and it OVER-REPORTS on this protocol, worse
// than the TLV tools do. A washer message type is one byte, and one-byte constants are everywhere
// in a handler - FX___S has KEY_STEAM = 0x3e, so message type 0x3e reads as "known" when nothing
// dispatches on it. Treat the column as "this byte appears somewhere", and get the real answer by
// reading what processAABB() branches on: for FX___S that is 0x0a, 0xe6 and 0x4d, and nothing else.
//
// Usage:
//   tsx tools/aabb-survey.ts <handler.ts> <capture.jsonl> [more.jsonl ...]
//   tsx tools/aabb-survey.ts <handler.ts> --type 0xe2 <capture.jsonl>   # dump one type's payloads

import * as fs from 'node:fs'

const argv = process.argv.slice(2)
const ti = argv.indexOf('--type')
const only = ti >= 0 ? parseInt(argv[ti + 1], 16) : undefined
// ti === -1 would make ti+1 === 0 and silently eat the handler argument - the first run of this
// tool did exactly that and reported MSG_TUNNEL as undecoded.
const rest = ti >= 0 ? argv.filter((_, i) => i !== ti && i !== ti + 1) : argv
const [handlerFile, ...captures] = rest

if (!handlerFile || !captures.length) {
    console.error('Usage: tsx tools/aabb-survey.ts <handler.ts> [--type 0xNN] <capture.jsonl> [...]')
    process.exit(1)
}

const src = fs.readFileSync(handlerFile, 'utf8')
const mentioned = new Set((src.match(/0x[0-9a-fA-F]{2}\b/g) ?? []).map((s) => parseInt(s, 16)))

type Group = { frames: Buffer[]; files: Set<string> }
const byType = new Map<number, Group>()

for (const file of captures) {
    for (const line of fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())) {
        let r: { k?: string; dir?: string; hex?: string; rx?: string }
        try {
            r = JSON.parse(line)
        } catch {
            continue
        }
        const hex = r.hex ?? r.rx
        const fromDevice = r.rx !== undefined || r.dir === 'fromDevice'
        if (!hex || !fromDevice) continue

        const buf = Buffer.from(hex, 'hex')
        if (buf.length < 6 || buf[0] !== 0xaa || buf[buf.length - 1] !== 0xbb) continue
        const inner = buf.subarray(2, buf.length - 2)
        if (inner.length < 2) continue

        const type = inner[1]
        const g = byType.get(type) ?? { frames: [], files: new Set<string>() }
        g.frames.push(inner)
        g.files.add(file.replace(/^.*[/\\]/, ''))
        byType.set(type, g)
    }
}

const hex2 = (n: number) => `0x${n.toString(16).padStart(2, '0')}`

if (only !== undefined) {
    const g = byType.get(only)
    if (!g) {
        console.log(`type ${hex2(only)}: not seen`)
        process.exit(0)
    }
    const distinct = new Map<string, number>()
    for (const f of g.frames) distinct.set(f.toString('hex'), (distinct.get(f.toString('hex')) ?? 0) + 1)
    console.log(`type ${hex2(only)}: ${g.frames.length} frames, ${distinct.size} distinct payloads\n`)
    for (const [payload, n] of [...distinct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
        console.log(`${String(n).padStart(4)}x  ${payload}`)
    }
    process.exit(0)
}

console.log(`handler:  ${handlerFile}`)
console.log(`captures: ${captures.length}\n`)

for (const [type, g] of [...byType.entries()].sort((a, b) => b[1].frames.length - a[1].frames.length)) {
    const lengths = [...new Set(g.frames.map((f) => f.length))].sort((a, b) => a - b)
    const known = mentioned.has(type)

    // byte-wise variance, only meaningful where every frame has the same length
    let detail = ''
    if (lengths.length === 1) {
        const len = lengths[0]
        const moving: string[] = []
        for (let i = 2; i < len; i++) {
            const vals = [...new Set(g.frames.map((f) => f[i]))]
            if (vals.length > 1)
                moving.push(
                    `@${i}(${vals.length}${vals.length <= 4 ? ':' + vals.sort((a, b) => a - b).join('/') : ''})`,
                )
        }
        detail = moving.length ? `moving bytes: ${moving.join(' ')}` : 'every byte constant'
    } else {
        detail = `variable length - use --type ${hex2(type)} to dump`
    }

    console.log(
        `${hex2(type)}  ${String(g.frames.length).padStart(5)}x  len ${lengths.join('/')}  ` +
            `${known ? 'byte appears in handler (see caveat)' : '** byte absent from handler **'}`,
    )
    console.log(`        ${detail}`)
}
