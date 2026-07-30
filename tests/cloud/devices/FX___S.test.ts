import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/FX___S'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'FX___S'
const META: Metadata = { modelId: MODEL_ID, modelName: 'FX___S', swVersion: '2.11.246' }

// Every fixture is a real frame captured from the appliance (washer-capture-20260730.jsonl and
// washer-cycle-20260730.jsonl in the project root) while its owner operated it and named each action.
// The expected values below come from that log, not from re-reading these bytes.

// Idle, AI Wash selected: Normal wash / default water temperature / 2 rinses / High spin, 36 minutes,
// beep at "very high" (the last of six volume steps the owner stepped through), 15 cycles to date.
const STANDBY = buf(
    'aaff200a00980085bc000100ec00860003000408ff0000000000000000520052000700540100f6000000040f04000000002010000000003400000000000004000000000000000000000000000000180000000003030206720000000000000000240024000700720100' +
        '1b000000020f04000000002000000000003400000000000004000000000000000000000000000000180000008025bb',
)

// Immediately after the start trigger: phase 3, still 36 minutes.
const STARTED = buf(
    'aaff200a00980085cf000100ec008600030302067200000000000000002400240007007201001b000000020f04000000002000000000003400000000000004000000000000000000000000000000180000000003030206720000000000000000240024000700720301' +
        '1b000000020f0400000000200000900000340000000000000400000000000000000000000000000018000000f51bbb',
)

// Rinsing: the wash and water-temperature bytes have dropped to 0, which is what identified phase 12.
const RINSING = buf(
    'aaff200a0098008798000100ec0086000303020672000000000000000018001e005e0072280b1b010000020f0400000000200000900100340000000000000400000000000000000000000000000018000000000000020672000000000000000015001c005e00720c0b' +
        '1b010000020f04000000002000009001003400000000000004000000000000000000000000000000180000008b39bb',
)

// Cycle complete: the spin byte has cleared too. Note the remaining-minutes byte stops at 1, never 0.
const COMPLETE = buf(
    'aaff200a00980088f0000100ec0086000000000672000000000000000001001c007600720e0c1b010000000f0400000000200000900100340000000000000400000000000000000000000000000018000000000000000072000000000000000001001c0080007' +
        '22a0e1b01000000100400000000000000100100340000000000000400000000000000000000000000000018000000b701bb',
)

// A second course - Rinse + Spin (0x37) with 1 rinse and Medium spin - started with the wash byte
// already 0 and went straight to phase 12, skipping the wash phases entirely.
const RINSE_SPIN_STARTED = buf(
    'aaff200a0098008b76000100ec0086000000000072000000000000000001001c008800722f2a1b01000000100400000000000000100100340000000000000c000000000000000000000000000000180000000000000104370000000000000000190019000000370c01' +
        '1105000001100400000000000000900100340000000000000c0000000000000000000000000000001800000046abbb',
)

// Powered off - the entire record reads zero.
const POWERED_OFF = buf(
    'aaff200a0098008c1f000100ec0086000000010437000000000000000014001900050037020c1105000001100400000000000000100100340000000000000c00000000000000000000000000000018000000000000000437000000000000000001000000060037' +
        '00021100000000100400000000000000000100340000000000000400000000000000000000000000000018000000f913bb',
)

// The short (non-extended) framing: a reply to a settings write. Carries the same 66-byte record after
// the per-key status list, so state must be picked up from it too.
const SETTINGS_REPLY_POWER_OFF = buf(
    'aa5020e6000201ff01020000030300062e00000000000000000100000003002e000105000000000f0300000000200000000000340000000000000400000000000000000000000000000018000000acbb',
)

// Sent once immediately after the appliance reconnects: a single record with no previous one ahead of
// it. Captured at 08:24:44 - the exact moment rethink was restarted to deploy this handler - while a
// Rinse + Spin was in its spin stage.
const RECONNECT_SNAPSHOT = buf(
    'aaff200a0055008e8e000100eb00430000000004370000000000000000020019001e00370e0c1105000000100400000000000000900100340000000000000400000000000000000000000000000018000000ac12bb',
)

// Remote control switched on from the panel, with the door lock that follows it a few seconds later.
// Captured 09:53:48, three seconds after the toggle.
const REMOTE_CONTROL_ON = buf(
    'aaff200a00980094f8000100ec008600030302067200000000000000002400240032007201001b0000000210040000000020000010000034000000000000040000000000000000000000000000001800000000030302067200000000000000002400240032007201001b000000021004000000002000001001003400000000000004000000000000000000000000000000180000009852bb',
)

function setup() {
    const HA = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dut = new DUT(HA.asConnection(), thinq, META)
    return { HA, thinq, dut }
}

function feed(thinq: MockThinq2Device, frame: Buffer) {
    thinq.emit('data', frame)
}

const get = (HA: MockHAConnection, prop: string) => HA.devices[DEVICE_ID].properties[prop]

describe('FX___S washer', () => {
    test('publishes a discovery config naming the model', () => {
        const { HA } = setup()
        const config = HA.devices[DEVICE_ID].config!
        assert.equal(config.device.model, 'FX___S')
        assert.ok(config.components.status)
        assert.ok(config.components.remaining_time)
    })

    test('decodes the idle record', () => {
        const { HA, thinq } = setup()
        feed(thinq, STANDBY)

        assert.equal(get(HA, 'power'), 'ON')
        assert.equal(get(HA, 'status'), 'standby')
        assert.equal(get(HA, 'status_code'), 1)
        assert.equal(get(HA, 'running'), 'OFF')
        assert.equal(get(HA, 'remaining_time'), 0) // not a timed phase
        assert.equal(get(HA, 'course'), 'AI Wash')
        assert.equal(get(HA, 'current_course'), 'AI Wash')
        assert.equal(get(HA, 'wash'), 'normal')
        assert.equal(get(HA, 'water_temp'), '40')
        assert.equal(get(HA, 'rinse'), '2')
        assert.equal(get(HA, 'spin'), 'high')
        assert.equal(get(HA, 'beep'), 'very_high')
        assert.equal(get(HA, 'cycles'), 15) // the LG cloud reported 15 the same morning
        assert.equal(get(HA, 'total_time'), 36) // the course estimate, useful before pressing start
    })

    test('decodes a started cycle, including the running flag and the clock', () => {
        const { HA, thinq } = setup()
        feed(thinq, STARTED)

        assert.equal(get(HA, 'status'), 'starting')
        assert.equal(get(HA, 'status_code'), 3)
        assert.equal(get(HA, 'running'), 'ON')
        assert.equal(get(HA, 'drum_active'), 'ON')
        assert.equal(get(HA, 'remaining_time'), 36)
        assert.equal(get(HA, 'total_time'), 36)
    })

    test('reports the rinse stage and the rinses still to go', () => {
        const { HA, thinq } = setup()
        feed(thinq, RINSING)

        assert.equal(get(HA, 'status'), 'rinsing')
        assert.equal(get(HA, 'status_code'), 12)
        assert.equal(get(HA, 'remaining_time'), 21)
        assert.equal(get(HA, 'total_time'), 28) // re-estimated mid-cycle, down from 36
        assert.equal(get(HA, 'rinse_remaining'), 2)
    })

    test('does not overwrite the selected settings while a cycle is running', () => {
        const { HA, thinq } = setup()
        feed(thinq, STANDBY)
        feed(thinq, RINSING)

        // The record's wash/water-temperature bytes have been consumed to 0 by this point; the selects
        // must still show what was selected.
        assert.equal(get(HA, 'wash'), 'normal')
        assert.equal(get(HA, 'water_temp'), '40')
    })

    test('treats phase 42 as complete and suppresses the stuck 1-minute clock', () => {
        const { HA, thinq } = setup()
        feed(thinq, COMPLETE)

        assert.equal(get(HA, 'status'), 'complete')
        assert.equal(get(HA, 'status_code'), 42)
        assert.equal(get(HA, 'remaining_time'), 0)
        // The 0x10 flag is still set here, so deriving `running` from it reported a finished wash as
        // running - seen on the appliance after the first deploy.
        assert.equal(get(HA, 'running'), 'OFF')
        // ...and the course must still come through, since that byte is never consumed.
        assert.equal(get(HA, 'course'), 'AI Wash')
    })

    test('decodes a different course, proving the phase codes are not course-specific', () => {
        const { HA, thinq } = setup()
        feed(thinq, RINSE_SPIN_STARTED)

        assert.equal(get(HA, 'status'), 'rinsing')
        assert.equal(get(HA, 'remaining_time'), 25)
        assert.equal(get(HA, 'rinse_remaining'), 1)
        assert.equal(get(HA, 'current_course'), 'Rinse + Spin')
    })

    test('reports power off from an all-zero record', () => {
        const { HA, thinq } = setup()
        feed(thinq, STANDBY)
        feed(thinq, POWERED_OFF)

        assert.equal(get(HA, 'power'), 'OFF')
        assert.equal(get(HA, 'status'), 'off')
        assert.equal(get(HA, 'running'), 'OFF')
        assert.equal(get(HA, 'total_time'), 0)
        // Powering off clears the phase, the clock and wash/temperature/rinse, but NOT these two -
        // they stay correct and must keep being published (a 16 -> 0 -> 16 cycle count would read as a
        // counter reset to Home Assistant's statistics).
        assert.equal(get(HA, 'cycles'), 16)
        assert.equal(get(HA, 'beep'), 'very_high')
        // The course byte survives being powered off, and this record was captured after a Rinse + Spin
        // had been selected, so it correctly overrides the AI Wash published from the standby frame.
        assert.equal(get(HA, 'course'), 'Rinse + Spin')
        // The consumable option bytes were cleared though, and must not be written back over the select.
        assert.equal(get(HA, 'wash'), 'normal')
    })

    test('also reads state out of the short-framed settings reply', () => {
        const { HA, thinq } = setup()
        feed(thinq, SETTINGS_REPLY_POWER_OFF)

        assert.equal(get(HA, 'status'), 'off')
        assert.equal(get(HA, 'status_code'), 0)
    })

    test('leaves a select alone when the appliance reports a value we cannot name', () => {
        const { HA, thinq } = setup()
        feed(thinq, STANDBY)
        // Rinse + Spin is a known course, but its Medium spin is published while `wash` (0x00 = Off)
        // and the rest stay as they were rather than being set to an option that does not exist.
        feed(thinq, POWERED_OFF)
        assert.equal(get(HA, 'spin'), 'high')
        assert.ok(String(get(HA, 'options_raw') ?? '').startsWith('course=114'))
    })

    test('picks up the single-record snapshot sent on reconnect', () => {
        const { HA, thinq } = setup()
        feed(thinq, RECONNECT_SNAPSHOT)

        // Without this the entities stay unknown from a restart until the appliance next changes state.
        assert.equal(get(HA, 'status'), 'spinning')
        assert.equal(get(HA, 'status_code'), 14)
        assert.equal(get(HA, 'running'), 'ON')
        assert.equal(get(HA, 'course'), 'Rinse + Spin')
        assert.equal(get(HA, 'remaining_time'), 2)
        assert.equal(get(HA, 'total_time'), 25)
        assert.equal(get(HA, 'cycles'), 16)
        assert.equal(get(HA, 'beep'), 'very_high')
    })

    test('reports which controls the current course actually lets you change', () => {
        const { HA, thinq } = setup()
        feed(thinq, STANDBY) // AI Wash

        // Steam cannot be switched on this course, and wash is limited to two of its six positions -
        // both reported by the owner working the panel, since the appliance never declares any of it.
        assert.equal(get(HA, 'available_options'), 'wash, water_temp, rinse, spin')
        const attrs = JSON.parse(String(get(HA, 'available_options_attrs')))
        assert.deepEqual(attrs.wash, ['normal', 'soak'])
        assert.equal(attrs.steam, false)
        assert.equal(attrs.water_temp.length, 5)
    })

    test('reports a course that locks everything', () => {
        const { HA, thinq } = setup()
        feed(thinq, RINSE_SPIN_STARTED) // Rinse + Spin, which fixes wash and temperature
        const attrs = JSON.parse(String(get(HA, 'available_options_attrs')))
        assert.equal(attrs.wash, null)
        assert.equal(attrs.water_temp, null)
    })

    test('decodes remote control, the door lock that follows it, and TurboShot', () => {
        const { HA, thinq } = setup()
        feed(thinq, REMOTE_CONTROL_ON)

        assert.equal(get(HA, 'remote_control'), 'ON')
        // Nothing was done to the door - switching remote control on locks it a few seconds later.
        assert.equal(get(HA, 'door_lock'), 'OFF') // device_class lock: off means locked
        assert.equal(get(HA, 'child_lock'), 'OFF')
        assert.equal(get(HA, 'wrinkle_care'), 'OFF')
        assert.equal(get(HA, 'turbowash'), 'ON')
        // The same bit was read as "a cycle is loaded" before this was isolated on the panel.
        assert.equal(get(HA, 'status'), 'standby')
        assert.equal(get(HA, 'running'), 'OFF')
    })

    test('ignores frames that are not from the appliance', () => {
        const { HA, thinq } = setup()
        feed(thinq, buf('aa09f0241001018cbb')) // our own start command echoed back
        assert.equal(get(HA, 'status'), undefined)
    })
})

describe('FX___S commands', () => {
    // Each expected frame is the exact bytes captured going to the appliance.
    const cases: [string, string, string, string][] = [
        ['power', 'OFF', 'aa0df0e5000201ff010200c4bb', 'power off'],
        ['power', 'ON', 'aa0df0e5000201ff010201c7bb', 'power on'],
        ['pause', '', 'aa0df0e5000201ff010302c1bb', 'pause'],
        ['course', 'Tub Clean', 'aa0df0e5000201ff010a55bbbb', 'course = Tub Clean'],
        ['course', 'AI Wash', 'aa0df0e5000201ff010a725ebb', 'course = AI Wash'],
        ['course', 'Normal', 'aa0df0e5000201ff010a2e92bb', 'course = Normal'],
    ]

    for (const [prop, value, expected, name] of cases) {
        test(`${name} reproduces the captured frame`, () => {
            const { thinq, dut } = setup()
            dut.setProperty(prop, value)
            assert.equal(thinq.outbox.length, 1)
            assert.equal(hex(thinq.outbox[0]), hex(buf(expected)))
        })
    }

    test('start sends the operation write and then the trigger', () => {
        const { thinq, dut } = setup()
        dut.setProperty('start', '')
        assert.equal(thinq.outbox.length, 2)
        assert.equal(hex(thinq.outbox[0]), hex(buf('aa0df0e5000201ff010301c6bb')))
        assert.equal(hex(thinq.outbox[1]), hex(buf('aa09f0241001018cbb')))
    })

    test('resume sends the operation write and then the trigger', () => {
        const { thinq, dut } = setup()
        dut.setProperty('resume', '')
        assert.equal(thinq.outbox.length, 2)
        assert.equal(hex(thinq.outbox[0]), hex(buf('aa0df0e5000201ff010303c0bb')))
    })

    test('pause does not send a trigger', () => {
        const { thinq, dut } = setup()
        dut.setProperty('pause', '')
        assert.equal(thinq.outbox.length, 1)
    })

    test('laundry care reproduces the captured frame', () => {
        const { thinq, dut } = setup()
        dut.setProperty('laundry_care', '')
        assert.equal(hex(thinq.outbox[0]), hex(buf('aa0df0e5000201ff015701b2bb')))
    })

    test('beep volume covers all five captured steps', () => {
        const { thinq, dut } = setup()
        const expected = [
            'aa0df0e5000201ff011300f7bb',
            'aa0df0e5000201ff011301f6bb',
            'aa0df0e5000201ff011302f1bb',
            'aa0df0e5000201ff011303f0bb',
            'aa0df0e5000201ff011304f3bb',
        ]
        for (const name of ['mute', 'low', 'medium', 'high', 'very_high']) {
            dut.setProperty('beep', name)
        }
        assert.deepEqual(
            thinq.outbox.map((b) => hex(b)),
            expected.map((e) => hex(buf(e))),
        )
    })

    test('rejects a value that is not in the option list', () => {
        const { thinq, dut } = setup()
        dut.setProperty('spin', 'warp_speed')
        dut.setProperty('rinse', '9')
        assert.equal(thinq.outbox.length, 0)
    })
})
