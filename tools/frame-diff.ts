// Decode every frame in a capture and show, per frame family, which TLV tags CHANGED.
//
// LOCAL TOOL — not for upstream. Companion to tools/decode-caps.ts (which only hunts the
// capability reply). This one is for labelling a live sweep: the interesting signal is
// "the user did X and tag 0xNNN went a -> b", not the full 60-tag dump each time.
//
// Frame layout (same as decode-caps.ts, verified on PAC_910604_WW and re-checked here):
//   [0,1] prefix | [2..5] 04 00 00 00 | [6] kind | [7] byte5 | [8] byte6 | [9] byte7 | [10] len
//   payload = buf[11 .. 11+len)   then 2 CRC bytes
// A frame family is (dir, kind, byte5, byte6) — byte7 varies per frame family on some
// appliances, so it is printed but not part of the key.
//
// Usage:
//   tsx tools/frame-diff.ts <capture.jsonl> [notes.jsonl] [--census] [--family <hex kind>] [--tag <hex>]
//
//   --census        one line per family: count, byte7 values seen, length-check result
//   --family 0xa7   restrict the diff stream to one kind
//   --tag 0x1f7     show only changes of these tags (repeatable, comma-separated)

import * as fs from 'node:fs'
import * as TLV from '@/util/tlv'

type Rec = {
    ts: number
    k?: string
    dir?: string
    hex?: string
    raw?: string
    injected?: boolean
    protocol?: string
    phase?: string
    meta?: unknown
    text?: string
}

const args = process.argv.slice(2)
const files: string[] = []
let census = false
let familyFilter: number | undefined
const tagFilter = new Set<number>()
for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--census') census = true
    else if (a === '--family') familyFilter = Number(args[++i])
    else if (a === '--tag') args[++i].split(',').forEach((t) => tagFilter.add(Number(t)))
    else files.push(a)
}
if (!files.length) {
    console.error(
        'Usage: tsx tools/frame-diff.ts <capture.jsonl> [notes.jsonl] [--census] [--family 0xa7] [--tag 0x1f7]',
    )
    process.exit(1)
}

const records: Rec[] = []
for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
            records.push(JSON.parse(line) as Rec)
        } catch {
            console.error(`skipping unparsable line in ${f}`)
        }
    }
}
records.sort((a, b) => a.ts - b.ts)

function parseFrame(hex: string) {
    const buf = Buffer.from(hex, 'hex')
    const len = buf[10]
    let tlv: TLV.TLV[] = []
    try {
        tlv = TLV.parse(buf.subarray(11, 11 + len))
    } catch {
        /* util/tlv returns partial output rather than throwing */
    }
    return {
        kind: buf[6],
        b5: buf[7],
        b6: buf[8],
        b7: buf[9],
        len,
        declared: 11 + len + 2,
        actual: buf.length,
        tlv,
    }
}

const t0 = records[0]?.ts ?? 0
const rel = (ts: number) => `+${((ts - t0) / 1000).toFixed(1)}s`
const hex = (n: number) => `0x${n.toString(16)}`

// ---- census -------------------------------------------------------------------------
if (census) {
    const fam = new Map<
        string,
        { n: number; b7: Set<number>; lens: Set<number>; ok: number; bad: number; tlvs: Set<number> }
    >()
    for (const r of records) {
        if (r.k !== 'wire' || typeof r.hex !== 'string') continue
        const f = parseFrame(r.hex)
        const key = `${r.dir} kind=${hex(f.kind)} b5=${hex(f.b5)} b6=${hex(f.b6)}`
        const e = fam.get(key) ?? { n: 0, b7: new Set(), lens: new Set(), ok: 0, bad: 0, tlvs: new Set() }
        e.n++
        e.b7.add(f.b7)
        e.lens.add(f.actual)
        if (f.declared === f.actual) e.ok++
        else e.bad++
        e.tlvs.add(f.tlv.length)
        fam.set(key, e)
    }
    const nonWire = records.filter((r) => r.k !== 'wire')
    console.log(`records: ${records.length} (wire ${records.length - nonWire.length}, other ${nonWire.length})`)
    console.log(`window : ${new Date(t0).toISOString()} .. ${new Date(records[records.length - 1].ts).toISOString()}`)
    console.log()
    for (const [key, e] of [...fam.entries()].sort((a, b) => b[1].n - a[1].n)) {
        console.log(
            `${key.padEnd(44)} n=${String(e.n).padStart(4)}  len=[${[...e.lens].sort((a, b) => a - b).join(',')}]  ` +
                `lengthCheck ok=${e.ok} bad=${e.bad}  b7=[${[...e.b7].map(hex).join(',')}]  #tlv=[${[...e.tlvs].sort((a, b) => a - b).join(',')}]`,
        )
    }
    process.exit(0)
}

// ---- diff stream --------------------------------------------------------------------
const prev = new Map<string, Map<number, number>>()
for (const r of records) {
    if (r.k === 'note') {
        console.log(`\n### ${rel(r.ts)}  NOTE: ${r.text}\n`)
        continue
    }
    if (r.k === 'marker') {
        console.log(`--- ${rel(r.ts)}  marker ${r.phase} ${r.meta ? JSON.stringify(r.meta) : ''}`)
        continue
    }
    if (r.k !== 'wire') continue
    if (typeof r.hex !== 'string') {
        console.log(`${rel(r.ts)} ${r.dir} non-hex payload: ${r.raw}`)
        continue
    }
    const f = parseFrame(r.hex)
    if (familyFilter !== undefined && f.kind !== familyFilter) continue
    const key = `${r.dir}/${f.kind}/${f.b5}/${f.b6}`

    const cur = new Map<number, number>()
    for (const e of f.tlv) cur.set(e.t, e.v) // last wins; duplicate tags are reported below
    const dupes = f.tlv.length - cur.size

    const before = prev.get(key)
    prev.set(key, cur)

    const head =
        `${rel(r.ts).padStart(9)} ${r.dir === 'fromDevice' ? 'rx' : 'tx'} ` +
        `kind=${hex(f.kind)} b5=${hex(f.b5)} b6=${hex(f.b6)} b7=${hex(f.b7)} ` +
        `${f.actual}B ${f.declared === f.actual ? 'len✓' : `len✗(declares ${f.declared})`} tlv=${f.tlv.length}` +
        (dupes ? ` dup=${dupes}` : '') +
        (r.injected ? ' INJECTED' : '')

    if (!before) {
        const shown = [...cur.entries()].filter(([t]) => !tagFilter.size || tagFilter.has(t))
        console.log(`${head}  [first of family] ${shown.map(([t, v]) => `${hex(t)}=${v}`).join(' ')}`)
        continue
    }

    const changes: string[] = []
    for (const [t, v] of cur) {
        if (tagFilter.size && !tagFilter.has(t)) continue
        if (!before.has(t)) changes.push(`${hex(t)}=${v} (new)`)
        else if (before.get(t) !== v) changes.push(`${hex(t)}: ${before.get(t)} -> ${v}`)
    }
    for (const [t] of before) {
        if (tagFilter.size && !tagFilter.has(t)) continue
        if (!cur.has(t)) changes.push(`${hex(t)} gone`)
    }
    console.log(`${head}  ${changes.length ? changes.join('  ') : '(no change)'}`)
}
