import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RAC_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'
import * as TLV from '@/util/tlv'

/** The TLVs a frame carries. Lets a write be asserted on meaning rather than on bytes, which
 *  matters where no capture of that write exists to compare against. */
function tlvOf(frame: Buffer) {
    return TLV.parse(frame.subarray(11, 11 + frame[10])).map(({ t, v }) => ({ t, v }))
}

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RAC_056905_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'TEST', swVersion: '1.0' }

// Real packet captures from a RAC_056905_WW air conditioner.

// Capability request
const CAPS_REQUEST_HEX = '01010400000065020201027D416A0D'

// Capability response (response to query 0x1F5/1). Contains TLV t=0x2DA (eeprom checksum),
// which triggers `isCapsResponse`
const CAPS_RESPONSE_HEX =
    '0000040000008702010249' +
    'B001B05057B0A0017CB0C1B103B306B34FB4C7B582B541B543B6A04D81B6F0690409B701BC40BD47' +
    'B5C0B61024B643B5C1B600B643B5C2B600B643B5C4B61026B643B5C6B6102CB643' +
    '44E1'

// Comprehensive state response (response to query 0x1F5/2).
// Contains TLV t=0x1f7 (power), which triggers `isValuesResponse`
//      t=0x1f9 l=0 v=0x4 (4)   mode=heat
//      t=0x1f7 l=0 v=0x1 (1)   power=ON
//      t=0x1fa l=0 v=0x3 (3)   fan=low
//      t=0x1fd l=1 v=0x29 (41) current_temp=20.5
//      t=0x1fe l=1 v=0x26 (38) set_temp=19
//      ...
const QUERY_RESPONSE_HEX =
    '00000400000087020415' +
    '777E447DC17E837F50297F9026C840C880C8C08340838083C0868086C0870087C0894088408A1011' +
    '8A505A8A8F8CA0C0BA8CD010ACE00164D540D580C900CAD0A0CB1040CB40CB8CCBCFCC1032CC504F' +
    'CC90438B40BF600155BFE00271BFA00155C0200271BE509FBE90A01B01BED050C300C340C0C0C380' +
    '3E6B'

// Bytes that the device sends in response to specific HA setProperty calls.
const WRITE_MODE_FAN_ONLY_HEX = '01010400000065020101067E427E837F80B452'
const WRITE_MODE_HEAT_HEX = '01010400000065020101077E447E837F902AF936'
const WRITE_POWER_OFF_HEX = '01010400000065020101027DC00576'

// A SECOND, real RAC_056905_WW: the wall unit captured 2026-07-30 (caps-rac-20260730.jsonl).
//
// Worth knowing before reading the assertions: its capability mask is not the same hardware as
// the fixture above. 0x2C1=7 here (bits 0,1,2 - cool/dry/fan_only) against 0x2C1=87 (bits
// 0,1,2,4,6 - which adds heat and auto), and both replies are internally consistent, each unit's
// 0x2D7 list agreeing with its own mask. One modelId, two different sets of modes.
//
// It also carries 0x192=84, the auto-dry strength axis, which the other unit does not report.
const CAPS_RESPONSE_WALL_HEX =
    '0000040000008702010879' +
    'B001E190CAB047B0B040017CD4101AD3F0020000B85024B8903CB8D020B9103CB0C1B10FB306B2A00800B2C0B370' +
    '200005B480B4F0045011B5A08000B6A05100B6F0249003B701B740BC40BD30080000BD60080FFB0FEA1021DD0464' +
    '4F649054BC08FA01B5C0B61033B642B5C1B61032B642B5C2B61032B642' +
    'F0B8'

// The same unit's state frame, carrying 0x1F2=6 (auto dry strength) and 0x20E=255.
const QUERY_RESPONSE_WALL_HEX =
    '0000040000008702040C' +
    '907E407DC07E827F50397F90307EC07F00C840C880C8C083408390FF83C0A880868086C0870087C18F8089407C86' +
    'E880594088408A103F8A50528A808C808CC0ACD032CA00A041D540D580C900CAC01E90BCCB40CB89CBC0CC00CC40' +
    'CC909E8B40E801FA80BF600567BFC0BFA00567C000BE5061BE906E6240BEC0C340C0C0EE40C380CCC8CD08CD4890' +
    '004B414BC14CC1' +
    '165E'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => {
        dev.setProperty(prop, value)
    })
    return { ha, thinq, dev }
}

/** Bring the device through the full caps->values->initMakeSetConfig flow using mock timers.
 *  Returns the device with config installed and thinq recorder cleared. */
function buildReadyDevice(t: import('node:test').TestContext) {
    enableMockTimers(t)
    const { ha, thinq, dev } = makeDevice()

    // Constructor sent the queryCaps packet, discard it.
    thinq.resetRecorder()

    // Respond & give other timeouts a chance to fire.
    thinq.emit('data', buf(CAPS_RESPONSE_HEX))
    thinq.emit('data', buf(QUERY_RESPONSE_HEX))
    tickMockTimers(t, 6000)

    thinq.resetRecorder()
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('caps and values responses triggers config publish', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder() // discard the queryCaps from the constructor

        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))

        // allow timed events to process
        tickMockTimers(t, 6000)
        const device = ha.devices[DEVICE_ID]
        assert.ok(device, 'HA configuration published')

        // Config exposes the climate component with all five base fields registered.
        const components = device.config!.components as Record<string, Record<string, unknown>>
        assert.ok(components.climate, 'climate component')
        assert.equal(components.climate.platform, 'climate')

        // Capability bits from the captured caps response unlocked these optional components.
        assert.ok(components.jet, 'jet (because 0x2CD bits 0x1|0x2)')
        assert.ok(components.energysave, 'energysave (because 0x2CC bit 0x2)')
        assert.ok(components.autodry, 'autodry (because 0x2CC bit 0x4)')
        assert.ok(components.sleeptimer, 'sleeptimer (because 0x2D3 bit 0x1)')
        assert.ok(components.starttimer, 'starttimer (because 0x2D3 bit 0x4)')
        assert.ok(components.stoptimer, 'stoptimer (because 0x2D3 bit 0x4)')
        // Conversely, airclean (0x2CC bit 0x1) is not unlocked.
        assert.ok(!components.airclean, 'airclean off (0x2CC bit 0x1 unset)')

        // 0x2C1=87 is bits 0,1,2,4,6 - this unit really does have heat and auto.
        assert.deepEqual(components.climate.modes, ['off', 'cool', 'dry', 'fan_only', 'heat', 'auto'])

        // 0x2C2=380 is bits 2,3,4,5,6,8: the five steps and nature, but no bit 22, so this unit
        // gets no super breeze. Note there is no fan 'auto' on either unit - bit 8 is 자연풍.
        assert.deepEqual(components.climate.fan_modes, ['very low', 'low', 'medium', 'high', 'very high', 'nature'])

        // Swing modes registered because 0x2CD has both 0x4 and 0x8.
        assert.deepEqual(components.climate.swing_modes, ['1', '2', '3', '4', '5', '6', 'on', 'off'])
        assert.deepEqual(components.climate.swing_horizontal_modes, [
            '1',
            '2',
            '3',
            '4',
            '5',
            '1-3',
            '3-5',
            'on',
            'off',
        ])

        dev.drop()
    })

    test('initial state response publishes all expected HA properties', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(QUERY_RESPONSE_HEX))

        // allow timed events to process
        tickMockTimers(t, 1000)

        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 20.5) // 0x29 / 2
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 19) // 0x26 / 2
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'low') // 0x1FA=3
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'heat') // 0x1F9=4 with power=ON
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_mode_state'), 'off') // 0x321=0
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_state'), 'off') // 0x322=0
        assert.equal(ha.getProperty(DEVICE_ID, 'autodry', 'state'), 'OFF') // 0x20E=0
        assert.equal(ha.getProperty(DEVICE_ID, 'sleeptimer', 'state'), 0) // 0x21A=0
        assert.equal(ha.getProperty(DEVICE_ID, 'starttimer', 'state'), 0) // 0x21C=0
        assert.equal(ha.getProperty(DEVICE_ID, 'stoptimer', 'state'), 0) // 0x21B=0
        assert.equal(ha.getProperty(DEVICE_ID, 'jet', 'state'), 'OFF')

        // energysave only applies in cooling, and the appliance reports 0 for it in every other
        // mode. Publish that rather than withholding it: a switch that says nothing is worse than
        // one that says what the appliance is doing. (local change - upstream suppresses this.)
        assert.equal(ha.getProperty(DEVICE_ID, 'energysave', 'state'), 'OFF')

        dev.drop()
    })

    test('HA write climate-mode=fan_only emits expected bytes', (t) => {
        const { thinq, dev, ha } = buildReadyDevice(t)
        // Pre-state observed in the capture at the moment of this write.
        dev.raw_clip_state[0x1fa] = 3
        dev.raw_clip_state[0x1fe] = 0

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'fan_only')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_MODE_FAN_ONLY_HEX.toUpperCase())

        dev.drop()
    })

    test('HA write climate-mode=heat emits expected bytes', (t) => {
        const { thinq, dev, ha } = buildReadyDevice(t)
        // Pre-state observed in the capture at the moment of this write.
        dev.raw_clip_state[0x1fa] = 3
        dev.raw_clip_state[0x1fe] = 42 // 21C

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'heat')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_MODE_HEAT_HEX.toUpperCase())

        dev.drop()
    })

    test('HA write climate-mode=off triggers power=OFF instead of mode write', (t) => {
        const { thinq, dev, ha } = buildReadyDevice(t)
        dev.raw_clip_state[0x1f7] = 1
        dev.raw_clip_state[0x1f9] = 0
        dev.raw_clip_state[0x1fa] = 3
        dev.raw_clip_state[0x1fe] = 42

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'off')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_OFF_HEX.toUpperCase())

        dev.drop()
    })

    test('auto dry level appears when the appliance declares the axis (0x192)', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder() // discard the queryCaps from the constructor

        thinq.emit('data', buf(CAPS_RESPONSE_WALL_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_WALL_HEX))
        tickMockTimers(t, 6000)

        // The first values response builds the config; states publish off the next one, the same
        // way the initial-state test above does it.
        thinq.emit('data', buf(QUERY_RESPONSE_WALL_HEX))
        tickMockTimers(t, 1000)

        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.ok(components.autodry, 'autodry (0x2CC bit 0x4, as on the other unit)')
        assert.equal(components.autodry.platform, 'switch', 'the owner operates this from the app')
        assert.ok(components.autodrylevel, 'autodrylevel (because this unit reports 0x192)')
        assert.equal(components.autodrylevel.platform, 'select')

        // 0x192=84 is bits 2/4/6, so this unit offers three strengths - not the five
        // PAC_910604_WW declares - and the captured 0x1F2=6 is the top of its own set.
        assert.deepEqual(components.autodrylevel.options, ['low', 'mid', 'high'])
        assert.equal(ha.getProperty(DEVICE_ID, 'autodrylevel', 'state'), 'high')
        assert.equal(ha.getProperty(DEVICE_ID, 'autodry', 'state'), 'ON') // 0x20E=255

        // The same capture is also the evidence that one modelId spans different hardware, and
        // the mode list has to follow the appliance rather than the model name: 0x2C1=7 here
        // against 87 in the other fixture, so no heat and no auto are offered on this one.
        assert.equal(dev.raw_clip_state[0x2c1], 7, 'cool/dry/fan_only only - no heat, no auto')
        assert.deepEqual(components.climate.modes, ['off', 'cool', 'dry', 'fan_only'])

        // 0x2C2=4194684 adds bit 22 on top of the other unit's set. The owner's appliance lists
        // 초미풍 first, then 1..5, and offers 자연풍 - which is exactly bit 22, bits 2-6, bit 8.
        // Bit 22's wire value is 16, not 22: this axis is where bit index and wire value diverge.
        assert.deepEqual(components.climate.fan_modes, [
            'super breeze',
            'very low',
            'low',
            'medium',
            'high',
            'very high',
            'nature',
        ])

        dev.drop()
    })

    test('auto dry writes carry the strength the mask names, not its position', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder()
        thinq.emit('data', buf(CAPS_RESPONSE_WALL_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_WALL_HEX))
        tickMockTimers(t, 6000)
        thinq.resetRecorder()

        // 'mid' is the second option offered, but its wire value is 4 - bit 4 of 0x192 - not 1.
        // A contiguous base+index select would send 3 here, which is why this one maps explicitly.
        ha.setProperty(DEVICE_ID, 'autodrylevel', 'command', 'mid')
        assert.equal(thinq.outbox.length, 1)
        assert.deepEqual(tlvOf(thinq.outbox[0]), [{ t: 0x1f2, v: 4 }])

        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'autodry', 'command', 'OFF')
        assert.equal(thinq.outbox.length, 1)
        assert.deepEqual(tlvOf(thinq.outbox[0]), [{ t: 0x20e, v: 0 }])

        // Cancelling a run is 0x225 = 0, and it must NOT touch 0x20e: the setting stays put and
        // only the run stops. In Controls rather than Configuration, so no entity_category.
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.autodry_cancel.platform, 'button')
        assert.equal(components.autodry_cancel.entity_category, undefined)

        // Emitted directly, as the DHUM_231006_WW test does: the button is registered straight
        // into fields_by_ha, so there is no component topic for setProperty() to look up.
        thinq.resetRecorder()
        ha.emit('setProperty', DEVICE_ID, 'autodry_cancel', 'PRESS')
        assert.equal(thinq.outbox.length, 1)
        assert.deepEqual(tlvOf(thinq.outbox[0]), [{ t: 0x225, v: 0 }])

        dev.drop()
    })

    test('the six app-decoded controls appear, in the categories they belong in', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder()
        thinq.emit('data', buf(CAPS_RESPONSE_WALL_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_WALL_HEX))
        tickMockTimers(t, 6000)

        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        for (const [name, category] of [
            ['beep', 'config'],
            ['goodsleep', 'config'],
            ['goodsleepstarttemp', 'config'],
            ['goodsleepcustomtemp', 'config'],
            ['heatexchangerclean', 'diagnostic'],
            ['allclean', 'diagnostic'],
        ] as const) {
            assert.ok(components[name], `${name} present`)
            assert.equal(components[name].entity_category, category, `${name} category`)
        }

        // 0x3A0 is inverted, measured that way on this appliance and on two others: 0 is on.
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'beep', 'command', 'ON')
        assert.deepEqual(tlvOf(thinq.outbox[0]), [{ t: 0x3a0, v: 0 }])

        // 0x165 starts with 100 and reports 2 while running, so ON must not be read as "equals
        // what we wrote" - that would leave the switch stuck off through the whole cycle. Both
        // numbers are from the capture: TX 0x165=100 at +137.2s, rx 0x165=2 at +137.5s.
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'allclean', 'command', 'ON')
        assert.deepEqual(tlvOf(thinq.outbox[0]), [{ t: 0x165, v: 100 }])

        const allclean = dev.fields_by_id[0x165]
        assert.equal(allclean.read_xform!(2), 'ON', 'reads back 2 while running')
        assert.equal(allclean.read_xform!(0), 'OFF')

        dev.drop()
    })

    test('auto dry level stays absent on a unit that does not report 0x192', (t) => {
        const { ha, dev } = buildReadyDevice(t)

        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.ok(components.autodry, 'autodry is still unlocked by 0x2CC')
        assert.ok(!components.autodrylevel, 'no autodrylevel - 0x192 absent from this caps reply')

        dev.drop()
    })

    test('constructor sends a queryCaps packet on the wire', () => {
        const { thinq, dev } = makeDevice()
        if (dev.query_caps_timeout) {
            clearInterval(dev.query_caps_timeout)
            dev.query_caps_timeout = undefined
        }
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), CAPS_REQUEST_HEX.toUpperCase())
        dev.drop()
    })
})
