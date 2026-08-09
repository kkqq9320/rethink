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

// Towels 1 selected and idle, with the options the app had at the moment it sent the extended-course
// write that this fixture is paired with in the test below.
const TOWELS_1_IDLE = buf(
    'aaff200a00980085b0000100ec008600030502045500000000000000007c007c0006005501000a000000020f04000000000000000000003400000000000004000000000000000000000000000000180000000003000408ff0000000000000000520052000700540100f6000000040f04000000002010000000003400000000000004000000000000000000000000000000180000000cc4bb',
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
        assert.equal(get(HA, 'status'), 'initial')
        assert.equal(get(HA, 'status_code'), 1)
        assert.equal(get(HA, 'running'), 'OFF')
        assert.equal(get(HA, 'remaining_time'), 0) // not a timed phase
        assert.equal(get(HA, 'course'), 'AI_COURSE')
        assert.equal(get(HA, 'current_course'), 'AI_COURSE')
        assert.equal(get(HA, 'wash'), 'normal')
        assert.equal(get(HA, 'water_temp'), '40')
        assert.equal(get(HA, 'rinse'), '2')
        assert.equal(get(HA, 'spin'), 'high')
        assert.equal(get(HA, 'beep'), 'very_high')
        assert.equal(get(HA, 'cycles'), '15') // the LG cloud reported 15 the same morning
        assert.equal(get(HA, 'total_time'), 36) // the course estimate, useful before pressing start
    })

    test('decodes a started cycle, including the running flag and the clock', () => {
        const { HA, thinq } = setup()
        feed(thinq, STARTED)

        assert.equal(get(HA, 'status'), 'detecting')
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

        assert.equal(get(HA, 'status'), 'end')
        assert.equal(get(HA, 'status_code'), 42)
        assert.equal(get(HA, 'remaining_time'), 0)
        // The 0x10 flag is still set here, so deriving `running` from it reported a finished wash as
        // running - seen on the appliance after the first deploy.
        assert.equal(get(HA, 'running'), 'OFF')
        // ...and the course must still come through, since that byte is never consumed. The select
        // holds it because it is what the next start will run; the sensor clears because nothing is on.
        assert.equal(get(HA, 'course'), 'AI_COURSE')
        assert.equal(get(HA, 'current_course'), '-')
    })

    test('decodes a different course, proving the phase codes are not course-specific', () => {
        const { HA, thinq } = setup()
        feed(thinq, RINSE_SPIN_STARTED)

        assert.equal(get(HA, 'status'), 'rinsing')
        assert.equal(get(HA, 'remaining_time'), 25)
        assert.equal(get(HA, 'rinse_remaining'), 1)
        assert.equal(get(HA, 'current_course'), 'RINSE_SPIN')
    })

    test('reports power off from an all-zero record', () => {
        const { HA, thinq } = setup()
        feed(thinq, STANDBY)
        feed(thinq, POWERED_OFF)

        assert.equal(get(HA, 'power'), 'OFF')
        assert.equal(get(HA, 'status'), 'power_off')
        assert.equal(get(HA, 'running'), 'OFF')
        assert.equal(get(HA, 'total_time'), 0)
        // Powering off clears the phase, the clock and wash/temperature/rinse, but NOT these two -
        // they stay correct and must keep being published (a 16 -> 0 -> 16 cycle count would read as a
        // counter reset to Home Assistant's statistics).
        assert.equal(get(HA, 'cycles'), '16')
        assert.equal(get(HA, 'beep'), 'very_high')
        // The course byte survives being powered off, and this record was captured after a Rinse + Spin
        // had been selected, so it correctly overrides the AI Wash published from the standby frame.
        assert.equal(get(HA, 'course'), 'RINSE_SPIN')
        // The consumable option bytes were cleared though, and must not be written back over the select.
        assert.equal(get(HA, 'wash'), 'normal')
    })

    test('also reads state out of the short-framed settings reply', () => {
        const { HA, thinq } = setup()
        feed(thinq, SETTINGS_REPLY_POWER_OFF)

        assert.equal(get(HA, 'status'), 'power_off')
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
        assert.equal(get(HA, 'course'), 'RINSE_SPIN')
        assert.equal(get(HA, 'remaining_time'), 2)
        assert.equal(get(HA, 'total_time'), 25)
        assert.equal(get(HA, 'cycles'), '16')
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
        assert.equal(get(HA, 'status'), 'initial')
        assert.equal(get(HA, 'running'), 'OFF')
    })

    test('adds a course it has no name for and makes it selectable', () => {
        const { HA, thinq, dut } = setup()
        // The current record starts at byte 83 of the frame, so its course byte is 87. 0x63 is not one
        // of the ten positions the dial sweep found.
        const unknown = Buffer.from(STANDBY)
        unknown[87] = 0x63
        feed(thinq, unknown)

        assert.equal(get(HA, 'current_course'), '#99')
        assert.ok(
            (HA.devices[DEVICE_ID].config!.components.course as unknown as { options: string[] }).options.includes(
                '#99',
            ),
        )

        thinq.resetRecorder()
        dut.setProperty('course', '#99')
        assert.equal(hex(thinq.outbox[0]), hex(buf('aa0df0e5000201ff010a63a9bb')))
    })

    test('adds a course it has no name for and makes it selectable', () => {
        const { HA, thinq, dut } = setup()
        // The current record starts at byte 83 of the frame, so its course byte is 87. 0x63 is not one
        // of the ten positions the dial sweep found.
        const unknown = Buffer.from(STANDBY)
        unknown[87] = 0x63
        feed(thinq, unknown)

        assert.equal(get(HA, 'current_course'), '#99')
        assert.ok(
            (HA.devices[DEVICE_ID].config!.components.course as unknown as { options: string[] }).options.includes(
                '#99',
            ),
        )

        thinq.resetRecorder()
        dut.setProperty('course', '#99')
        assert.equal(hex(thinq.outbox[0]), hex(buf('aa0df0e5000201ff010a63a9bb')))
    })

    test('stays available when the appliance drops after being switched off', () => {
        const { HA, thinq, dut } = setup()
        feed(thinq, POWERED_OFF)
        dut.drop() // what the bridge calls when the appliance disconnects

        // Switching it off at the panel drops the connection; going unavailable would throw away a
        // state we know is correct and read as a network fault.
        assert.equal(HA.devices[DEVICE_ID].availability, 'online')
        assert.equal(get(HA, 'status'), 'power_off')
    })

    test('goes unavailable when it drops from any other state', () => {
        const { HA, thinq, dut } = setup()
        feed(thinq, STANDBY)
        dut.drop()
        assert.equal(HA.devices[DEVICE_ID].availability, 'offline')
    })

    test('ignores frames that are not from the appliance', () => {
        const { HA, thinq } = setup()
        feed(thinq, buf('aa09f0241001018cbb')) // our own start command echoed back
        assert.equal(get(HA, 'status'), undefined)
    })
    test('the appliance reports its own energy every fifteen minutes', () => {
        const { HA, thinq } = setup()

        /*
         * Real 0x3E frames from washer-cycle-20260730.jsonl - the whole set that capture contains.
         * Each arrived ten times, one report every ~15 minutes, and the order is not guaranteed, so
         * the decode must depend on neither. What they are was settled by the smart plug on this
         * appliance's outlet: report 2 says 94 and the plug drew 1880-2018 W for three minutes in
         * exactly that window. See processEnergyReport.
         */
        for (const f of [
            'aa0b203e00030003014fbb',
            'aa0b203e005e00610281bb',
            'aa0b203e0016007703f6bb',
            'aa0b203e000b008204f1bb',
            'aa0b203e0003008505f5bb',
            'aa0b203e0003008806f1bb',
        ])
            feed(thinq, Buffer.from(f, 'hex'))

        assert.equal(get(HA, 'energy_reports'), '3/94/22/11/3/3')
        assert.equal(get(HA, 'energy'), 136)

        /* An 11 Wh report reads as an extended frame if the length is not checked; this is that one. */
        assert.equal(get(HA, 'energy_reports')?.toString().split('/')[3], '11')

        /* Report 1 starts a new cycle's count rather than extending the old one. */
        feed(thinq, Buffer.from('aa0b203e001600160115bb', 'hex'))
        feed(thinq, Buffer.from('aa0b203e000d00230210bb', 'hex'))
        assert.equal(get(HA, 'energy_reports'), '22/13')
        assert.equal(get(HA, 'energy'), 35)
    })

    test('the 2026-08-04 Normal cycle, which is what settled the unit', () => {
        const { HA, thinq } = setup()

        // The three reports of that cycle, byte for byte from washer-normal-20260804.jsonl. The
        // appliance ran 13:56:44 - 14:25:27, so a "167 minute" total was never possible; the plug
        // measured +0.18 kWh over the same cycle against the 164 reported here.
        feed(thinq, Buffer.from('aa0b203e008c008c01f4bb', 'hex')) // 14:10:08  140 / 140 / 1
        feed(thinq, Buffer.from('aa0b203e001800a40284bb', 'hex')) // 14:25:28   24 / 164 / 2
        assert.equal(get(HA, 'energy'), 164)

        feed(thinq, Buffer.from('aa0b203e000300a70395bb', 'hex')) // 14:40:06    3 / 167 / 3
        assert.equal(get(HA, 'energy'), 167, 'it keeps counting while the appliance idles')
        assert.equal(get(HA, 'energy_reports'), '140/24/3')
    })

    test('0xE2 carries the same cycle total at @22, from a different frame family', () => {
        // Not published - the handler ignores 0xE2 - but this is the cross-check that made the
        // energy reading independent of the plug, so the bytes are recorded here. Sent ten times,
        // 30 s before the cycle reached Complete: course 46 at @9 and @24, the options as selected
        // (3/3/2/6) at @5-@8, the nominal 35 minutes at @18 and @20, and 164 Wh at @22.
        const e2 = buf(
            'aa4b20e2034300030302062e000000000000000023002300a4002e030105000000001404000000002000009000003000' +
                '00000000000400000000000000000000000000000018000000fbbb',
        )
        const body = e2.subarray(2, e2.length - 2)
        assert.equal(body[9], 46)
        assert.equal(body[24], 46)
        assert.deepEqual([...body.subarray(5, 9)], [3, 3, 2, 6])
        assert.equal(body.readUInt16LE(18), 35)
        assert.equal(body.readUInt16LE(22), 164) // the cycle total 0x3E reported one second later
    })
})

describe('FX___S commands', () => {
    // Each expected frame is the exact bytes captured going to the appliance.
    const cases: [string, string, string, string][] = [
        ['power', 'OFF', 'aa0df0e5000201ff010200c4bb', 'power off'],
        ['power', 'ON', 'aa0df0e5000201ff010201c7bb', 'power on'],
        ['pause', '', 'aa0df0e5000201ff010302c1bb', 'pause'],
        ['course', 'TUB_CLEAN', 'aa0df0e5000201ff010a55bbbb', 'course = Tub Clean'],
        ['course', 'AI_COURSE', 'aa0df0e5000201ff010a725ebb', 'course = AI Wash'],
        ['course', 'NORMAL', 'aa0df0e5000201ff010a2e92bb', 'course = Normal'],
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

    test('selecting an extended course rebuilds the frame the app itself sent', () => {
        const { thinq, dut } = setup()
        feed(thinq, TOWELS_1_IDLE)
        thinq.resetRecorder()
        dut.setProperty('course', 'TOWELS_1')

        // Byte for byte the frame the LG app sent when it selected this course - the escape value needs
        // the real identifier and all eight option keys alongside it, and this is the only shape of that
        // write ever captured, so it is reproduced rather than guessed at.
        assert.equal(hex(thinq.outbox[0]), hex(buf('aa20f0e5000201ff0a0aff0bf61e03200421081f0035013e0143007f00002cbb')))
    })

    test('an extended course does nothing until a record has been seen', () => {
        const { thinq, dut } = setup()
        dut.setProperty('course', 'TOWELS_1')
        assert.equal(thinq.outbox.length, 0)
    })

    test('laundry care reproduces both captured frames', () => {
        const { thinq, dut } = setup()
        dut.setProperty('laundry_care', 'ON')
        dut.setProperty('laundry_care', 'OFF')
        assert.equal(hex(thinq.outbox[0]), hex(buf('aa0df0e5000201ff015701b2bb')))
        assert.equal(hex(thinq.outbox[1]), hex(buf('aa0df0e5000201ff015700b3bb')))
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

// The appliance declaring its own dial. A real frame, byte-identical in all 234 occurrences across the
// captures: ten (kind, id) pairs in dial order, with kind 0x00 on the two that need the 0xFF escape.
const COURSE_TABLE = buf('aa1e204d0302160a0272025e022e00f500f60255021b02870237028652bb')

// The same message type carrying the two extended courses' default settings, and a five-byte variant.
// Both are real frames and both must be ignored here - only the 0x03 table is the dial.
const EXT_DEFAULTS = buf(
    'aa30204d0202160200f52e01071e03200321061f00350143003e0100f65401071e03200421081f00350143003e0132bb',
)
const SHORT_VARIANT = buf('aa0b204d010301020379bb')

// The declaration the appliance sent on 2026-08-06 after the owner put every course back on the dial:
// thirty entries, and a header byte that moved from 0x16 to 0x17 - which this handler used to require
// exactly, and so threw the frame away. See TABLE_KIND.
const COURSE_TABLE_30 = buf(
    'aa46204d0302171e0272025e022e00f500f60255021b028702370286024a024c0205024e023602080246024f0206' +
        '0212026d026c0269027102410266026a025902380254bcbb',
)

// The order the appliance declares, which is the order of the dial itself.
const DIAL = [
    'AI_COURSE',
    'WOOL',
    'NORMAL',
    'NORMAL_1',
    'TOWELS_1',
    'TUB_CLEAN',
    'DUVET',
    'QUICK_STEAM_SANITIZE',
    'RINSE_SPIN',
    'QUICK_TUB_RINSE',
]

const courseOptions = (HA: MockHAConnection) =>
    (HA.devices[DEVICE_ID].config!.components.course as { options?: string[] }).options!

describe('FX___S course table', () => {
    test('the select becomes the dial, in the order the appliance gives it', () => {
        const { HA, thinq } = setup()
        assert.ok(courseOptions(HA).includes('SHIRT'), 'the seeded table offers everything at first')

        feed(thinq, COURSE_TABLE)
        // The declaration REPLACES the list: the dial is what the owner put on the appliance, and a
        // select still offering what they took off is showing something the panel does not.
        assert.deepEqual(courseOptions(HA), DIAL)
        assert.ok(!courseOptions(HA).includes('SHIRT'))
    })

    test('a declaration whose header byte has moved is read, not thrown away', () => {
        const { HA, thinq } = setup()
        feed(thinq, COURSE_TABLE_30)
        const options = courseOptions(HA)
        assert.equal(options.length, 30)
        // Dial order, as the appliance gave it: the original ten, then the twenty put back on.
        assert.deepEqual(options.slice(0, 5), ['AI_COURSE', 'WOOL', 'NORMAL', 'NORMAL_1', 'TOWELS_1'])
        assert.deepEqual(options.slice(-4), ['RAINY_DAY', 'WASHONLY', 'RINSEONLY', 'TOWELS'])
    })

    test('the two extended courses are the ones the appliance marks with kind 0x00', () => {
        const { HA, thinq, dut } = setup()
        feed(thinq, COURSE_TABLE)
        // Selecting one has to take the escape path, which is what kind 0x00 is being read as.
        feed(thinq, TOWELS_1_IDLE)
        thinq.resetRecorder()
        dut.setProperty('course', 'NORMAL_1')
        // key 0x0A = 0xFF (escape) followed by key 0x0B = 0xF5, the real identifier. The byte-for-byte
        // comparison against the app's own extended-course frame is the Towels 1 test above.
        assert.ok(hex(thinq.outbox[0]).includes('0AFF0BF5'))
        assert.ok(courseOptions(HA).includes('NORMAL_1'))
    })

    test('a declared course nobody has named is offered under its number, and none are withdrawn', () => {
        const { HA, thinq } = setup()
        // Synthesised, not captured: a hypothetical sibling model declaring one course we have a name
        // for and two we do not. Only the framing is real - incoming checksums are not verified.
        feed(thinq, buf('aa10204d03021603022e029900aa00bb'))
        // Exactly what it declared, nothing else - and the two it has no name for are offered under
        // their numbers rather than dropped.
        assert.deepEqual(courseOptions(HA), ['NORMAL', '#153', '#ext170'])
    })

    test('an unnamed declared course can actually be selected', () => {
        const { thinq, dut } = setup()
        feed(thinq, buf('aa10204d03021603022e029900aa00bb'))
        dut.setProperty('course', '#153')
        // Ordinary one-pair course write, 0x99 = 153. The trailing 0x67 is the documented checksum,
        // (sum & 0xff) ^ 0x55 over the frame with the checksum byte still zero.
        assert.equal(hex(thinq.outbox[0]), hex(buf('aa0df0e5000201ff010a9967bb')))
    })

    test('the other two variants of the message leave the select alone', () => {
        const { HA, thinq } = setup()
        const before = [...courseOptions(HA)]
        feed(thinq, EXT_DEFAULTS)
        feed(thinq, SHORT_VARIANT)
        assert.deepEqual(courseOptions(HA), before)
    })

    test('a count that disagrees with the frame length is ignored', () => {
        const { HA, thinq } = setup()
        const before = [...courseOptions(HA)]
        // Claims ten pairs and carries two. Reading it anyway would put garbage in the select.
        feed(thinq, buf('aa10204d0302160a022e029900aa00bb'))
        assert.deepEqual(courseOptions(HA), before)
    })

    test('discovery is republished once however often the declaration repeats', () => {
        const { HA, thinq } = setup()
        let publishes = 0
        const original = HA.publishConfig.bind(HA)
        HA.publishConfig = (id, config) => {
            publishes++
            original(id, config)
        }
        // The appliance sends it every 1.5 s for about half a minute at a time.
        for (let i = 0; i < 20; i++) feed(thinq, COURSE_TABLE)
        assert.equal(publishes, 1)
        assert.deepEqual(courseOptions(HA).slice(0, DIAL.length), DIAL)
    })
})

// The stale reconnect snapshot from 12:32:02 - a real frame, and the one that made this test necessary.
// The appliance is off and reports course 0, which is not a dial position: it used to be registered as a
// selectable "#0". Also the frame patches.md cites for 0xEB carrying an out-of-date power state.
const ZERO_COURSE_SNAPSHOT = buf(
    'aaff200a005500a0a7000100eb004300000000000000000000000000000000000000000000010000000000100400000000000000000000300000000000000400000000000000000000000000000018000000c467bb',
)

describe('FX___S zero course byte', () => {
    test('a course byte of 0 is not offered as a course', () => {
        const { HA, thinq } = setup()
        const before = [...courseOptions(HA)]
        feed(thinq, ZERO_COURSE_SNAPSHOT)
        assert.deepEqual(courseOptions(HA), before)
        assert.ok(!courseOptions(HA).includes('#0'))
    })

    test('it leaves the last real course standing rather than overwriting it', () => {
        const { HA, thinq } = setup()
        feed(thinq, STANDBY)
        assert.equal(get(HA, 'course'), 'AI_COURSE')
        feed(thinq, ZERO_COURSE_SNAPSHOT)
        assert.equal(get(HA, 'course'), 'AI_COURSE')
        // A record with neither a phase nor a course: the select keeps the selection, and the sensor
        // clears because this frame is the appliance saying nothing is on, not a missing reading.
        assert.equal(get(HA, 'current_course'), '-')
        // The rest of the record is still read: this frame really does say the appliance is off.
        assert.equal(get(HA, 'power'), 'OFF')
    })

    test('an extended course with a zero identifier is not offered either', () => {
        const { HA, thinq, dut } = setup()
        feed(thinq, STANDBY)
        const before = [...courseOptions(HA)]
        // Synthesised, and never seen on the wire: a record taking the 0xFF escape with a zero
        // identifier. It is here because it would have published "#ext0" for exactly the reason a zero
        // course byte published "#0" - offsets 4 and 22 are the same field in two forms.
        const rec = Buffer.alloc(66)
        rec[20] = 1 // standby
        rec[4] = 0xff // extended escape
        rec[22] = 0 // ...with no identifier behind it
        dut.processRecord(rec)
        assert.deepEqual(courseOptions(HA), before)
        assert.equal(get(HA, 'course'), 'AI_COURSE')
    })
})

describe('FX___S current course clears when nothing is running', () => {
    // A record the appliance never sent in any capture: laundry care (phase 47) is real - it is what
    // the "Laundry care when done" setting starts - but no capture caught the phase byte itself. It is
    // synthesised here because the interesting case is the ORDER 42 -> 47 -> 0, and the only thing that
    // needs to be true of the frame is its phase.
    function record(phase: number, course = 0x72) {
        const rec = Buffer.alloc(66)
        rec[20] = phase
        rec[4] = course
        return rec
    }

    test('holds the course through standby and the whole cycle', () => {
        const { HA, thinq } = setup()
        feed(thinq, STANDBY)
        assert.equal(get(HA, 'current_course'), 'AI_COURSE')
        feed(thinq, STARTED)
        assert.equal(get(HA, 'current_course'), 'AI_COURSE')
        feed(thinq, RINSING)
        assert.equal(get(HA, 'current_course'), 'AI_COURSE')
    })

    test('clears at complete, stays clear through laundry care, and stays clear when switched off', () => {
        const { HA, thinq, dut } = setup()
        feed(thinq, STANDBY)

        dut.processRecord(record(42))
        assert.equal(get(HA, 'current_course'), '-')
        // The flicker this is here to prevent: care follows complete on every cycle that ends with the
        // setting on, and restoring the name for its duration would read as a second wash starting.
        dut.processRecord(record(47))
        assert.equal(get(HA, 'current_course'), '-')
        dut.processRecord(record(0))
        assert.equal(get(HA, 'current_course'), '-')
    })

    test('never writes the placeholder to the select, which would not accept it', () => {
        const { HA, thinq, dut } = setup()
        feed(thinq, STANDBY)
        dut.processRecord(record(42))

        // '-' is not one of the select's options and Home Assistant rejects a state that is not, so the
        // select must keep the selection - which is also what the next start will actually run.
        assert.equal(get(HA, 'course'), 'AI_COURSE')
        assert.ok(!courseOptions(HA).includes('-'))
    })

    test('comes back on its own when a course is selected again', () => {
        const { HA, thinq, dut } = setup()
        feed(thinq, COMPLETE)
        assert.equal(get(HA, 'current_course'), '-')
        dut.processRecord(record(1, 0x2e))
        assert.equal(get(HA, 'current_course'), 'NORMAL')
    })
})

describe('FX___S entity names', () => {
    const nameOf = (HA: MockHAConnection, key: string) =>
        (HA.devices[DEVICE_ID].config!.components[key] as unknown as { name: string }).name

    test('the seven writable cycle settings are grouped under one prefix', () => {
        const { HA } = setup()
        assert.deepEqual(
            ['course', 'wash', 'water_temp', 'rinse', 'spin', 'steam', 'turbowash'].map((k) => nameOf(HA, k)),
            [
                'Course - Select',
                'Course - Wash',
                'Course - Water temperature',
                'Course - Rinse',
                'Course - Spin',
                'Course - Steam',
                'Course - TurboShot',
            ],
        )
    })

    test('the readings that describe the cycle keep their own names', () => {
        const { HA } = setup()
        // These report what the appliance is doing rather than setting it, so grouping them with the
        // controls would say they are adjustable.
        assert.equal(nameOf(HA, 'current_course'), 'Current course')
        assert.equal(nameOf(HA, 'energy_reports'), 'Energy per report')
        assert.equal(nameOf(HA, 'remaining_time'), 'Remaining time')
    })
})

describe('FX___S status names follow the appliance, aligned against LG on one clock', () => {
    // Every pair below was measured, not chosen: our phase byte and the LG cloud's own status for this
    // appliance were laid on one timeline across three washes (2026-07-30 from the capture, two more on
    // 2026-08-03 from Home Assistant's recorder) and a tub clean on 2026-08-07, and each of our
    // transitions had exactly one cloud transition beside it. See the table above STATUS in the handler.
    const MEASURED: [number, string][] = [
        [0, 'power_off'],
        [1, 'initial'],
        [2, 'pause'],
        [3, 'detecting'],
        [37, 'detecting'],
        [11, 'running'],
        [40, 'detecting'], // the appliance re-senses mid-wash; this is not a second name for washing
        [12, 'rinsing'],
        [14, 'spinning'],
        // The JSON calls it TUB_CLEANING and this handler published that until the appliance first
        // reached it. The cloud says `running`, and has no finer word to offer.
        [41, 'running'],
        [42, 'end'],
        [47, 'refreshing'],
    ]

    for (const [phase, name] of MEASURED) {
        test(`phase ${phase} is ${name}`, () => {
            const { HA, dut } = setup()
            const rec = Buffer.alloc(66)
            rec[20] = phase
            dut.processRecord(rec)
            assert.equal(get(HA, 'status'), name)
            assert.equal(get(HA, 'status_code'), phase)
        })
    }

    test('every name it can publish is one of the options it declared', () => {
        const { HA, dut } = setup()
        const declared = (HA.devices[DEVICE_ID].config!.components.status as unknown as { options: string[] }).options

        for (const [phase] of MEASURED) {
            const rec = Buffer.alloc(66)
            rec[20] = phase
            dut.processRecord(rec)
            assert.ok(declared.includes(String(get(HA, 'status'))), `${phase} publishes a declared option`)
        }

        // A phase we have never seen. The fallback used to be 'Unknown', which is not in the list - and
        // a sensor with device_class 'enum' has its state rejected when it is not one of the options.
        const rec = Buffer.alloc(66)
        rec[20] = 200
        dut.processRecord(rec)
        assert.equal(get(HA, 'status'), 'unknown')
        assert.ok(declared.includes('unknown'))
    })
})

describe('FX___S finish time is a timestamp, not a countdown that gives up', () => {
    test('while running it is the predicted finish', () => {
        const { HA, thinq } = setup()
        const before = Date.now()
        feed(thinq, RINSING) // 21 minutes left

        // Published on the minute, so it can sit up to half a minute either side of the raw estimate.
        const predicted = Date.parse(String(get(HA, 'end_time')))
        assert.ok(predicted >= before + 21 * 60_000 - 30_000, 'about 21 minutes out')
        assert.ok(predicted <= Date.now() + 21 * 60_000 + 30_000)
        assert.equal(new Date(predicted).getSeconds(), 0)
    })

    test('it latches at the moment the cycle completes, instead of going unknown', () => {
        const { HA, thinq } = setup()
        feed(thinq, RINSING)
        const running = String(get(HA, 'end_time'))

        const before = Date.now()
        feed(thinq, COMPLETE)
        const finished = String(get(HA, 'end_time'))

        assert.notEqual(finished, running)
        // This is what makes Home Assistant render "5 minutes ago" rather than nothing: the entity
        // has device_class 'timestamp', so a kept value is shown relative to now.
        const at = Date.parse(finished)
        assert.ok(at >= before && at <= Date.now(), 'the completion instant, not a prediction')
    })

    test('every frame that repeats Complete leaves the timestamp alone', () => {
        const { HA, thinq } = setup()
        feed(thinq, RINSING)
        feed(thinq, COMPLETE)
        const latched = String(get(HA, 'end_time'))

        // Without the transition check this would be dragged along with the clock and read
        // "0 minutes ago" forever - the appliance repeats its state for as long as it sits there.
        feed(thinq, COMPLETE)
        feed(thinq, COMPLETE)
        assert.equal(get(HA, 'end_time'), latched)
    })

    test('a restart while the washer already sits finished does not restamp it', () => {
        const { HA, thinq } = setup()
        // First frame after a restart, already Complete. That instant is the restart, not the
        // finish; the retained MQTT value still holds the real one, so publishing here would
        // overwrite a true timestamp with a false one.
        feed(thinq, COMPLETE)
        assert.equal(get(HA, 'end_time'), undefined)
    })

    test("it never publishes 'None', which is what took it to unknown", () => {
        const { HA, thinq } = setup()
        const seen: string[] = []
        for (const frame of [STANDBY, STARTED, RINSING, COMPLETE, POWERED_OFF]) {
            feed(thinq, frame)
            const value = get(HA, 'end_time')
            if (value !== undefined) seen.push(String(value))
        }
        assert.ok(!seen.includes('None'))
        // ...and switching the appliance off afterwards keeps the finish time on screen.
        assert.ok(Date.parse(String(get(HA, 'end_time'))) > 0)
    })
})

describe('FX___S finish time does not wobble while the appliance revises its own estimate', () => {
    // The 2026-08-04 cycle, from Home Assistant's own recorder: (seconds into the cycle, remaining
    // minutes as the appliance reported it). Its ticks are 43 to 74 s apart and it drops two minutes
    // at once twice - that irregularity is what moved the published timestamp 21 times.
    const TICKS: [number, number][] = [
        [0, 35],
        [17, 28],
        [19, 27],
        [73, 26],
        [133, 25],
        [193, 24],
        [253, 23],
        [313, 22],
        [387, 21],
        [402, 19],
        [476, 18],
        [523, 17],
        [601, 16],
        [639, 15],
        [649, 14],
        [729, 13],
        [789, 12],
        [883, 11],
        [931, 10],
        [974, 8],
    ]

    function runCycle() {
        const { HA, dut } = setup()
        const start = Date.now()
        const seen: string[] = []
        for (const [offset, remaining] of TICKS) {
            const rec = Buffer.alloc(66)
            rec[OFF_PHASE_FOR_TEST] = 11 // running, which is a timed phase
            rec[13] = remaining % 60
            rec[12] = Math.floor(remaining / 60)
            // The handler stamps from Date.now(); shifting it per tick is what reproduces the
            // re-anchoring, so the clock is moved rather than the record.
            const at = start + offset * 1000
            const realNow = Date.now
            Date.now = () => at
            try {
                dut.processRecord(rec)
            } finally {
                Date.now = realNow
            }
            const value = String(get(HA, 'end_time') ?? '')
            if (value && seen[seen.length - 1] !== value) seen.push(value)
        }
        return seen
    }

    const OFF_PHASE_FOR_TEST = 20

    test('a minute of hysteresis cuts twenty-one publishes to a handful', () => {
        const seen = runCycle()
        // Measured: 27 recomputes over these ticks, 21 of which HA recorded as changes. Anything in
        // single figures is the wobble gone; the exact number is not the point and is not pinned.
        assert.ok(seen.length <= 8, `published ${seen.length} times: ${seen.join(' ')}`)
        assert.ok(seen.length >= 2, 'but it must still follow the appliance revising its estimate')
    })

    test('every published value is on the minute', () => {
        for (const value of runCycle()) {
            assert.equal(new Date(value).getSeconds(), 0, `${value} carries seconds`)
            assert.equal(new Date(value).getMilliseconds(), 0)
        }
    })

    test('the revisions that survive are the real ones', () => {
        const seen = runCycle().map((v) => Date.parse(v))
        // The appliance's estimate genuinely moved - 35 minutes at the start, then 28 seventeen
        // seconds later - so the first two must differ by minutes, not seconds.
        assert.ok(Math.abs(seen[1] - seen[0]) >= 60_000)
        for (let i = 1; i < seen.length; i++) {
            assert.ok(Math.abs(seen[i] - seen[i - 1]) >= 60_000, 'no sub-minute step is ever published')
        }
    })
})

describe('FX___S names every state its own maker declares', () => {
    // LG's model JSON for this appliance declares 33 states, each with an index, and the index is this
    // byte: every one of the twelve values measured here is declared at exactly the number measured,
    // which is what licenses using the rest of that list for states this appliance has not reached.
    const DECLARED = [
        0, 1, 2, 3, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 21, 23, 27, 28, 29, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43,
        47, 48, 49,
    ]

    test('no declared state reads as unknown', () => {
        const { HA, dut } = setup()
        const declared = (HA.devices[DEVICE_ID].config!.components.status as unknown as { options: string[] }).options

        for (const phase of DECLARED) {
            const rec = Buffer.alloc(66)
            rec[20] = phase
            dut.processRecord(rec)
            const name = String(get(HA, 'status'))
            assert.notEqual(name, 'unknown', `phase ${phase} has no name`)
            assert.ok(declared.includes(name), `phase ${phase} publishes ${name}, which is not an option`)
        }
    })

    test('the two that matter are named', () => {
        const { HA, dut } = setup()
        const rec = Buffer.alloc(66)

        // A delay-end reservation counting down.
        rec[20] = 7
        dut.processRecord(rec)
        assert.equal(get(HA, 'status'), 'reserved')

        // A finished cycle on a machine that does NOT leave remote control on. This owner's washer
        // always finishes on 42, which the JSON calls END_REMOTE_MAINTAIN_ON; 16 is the plain END and
        // used to publish 'unknown'.
        rec[20] = 16
        dut.processRecord(rec)
        assert.equal(get(HA, 'status'), 'end')
    })

    test('a byte outside the declaration still falls back rather than inventing a name', () => {
        const { HA, dut } = setup()
        const rec = Buffer.alloc(66)
        rec[20] = 200
        dut.processRecord(rec)
        assert.equal(get(HA, 'status'), 'unknown')
    })
})

describe('FX___S delay-end reservation', () => {
    // The two frames the LG app sent on 2026-08-04 while a capture ran, byte for byte, with the owner
    // setting 5 hours and then 5 hours 30. The appliance's record answered 300 and then 330 - which is
    // what those are in minutes - so both directions are pinned by the same labelled action.
    const APP_SET_5H = buf('aa1cf0e5000201ff081e03200221061f0335013e0043007f012cc1bb')
    const APP_SET_5H30 = buf('aa1cf0e5000201ff081e03200221061f0335013e0043007f014ae7bb')

    // The record the appliance was holding when the app sent those: AI Wash, normal/40/2/high, turbo
    // on, steam off. Reproduced here because the write is built from the last record.
    function idle(minutes = 0, flag = false) {
        const rec = Buffer.alloc(66)
        rec[0] = 3 // wash normal
        rec[1] = 3 // 40 degrees
        rec[2] = 2 // two rinses
        rec[3] = 6 // high spin
        rec[4] = 0x72 // AI Wash
        rec[20] = 1 // standby
        rec[33] = 0x20 // turboshot on
        rec[10] = (minutes >> 8) & 0xff
        rec[11] = minutes & 0xff
        if (flag) rec[38] = 0x80
        return rec
    }

    test('reads the reservation as hours', () => {
        const { HA, dut } = setup()
        dut.processRecord(idle(300, true))
        assert.equal(get(HA, 'reservation'), 5)
        dut.processRecord(idle(330, true))
        assert.equal(get(HA, 'reservation'), 5.5)
        // 2026-07-30, the only other record in four captures with the flag set.
        dut.processRecord(idle(210, true))
        assert.equal(get(HA, 'reservation'), 3.5)
    })

    test('reads no reservation as zero, and ignores a stale count without the flag', () => {
        const { HA, dut } = setup()
        dut.processRecord(idle(0, false))
        assert.equal(get(HA, 'reservation'), 0)
        dut.processRecord(idle(330, false))
        assert.equal(get(HA, 'reservation'), 0)
    })

    test('writing 5 hours reproduces the frame the app sent', () => {
        const { thinq, dut } = setup()
        dut.processRecord(idle())
        thinq.resetRecorder()
        dut.setProperty('reservation', '5')
        assert.equal(hex(thinq.outbox[0]), hex(APP_SET_5H))
    })

    test('writing 5.5 hours reproduces the second frame', () => {
        const { thinq, dut } = setup()
        dut.processRecord(idle())
        thinq.resetRecorder()
        dut.setProperty('reservation', '5.5')
        assert.equal(hex(thinq.outbox[0]), hex(APP_SET_5H30))
    })

    test('zero is sent - it is the value the app itself uses for "none"', () => {
        const { thinq, dut } = setup()
        dut.processRecord(idle())
        thinq.resetRecorder()
        dut.setProperty('reservation', '0')
        // The same frame with the 16-bit field at zero, which is the shape the extended-course capture
        // carried: ... 7f 00 00 <checksum> BB.
        const sent = thinq.outbox[0]
        assert.deepEqual([...sent.subarray(sent.length - 5, sent.length - 2)], [0x7f, 0x00, 0x00])
    })

    test('refuses what the appliance declares out of range rather than sending it', () => {
        const { thinq, dut } = setup()
        dut.processRecord(idle())
        thinq.resetRecorder()
        dut.setProperty('reservation', '2') // below the declared 3 h
        dut.setProperty('reservation', '20') // above the declared 19 h
        dut.setProperty('reservation', '5.25') // not a half hour
        assert.equal(thinq.outbox.length, 0)
    })

    test('does nothing until a record has been seen', () => {
        const { thinq, dut } = setup()
        dut.setProperty('reservation', '5')
        assert.equal(thinq.outbox.length, 0)
    })
})

describe('FX___S reservation armed on the appliance itself', () => {
    // The record the washer sent at 2026-08-04 18:21:28, the moment a three-hour reservation was armed
    // on the panel: phase 1 -> 7, the reservation 330 -> 180 minutes, and the flags byte 0 -> 128.
    function armed() {
        const rec = Buffer.alloc(66)
        rec[4] = 0x72
        rec[10] = 0
        rec[11] = 180
        rec[20] = 7
        rec[21] = 1
        rec[36] = 0x80
        rec[38] = 0x80
        return rec
    }

    test('phase 7 is what the model JSON called RESERVED, and it really happens', () => {
        const { HA, dut } = setup()
        dut.processRecord(armed())
        assert.equal(get(HA, 'status'), 'reserved')
        assert.equal(get(HA, 'status_code'), 7)
        assert.equal(get(HA, 'reservation'), 3)
    })

    test('the drum is not reported as turning for the hours a reservation waits', () => {
        const { HA, dut } = setup()
        dut.processRecord(armed())
        // Bit 0x80 is set for the whole reservation - five records over three minutes on
        // 2026-08-04, never clearing, while the appliance stood still. A sensing tumble would have
        // ended and said so, because a reservation emits a record every minute as it counts down.
        assert.equal(get(HA, 'drum_active'), 'OFF')
        // Running is a different question and answers it correctly: a reservation has not started.
        assert.equal(get(HA, 'running'), 'OFF')
    })

    test('the bit still means the drum in the phases where that was measured', () => {
        const { HA, thinq } = setup()
        feed(thinq, STARTED) // phase 3, flags 0x80
        assert.equal(get(HA, 'drum_active'), 'ON')
    })

    test('the finish time counts the reservation, not the cycle length', () => {
        const { HA, dut } = setup()
        const before = Date.now()
        // 18:45:21 exactly: seven hours to go, on a cycle whose own length reads 30 minutes.
        const rec = armed()
        rec[10] = 1
        rec[11] = 163 // 419 minutes
        rec[12] = 0
        rec[13] = 30 // the cycle is half an hour, and that is NOT when it finishes
        dut.processRecord(rec)

        const at = Date.parse(String(get(HA, 'end_time')))
        assert.ok(at >= before + 419 * 60_000 - 30_000, 'about seven hours out, not thirty minutes')
        assert.ok(at <= Date.now() + 419 * 60_000 + 30_000)
        // ...and the remaining-time sensor stays out of it: the cycle has not started.
        assert.equal(get(HA, 'remaining_time'), 0)
    })

    test('it counts down a minute at a time without the reservation setpoint jittering', () => {
        const { HA, dut } = setup()
        const seen = new Set<string>()
        for (const minutes of [420, 419, 418, 417, 416]) {
            const rec = armed()
            rec[10] = (minutes >> 8) & 0xff
            rec[11] = minutes & 0xff
            dut.processRecord(rec)
            seen.add(String(get(HA, 'reservation')))
        }
        // Published in half hours, so a minute of countdown does not move it.
        assert.deepEqual([...seen], ['7'])
    })

    test('powering off clears the reservation, as it did on 2026-07-30 and again today', () => {
        const { HA, dut } = setup()
        dut.processRecord(armed())
        assert.equal(get(HA, 'reservation'), 3)
        dut.processRecord(Buffer.alloc(66)) // phase 0, everything zero
        assert.equal(get(HA, 'reservation'), 0)
        assert.equal(get(HA, 'status'), 'power_off')
    })
})

describe('FX___S course names are the ones LG itself uses', () => {
    test('the six the model JSON names are named its way', () => {
        const { HA, thinq } = setup()
        feed(thinq, STANDBY)
        // LG's Course section calls 이불 DUVET, not BEDDING - taking its word for it is the whole
        // point of using its keys.
        assert.equal(get(HA, 'current_course'), 'AI_COURSE')
        const options = (HA.devices[DEVICE_ID].config!.components.course as unknown as { options: string[] }).options
        for (const key of ['NORMAL', 'WOOL', 'DUVET', 'TUB_CLEAN', 'RINSE_SPIN']) assert.ok(options.includes(key), key)
    })

    test('the four it cannot name are ours, and say so in the code', () => {
        const { HA } = setup()
        const options = (HA.devices[DEVICE_ID].config!.components.course as unknown as { options: string[] }).options
        for (const key of ['QUICK_STEAM_SANITIZE', 'QUICK_TUB_RINSE', 'NORMAL_1', 'TOWELS_1'])
            assert.ok(options.includes(key), key)
    })

    test('a write still accepts the names this handler used to publish', () => {
        // An automation that SETS a course keeps working across the rename; only comparisons against
        // the published state have to be updated.
        for (const [name, frame] of [
            ['NORMAL', 'aa0df0e5000201ff010a2e92bb'],
            ['Normal', 'aa0df0e5000201ff010a2e92bb'],
            ['AI_COURSE', 'aa0df0e5000201ff010a725ebb'],
            ['AI Wash', 'aa0df0e5000201ff010a725ebb'],
            ['Tub Clean', 'aa0df0e5000201ff010a55bbbb'],
        ] as const) {
            const { thinq, dut } = setup()
            dut.setProperty('course', name)
            assert.equal(hex(thinq.outbox[0]), hex(buf(frame)), name)
        }
    })

    test('an extended course takes the old name too', () => {
        for (const name of ['TOWELS_1', 'Towels 1']) {
            const { thinq, dut } = setup()
            feed(thinq, TOWELS_1_IDLE)
            thinq.resetRecorder()
            dut.setProperty('course', name)
            assert.equal(
                hex(thinq.outbox[0]),
                hex(buf('aa20f0e5000201ff0a0aff0bf61e03200421081f0035013e0143007f00002cbb')),
                name,
            )
        }
    })
})

describe("FX___S the dial is the owner's, not the appliance's", () => {
    // Same appliance, twenty minutes apart on 2026-08-06: thirty courses with revision 0x17, then
    // twenty with 0x18 after ten were taken back off. The count went down and the byte went up, which
    // is what says it counts edits rather than describing the contents.
    const DECLARED_20 = buf(
        'aa32204d030218140272025e022e00f500f60255021b028702370286024a024c0205024e023602080246024f02060212' + '5abb',
    )

    test('a declaration with a higher revision and fewer courses is still read', () => {
        const { HA, thinq } = setup()
        feed(thinq, COURSE_TABLE_30)
        assert.equal(courseOptions(HA).length, 30)

        feed(thinq, DECLARED_20)
        // The twenty it now declares lead, in dial order...
        assert.deepEqual(courseOptions(HA).slice(0, 3), ['AI_COURSE', 'WOOL', 'NORMAL'])
        assert.equal(courseOptions(HA)[19], 'COLORCARE')
    })

    test('the ten taken off the dial leave the list with it', () => {
        const { HA, thinq } = setup()
        feed(thinq, COURSE_TABLE_30)
        assert.equal(courseOptions(HA).length, 30)

        feed(thinq, DECLARED_20)
        assert.equal(courseOptions(HA).length, 20)
        for (const gone of ['TOWELS', 'SHIRT', 'RINSEONLY', 'SINGLE_GARMENTS'])
            assert.ok(!courseOptions(HA).includes(gone), gone)
    })

    test('...except whatever is selected right now, which has to stay offered', () => {
        const { HA, thinq, dut } = setup()
        feed(thinq, COURSE_TABLE_30)

        // TOWELS selected, then taken off the dial. Home Assistant rejects a select state that is not
        // one of its options, so dropping it here would leave the entity unable to report itself.
        const rec = Buffer.alloc(66)
        rec[20] = 1
        rec[4] = 0x54
        dut.processRecord(rec)
        feed(thinq, DECLARED_20)

        assert.equal(get(HA, 'course'), 'TOWELS')
        assert.ok(courseOptions(HA).includes('TOWELS'))
        assert.equal(courseOptions(HA).length, 21)
    })
})

describe('FX___S a course off the dial can still be selected', () => {
    // Measured 2026-08-06 with the dial cut back to twenty: SHIRT (108) and SWEAT_STAIN (113) are on
    // neither the dial nor the base of any extended course, and the appliance took both - status 0x00
    // and a record carrying the course with its own default options. That is why courseOptions keeps
    // courses the dial has dropped: they are reachable, not dead entries.
    test('an ordinary course write goes out for one the declaration no longer lists', () => {
        const { thinq, dut } = setup()
        feed(
            thinq,
            buf(
                'aa32204d030218140272025e022e00f500f60255021b028702370286024a024c0205024e023602080246024f02060212' +
                    '5abb',
            ),
        )
        thinq.resetRecorder()

        dut.setProperty('course', 'SHIRT')
        // key 0x0A = 0x6C. Byte for byte the frame the appliance accepted.
        assert.equal(hex(thinq.outbox[0]), hex(buf('aa0df0e5000201ff010a6c50bb')))
    })

    test('but the select no longer offers it, because the dial does not', () => {
        const { HA, thinq } = setup()
        feed(
            thinq,
            buf(
                'aa32204d030218140272025e022e00f500f60255021b028702370286024a024c0205024e023602080246024f02060212' +
                    '5abb',
            ),
        )
        // The write above still works - a name this handler knows resolves whatever the dial says -
        // but Home Assistant validates select_option against the options, so from the UI it is the
        // dial that decides. That is the point of syncing: the select shows the panel.
        assert.ok(!courseOptions(HA).includes('SHIRT'))
        assert.ok(!courseOptions(HA).includes('TOWELS'))
    })
})

describe('FX___S two settings of the appliance rather than of a cycle', () => {
    // Labelled 2026-08-07 00:27, one at a time: the owner named each switch, turned it on, waited, and
    // turned it off. Both writes echoed in the record and both came back to where they started.
    test('course auto-optimisation is key 0x4C and bit 0x08 of byte 39', () => {
        const { HA, thinq, dut } = setup()

        const rec = Buffer.alloc(66)
        rec[20] = 1
        rec[39] = 0x34 // as captured with it off
        dut.processRecord(rec)
        assert.equal(get(HA, 'auto_optimise'), 'OFF')

        rec[39] = 0x3c // ...and on
        dut.processRecord(rec)
        assert.equal(get(HA, 'auto_optimise'), 'ON')

        thinq.resetRecorder()
        dut.setProperty('auto_optimise', 'ON')
        dut.setProperty('auto_optimise', 'OFF')
        assert.equal(hex(thinq.outbox[0]), hex(buf('aa0df0e5000201ff014c0189bb')))
        assert.equal(hex(thinq.outbox[1]), hex(buf('aa0df0e5000201ff014c008ebb')))
    })

    test('the clock while switched off is key 0x58 and bit 0x80 of byte 46', () => {
        const { HA, thinq, dut } = setup()

        const rec = Buffer.alloc(66)
        rec[20] = 1
        rec[46] = 0x04 // captured: laundry care off, clock off
        dut.processRecord(rec)
        assert.equal(get(HA, 'clock_when_off'), 'OFF')
        assert.equal(get(HA, 'laundry_care'), 'OFF')

        rec[46] = 0x84 // clock on, laundry care still off - one byte, two settings
        dut.processRecord(rec)
        assert.equal(get(HA, 'clock_when_off'), 'ON')
        assert.equal(get(HA, 'laundry_care'), 'OFF')

        rec[46] = 0x8c // both on
        dut.processRecord(rec)
        assert.equal(get(HA, 'clock_when_off'), 'ON')
        assert.equal(get(HA, 'laundry_care'), 'ON')

        thinq.resetRecorder()
        dut.setProperty('clock_when_off', 'ON')
        dut.setProperty('clock_when_off', 'OFF')
        assert.equal(hex(thinq.outbox[0]), hex(buf('aa0df0e5000201ff015801bdbb')))
        assert.equal(hex(thinq.outbox[1]), hex(buf('aa0df0e5000201ff015800b2bb')))
    })
})

describe('FX___S the cycle options are a setting and a reading, not one entity doing both', () => {
    // Byte 33 bit 0x20 is TurboShot, byte 34 bit 0x10 is steam, byte 46 bit 0x08 is laundry care.
    function record(phase: number, { turbo = false, steam = false, care = false } = {}) {
        const rec = Buffer.alloc(66)
        rec[20] = phase
        rec[4] = 0x2e
        if (turbo) rec[33] = 0x20
        if (steam) rec[34] = 0x10
        rec[46] = care ? 0x0c : 0x04 // 0x04 is the constant this byte always carries
        return rec
    }

    test('the switches take the selection from standby', () => {
        const { HA, dut } = setup()
        dut.processRecord(record(1, { turbo: true, steam: true }))
        assert.equal(get(HA, 'turbowash'), 'ON')
        assert.equal(get(HA, 'steam'), 'ON')
    })

    test('and hold it when the appliance zeroes the bytes at the end of the cycle', () => {
        const { HA, dut } = setup()
        dut.processRecord(record(1, { turbo: true }))
        assert.equal(get(HA, 'turbowash'), 'ON')

        // Measured in both full cycles on disk: the option bytes survive every working phase and are
        // zeroed on the move into Complete. Published unconditionally this read as the appliance
        // switching TurboShot off by itself, which is what Home Assistant's history recorded on four
        // separate cycles.
        dut.processRecord(record(11, { turbo: true }))
        assert.equal(get(HA, 'turbowash'), 'ON')
        dut.processRecord(record(42))
        assert.equal(get(HA, 'turbowash'), 'ON')
        dut.processRecord(record(0))
        assert.equal(get(HA, 'turbowash'), 'ON')

        // The next standby is the next selection, and it is followed.
        dut.processRecord(record(1))
        assert.equal(get(HA, 'turbowash'), 'OFF')
    })

    test('the sensors answer the other question: what is this cycle running with', () => {
        const { HA, dut } = setup()
        dut.processRecord(record(1, { turbo: true, steam: true }))
        // Nothing is under way at standby, so they say so rather than repeating the switches.
        assert.equal(get(HA, 'turbowash_active'), 'OFF')
        assert.equal(get(HA, 'steam_active'), 'OFF')

        dut.processRecord(record(11, { turbo: true, steam: true }))
        assert.equal(get(HA, 'turbowash_active'), 'ON')
        assert.equal(get(HA, 'steam_active'), 'ON')

        // Still mid-cycle: a pause is excluded from `running` on purpose, but the cycle is unchanged.
        dut.processRecord(record(2, { turbo: true, steam: true }))
        assert.equal(get(HA, 'running'), 'OFF')
        assert.equal(get(HA, 'turbowash_active'), 'ON')

        dut.processRecord(record(42))
        assert.equal(get(HA, 'turbowash_active'), 'OFF')
        assert.equal(get(HA, 'steam_active'), 'OFF')
    })

    test('laundry care keeps its switch live, because the setting is not consumed by a cycle', () => {
        const { HA, dut } = setup()
        // 2026-07-30: switched on at Complete, still on through the whole of the next wash, cleared
        // only by switching the appliance off. Gating this to standby would go stale exactly where
        // the owner uses it.
        dut.processRecord(record(42, { care: true }))
        assert.equal(get(HA, 'laundry_care'), 'ON')
        dut.processRecord(record(12, { care: true }))
        assert.equal(get(HA, 'laundry_care'), 'ON')
        dut.processRecord(record(0))
        assert.equal(get(HA, 'laundry_care'), 'OFF')
    })

    test('and takes its running state from the phase, which is the appliance own word', () => {
        const { HA, dut } = setup()
        dut.processRecord(record(42, { care: true }))
        assert.equal(get(HA, 'laundry_care_active'), 'OFF')
        // 47 is LG's LAUNDRYCARE, the state the cloud reports as `refreshing`.
        dut.processRecord(record(47, { care: true }))
        assert.equal(get(HA, 'laundry_care_active'), 'ON')
        dut.processRecord(record(0))
        assert.equal(get(HA, 'laundry_care_active'), 'OFF')
    })

    test('the switches still write the same two keys', () => {
        const { thinq, dut } = setup()
        dut.setProperty('steam', 'ON')
        dut.setProperty('turbowash', 'ON')
        assert.equal(hex(thinq.outbox[0]), hex(buf('aa0df0e5000201ff013e019bbb')))
        assert.equal(hex(thinq.outbox[1]), hex(buf('aa0df0e5000201ff01350190bb')))
    })
})

describe('FX___S course names in the configured language', () => {
    function setupIn(language?: string) {
        const HA = new MockHAConnection()
        HA.config = { language }
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const dut = new DUT(HA.asConnection(), thinq, META)
        return { HA, thinq, dut }
    }

    test('English by default, Korean when asked', () => {
        const { HA: en, thinq: te } = setupIn()
        feed(te, STANDBY)
        assert.equal(get(en, 'current_course'), 'AI_COURSE')

        const { HA: ko, thinq: tk } = setupIn('ko')
        feed(tk, STANDBY)
        // Without the space LG's own model JSON puts in it - the owner's word, since it is their panel.
        assert.equal(get(ko, 'current_course'), '인공지능세탁')
    })

    test('the wash scale is named in that language too, and only that one', () => {
        const { HA: en, thinq: te } = setupIn()
        feed(te, STANDBY)
        assert.equal(get(en, 'wash'), 'normal')

        const { HA: ko, thinq: tk } = setupIn('ko')
        feed(tk, STANDBY)
        assert.equal(get(ko, 'wash'), '표준')
        assert.deepEqual((ko.devices[DEVICE_ID].config!.components.wash as { options?: string[] }).options, [
            '안함',
            '적은 때',
            '표준',
            '강력',
            '애벌',
            '불림',
        ])
        // The advisory attributes speak the same vocabulary, or the sensor would name values the
        // select does not offer. AI Wash allows two of the six.
        assert.deepEqual(JSON.parse(String(get(ko, 'available_options_attrs'))).wash, ['표준', '불림'])
        // Untouched: the owner asked for the wash scale, and each of these would change an entity
        // state that automations may compare against.
        assert.equal(get(ko, 'spin'), 'high')
        assert.equal(get(ko, 'water_temp'), '40')
        assert.equal(get(ko, 'beep'), 'very_high')
    })

    test('a wash write takes either vocabulary, so an automation setting the old name survives', () => {
        for (const language of [undefined, 'ko']) {
            for (const name of ['normal', '표준']) {
                const { thinq, dut } = setupIn(language)
                dut.setProperty('wash', name)
                assert.equal(hex(thinq.outbox[0]), hex(buf('aa0df0e5000201ff011e03e5bb')), `${language} <- ${name}`)
            }
        }
    })

    test('the dial the appliance declares is named in that language too', () => {
        const { HA, thinq } = setupIn('ko')
        feed(thinq, COURSE_TABLE)
        assert.deepEqual(courseOptions(HA), [
            '인공지능세탁',
            '울/섬세',
            '표준',
            '표준1',
            '타월1',
            '통살균',
            '이불',
            '쾌속스팀살균',
            '헹굼+탈수',
            '급속통헹굼',
        ])
    })

    test('the course renamed on 2026-08-09 still answers to the spelling it had', () => {
        const { thinq, dut } = setupIn('ko')
        dut.setProperty('course', '인공지능 세탁')
        assert.equal(hex(thinq.outbox[0]), hex(buf('aa0df0e5000201ff010a725ebb')))
    })

    test('a write takes any name this handler knows, in either language and the old ones', () => {
        for (const language of [undefined, 'ko']) {
            for (const name of ['NORMAL', '표준', 'Normal']) {
                const { thinq, dut } = setupIn(language)
                dut.setProperty('course', name)
                assert.equal(hex(thinq.outbox[0]), hex(buf('aa0df0e5000201ff010a2e92bb')), `${language} <- ${name}`)
            }
        }
    })

    test('an unnamed course keeps its number, and an extended one says so', () => {
        const { HA, thinq } = setupIn('ko')
        // 0x99 is on no dial we have swept; 0xAA is an extended id we have never seen.
        feed(thinq, buf('aa10204d03021603022e029900aa00bb'))
        assert.deepEqual(courseOptions(HA), ['표준', '#153', '#ext170'])
    })
})

describe('FX___S the operation buttons say when they can be used', () => {
    const avail = (HA: MockHAConnection, name: string) => get(HA, `${name}-availability`)

    function record(phase: number, remote = true) {
        const rec = Buffer.alloc(66)
        rec[20] = phase
        if (remote) rec[36] = 0x10 // FLAG_REMOTE_CONTROL
        return rec
    }

    test('all three are available before the appliance has said anything', () => {
        const { HA } = setup()
        // An MQTT entity whose availability topic was never published reads as unavailable, so the
        // honest default has to be published at startup rather than waited for.
        for (const name of ['start', 'pause', 'resume']) assert.equal(avail(HA, name), 'online')
    })

    test('standby offers start, and nothing else', () => {
        const { HA, dut } = setup()
        dut.processRecord(record(1))
        assert.equal(avail(HA, 'start'), 'online')
        assert.equal(avail(HA, 'pause'), 'offline')
        assert.equal(avail(HA, 'resume'), 'offline')
    })

    test('a running cycle offers pause, and neither of the others', () => {
        const { HA, dut } = setup()
        dut.processRecord(record(11))
        assert.equal(avail(HA, 'pause'), 'online')
        assert.equal(avail(HA, 'start'), 'offline')
        assert.equal(avail(HA, 'resume'), 'offline')
    })

    test('paused offers resume', () => {
        const { HA, dut } = setup()
        dut.processRecord(record(2))
        assert.equal(avail(HA, 'resume'), 'online')
        assert.equal(avail(HA, 'pause'), 'offline')
    })

    test('remote control off takes start and resume away, but not pause', () => {
        const { HA, dut } = setup()
        dut.processRecord(record(1, false))
        assert.equal(avail(HA, 'start'), 'offline')

        dut.processRecord(record(2, false))
        assert.equal(avail(HA, 'resume'), 'offline')

        // Pause is NOT gated on it: whether the appliance needs remote control for a pause has never
        // been measured, and greying out a control that might work is worse than a log line.
        dut.processRecord(record(11, false))
        assert.equal(avail(HA, 'pause'), 'online')
    })

    test('switched off, start is not offered either', () => {
        const { HA, dut } = setup()
        dut.processRecord(record(0))
        assert.equal(avail(HA, 'start'), 'offline')
    })

    test('the buttons declare the two device topics as well as their own', () => {
        const { HA } = setup()
        for (const name of ['start', 'pause', 'resume']) {
            const comp = HA.devices[DEVICE_ID].config!.components[name] as unknown as {
                availability: { topic: string }[]
                availability_mode: string
            }
            // A component's availability REPLACES the device-level list, so both device topics have
            // to be repeated or the button stops following the device's own online/offline.
            assert.deepEqual(
                comp.availability.map((a) => a.topic),
                ['$this/availability', '$rethink/availability', `$this/${name}-availability`],
            )
            assert.equal(comp.availability_mode, 'all')
        }
    })
})

describe('FX___S the two moments it announces', () => {
    // All four 0x72 frames the appliance sent during washer-notify-20260807.jsonl, verbatim. The two
    // that are published were each timed against the LG cloud's own push for the same instant:
    // 00 -> washing_is_complete (+1.86 s), 64 -> error_during_washing (+1.36 s).
    const COMPLETE_NOTIFY = buf('aa09207200000010bb')
    const ERROR_NOTIFY = buf('aa0c2072006403000000fabb')
    // Sent 34 s after a power-off and 16 s before another. Assumed to be the door opening and closing
    // until the owner opened and closed it three times and produced neither. Nobody has named these.
    const NOTIFY_201 = buf('aa09207200c9005bbb')
    const NOTIFY_200 = buf('aa09207200c80058bb')

    // The record carrying the door fault, captured 2026-08-07 15:22:30 - the owner had just tried to
    // start a cycle with the door open. Byte 18 reads 20, which is DE1 in LG's own error enum.
    const DOOR_ERROR_RECORD = buf(
        'aaff200a009800c3fc000100ec00860000000000370000000000000000010000001d0037002a110000000000030000000000000000000034000000000000040000000000000000000000000000001800000000030302067200000000000000002400240000147202031b000000020003000000002000000000003400000000000004000000000000000000000000000000180000006ad0bb',
    )

    /** Counts publishes per topic, which the mock's last-value-wins map cannot show. */
    function counting(HA: MockHAConnection) {
        const counts: Record<string, number> = {}
        const inner = HA.publishProperty.bind(HA)
        HA.publishProperty = (id: string, property: string, value: string | number) => {
            counts[property] = (counts[property] ?? 0) + 1
            return inner(id, property, value)
        }
        return counts
    }

    const eventType = (HA: MockHAConnection, topic: string) => JSON.parse(String(get(HA, topic))).event_type as string

    test('a finished cycle announces itself, half a minute before the phase says so', () => {
        const { HA, thinq } = setup()
        feed(thinq, COMPLETE_NOTIFY)
        assert.equal(eventType(HA, 'notification'), 'washing_is_complete')
        // ...and nothing about the state has moved: this frame carries no record.
        assert.equal(get(HA, 'status'), undefined)
    })

    test('the second wash of the day announces itself too', () => {
        const { HA, thinq } = setup()
        const counts = counting(HA)
        feed(thinq, COMPLETE_NOTIFY)
        feed(thinq, COMPLETE_NOTIFY)
        // publishProperty drops a repeat of the value it last sent, which is right for state and
        // would have swallowed this one - the two payloads are the same string. See publishEvent.
        assert.equal(counts['notification'], 2)
    })

    test('an error is a different announcement from a finished cycle', () => {
        const { HA, thinq } = setup()
        feed(thinq, ERROR_NOTIFY)
        assert.equal(eventType(HA, 'notification'), 'error_during_washing')
    })

    test('the two values nobody has ever labelled fire nothing at all', () => {
        const { HA, thinq } = setup()
        feed(thinq, NOTIFY_200)
        feed(thinq, NOTIFY_201)
        assert.equal(get(HA, 'notification'), undefined)
    })

    test('the fault names itself, and it is the name the official integration uses', () => {
        const { HA, thinq, dut } = setup()
        feed(thinq, STANDBY) // a record with no fault first, so the next one is a MOVE
        feed(thinq, DOOR_ERROR_RECORD)
        assert.equal(eventType(HA, 'error'), 'door_open_error')
        assert.equal(dut.lastRecord?.[18], 20) // DE1, straight out of LG's model JSON
    })

    test('it fires on the move into the fault, not on every record reporting it', () => {
        const { HA, thinq } = setup()
        feed(thinq, STANDBY)
        const counts = counting(HA)
        feed(thinq, DOOR_ERROR_RECORD)
        feed(thinq, DOOR_ERROR_RECORD)
        assert.equal(counts['error'], 1)
    })

    test('a fault already present in the very first record is not fired', () => {
        const { HA, thinq } = setup()
        // The instant this arrives is the reconnect, not the fault - the same call the finish-time
        // latch makes for a cycle that is already Complete when the first frame lands.
        feed(thinq, DOOR_ERROR_RECORD)
        assert.equal(get(HA, 'error'), undefined)
    })

    test('a fault that clears and comes back fires again', () => {
        const { HA, thinq, dut } = setup()
        feed(thinq, STANDBY)
        const counts = counting(HA)
        feed(thinq, DOOR_ERROR_RECORD)
        feed(thinq, STANDBY) // cleared
        feed(thinq, DOOR_ERROR_RECORD)
        assert.equal(counts['error'], 2)
        assert.equal(dut.lastRecord?.[18], 20)
    })

    test('a code LG does not declare still publishes something Home Assistant will accept', () => {
        const { HA, dut } = setup()
        dut.processRecord(Buffer.alloc(66))
        const rec = Buffer.alloc(66)
        rec[18] = 99
        dut.processRecord(rec)
        assert.equal(eventType(HA, 'error'), 'unknown_error')
    })

    test('both entities declare every type they can publish', () => {
        const { HA } = setup()
        const components = HA.devices[DEVICE_ID].config!.components as unknown as Record<
            string,
            { platform: string; event_types: string[] }
        >

        assert.equal(components.notification.platform, 'event')
        assert.deepEqual(components.notification.event_types, ['washing_is_complete', 'error_during_washing'])

        assert.equal(components.error.platform, 'event')
        // An event_type that is not declared is dropped by Home Assistant, so the fallback the
        // handler falls back to has to be in the list or an unknown fault would vanish silently.
        assert.ok(components.error.event_types.includes('door_open_error'))
        assert.ok(components.error.event_types.includes('unknown_error'))
        // Nine names shared with the official integration, ten of LG's own codes, one fallback.
        assert.equal(components.error.event_types.length, 20)
    })
})

describe('FX___S a tub clean is a running cycle', () => {
    // 2026-08-07, the first time this appliance ever reached phase 41 - 통살균, 84 minutes. It had a
    // name taken from the model JSON and a place in none of the phase sets, and all of that showed at
    // once: a status the official integration has no word for, `running` off while the machine drew
    // 1.8 kW, no remaining time, a finish time still holding the previous day's cycle, Pause greyed
    // out - and Start offered in the middle of a running cycle.
    //
    // The numbers below are that run: our byte went 1 -> 41 at 12:47:48.667 and the cloud went
    // initial -> running at 12:47:49.512, and both integrations read the total as 84.
    const tubClean = () => {
        const rec = Buffer.alloc(66)
        rec[20] = 41
        rec[36] = 0x10 // remote control on, as it was
        rec[12] = 1
        rec[13] = 22 // 82 minutes left, which is where the cloud put the finish
        rec[14] = 1
        rec[15] = 24 // of 84
        return rec
    }

    test('it is called what the cloud calls it, and the appliance is working', () => {
        const { HA, dut } = setup()
        dut.processRecord(tubClean())
        assert.equal(get(HA, 'status'), 'running')
        // The raw byte still tells 41 apart from 11 for anyone who needs to.
        assert.equal(get(HA, 'status_code'), 41)
        assert.equal(get(HA, 'running'), 'ON')
    })

    test('its clock is live, so the finish time is this cycle and not the last one', () => {
        const { HA, dut } = setup()
        const before = Date.now()
        dut.processRecord(tubClean())
        assert.equal(get(HA, 'remaining_time'), 82)
        assert.equal(get(HA, 'total_time'), 84)
        const at = Date.parse(String(get(HA, 'end_time')))
        assert.ok(at >= before + 82 * 60_000 - 60_000, 'about 82 minutes out')
        assert.ok(at <= Date.now() + 82 * 60_000 + 60_000)
    })

    test('it offers pause, and does not offer start', () => {
        const { HA, dut } = setup()
        dut.processRecord(tubClean())
        assert.equal(get(HA, 'pause-availability'), 'online')
        // The one that was actually dangerous: start was live for the whole of the cycle.
        assert.equal(get(HA, 'start-availability'), 'offline')
        assert.equal(get(HA, 'resume-availability'), 'offline')
    })
})
