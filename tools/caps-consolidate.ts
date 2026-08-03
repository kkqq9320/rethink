// Cross-reference two or more appliances' capability replies against their model JSONs and
// print only the TLV tag -> support.* mappings that survive the comparison.
//
// LOCAL TOOL — not for upstream. Companion to tools/caps-vs-modeljson.ts, which does one
// appliance at a time and shows the working.
//
// Why a second unit matters: many capability masks have one or four bits set, and several
// support.* dictionaries have exactly those bits, so a single appliance leaves the tag
// ambiguous. Two appliances of different model types usually do not agree by accident — the
// intersection of "exact matches on unit A" and "exact matches on unit B" collapses to one
// key for most tags. Confidence is reported, never assumed:
//
//   HIGH   present on both units, intersection is exactly one key
//   AMBIG  present on both, intersection has several keys — undecided, not a result
//   MED    present on one unit only, unique there — plausible, unconfirmed
//
// Usage:
//   tsx tools/caps-consolidate.ts <capture.jsonl> <model.json> [<capture2.jsonl> <model2.json> ...]

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as TLV from '@/util/tlv'

const TAG_CAPS_KEY = 0x2da

const argv = process.argv.slice(2)
if (argv.length < 2 || argv.length % 2 !== 0) {
    console.error('Usage: tsx tools/caps-consolidate.ts <capture.jsonl> <model.json> [<capture2> <model2> ...]')
    process.exit(1)
}

type Support = Record<string, { bits: number[]; labels: Record<number, string> }>

function supportOf(modelFile: string): Support {
    const j = JSON.parse(fs.readFileSync(modelFile, 'utf8')) as { Value: Record<string, any> }
    const out: Support = {}
    for (const [k, v] of Object.entries(j.Value)) {
        if (!k.startsWith('support.') || !v.value_mapping) continue
        const idx = Object.keys(v.value_mapping).map(Number).filter(Number.isFinite)
        out[k] = {
            bits: idx
                .filter((i) => i >= 1)
                .map((i) => i - 1)
                .sort((a, b) => a - b),
            labels: Object.fromEntries(idx.map((i) => [i, String(v.value_mapping[String(i)]).replace(/^@/, '')])),
        }
    }
    return out
}

function capsOf(captureFile: string) {
    const frames = fs
        .readFileSync(captureFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { k?: string; dir?: string; hex?: string })
        .filter((r) => r.k === 'wire' && r.dir === 'fromDevice' && typeof r.hex === 'string')
        .map((r) => {
            const buf = Buffer.from(r.hex as string, 'hex')
            const len = buf[10]
            return { ok: 11 + len + 2 === buf.length, tlv: TLV.parse(buf.subarray(11, 11 + len)) }
        })
        .filter((f) => f.tlv.some((x) => x.t === TAG_CAPS_KEY))
    if (!frames.length) throw new Error(`no capability reply in ${captureFile}`)
    if (!frames[0].ok) throw new Error(`capability frame truncated in ${captureFile}`)
    return frames[0]
}

const bitsOf = (v: number) => Array.from({ length: 32 }, (_, b) => b).filter((b) => (v >>> b) & 1)
const eq = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i])

// ---- per-unit exact matches ------------------------------------------------------------
type Unit = { name: string; support: Support; byTag: Map<number, { v: number; exact: string[] }> }
const units: Unit[] = []

for (let i = 0; i < argv.length; i += 2) {
    const [captureFile, modelFile] = [argv[i], argv[i + 1]]
    const support = supportOf(modelFile)
    const caps = capsOf(captureFile)
    const byTag = new Map<number, { v: number; exact: string[] }>()
    for (const tlv of caps.tlv) {
        if (byTag.has(tlv.t)) continue // 0x2d7/0x2d8/0x2d9 repeat per mode
        const bits = bitsOf(tlv.v)
        if (!bits.length) continue // an all-zero mask matches nothing and means "unsupported"
        byTag.set(tlv.t, {
            v: tlv.v,
            exact: Object.entries(support)
                .filter(([, s]) => eq(s.bits, bits))
                .map(([k]) => k),
        })
    }
    units.push({ name: path.basename(modelFile).replace(/\.model\.json$/, ''), support, byTag })
}

// ---- intersect -------------------------------------------------------------------------
const tags = [...new Set(units.flatMap((u) => [...u.byTag.keys()]))].sort((a, b) => a - b)
const rows: { tag: number; conf: string; key: string; vals: string }[] = []

for (const tag of tags) {
    const present = units.filter((u) => u.byTag.has(tag))
    const inter = present
        .map((u) => u.byTag.get(tag)!.exact)
        .reduce((a, b) => a.filter((k) => b.includes(k)), present[0].byTag.get(tag)!.exact)
    if (!inter.length) continue

    const conf =
        present.length === units.length ? (inter.length === 1 ? 'HIGH' : 'AMBIG') : inter.length === 1 ? 'MED' : 'AMBIG'

    rows.push({
        tag,
        conf,
        key: inter.join(' / '),
        vals: units.map((u) => `${u.name.split('_')[0]}=${u.byTag.has(tag) ? u.byTag.get(tag)!.v : '-'}`).join(' '),
    })
}

for (const conf of ['HIGH', 'MED', 'AMBIG']) {
    const sel = rows.filter((r) => r.conf === conf)
    console.log(`\n=========== ${conf} (${sel.length}) ===========`)
    for (const r of sel) {
        console.log(`0x${r.tag.toString(16).padEnd(4)} ${r.vals.padEnd(30)} ${r.key}`)
        if (conf !== 'HIGH') continue
        // show the decoded bits from whichever unit has the tag
        for (const u of units) {
            const hit = u.byTag.get(r.tag)
            if (!hit) continue
            const labels = u.support[r.key].labels
            console.log(
                `        ${u.name}: ` +
                    bitsOf(hit.v)
                        .map((b) => `${b}=${labels[b + 1]}`)
                        .join(', '),
            )
        }
    }
}

// tags that matched nothing anywhere are the open questions
const unmatched = units.flatMap((u) =>
    [...u.byTag.entries()].filter(([t]) => !rows.some((r) => r.tag === t)).map(([t, d]) => ({ u: u.name, t, v: d.v })),
)
console.log(`\n=========== no support.* match on any unit (${unmatched.length}) ===========`)
console.log(unmatched.map((x) => `${x.u.split('_')[0]}:0x${x.t.toString(16)}=${x.v}`).join('  '))
