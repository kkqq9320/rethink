import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2REFO1DBN3__U'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2REFO1DBN3__U'
const META: Metadata = { modelId: MODEL_ID, modelName: '2REFO1DBN3__U', swVersion: '' }

// Every frame below is verbatim from fridge-probe-20260806.jsonl / fridge-app-writes-20260806.jsonl,
// captured on the owner's appliance while they operated it and named what they were doing.

// 17:38:53 KST. AA 88 10 EC <prev 65> <cur 65> <cksum> BB.
// current: [1]=7 -> 1C, [2]=1 -> -15C, [3]=1 express off, [7]=1 door OPEN, [8]=1 Celsius,
//          [17]=1 smart care on, [40]=1 beep on.
const SAMPLE_STATUS = buf(
    'AA8810EC' +
        '02070101FFFFFF00010001FFFFFFFFFFFF01FFFFFFFFFFFFFFFF020101FF00FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078' +
        '02070101FFFFFF01010001FFFFFFFFFFFF01FFFFFFFFFFFFFFFF020101FF00FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078' +
        'B0BB',
)

// The final door sweep (20:18:44 - 20:19:03 KST), owner-labelled in this order.
const DOOR_FREEZER_LEFT = buf('AAFF100A002A0063170001C6260018030000000100060000010000000001000000000000000000AE6FBB')
const DOOR_ALL_CLOSED = buf('AAFF100A002A0063180001C6260018030000000100060000000000000000000000000000000000C4A6BB')
const DOOR_FRIDGE_LEFT = buf('AAFF100A002A0063190001C6250018030000000100060001000100000000000000000000000000A660BB')
const DOOR_FRONT = buf('AAFF100A002A00631B0001C6250018030000000100060001000000000100000000000000000000093BBB')
// 18:33:37 and 17:40:30 - the other two panels.
const DOOR_FRIDGE_RIGHT = buf('AAFF100A002A0062DC0001C6250018030000000100060001000001000000000000000000000000E509BB')
const DOOR_FREEZER_RIGHT = buf('AAFF100A002A0062DA0001C626001803000000010006000001000000000001000000000000000066AEBB')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config is published immediately, in Celsius, with this unit`s measured ranges', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID]?.config!.components as Record<string, Record<string, unknown>>

        assert.equal(components.fridge_setpoint.unit_of_measurement, '°C')
        assert.equal(components.fridge_setpoint.min, 1)
        assert.equal(components.fridge_setpoint.max, 7)
        assert.equal(components.freezer_setpoint.unit_of_measurement, '°C')
        assert.equal(components.freezer_setpoint.min, -23)
        assert.equal(components.freezer_setpoint.max, -15)
    })

    test('start() sends nothing - this appliance reports on its own', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 0)
    })

    test('10EC decodes the six measured fields from the current half of the pair', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATUS)

        const dev = ha.devices[DEVICE_ID]
        assert.equal(dev.properties.fridge_setpoint, 1) // 8 - 7, owner read 1C off the panel
        assert.equal(dev.properties.freezer_setpoint, -15) // -14 - 1
        assert.equal(dev.properties.express_freeze, 'OFF') // 1 = off
        assert.equal(dev.properties.door, 'ON') // current half has [7]=1
        assert.equal(dev.properties.smart_care, 'ON')
        assert.equal(dev.properties.beep, 'ON')
    })

    test('each door panel is reported on its own byte', () => {
        const cases: [Buffer, string][] = [
            [DOOR_FRIDGE_LEFT, 'door_fridge_left'],
            [DOOR_FRIDGE_RIGHT, 'door_fridge_right'],
            [DOOR_FRONT, 'door_front'],
            [DOOR_FREEZER_LEFT, 'door_freezer_left'],
            [DOOR_FREEZER_RIGHT, 'door_freezer_right'],
        ]

        for (const [frame, expected] of cases) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', frame)
            const props = ha.devices[DEVICE_ID].properties

            for (const name of cases.map((c) => c[1])) {
                assert.equal(props[name], name === expected ? 'ON' : 'OFF', `${expected} frame -> ${name}`)
            }
        }
    })

    test('a notification with no slot set closes every door', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DOOR_FRIDGE_LEFT)
        assert.equal(ha.devices[DEVICE_ID].properties.door_fridge_left, 'ON')

        thinq.emit('data', DOOR_ALL_CLOSED)
        const props = ha.devices[DEVICE_ID].properties
        for (const name of [
            'door_fridge_left',
            'door_fridge_right',
            'door_front',
            'door_freezer_left',
            'door_freezer_right',
        ]) {
            assert.equal(props[name], 'OFF')
        }
    })

    test('a status saying no door is open clears a per-door sensor whose release was missed', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', DOOR_FRONT)
        assert.equal(ha.devices[DEVICE_ID].properties.door_front, 'ON')

        // SAMPLE_STATUS's current half has [7]=1, so it must NOT clear anything.
        thinq.emit('data', SAMPLE_STATUS)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.door_front, 'ON', 'still open - [7]=1 says so')

        // Same frame with the current half's [7] set to 0: every panel must go OFF.
        const closed = Buffer.from(SAMPLE_STATUS)
        closed[4 + 65 + 7] = 0
        thinq.emit('data', closed)

        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.door, 'OFF')
        for (const name of [
            'door_fridge_left',
            'door_fridge_right',
            'door_front',
            'door_freezer_left',
            'door_freezer_right',
        ]) {
            assert.equal(props[name], 'OFF', name)
        }
    })

    test('frames outside the AA..BB envelope, or of an unknown shape, publish nothing', () => {
        const { ha, thinq } = makeDevice()
        const before = { ...ha.devices[DEVICE_ID].properties }

        thinq.emit('data', buf('001122'))
        thinq.emit('data', buf('AA08109901020304BB'))

        assert.deepEqual(ha.devices[DEVICE_ID].properties, before)
    })

    test('write fridge_setpoint=1C reproduces the frame LG`s own cloud sent', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('fridge_setpoint', '1')

        // Captured 20:12:40 KST when the owner set 1C in the ThinQ app.
        assert.equal(
            hex(thinq.outbox[0]),
            'AA7CF017FF07FFFFFFFFFFFF01FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFA7BB',
        )
    })

    test('write freezer_setpoint=-18C reproduces the captured frame', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('freezer_setpoint', '-18')

        // Captured 20:12:51 KST.
        assert.equal(
            hex(thinq.outbox[0]),
            'AA7CF017FFFF04FFFFFFFFFF01FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBABB',
        )
    })

    test('write express_freeze=ON reproduces the captured frame, with no zone selector', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('express_freeze', 'ON')

        // Captured 20:18:18 KST. Note payload[8] stays 0xFF - the selector rides with temperatures only.
        assert.equal(
            hex(thinq.outbox[0]),
            'AA7CF017FFFFFF02FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBEBB',
        )
    })

    test('write beep and smart_care land on their measured offsets', () => {
        const { thinq, dev } = makeDevice()

        thinq.resetRecorder()
        dev.setProperty('beep', 'OFF')
        assert.equal(thinq.outbox[0][4 + 40], 0)
        assert.equal(thinq.outbox[0][4 + 17], 0xff, 'smart care untouched')
        assert.equal(thinq.outbox[0][4 + 8], 0xff, 'no zone selector')

        thinq.resetRecorder()
        dev.setProperty('smart_care', 'ON')
        assert.equal(thinq.outbox[0][4 + 17], 1)
        assert.equal(thinq.outbox[0][4 + 40], 0xff, 'beep untouched')
    })

    test('an unknown property emits no packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('nonsense', 'whatever')
        assert.equal(thinq.outbox.length, 0)
    })
})
