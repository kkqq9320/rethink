import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/PAC_910604_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'PAC_910604_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'TEST', swVersion: '1.0' }

/*
 * Real packet captures from a PAC_910604_WW stand air conditioner, driven by hand through
 * the LG ThinQ app while an operator annotated each action. Every state frame below is
 * marked 0xa7 at buf[6] - the quirk this profile exists to handle. The exceptions are
 * called out where they appear: one state frame deliberately re-marked 0x87, and the single
 * private-channel fixture, which is marked 0x65.
 *
 * Each fixture is labelled with the LG-app command that caused it rather than with the
 * nearest operator note: the operator types the note *after* acting, with a lag of 0.4 to
 * 13 s, so nearest-note-in-time mislabels several frames.
 */

// Capability request emitted by the TLVDevice constructor (TLV 0x1f5 = 1).
const CAPS_REQUEST_HEX = '01010400000065020201027D416A0D'

/*
 * SYNTHETIC. The only frame in this file that is not a capture, and it is one because the
 * appliance's real capability reply was never recorded: a live probe established that it is
 * 174 bytes carrying 54 TLVs, and wrote down ten of the tags - 0x2da, 0x2e1 = 36, 0x2e2 = 60
 * among them - but the bytes themselves are gone and the other 44 tags are unknown.
 *
 * So this frame is built to the same shape - buf[8] = 0x01, which is what distinguishes a
 * capability reply from a state frame's 0x04 - out of the tags that were recorded, plus
 * 0x355 and 0x356 carrying values no live counter could hold: a 1 h filter with 1 h left.
 * The CRC is computed rather than captured, using the same convention as the real frames
 * (crc16 over buf[2 .. len-3], verified against STATE_FILTER_REMAINING_2441_HEX).
 *
 *      t=0x2e1 v=36    setpoint minimum, 18.0 C                   (recorded)
 *      t=0x356 v=1     filter rated life                          (invented)
 *      t=0x2e2 v=60    setpoint maximum, 30.0 C                   (recorded)
 *      t=0x355 v=1     filter hours remaining                     (invented)
 *      t=0x2da v=4660  eeprom checksum - what isCapsResponse() keys on (value invented)
 *
 * It cannot prove what the appliance really sends. It pins down the only thing that has to
 * hold whatever the appliance sends: a capability reply must not reach the filter sensors.
 */
const CAPS_RESPONSE_HEX = '000004000000A70201400EB85024D581B8903CD541B6A012340EC4'

/*
 * Comprehensive state dump, 221 bytes / 94 TLVs, emitted once at first connect.
 * Deliberately NOT called a "response to query 0x1f5/2": the LG app never sends 0x1f5 to
 * this appliance, so what provokes the dump is unproven. It does contain 0x1f7, so
 * isValuesResponse() accepts it.
 *      t=0x1f7 v=1     power ON
 *      t=0x1f9 v=0     mode cool
 *      t=0x1fa v=4     fan 3단 -> 'medium'
 *      t=0x1fb v=0     temp step 0.5 C
 *      t=0x1fd v=50    current temp 25.0 C
 *      t=0x1fe v=42    target temp 21.0 C
 *      t=0x356 v=3000  filter rated life, hours       (bytes D5A00BB8)
 *      t=0x355 v=2442  filter hours remaining         (bytes D560098A)
 *      ...
 * Note the wire order: 0x356 arrives before 0x355, so the derived "used" sensor cannot be
 * computed when the first of the pair is processed.
 */
const QUERY_RESPONSE_HEX =
    '000004000000A7020440' +
    'D091009283918091C0A300A3407DC17E407F902A7E847F5032820081408180808080C082408D8082' +
    'C0830083408390FF83C19080868086C087009F4087C08780938193C09440948090409000D2008940' +
    '8840ACE00DAD8E808E408E0090C0CCC0CD00CD40CD9039D5A00BB8D560098ACDC1C8C08F808FC08F' +
    '41AB40AB00D1009780A801A840A881A8C1E8807EC0E3D065E800FA80F140E480EB103CEA80EAC0EA' +
    '40EEC2EE407C86EE80698169C16D406E416CD03C5DF0B405A0A740AA0064F00201016F8059404B40' +
    '4BC14CC15F41C490CD' +
    '5D7F'

// --- change notifications, by the operator action that caused them ---

// "바람세기1단" .. "바람세기5단" - fan steps 1 to 5, raw 2 to 6. The 1단, 2단 and 4단
// frames carry the unmapped tag 0x312 alongside the fan speed; the other two do not.
const STATE_FAN_1_HEX = '000004000000A7020441047E82C4829AD1' // 0x1fa=2
const STATE_FAN_2_HEX = '000004000000A7020443047E83C48226A1' // 0x1fa=3
const STATE_FAN_3_HEX = '000004000000A7020444027E84BF1D' // 0x1fa=4
const STATE_FAN_4_HEX = '000004000000A7020446047E85C482D700' // 0x1fa=5
const STATE_FAN_5_HEX = '000004000000A7020447027E860483' // 0x1fa=6

// "냉방" / "제습" / "공기청정" - cool, dry, air-clean mode. 0x348 mirrors 0x1f9 in each.
const STATE_MODE_COOL_HEX = '000004000000A70204920B7E407F902A7E86D200C489366F'
const STATE_MODE_DRY_HEX = '000004000000A70204850B7E417F90307E88D201C489B93B'
const STATE_MODE_AIRCLEAN_HEX = '000004000000A702048E0B7E457F90347E82D205C4898B59'

// "제습 상태에서 온도 내리기" / "온도 올리기" - temp down/up while in dry mode.
const STATE_TEMP_24_HEX = '000004000000A702048C037F9030C2C1' // 0x1fe=48 -> 24.0 C
const STATE_TEMP_245_HEX = '000004000000A7020488057F9031C483B937' // 0x1fe=49 -> 24.5 C

// Unprompted room temperature report. The comprehensive dump carries 0x1fd=50; this is the
// only other value the appliance sent, and two points are what pin the /2 scaling.
const STATE_CURRENT_TEMP_24_HEX = '000004000000A702048A057F5030C4835D40' // 0x1fd=48 -> 24.0 C

// "바람 방향 ..." - wind direction concentrated / wide / left / right / split.
const STATE_WIND_CONCENTRATED_HEX = '000004000000A702049A02A8C112A4' // 0x2a3=1
const STATE_WIND_WIDE_HEX = '000004000000A702049504A8C2C482AAF3' // 0x2a3=2
const STATE_WIND_LEFT_HEX = '000004000000A702049704A8C3C4821683' // 0x2a3=3
const STATE_WIND_RIGHT_HEX = '000004000000A702049904A8C4C48213B0' // 0x2a3=4
const STATE_WIND_SPLIT_HEX = '000004000000A70204940F8CA001F08CD045ACE00129A8C5C48D2B51' // 0x2a3=5, 0x2b3=297

// "제트 모드 ON" / "OFF". Jet ON also forces 0x1fe=36 (18.0 C) and the pseudo fan speed 7.
const STATE_JET_ON_HEX = '000004000000A70204E40D7F90247E8781A001018D81C48B5DA5'
const STATE_JET_OFF_HEX = '000004000000A70204E6087E8681808D80C486D02D'

// "버튼 잠금 ON" / "OFF" - child lock.
const STATE_CHILDLOCK_ON_HEX = '000004000000A70204EE04EA41C482CD33' // 0x3a9=1
const STATE_CHILDLOCK_OFF_HEX = '000004000000A70204F004EA40C4826024' // 0x3a9=0

// "제품 화면 OFF" / "ON" - product display. INVERTED: the raw value is 1 when off.
const STATE_DISPLAY_OFF_HEX = '000004000000A70204F70487C1C482C45B' // 0x21f=1
const STATE_DISPLAY_ON_HEX = '000004000000A70204F90487C0C48273C8' // 0x21f=0

// "제품 소리 OFF" - product beep muted. INVERTED: the raw value is 1 when muted.
const STATE_BEEP_MUTED_HEX = '000004000000A70204FB04E801C4826473' // 0x3a0=1

// Room humidity, reported unprompted as it drifts. Plain integer %RH, no scaling.
// The capture has 30 of these spanning 55 .. 70.
const STATE_HUMIDITY_55_HEX = '000004000000A702048B03CD9037456D' // 0x336=55, single tag
const STATE_HUMIDITY_58_HEX = '000004000000A702044A05CD903AC483358D' // 0x336=58

// "저소음 모드 ON" / "OFF" - quiet mode.
const STATE_QUIET_ON_HEX = '000004000000A70204E90A8FE00800A042A741C4880D9D' // 0x29d=1
const STATE_QUIET_OFF_HEX = '000004000000A70204EB068FC0A740C4845BF8' // 0x29d=0

// "uv nano on" / "Off".
const STATE_UVNANO_ON_HEX = '000004000000A702046204A881C482B7F3' // 0x2a2=1
const STATE_UVNANO_OFF_HEX = '000004000000A702045F04A880C482E10C' // 0x2a2=0

// "ai 건조 1단" / "4단" - AI dry level, and the separate AI dry enable switch.
const STATE_AIDRY_LEVEL_1_HEX = '000004000000A7020463027C82DFDA' // 0x1f2=2
const STATE_AIDRY_LEVEL_4_HEX = '000004000000A7020469027C85C796' // 0x1f2=5
const STATE_AIDRY_ON_HEX = '000004000000A702046E038390FF03DE' // 0x20e=255
const STATE_AIDRY_OFF_HEX = '000004000000A702046C0F83808CA005638CD038ACE023A7C48D8836' // 0x20e=0

// "한쪽 바람 왼쪽" / "오른쪽" - one-side wind left / right.
const STATE_ONESIDE_LEFT_HEX = '000004000000A70204DD087E84A8C3AA01C4860E88' // 0x2a8=1
const STATE_ONESIDE_RIGHT_HEX = '000004000000A70204E006A8C4AA02C484B353' // 0x2a8=2

// "바람 방향 공간 맞춤 설정 ON" - space-fit wind.
const STATE_SPACEFIT_ON_HEX = '000004000000A70204CC06A8C36F81C484D3B3' // 0x1be=1

// "스마트 케어 ON" - smart care. 0x23e and 0x25e move together in one frame.
const STATE_SMARTCARE_ON_HEX = '000004000000A70204F10F7F90307E8881A001018F819781C48D3057'

// "습도 센서 항상 표시 옵션" - humidity sensor shown always.
const STATE_HUMIDITY_ALWAYS_HEX = '000004000000A70204FF04CDC1C482CF2E' // 0x337=1

// "온도 단위 1도로 변경" / "0.5도로 변경" - temperature resolution.
const STATE_TEMPSTEP_1C_HEX = '000004000000A70204A2047EC1C4829BF4' // 0x1fb=1
const STATE_TEMPSTEP_05C_HEX = '000004000000A70204A3027EC0629A' // 0x1fb=0

// "열교환기 세척 시작" - heat exchanger clean started. The appliance also resets the fan
// speed and wind direction and clears smart care by itself.
const STATE_HXCLEAN_START_HEX = '000004000000A70204AA0E7E8481808F809780A8C1E881C48C4242' // 0x3a2=1

/*
 * All-clean running and stopped. These are the only frames in the whole capture that move
 * 0x1f7, and they do it as a side effect of the cleaning cycle - there is no operator
 * power action anywhere in the capture, so they double as the power decode fixtures.
 * While all-clean runs, 0x3a2 reads 255 (NOT 1) and 0x165 reads 2.
 */
const STATE_ALLCLEAN_RUNNING_HEX = '000004000000A70204AE157DC17E407F90247E84D2008F41E890FF5942C49012A3F8'
const STATE_ALLCLEAN_STOPPED_HEX = '000004000000A70204B0147DC07E407F90247E84D2008F40E8805940C49011E98F'

/*
 * Filter remaining hours ticking down by one. Captured verbatim, and it is the only frame
 * in the whole capture besides the comprehensive dump that carries 0x355 or 0x356 - so the
 * dump (0x356=3000, 0x355=2442) and this frame (0x355=2441) are the entire evidence base,
 * and both are used below.
 *
 * Decoding the payload D5600989 C484 by hand, because the numbers are the point:
 *   D5 60   tag = (0xD5 << 2) | (0x60 >> 6) = 0x355, len = (0x60 >> 4) & 3 = 2, nibble = 0
 *   09 89   => value 0x000989 = 2441 hours left
 *   C4 84   tag 0x312 = 4, the frame's own length field - deliberately not an entity
 *
 * 2442 -> 2441 against a constant 3000 h life is what fixes the direction of 0x355: it
 * counts DOWN. The LG app read the same appliance a day later at 2438 h remaining / 562 h
 * used, and 2438 + 562 = 3000 exactly.
 */
const STATE_FILTER_REMAINING_2441_HEX = '000004000000A70204DE06D5600989C4847922'

/*
 * Captured verbatim: the appliance answering a read of private command 0x0c (the humidity
 * display setting) with buf[6] = 0x65. This profile sends no private commands and decodes
 * no private payloads - see the filter note in the profile - so the only thing this fixture
 * can now prove is the negative: a private-channel frame publishes nothing and, in
 * particular, cannot resurrect a filter entity.
 */
const PRIV_0C_RESPONSE_HEX = '02FF0400000065FD0300050C000000003EC7'

/*
 * Bytes this profile emits for specific HA writes.
 *
 * These are NOT copies of the captured LG-app command frames, and cannot be: the shared
 * TLVDevice.setProperty() path sends header [1,1,2,1,1], so buf[9] is 0x01 where the app
 * used 0x00 (the byte the base class documents as a sequence number - RAC_056905_WW ships
 * the same 0x01 and works), and the CRC differs accordingly. For fan and temperature
 * writes the TLV order also differs, because setProperty() always puts the written tag
 * first and the app always ordered the trio 0x1f9, 0x1fa, 0x1fe. Contents are identical;
 * the captured app frame is quoted next to each constant for comparison.
 */
// app sent 01010400000065020100077E407E867F902AA8F1 ("냉방")
const WRITE_MODE_COOL_HEX = '01010400000065020101077E407E867F902A43D2'
// app sent 01010400000065020100077E417E887F9030FC70 ("제습")
const WRITE_MODE_DRY_HEX = '01010400000065020101077E417E887F90301753'
// app sent 01010400000065020100077E457E827F9034D2FE ("공기청정")
const WRITE_MODE_FAN_ONLY_HEX = '01010400000065020101077E457E827F903439DD'
/*
 * Selecting a mode while the appliance is off has to power it on, so these carry 0x1f7=1
 * that the three frames above do not. No app fixture exists for any of them, or for the
 * two power writes: the capture contains zero writes of 0x1f7 in any form.
 */
const WRITE_MODE_COOL_FROM_OFF_HEX = '01010400000065020101097E407DC17E867F902A4E15'
const WRITE_MODE_DRY_FROM_OFF_HEX = '01010400000065020101097E417DC17E887F903018E7'
const WRITE_MODE_FAN_ONLY_FROM_OFF_HEX = '01010400000065020101097E457DC17E827F90343FA5'
const WRITE_POWER_OFF_HEX = '01010400000065020101027DC00576'
const WRITE_POWER_ON_HEX = '01010400000065020101097DC17E407E847F902A7D69'
// app sent 01010400000065020100077E407E847F902A4599 ("바람세기3단"); differing TLV order
const WRITE_FAN_MEDIUM_HEX = '01010400000065020101077E847E407F902A6F7E'
// app sent 01010400000065020100077E417E887F9031EC51 ("온도 올리기"); differing TLV order
const WRITE_TEMP_245_HEX = '01010400000065020101077F90317E417E8849A9'
const WRITE_TEMP_CLAMP_HIGH_HEX = '01010400000065020101077F903C7E407E849E6F' // 0x1fe=60 = 30.0 C
const WRITE_TEMP_CLAMP_LOW_HEX = '01010400000065020101077F90247E407E849818' // 0x1fe=36 = 18.0 C

/*
 * Single-tag writes. Each differs from the captured app frame only in buf[9] and the CRC;
 * the TLV payload is byte-identical, so the app frame is quoted for each.
 */
const WRITE_SWITCHES: [string, string, string, string][] = [
    // component, HA payload, our bytes, captured app frame
    ['jet', 'ON', '01010400000065020101028D814E52', '01010400000065020100028D8138E6'],
    ['jet', 'OFF', '01010400000065020101028D805E73', '01010400000065020100028D8028C7'],
    ['quiet', 'ON', '0101040000006502010102A7417E33', '0101040000006502010002A7410887'],
    ['quiet', 'OFF', '0101040000006502010102A7406E12', '0101040000006502010002A74018A6'],
    ['uvnano', 'ON', '0101040000006502010102A881B741', '0101040000006502010002A881C1F5'],
    ['uvnano', 'OFF', '0101040000006502010102A880A760', '0101040000006502010002A880D1D4'],
    ['spacefit', 'ON', '01010400000065020101026F813882', '01010400000065020100026F814E36'],
    ['spacefit', 'OFF', '01010400000065020101026F8028A3', '01010400000065020100026F805E17'],
    ['airclean', 'ON', '010104000000650201010283C12599', '010104000000650201000283C1532D'],
    ['airclean', 'OFF', '010104000000650201010283C035B8', '010104000000650201000283C0430C'],
    ['childlock', 'ON', '0101040000006502010102EA4105A3', '0101040000006502010002EA417317'],
    ['childlock', 'OFF', '0101040000006502010102EA401582', '0101040000006502010002EA406336'],
    ['smartcare', 'ON', '01010400000065020101028F812830', '01010400000065020100028F815E84'],
    ['smartcare', 'OFF', '01010400000065020101028F803811', '01010400000065020100028F804EA5'],
    // 0 / 255 rather than 0 / 1
    ['aidry', 'ON', '01010400000065020101038390FFB80D', '01010400000065020100038390FF125C'],
    ['aidry', 'OFF', '010104000000650201010283807D7C', '010104000000650201000283800BC8'],
    // INVERTED: 'ON' writes 0
    ['display', 'ON', '010104000000650201010287C0F97C', '010104000000650201000287C08FC8'],
    ['display', 'OFF', '010104000000650201010287C1E95D', '010104000000650201000287C19FE9'],
    ['beep', 'ON', '0101040000006502010102E8003B24', '0101040000006502010002E8004D90'],
    ['beep', 'OFF', '0101040000006502010102E8012B05', '0101040000006502010002E8015DB1'],
    // cleaning cycles: start / stop
    ['hxclean', 'ON', '0101040000006502010102E881BA8D', '0101040000006502010002E881CC39'],
    ['hxclean', 'OFF', '0101040000006502010102E880AAAC', '0101040000006502010002E880DC18'],
    ['allclean', 'ON', '01010400000065020101035950643EDE', '0101040000006502010003595064948F'],
    ['allclean', 'OFF', '010104000000650201010259405EDC', '010104000000650201000259402868'],
]

/* Every row has a captured app TLV write - see the read-only note on 0x337 in the profile. */
const WRITE_SELECTS: [string, string, string, string][] = [
    ['onesidewind', 'off', '0101040000006502010102AA00508A', '0101040000006502010002AA00263E'],
    ['onesidewind', 'left', '0101040000006502010102AA0140AB', '0101040000006502010002AA01361F'],
    ['onesidewind', 'right', '0101040000006502010102AA0270C8', '0101040000006502010002AA02067C'],
    ['aidrylevel', '1', '01010400000065020101027C825EC1', '01010400000065020100027C822875'],
    ['aidrylevel', '5', '01010400000065020101027C861E45', '01010400000065020100027C8668F1'],
]

/* Wind direction. The app wrote all five values; each row quotes its frame. */
const WRITE_SWINGS: [string, string, string][] = [
    // HA swing_horizontal_mode, our bytes, captured app frame
    ['focus', '0101040000006502010102A8C1FF85', '0101040000006502010002A8C18931'],
    ['wide', '0101040000006502010102A8C2CFE6', '0101040000006502010002A8C2B952'],
    ['left', '0101040000006502010102A8C3DFC7', '0101040000006502010002A8C3A973'],
    ['right', '0101040000006502010102A8C4AF20', '0101040000006502010002A8C4D994'],
    ['split', '0101040000006502010102A8C5BF01', '0101040000006502010002A8C5C9B5'],
]

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => {
        dev.setProperty(prop, value)
    })
    return { ha, thinq, dev }
}

/** Device with the comprehensive state dump applied and the thinq recorder cleared.
 *  Unlike RAC this profile publishes its config from the constructor, so no caps/values
 *  handshake is needed to get entities. */
function readyDevice() {
    const { ha, thinq, dev } = makeDevice()

    // Constructor sent the queryCaps packet, discard it.
    thinq.resetRecorder()

    thinq.emit('data', buf(QUERY_RESPONSE_HEX))

    thinq.resetRecorder()
    return { ha, thinq, dev }
}

/** readyDevice() plus mock timers. Tests that build several devices must enable the mock
 *  timers themselves, once, because enabling them twice throws. */
function buildReadyDevice(t: import('node:test').TestContext) {
    enableMockTimers(t)
    return readyDevice()
}

describe(MODEL_ID, () => {
    test('constructor publishes the full config without waiting for capabilities', (t) => {
        enableMockTimers(t)
        const { ha, dev } = makeDevice()

        const device = ha.devices[DEVICE_ID]
        assert.ok(device, 'HA configuration published')
        assert.equal(device.availability, 'online')

        const components = device.config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.climate.platform, 'climate')

        // This model has exactly three modes: no heat, no auto, no separate fan_only tag.
        assert.deepEqual(components.climate.modes, ['off', 'cool', 'dry', 'fan_only'])
        assert.deepEqual(components.climate.fan_modes, ['very low', 'low', 'medium', 'high', 'very high', 'auto'])
        // Sideways airflow aim lives on swing_horizontal_mode, not swing_mode.
        assert.deepEqual(components.climate.swing_horizontal_modes, ['focus', 'wide', 'left', 'right', 'split'])
        assert.equal(components.climate.min_temp, 18)
        assert.equal(components.climate.max_temp, 30)

        // This model has no vertical louvre control at all, so no swing_mode.
        assert.ok(!components.climate.swing_modes, 'no vertical swing')

        for (const name of [
            'jet',
            'quiet',
            'uvnano',
            'spacefit',
            'airclean',
            'childlock',
            'smartcare',
            'aidry',
            'display',
            'beep',
            'hxclean',
            'allclean',
        ]) {
            assert.equal(components[name]?.platform, 'switch', `${name} switch`)
        }

        /*
         * The cleaning cycles are occasional maintenance, not settings, so they sit under
         * diagnostics; every other switch is an everyday control and stays under config.
         */
        for (const name of ['hxclean', 'allclean']) {
            assert.equal(components[name]?.entity_category, 'diagnostic', `${name} is diagnostic`)
        }
        for (const name of ['jet', 'quiet', 'uvnano', 'childlock', 'display', 'beep']) {
            assert.equal(components[name]?.entity_category, 'config', `${name} is config`)
        }

        for (const name of ['onesidewind', 'aidrylevel']) {
            assert.equal(components[name]?.platform, 'select', `${name} select`)
        }

        assert.equal(components.energy_current?.platform, 'sensor')
        assert.equal(components.energy_current?.unit_of_measurement, 'W')
        assert.equal(components.error?.platform, 'sensor')

        // 0x336 is the room humidity, the value behind the 0x337 display option.
        assert.equal(components.humidity?.platform, 'sensor')
        assert.equal(components.humidity?.device_class, 'humidity')
        assert.equal(components.humidity?.unit_of_measurement, '%')
        // a room measurement belongs on the device card, not under diagnostics
        assert.ok(!components.humidity?.entity_category, 'humidity is not diagnostic')

        // 0x337 is read-only: the app changes this setting over the private command channel
        // (command 0x0c) and never by a TLV write, so it is a sensor with no command topic.
        assert.equal(components.humiditydisplay?.platform, 'sensor')
        assert.ok(!components.humiditydisplay?.command_topic, 'humiditydisplay is not writable')

        // Tags the capture shows but nobody understands must not become entities.
        // 0x312 in particular is the frame's own length field - it is the most frequently
        // observed tag in the capture and therefore the most tempting false positive.
        for (const name of ['348', '279', '27a', '312', '232', '233', '25e', '1fc']) {
            assert.ok(!components[name], `no entity for unknown tag 0x${name}`)
        }

        // The three filter entities are TLV-backed (0x355 / 0x356) and therefore present
        // from the constructor, with no query and no private-channel handshake.
        for (const name of ['filterlife', 'filterremaining', 'filterused']) {
            assert.equal(components[name]?.platform, 'sensor', `${name} sensor`)
            assert.equal(components[name]?.device_class, 'duration', `${name} is a duration`)
            assert.equal(components[name]?.unit_of_measurement, 'h', `${name} is in hours`)
            assert.equal(components[name]?.icon, 'mdi:air-filter', `${name} icon`)
            assert.equal(components[name]?.entity_category, 'diagnostic', `${name} is diagnostic`)
            assert.ok(!components[name]?.command_topic, `${name} is read-only`)
        }
        // Only the derived one accumulates.
        assert.equal(components.filterused?.state_class, 'total_increasing')

        /*
         * The private-channel filter support is gone: its live probe reported a 720 h part
         * while the appliance's own app reports 3000 h, so those numbers described something
         * other than the user's filter. The reset button went with it - its target was never
         * verified - and so did the changed-date sensor, which the old code registered under
         * the key 'changeddate' rather than 'filterchangeddate'.
         *
         * Both keys are still in the payload, as removal markers. Omitting a component does
         * not delete it from HA, it only stops updating it, so an installation that ran the
         * previous version would keep a reset button wired to nothing. HA deletes a component
         * whose config carries the platform and nothing else - hence deepEqual rather than a
         * presence check: one extra key turns the removal back into a registration.
         */
        assert.deepEqual(components.filterreset, { platform: 'button' }, 'reset button marked for removal')
        assert.deepEqual(components.changeddate, { platform: 'sensor' }, 'changed-date sensor marked for removal')
        assert.ok(!dev.fields_by_ha['filterreset'], 'no filter reset write path')
        assert.ok(!components.filterchangeddate, 'no filter changed-date sensor (topic name)')

        dev.drop()
    })

    test('constructor sends a queryCaps packet on the wire', () => {
        const { thinq, dev } = makeDevice()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), CAPS_REQUEST_HEX.toUpperCase())
        dev.drop()
    })

    test('comprehensive state dump publishes every mapped property', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool') // 0x1F9=0, power ON
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 21) // 0x1FE=42
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 25) // 0x1FD=50
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'medium') // 0x1FA=4
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_state'), 'focus') // 0x2A3=1

        assert.equal(ha.getProperty(DEVICE_ID, 'jet', 'state'), 'OFF') // 0x236=0
        assert.equal(ha.getProperty(DEVICE_ID, 'quiet', 'state'), 'OFF') // 0x29D=0
        assert.equal(ha.getProperty(DEVICE_ID, 'uvnano', 'state'), 'ON') // 0x2A2=1
        assert.equal(ha.getProperty(DEVICE_ID, 'spacefit', 'state'), 'OFF') // 0x1BE=0
        assert.equal(ha.getProperty(DEVICE_ID, 'airclean', 'state'), 'ON') // 0x20F=1
        assert.equal(ha.getProperty(DEVICE_ID, 'childlock', 'state'), 'OFF') // 0x3A9=0
        assert.equal(ha.getProperty(DEVICE_ID, 'smartcare', 'state'), 'OFF') // 0x23E=0
        assert.equal(ha.getProperty(DEVICE_ID, 'aidry', 'state'), 'ON') // 0x20E=255
        assert.equal(ha.getProperty(DEVICE_ID, 'hxclean', 'state'), 'OFF') // 0x3A2=0
        assert.equal(ha.getProperty(DEVICE_ID, 'allclean', 'state'), 'OFF') // 0x165=0

        // Inverted pair: raw 0 means the display is lit and the beeper is audible.
        assert.equal(ha.getProperty(DEVICE_ID, 'display', 'state'), 'ON') // 0x21F=0
        assert.equal(ha.getProperty(DEVICE_ID, 'beep', 'state'), 'ON') // 0x3A0=0

        assert.equal(ha.getProperty(DEVICE_ID, 'onesidewind', 'state'), 'off') // 0x2A8=0
        assert.equal(ha.getProperty(DEVICE_ID, 'aidrylevel', 'state'), '5') // 0x1F2=6
        assert.equal(ha.getProperty(DEVICE_ID, 'humiditydisplay', 'state'), 'always') // 0x337=1

        assert.equal(ha.getProperty(DEVICE_ID, 'energy_current', 'state'), 3501) // 0x2B3
        assert.equal(ha.getProperty(DEVICE_ID, 'error', 'state'), 0) // 0x221
        assert.equal(ha.getProperty(DEVICE_ID, 'humidity', 'state'), 57) // 0x336, integer %RH

        // Filter, read straight off the two TLV tags plus the derived difference.
        assert.equal(ha.getProperty(DEVICE_ID, 'filterlife', 'state'), 3000) // 0x356
        assert.equal(ha.getProperty(DEVICE_ID, 'filterremaining', 'state'), 2442) // 0x355
        assert.equal(ha.getProperty(DEVICE_ID, 'filterused', 'state'), 558) // 3000 - 2442

        dev.drop()
    })

    test('0xa7-marked state frames are accepted, and 0x87 still is too', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        // The whole reason this profile overrides processData().
        thinq.emit('data', buf(STATE_FAN_5_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'very high')

        // Same payload re-marked 0x87 (the value the base class expects) must still decode,
        // so a firmware that switches back is not broken by the override.
        thinq.emit('data', buf('00000400000087020444027E84BF1D'))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'medium')

        dev.drop()
    })

    test('mode notifications round-trip through the three supported modes', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(STATE_MODE_DRY_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'dry') // 0x1F9=1
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 24) // 0x1FE=48
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'auto') // 0x1FA=8

        thinq.emit('data', buf(STATE_MODE_AIRCLEAN_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'fan_only') // 0x1F9=5
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 26) // 0x1FE=52
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'very low') // 0x1FA=2

        thinq.emit('data', buf(STATE_MODE_COOL_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool') // 0x1F9=0
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 21) // 0x1FE=42
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'very high') // 0x1FA=6

        dev.drop()
    })

    test('power is reported as the climate mode, including off', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        // All-clean start turns the appliance on as a side effect.
        thinq.emit('data', buf(STATE_ALLCLEAN_RUNNING_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool') // 0x1F7=1, 0x1F9=0

        // ... and all-clean stop turns it back off.
        thinq.emit('data', buf(STATE_ALLCLEAN_STOPPED_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'off') // 0x1F7=0

        dev.drop()
    })

    test('fan speed notifications map 2..6 onto the named steps', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        // Every step the appliance reported, so no two names can be swapped unnoticed.
        const steps: [string, string][] = [
            [STATE_FAN_1_HEX, 'very low'], // 0x1FA=2
            [STATE_FAN_2_HEX, 'low'], // 0x1FA=3
            [STATE_FAN_3_HEX, 'medium'], // 0x1FA=4
            [STATE_FAN_4_HEX, 'high'], // 0x1FA=5
            [STATE_FAN_5_HEX, 'very high'], // 0x1FA=6
        ]

        for (const [frame, expected] of steps) {
            thinq.emit('data', buf(frame))
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), expected, expected)
        }

        dev.drop()
    })

    test('current temperature is degrees times two', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        // The dump carried 0x1FD=50. A second, different sample is what distinguishes the
        // /2 scaling from any other transform that happens to pass through 25.
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 25) // 0x1FD=50

        thinq.emit('data', buf(STATE_CURRENT_TEMP_24_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 24) // 0x1FD=48

        dev.drop()
    })

    test('target temperature honours the 0.5 C resolution', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(STATE_TEMP_24_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 24) // 0x1FE=48

        thinq.emit('data', buf(STATE_TEMP_245_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 24.5) // 0x1FE=49

        dev.drop()
    })

    test('wind direction notifications become swing modes', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        // All five directions: left and right are the pair a reversed map would silently
        // swap, and the appliance reported each of them in a frame of its own.
        const directions: [string, string][] = [
            [STATE_WIND_WIDE_HEX, 'wide'], // 0x2A3=2
            [STATE_WIND_LEFT_HEX, 'left'], // 0x2A3=3
            [STATE_WIND_RIGHT_HEX, 'right'], // 0x2A3=4
            [STATE_WIND_CONCENTRATED_HEX, 'focus'], // 0x2A3=1
        ]

        for (const [frame, expected] of directions) {
            thinq.emit('data', buf(frame))
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_state'), expected, expected)
        }

        thinq.emit('data', buf(STATE_WIND_SPLIT_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_state'), 'split') // 0x2A3=5
        // the same frame carries a power reading
        assert.equal(ha.getProperty(DEVICE_ID, 'energy_current', 'state'), 297) // 0x2B3

        dev.drop()
    })

    test('jet mode reports fan speed 7 as auto, because the appliance owns the fan', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        // Before jet, the user's own selection is showing.
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'medium')

        thinq.emit('data', buf(STATE_JET_ON_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'jet', 'state'), 'ON') // 0x236=1
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 18) // forced 0x1FE=36
        /*
         * 0x1FA=7 means jet is driving the fan and the control is locked on the appliance.
         * Reporting 'auto' is what the hardware actually shows; leaving 'medium' up would
         * claim the user's old selection is still in force, which it is not.
         */
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'auto')

        thinq.emit('data', buf(STATE_JET_OFF_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'jet', 'state'), 'OFF') // 0x236=0
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'very high') // 0x1FA=6

        dev.drop()
    })

    test('dry mode also reports auto, from the other device-driven fan value', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        // 0x1FA=8 accompanies the dry-mode trio; the appliance greys the fan control out.
        thinq.emit('data', buf(STATE_MODE_DRY_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'dry')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'auto')

        dev.drop()
    })

    test('plain switch notifications', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(STATE_CHILDLOCK_ON_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'childlock', 'state'), 'ON')
        thinq.emit('data', buf(STATE_CHILDLOCK_OFF_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'childlock', 'state'), 'OFF')

        thinq.emit('data', buf(STATE_QUIET_ON_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'quiet', 'state'), 'ON')
        thinq.emit('data', buf(STATE_QUIET_OFF_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'quiet', 'state'), 'OFF')

        thinq.emit('data', buf(STATE_UVNANO_OFF_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'uvnano', 'state'), 'OFF')
        thinq.emit('data', buf(STATE_UVNANO_ON_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'uvnano', 'state'), 'ON')

        thinq.emit('data', buf(STATE_SPACEFIT_ON_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'spacefit', 'state'), 'ON')

        // 0x23E and 0x25E move together; only 0x23E is mapped.
        thinq.emit('data', buf(STATE_SMARTCARE_ON_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'smartcare', 'state'), 'ON')

        // AI dry enable is 0 / 255, not 0 / 1.
        thinq.emit('data', buf(STATE_AIDRY_OFF_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'aidry', 'state'), 'OFF')
        thinq.emit('data', buf(STATE_AIDRY_ON_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'aidry', 'state'), 'ON')

        dev.drop()
    })

    test('INVERTED display and beep decode with raw 1 meaning off', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(STATE_DISPLAY_OFF_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'display', 'state'), 'OFF') // 0x21F=1
        thinq.emit('data', buf(STATE_DISPLAY_ON_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'display', 'state'), 'ON') // 0x21F=0

        thinq.emit('data', buf(STATE_BEEP_MUTED_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'beep', 'state'), 'OFF') // 0x3A0=1

        dev.drop()
    })

    test('humidity is reported as a plain integer percentage', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(STATE_HUMIDITY_55_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'humidity', 'state'), 55)

        thinq.emit('data', buf(STATE_HUMIDITY_58_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'humidity', 'state'), 58)

        // 0x336 (the value) and 0x337 (the appliance's display option for it) are distinct
        // entities; moving one must not disturb the other.
        assert.equal(ha.getProperty(DEVICE_ID, 'humiditydisplay', 'state'), 'always')

        dev.drop()
    })

    test('select notifications', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(STATE_ONESIDE_LEFT_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'onesidewind', 'state'), 'left') // 0x2A8=1
        thinq.emit('data', buf(STATE_ONESIDE_RIGHT_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'onesidewind', 'state'), 'right') // 0x2A8=2

        thinq.emit('data', buf(STATE_AIDRY_LEVEL_1_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'aidrylevel', 'state'), '1') // 0x1F2=2
        thinq.emit('data', buf(STATE_AIDRY_LEVEL_4_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'aidrylevel', 'state'), '4') // 0x1F2=5

        // 0x337 is exposed read-only, but still decodes to a named value.
        thinq.emit('data', buf(STATE_HUMIDITY_ALWAYS_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'humiditydisplay', 'state'), 'always') // 0x337=1

        dev.drop()
    })

    test('cleaning cycles: 0x3A2 = 255 means all-clean, not heat-exchanger clean', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(STATE_HXCLEAN_START_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'hxclean', 'state'), 'ON') // 0x3A2=1
        assert.equal(ha.getProperty(DEVICE_ID, 'allclean', 'state'), 'OFF')
        // the appliance resets these by itself while the cycle runs
        assert.equal(ha.getProperty(DEVICE_ID, 'smartcare', 'state'), 'OFF') // 0x23E=0
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_state'), 'focus') // 0x2A3=1

        thinq.emit('data', buf(STATE_ALLCLEAN_RUNNING_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'allclean', 'state'), 'ON') // 0x165=2
        // 0x3A2 now reads 255, which means all-clean - a truthiness test would wrongly
        // report the heat exchanger clean as running.
        assert.equal(ha.getProperty(DEVICE_ID, 'hxclean', 'state'), 'OFF')

        thinq.emit('data', buf(STATE_ALLCLEAN_STOPPED_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'allclean', 'state'), 'OFF') // 0x165=0
        assert.equal(ha.getProperty(DEVICE_ID, 'hxclean', 'state'), 'OFF') // 0x3A2=0

        dev.drop()
    })

    test('temp_step follows 0x1FB and republishes the config', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        const climate = () => ha.devices[DEVICE_ID].config!.components.climate as Record<string, unknown>

        assert.equal(climate().temp_step, 0.5) // 0x1FB=0 in the dump
        assert.equal(climate().precision, 0.5)

        thinq.emit('data', buf(STATE_TEMPSTEP_1C_HEX))
        assert.equal(climate().temp_step, 1) // 0x1FB=1
        assert.equal(climate().precision, 1)

        thinq.emit('data', buf(STATE_TEMPSTEP_05C_HEX))
        assert.equal(climate().temp_step, 0.5) // 0x1FB=0
        assert.equal(climate().precision, 0.5)

        // 0x1FB must not have produced an entity of its own on the climate component.
        assert.ok(!climate().temp_step_state_topic, 'no stray topic for 0x1FB')
        assert.ok(!climate().state_topic, 'no stray bare state_topic on climate')

        dev.drop()
    })

    // --- writes ---

    test('HA write climate-mode emits the captured TLV trio', (t) => {
        enableMockTimers(t)
        const cases: [string, string, Record<number, number>][] = [
            ['cool', WRITE_MODE_COOL_HEX, { 0x1fa: 6, 0x1fe: 42 }],
            ['dry', WRITE_MODE_DRY_HEX, { 0x1fa: 8, 0x1fe: 48 }],
            ['fan_only', WRITE_MODE_FAN_ONLY_HEX, { 0x1fa: 2, 0x1fe: 52 }],
        ]

        for (const [mode, expected, pre] of cases) {
            const { ha, thinq, dev } = readyDevice()
            // Pre-state observed in the capture at the moment of this write. The appliance
            // was running throughout - the dump left 0x1F7=1 - which is the case in which
            // our frame has to stay byte-identical to the app's trio.
            assert.equal(dev.raw_clip_state[0x1f7], 1, 'appliance is on')
            for (const tag of Object.keys(pre)) dev.raw_clip_state[Number(tag)] = pre[Number(tag)]

            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', mode)

            assert.equal(thinq.outbox.length, 1, mode)
            assert.equal(hex(thinq.outbox[0]), expected.toUpperCase(), mode)
            dev.drop()
        }
    })

    test('HA write climate-mode from off also powers the appliance on', (t) => {
        enableMockTimers(t)
        const cases: [string, string, Record<number, number>][] = [
            ['cool', WRITE_MODE_COOL_FROM_OFF_HEX, { 0x1fa: 6, 0x1fe: 42 }],
            ['dry', WRITE_MODE_DRY_FROM_OFF_HEX, { 0x1fa: 8, 0x1fe: 48 }],
            ['fan_only', WRITE_MODE_FAN_ONLY_FROM_OFF_HEX, { 0x1fa: 2, 0x1fe: 52 }],
        ]

        for (const [mode, expected, pre] of cases) {
            const { ha, thinq, dev } = readyDevice()
            dev.raw_clip_state[0x1f7] = 0
            for (const tag of Object.keys(pre)) dev.raw_clip_state[Number(tag)] = pre[Number(tag)]

            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', mode)

            assert.equal(thinq.outbox.length, 1, mode)
            assert.equal(hex(thinq.outbox[0]), expected.toUpperCase(), mode)

            // The added tag must carry 1: attaching 0x1F7 while raw_clip_state still says 0
            // would send a power-off with the mode change.
            assert.equal(dev.raw_clip_state[0x1f7], 1, `${mode} sets power on`)
            const frame = thinq.outbox[0]
            assert.ok(frame.includes(Buffer.from([0x7d, 0xc1])), `${mode} frame carries 0x1F7=1`)
            assert.ok(!frame.includes(Buffer.from([0x7d, 0xc0])), `${mode} frame carries no 0x1F7=0`)

            dev.drop()
        }
    })

    test('HA write climate-mode=off triggers power=OFF instead of a mode write', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'off')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_OFF_HEX.toUpperCase())

        dev.drop()
    })

    test('HA write climate-power attaches the mode trio when switching on', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'climate', 'power_command', 'ON')
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_ON_HEX.toUpperCase())

        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'climate', 'power_command', 'OFF')
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_OFF_HEX.toUpperCase())

        dev.drop()
    })

    test('HA write climate-fan_mode emits expected bytes', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        dev.raw_clip_state[0x1f9] = 0
        dev.raw_clip_state[0x1fe] = 42

        ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', 'medium')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_FAN_MEDIUM_HEX.toUpperCase())

        dev.drop()
    })

    test('HA write climate-temperature emits expected bytes and clamps to 18..30 C', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        dev.raw_clip_state[0x1f9] = 1
        dev.raw_clip_state[0x1fa] = 8

        ha.setProperty(DEVICE_ID, 'climate', 'temperature_command', '24.5')
        assert.equal(hex(thinq.outbox[0]), WRITE_TEMP_245_HEX.toUpperCase())

        dev.raw_clip_state[0x1f9] = 0
        dev.raw_clip_state[0x1fa] = 4

        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'climate', 'temperature_command', '99')
        assert.equal(hex(thinq.outbox[0]), WRITE_TEMP_CLAMP_HIGH_HEX.toUpperCase())

        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'climate', 'temperature_command', '-5')
        assert.equal(hex(thinq.outbox[0]), WRITE_TEMP_CLAMP_LOW_HEX.toUpperCase())

        dev.drop()
    })

    test('HA write climate-swing_horizontal_mode emits the captured single-tag payload', (t) => {
        enableMockTimers(t)
        for (const [mode, expected, appFrame] of WRITE_SWINGS) {
            const { ha, thinq, dev } = readyDevice()

            ha.setProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_command', mode)

            assert.equal(thinq.outbox.length, 1, mode)
            assert.equal(hex(thinq.outbox[0]), expected.toUpperCase(), mode)

            const ours = buf(expected)
            const theirs = buf(appFrame)
            assert.deepEqual(
                ours.subarray(11, ours.length - 2),
                theirs.subarray(11, theirs.length - 2),
                `${mode} TLV payload matches the captured app frame`,
            )

            dev.drop()
        }
    })

    test('HA write of every switch emits the captured single-tag payload', (t) => {
        enableMockTimers(t)
        for (const [comp, payload, expected, appFrame] of WRITE_SWITCHES) {
            const { ha, thinq, dev } = readyDevice()

            ha.setProperty(DEVICE_ID, comp, 'command', payload)

            const label = `${comp}=${payload}`
            assert.equal(thinq.outbox.length, 1, label)
            assert.equal(hex(thinq.outbox[0]), expected.toUpperCase(), label)

            // The TLV payload (everything after the 11-byte header, minus the CRC) has to
            // match the LG app's own frame byte for byte.
            const ours = buf(expected)
            const theirs = buf(appFrame)
            assert.deepEqual(
                ours.subarray(11, ours.length - 2),
                theirs.subarray(11, theirs.length - 2),
                `${label} TLV payload matches the captured app frame`,
            )

            dev.drop()
        }
    })

    test('HA write of every select emits the captured single-tag payload', (t) => {
        enableMockTimers(t)
        for (const [comp, payload, expected, appFrame] of WRITE_SELECTS) {
            const { ha, thinq, dev } = readyDevice()

            ha.setProperty(DEVICE_ID, comp, 'command', payload)

            const label = `${comp}=${payload}`
            assert.equal(thinq.outbox.length, 1, label)
            assert.equal(hex(thinq.outbox[0]), expected.toUpperCase(), label)

            const ours = buf(expected)
            const theirs = buf(appFrame)
            assert.deepEqual(
                ours.subarray(11, ours.length - 2),
                theirs.subarray(11, theirs.length - 2),
                `${label} TLV payload matches the captured app frame`,
            )

            dev.drop()
        }
    })

    test('a select write with an unknown option sends nothing', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'onesidewind', 'command', 'sideways')
        ha.setProperty(DEVICE_ID, 'aidrylevel', 'command', '9')

        assert.equal(thinq.outbox.length, 0, 'no bogus TLV written')

        dev.drop()
    })

    // --- filter, from TLV tags 0x355 / 0x356 ---

    test('filter remaining counts down and used is derived from the pair', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        // Both halves of the transition in one place. A second, lower remaining is what
        // proves 0x355 counts DOWN rather than up, and that used tracks it the other way.
        assert.equal(ha.getProperty(DEVICE_ID, 'filterremaining', 'state'), 2442) // from the dump
        assert.equal(ha.getProperty(DEVICE_ID, 'filterused', 'state'), 558)

        thinq.emit('data', buf(STATE_FILTER_REMAINING_2441_HEX))

        assert.equal(ha.getProperty(DEVICE_ID, 'filterlife', 'state'), 3000) // 0x356, unchanged
        assert.equal(ha.getProperty(DEVICE_ID, 'filterremaining', 'state'), 2441) // 0x355
        assert.equal(ha.getProperty(DEVICE_ID, 'filterused', 'state'), 559) // 3000 - 2441

        dev.drop()
    })

    test('used is not published until both tags are known', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()

        // 0x355 alone. Its own sensor can publish, but 3000 - undefined is NaN, so the
        // derived one must stay silent. This is the only arrangement in which the guard is
        // observable: the dump carries 0x356 first, and a publish of NaN there would be
        // overwritten by the correct value later in the very same frame.
        thinq.emit('data', buf(STATE_FILTER_REMAINING_2441_HEX))

        assert.equal(ha.getProperty(DEVICE_ID, 'filterremaining', 'state'), 2441)
        assert.equal(ha.getProperty(DEVICE_ID, 'filterused', 'state'), undefined, 'nothing published yet')

        // Once the life arrives, the pair resolves.
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'filterlife', 'state'), 3000)
        assert.equal(ha.getProperty(DEVICE_ID, 'filterused', 'state'), 558) // dump carries 2442

        dev.drop()
    })

    test('nothing on the private command channel is queried or decoded any more', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder()

        // start() resets the TLV blacklist and that is now all it does - no private probe is
        // scheduled, because the 720 h counter that probe returned is not this appliance's
        // filter and its meaning is unidentified.
        dev.start()
        assert.deepEqual(thinq.sent, [{ cmd: 'setMaskingInfo', type: 0, data: { blacklist_tlv: '1200' } }])

        // The old code probed 500 ms after start() and then once a day. Nothing schedules a
        // private command now; what is left on the wire is the base class' 15 s capability
        // retry, which sends [0x01, 0x01, ...] rather than sendPrivCommand's [0x00, 0xff].
        tickMockTimers(t, 24 * 60 * 60 * 1000)
        assert.equal(thinq.outbox.filter((frame) => frame[1] === 0xff).length, 0, 'no private command sent')

        // A private-channel frame still reaches processData()'s widened branches, and must
        // now publish nothing at all.
        thinq.emit('data', buf(PRIV_0C_RESPONSE_HEX))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {}, 'no properties published')

        // The filter entities exist regardless, and read only from TLV.
        const components = ha.devices[DEVICE_ID].config!.components
        assert.ok(components.filterlife && components.filterremaining && components.filterused)
        assert.deepEqual(components.filterreset, { platform: 'button' }, 'reset button only marked for removal')

        dev.drop()
    })

    test('the capability reply cannot feed the filter sensors', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()

        /*
         * The base class dispatches every tag of every accepted frame to its field before it
         * looks at whether the frame is a capability reply, and the capability reply is the
         * first frame this profile ever sees - so this is the state the filter sensors are
         * born into, not an edge case.
         */
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))

        // First: the frame really was accepted and really did take the capability path.
        // Without this the assertions below would also pass on a frame processData() had
        // silently dropped, i.e. on a test that checks nothing.
        assert.equal(dev.raw_clip_state[0x2e1], 36, 'caps frame was parsed (0x2E1)')
        assert.equal(dev.raw_clip_state[0x2e2], 60, 'caps frame was parsed (0x2E2)')
        assert.equal(dev.query_caps_timeout, undefined, 'recognised as the capability reply')

        // And the filter tags inside it went nowhere - not to their own sensors, and not
        // into the raw state the derived one is computed from.
        assert.equal(dev.raw_clip_state[0x355], undefined, '0x355 not taken from caps')
        assert.equal(dev.raw_clip_state[0x356], undefined, '0x356 not taken from caps')
        assert.equal(ha.getProperty(DEVICE_ID, 'filterlife', 'state'), undefined, 'no life published')
        assert.equal(ha.getProperty(DEVICE_ID, 'filterremaining', 'state'), undefined, 'no remaining published')
        assert.equal(ha.getProperty(DEVICE_ID, 'filterused', 'state'), undefined, 'no used published')

        // Real counters come from a state frame, and a capability reply arriving afterwards
        // must not disturb them either.
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))

        assert.equal(ha.getProperty(DEVICE_ID, 'filterlife', 'state'), 3000)
        assert.equal(ha.getProperty(DEVICE_ID, 'filterremaining', 'state'), 2442)
        assert.equal(ha.getProperty(DEVICE_ID, 'filterused', 'state'), 558)

        dev.drop()
    })
})
