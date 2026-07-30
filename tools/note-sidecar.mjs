// Append a human note to a sidecar notes file on the SAME epoch-ms clock that
// tools/rethink-capture.ts uses, so notes align with wire events by timestamp.
//
// Why a sidecar: rethink-capture.ts takes notes on stdin, which is unavailable when it
// runs detached. Attaching a second capture socket to the same file is the documented
// trap (every frame recorded twice, and injectFlag is per-WS so the other socket's
// frames log as injected:false).
//
// Usage:
//   node tools/note-sidecar.mjs <notes.jsonl> "<text>"
import * as fs from 'node:fs'

const [out, ...rest] = process.argv.slice(2)
const text = rest.join(' ').trim()
if (!out || !text) {
    console.error('Usage: node tools/note-sidecar.mjs <notes.jsonl> "<text>"')
    process.exit(1)
}
const line = JSON.stringify({ ts: Date.now(), k: 'note', author: 'human', text }) + '\n'
fs.appendFileSync(out, line)
process.stdout.write(line)
