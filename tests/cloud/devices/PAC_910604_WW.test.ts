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
 * The REAL capability reply, captured from the appliance by injecting queryCaps()'s frame
 * (CAPS_REQUEST_HEX above) and recording what came back. 174 bytes, 54 TLVs, buf[8] = 0x01.
 * The synthetic fixture above stays because it carries filter tags this one does not, which
 * is the only way to test that a capability reply cannot reach the filter sensors.
 *
 *      t=0x2da v=3485736   eeprom checksum - what isCapsResponse() keys on
 *      t=0x2e1 v=36        setpoint minimum, 18.0 C
 *      t=0x2e2 v=60        setpoint maximum, 30.0 C
 *      t=0x2d7 v=0 / 1 / 5 three entries: the modes this appliance supports, i.e. cool,
 *                          dry and air-clean - the same three the remote offers
 *      ... 48 further tags, meaning unknown
 */
const CAPS_RESPONSE_REAL_HEX =
    '000004000000A7020161A1' +
    '6400644F64907C6C6018036C816D01B000B05023B0B001F07CB0C0B10DB23004F800B290C0B2E0084' +
    '3B340B4F0045013B500B5601213B5A0C002B76001A0B780B7C0B801B85024B8903CB8D020B9103CBC' +
    '600201BD1010BD60580FB240D3F0020000BC08D42001FFEA1021E1901CDD05FB102FB4A00200B6B03' +
    '53028B6F0310917EFC0F010FFF06003FEFA01B5C0B61030B644B5C1B61030B648B5C5B61030B643' +
    '2A9C'

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

/*
 * NO CHANGE FRAME EXISTS for 0x21a, the sleep timer, and none is invented here. Every capture
 * file was decoded frame by frame and searched for the tag, to the end of each file. It
 * appears exactly twice, once in each of the two 94-TLV comprehensive dumps, and reads 0 both
 * times:
 *
 *      t=0x21a v=0     bytes 8680, at payload offset 51 of QUERY_RESPONSE_HEX above
 *
 * The operator never set a sleep timer while capturing, so a nonzero reading was never
 * recorded, no countdown was ever seen, and the LG app was never observed writing the tag.
 * The decode of 0 is therefore asserted from the dump, and the nonzero read conversion is
 * driven through processKeyValue() - the same entry point processTLV() uses for every tag of
 * every frame - rather than through a frame that was never seen on the wire. The writes below
 * are a different matter: those are bytes this profile emits, so they are asserted exactly,
 * they just have no captured app frame to be compared against.
 *
 * 0x225 is NOT such a case. It has TEN real device-side readings and a real cancel write, all
 * in aidry-run.jsonl, a capture of a genuine AI dry cycle - see STATE_AIDRY_* below.
 *
 * SCAN TO THE END OF THE FILE, both times this comment has been wrong it was for not doing
 * that. The first version claimed 0x225 had no change frames at all, having searched only
 * stand-capture.jsonl and filter-reset.jsonl. The second claimed it had "four", having
 * searched aidry-run.jsonl but stopped at its `stopped` marker at t+213.8s - the file
 * continues with a fresh `session` record at t+706.8s and six more 0x225 frames after it.
 *
 * 0x1fb is real on both sides: the two change frames above are captures, and so are the LG
 * app's own writes of it, quoted at the temp-step select in the profile:
 *
 *      01010400000065020100047f007ec14025      0x1fc = 0, 0x1fb = 1
 *      01010400000065020100047f007ec05004      0x1fc = 0, 0x1fb = 0
 *
 * Note the 0x1fc = 0 the app pairs with each write. This profile sends a bare 0x1fb, because
 * 0x1fc is never reported by the appliance and so cannot be sourced from raw_clip_state; the
 * write below asserts what we actually emit, and is deliberately not compared against these
 * app frames the way every other write in this file is.
 */
const WRITE_TEMPSTEP_1C_HEX = '01010400000065020101027EC14004' // 0x1fb=1
const WRITE_TEMPSTEP_05C_HEX = '01010400000065020101027EC05025' // 0x1fb=0

/*
 * Sleep timer writes. No captured app frame exists for these either - the app was never seen
 * setting the timer - so they are what this profile emits, with the TLV hand-checked:
 *   2.5 h -> 150 min: t0 = 0x21a >> 2 = 0x86, then (0x21a & 3) << 6 | 0x10 = 0x90, then 150
 *   = 0x96, i.e. payload 869096. 15 h -> 900 min needs two value bytes: 86 A0 03 84.
 */
const WRITE_SLEEPTIMER_25H_HEX = '0101040000006502010103869096AE72' // 0x21a=150
const WRITE_SLEEPTIMER_15H_HEX = '010104000000650201010486A00384B247' // 0x21a=900
const WRITE_SLEEPTIMER_OFF_HEX = '010104000000650201010286808289' // 0x21a=0

/*
 * A REAL AI DRY CYCLE, captured verbatim from aidry-run.jsonl while the operator watched the
 * appliance's own display and wrote down what it said. This is the evidence that 0x225 is in
 * MINUTES on this model rather than the percent RAC_056905_WW publishes:
 *
 *      t+2.0s      the app sends 0x1f7 = 0, i.e. switch off
 *      t+2.9s      STATE_AIDRY_START_HEX below: 0x1f7 = 0 and 0x225 = 32 in one frame
 *      t+11.8s     operator: "전원 껐음 - 건조 시작될 것"  (turned it off, drying will start)
 *      t+18.2s     operator: "화면에 건조 표시 보임"       (the display shows drying)
 *      t+34.5s     operator: "32분 남았다고 보임"          (it says 32 minutes left)
 *      t+47.1s     0x225 = 31
 *      t+106.8s    0x225 = 30
 *      t+166.6s    0x225 = 29
 *      t+211.1s    operator: "29분 남았다고 보임"          (it says 29 minutes left)
 *      ---         the capture stops at t+213.8s and resumes at t+706.8s, so 28 .. 20 were
 *                  never recorded: the jump below is a recording gap, not a skipped tick
 *      t+763.6s    0x225 = 19  |
 *      t+823.3s    0x225 = 18  |  59.7 / 59.8 / 59.7 / 59.9 s apart
 *      t+883.1s    0x225 = 17  |
 *      t+942.8s    0x225 = 16  |
 *      t+1002.7s   0x225 = 15  |
 *      t+1019.5s   operator: "지금 15분 남음"              (15 minutes left now)
 *      t+1021.3s   the app cancels the cycle - see the read-only test for the frame
 *      t+1021.6s   STATE_AIDRY_END_HEX below: the appliance confirms 0x225 = 0
 *
 * Two independent things are pinned here. THREE operator transcriptions fix the UNIT: the
 * display said 32, 29 and 15 at moments when the tag held 32, 29 and 15.
 *
 * SIX intervals fix the RATE - 59.7, 59.8 in the first session and 59.7, 59.8, 59.7, 59.9 in
 * the second. Count them rather than counting decrements: seven transitions were observed and
 * the seventh, 32 -> 31, is 44.2 s because the cycle started part-way through a minute, so it
 * measures nothing. The recording gap is a seventh interval in disguise and the longest one
 * on file: 29 at t+166.6s and 19 at t+763.6s is 597.0 s for ten steps, i.e. 59.70 s a step,
 * agreeing with the six to a tenth of a second across ten minutes of wall clock. One step per
 * minute is a minute counter, and is not how a percentage of a ~32-minute cycle would move.
 *
 * Decoding the single-tag payload 89501F by hand, because the scale is the whole point:
 *   89 50   tag = (0x89 << 2) | (0x50 >> 6) = 0x225, len = (0x50 >> 4) & 3 = 1, nibble = 0
 *   1F      => value 31
 */
// 0x1f7=0 0x1f9=0 0x1fe=50 0x1fa=4 0x348=0 0x225=32 0x336=65 0x23d=0 0x312=19
const STATE_AIDRY_START_HEX = '000004000000A70204D7167DC07E407F90327E84D200895020CD90418F40C49013025A'
const STATE_AIDRY_REMAIN_31_HEX = '000004000000A70204DC0389501F45D8' // 0x225=31, single tag
// 0x225=30, alongside the unmapped 0x279 / 0x27a and the length field 0x312
const STATE_AIDRY_REMAIN_30_HEX = '000004000000A70204E20A89501E9E508B9E8EC488E7F0'
const STATE_AIDRY_REMAIN_29_HEX = '000004000000A70204E50389501DC108' // 0x225=29, single tag

/*
 * The second session's run, t+763.6s .. t+1002.7s. Kept as a list rather than as five more
 * named constants because no one of them means anything alone - the point is the rate, and
 * then the operator's third transcription landing on the last of them.
 *
 * The last one encodes DIFFERENTLY from its siblings, which is worth decoding by hand:
 *   89 4F   tag = (0x89 << 2) | (0x4F >> 6) = 0x225, len = (0x4F >> 4) & 3 = 0
 *           => the value is the low nibble itself, 15, with no value byte at all - unlike
 *              the 8950 1F above, which spends a byte to say 31.
 */
const STATE_AIDRY_TICKS_19_TO_15: [string, number][] = [
    ['000004000000A70204FD0389501326B1', 19],
    ['000004000000A70204FE03895012D842', 18],
    ['000004000000A70204FF038950114270', 17],
    ['000004000000A70204000389501008FE', 16],
    ['000004000000A702040309894F9E50149E82C4879B48', 15], // + the unmapped 0x279 / 0x27a
]

/*
 * The cycle ENDING, t+1021.6s: the appliance's own answer to the cancel, and the real OFF
 * edge. Three tags - 0x225 = 0, 0x2a3 = 1 (it resets the wind direction as the cycle ends,
 * so this frame moves swing_horizontal_mode too) and the length field 0x312 = 4.
 *
 * Used for the OFF edge in place of QUERY_RESPONSE_HEX, which rewrites all 94 tags at once
 * and therefore cannot distinguish "the running flag cleared BECAUSE 0x225 reached 0" from
 * "everything was rewritten at once".
 */
const STATE_AIDRY_END_HEX = '000004000000A7020404068940A8C1C48485B6' // 0x225=0 0x2a3=1 0x312=4

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

/*
 * --- the 0xa8 telemetry record, for hvac_action ---
 *
 * All of these are real frames, quoted whole. The long ones are from hvac-action.jsonl, a
 * capture the owner ran specifically to make the compressor start and stop on command: cooling
 * at 18 C, setpoint raised to 30 C so it would stop, lowered to 18 C so it would restart, then
 * a switch to dry - annotating each step live and metering the outdoor unit.
 *
 * These frames are NOT TLV. They are a fixed-offset struct, they carry 0xff at buf[10] where
 * every other frame kind puts a payload length, and they are 307 bytes. Only byte 160 is
 * decoded, and only after the profile has checked all three of those things.
 *
 * WHICH BYTE, AND WHY IT IS NOT OBVIOUS: the five frames the owner labelled with a
 * present-tense observation are reproduced equally well by @160, @173 and @198, and the first
 * two disagree on only two frames in the entire four-capture corpus. Both of those are frames
 * he predicted rather than watched. COMPRESSOR_RUNNING_OFFSET in the profile carries the full
 * derivation; the fixtures below are chosen so that the ones the tests lean on hardest are the
 * observed frames, and the two disputed frames are labelled as disputed.
 *
 * The short 0xa8 variant is the reason the length test is not optional: it is 15 bytes, so
 * buf[160] of it is `undefined`. It appears once, in stand-capture.jsonl at t+4341.7s, and
 * nothing else about it is known.
 */
/* t+4.5s, the appliance being switched on: @160=0 (@173=1 - one of the two disputed frames).
 * 0x2b3 reads 25.5 W here and ramps to 88.2 W by t+68.1s before stepping to 943.2 W at
 * t+77.8s, so the compressor started roughly 73 s after this frame: fan only, i.e. 'idle'. */
const A8_POWERON_HEX =
    '000004000000A8670301FF0B01010353010100000400000000000000000000010024350000000000000000000100000B' +
    'B80BB80100050000000000004E000000000100000103003C0001000000001800000202010156142D1E00320000000000' +
    '0000000000610000191900030C03340320000003160339032500007A007A180100000005250004800005D30001125A00' +
    '1612001300000A020A0008000000000000010200D400000002F8000000016C74D30035D300000F06A9000005C1039400' +
    '0000000001040100D7000000000000000000000000006400E20002620E0000012C012C00000000010000000012010000' +
    '000000000ACE000100030000000A0000330001C200008000000000000000000000000000000000000A0D3000FFFFFF00' +
    '020000000000000000000000000000000535EC'
const A8_COOLING_HEX = // hvac-action.jsonl t+142.3s, @160=1, "압축기 도는 중" at t+125.4s
    '000004000000A8670301FF0B0101035601010000040000000000000000000001003C350000000000000000000100000B' +
    'B80BB801000500000000000044000000000100000100003C0001000000001800000202010156142D1E00320000000000' +
    '00000000006100001919000226024E023A000002E4030702F8000099009A180000000005250004800005D300020F4618' +
    '4646009F080015021702180000000000010004000026170002EE000000014B51CA3735CE000055093209F00420036C00' +
    '0000000101010100FF000000000000000000000000006400DE0003DE3900030186018601000000010000000012010000' +
    '000000000ACE000100030000000A00005600024D00335F00000000000000000000000000000000000A0A3300FFFFFF00' +
    '020000000000000000000000000000000530AD'
const A8_STOPPED_HEX = // t+173.2s, @160=0, "압축기 선 듯" at t+156.6s, 0 W metered at t+185.5s
    '000004000000A8666501FF0B0101655801010000040000000000000000000001003C350000000000000000000100000B' +
    'B80BB801000500000000000044000000000100000100003C0001000000001800000202010156142D1E00320000000000' +
    '00000000006100001919000226024E023A0000022B0253023F0000900091180000000005250004800005D300000A2800' +
    '00000000000016020000000000000000000005002800000002EE000000004B5FCB0035D3000000098209F00458036C00' +
    '00000001010100001C000000000000000000000000006400E20001CC050000012C012C00000000010000000012010000' +
    '000000000ACE000100030000000A00005700026C0003F0000000000000000000000000000000000004033300FFFFFF00' +
    '02000000000000000000000000000000051BA1'
/* t+337.3s, 145 s after the setpoint was lowered back to 18 C: @160=0 (@173=1 - the OTHER
 * disputed frame). The owner's note here, at t+198.1s, is "다시 돌 것" - it WILL run again -
 * a prediction, so this frame has no observed label. Hz @177 and EEV @152 read 0 and coil
 * temperature @175 reads 121, the corpus maximum, against <= 107 in all 30 frames with
 * @177 > 0; 0x2b3 has moved 87.1 -> 138.8 W. Something is starting, nothing is cooling yet. */
const A8_NOT_YET_RESTARTED_HEX =
    '000004000000A8670D01FF0B01010D62010100000700000000000101000100000024350000000000000000000100000B' +
    'B70BB80100050000000000004C000000000100000100003C0001000000001800000202010156142D1E00320000000000' +
    '000000000061000019190004A604CE04BA000004B004DD04C4000079007A180100000005250004800005D300000A5A00' +
    '0000000000001602000000000000000000010100D600000001F4000000014E79D50035D30000550932000005C1000000' +
    '0000000001070100C6000000000000000000000000006400E2000208050000012C012C00000000010000000012010000' +
    '000000000ACE000000030000000A00005A000311000367000000000000000000000000000000000004043600FFFFFF00' +
    '0200000000000000000000000000000005A943'
const A8_RUNNING_AGAIN_HEX = // t+433.1s, @160=1, "다시 도는 중" (running again) at t+420.1s
    '000004000000A8670201FF0B0101026301010100080000000000000000000000002E340000000000000000000100000B' +
    'B70BB801000500000000000048000000000100000103003C0001000000001800000202010156142D1E00320000000000' +
    '000000000061000019190004A604CE04BA000004A104C904AB0000910081180101080005250004800005CC00023F5A00' +
    '3E4C005C010C120C150717010000000001010400D61F00000302000000015157CF3635D000005208B60A0904A403F000' +
    '0000000001030100FF000000000000000000000000006400DE0002B2470003011D011D00000000010000000012010000' +
    '000000000ACE000000030000000A00006C000371002D9C00000000000000000000000000000000000D043800FFFFFF00' +
    '0200000000000000000000000000000005DE0B'
const A8_DRYING_HEX = // t+473.0s, @160=1, taken while the appliance was in dry mode
    '000004000000A8666501FF0B0101656701010100080000000000000000000000002E340000000000000000000100000B' +
    'B70BB801000500000000000045000000000100000100003C0001000000001800000202010156142D1E00320000000000' +
    '0000000000610000191900029E02C602B20000029902C102BC00009900901801010800052500048000057801020F3F18' +
    '3F3F00840B001600160316000000000001010400ED0B170002F8000000014D53CC3B35CE000020094A0A030443046600' +
    '0000000001030100FF000000000000000000000000006400DF0003D9310002015E016301000000010000000012010000' +
    '000000000ACE000000030000000A000079000399002C7B000000000000000000000000000000000004043800FFFFFF00' +
    '0200000000000000000000000000000005368F'
/* The short variant: 15 bytes, buf[10] = 0x02 = length - 13. stand-capture.jsonl t+4341.7s. */
const A8_SHORT_HEX = '000004000000A8180201024EC1ABDA'

/*
 * Two more real frames, and the reason the profile tests power and mode BEFORE the compressor
 * flag. Both are the appliance genuinely reporting a running compressor in a situation where
 * 'cooling' would be the wrong answer, and each follows its partner state frame directly on
 * the wire - no combination of unrelated captures is involved:
 *
 *   aidry-run.jsonl     t+2.9s  STATE_AIDRY_START_HEX, 0x1f7=0 - the appliance switched off
 *                       t+5.1s  this frame, @160=1 - the compressor is still coasting down.
 *                               Operator at t+11.8s: "전원 껐음 - 건조 시작될 것" (turned the
 *                               power off, the dry will start). @160 only reaches 0 at t+14.0s.
 *   stand-capture.jsonl t+585.5s STATE_MODE_AIRCLEAN_HEX, 0x1f9=5 - switched to air-clean
 *                       t+587.5s this frame, @160=1 - still winding down from the dry cycle
 *                               that preceded it. Operator at t+590.6s: "공기청정".
 */
const A8_RUNNING_WHILE_OFF_HEX = // aidry-run.jsonl t+5.1s, @160=1 with 0x1f7=0
    '000004000000A8670101FF0B01010139000000000400000000000000000000000032330000000000000000000100000B' +
    'B80BB801000500000000000041000000000200000103003C0001000000001800000002010156142D1E00320000000000' +
    '000000000061000019190003DE040603F200000307032F032500009B008D1800000000052500048000049200020A4618' +
    '29291B2B1A001301150315000000000001000400001A09000384000000015B6BAE3E36CE00000807EB06D403FF03EF00' +
    '0000000100060100FF000000000000000000000000006400E00002AD3000020122012200000000010000000012010020' +
    '000000000ACE000000030000000A000B6B00000000048200000000000000000000000000000000000A652900FFFFFF00' +
    '0000000000000000000000000000000005A770'
const A8_RUNNING_WHILE_AIRCLEAN_HEX = // stand-capture.jsonl t+587.5s, @160=1 with 0x1f9=5
    '000004000000A8670201FF0B010102090101050002000000000000000000000100343100000000000000000001000009' +
    '8A0BB801000500000000000037000000000100000103003C0001000000001800000202010156142D1E00320000000000' +
    '00000000006100001919000276029E028A0000029E02BC02B20000A900AC1800010800057F0004D00003FB01020F3F18' +
    '3F3F04E415EA1804180319000000000001010400C433FE00033400000001454AB74D3CB50000060A6E0A26037D039200' +
    '0000000101020100FF000000000000000000000000006400DA0003DE3900030168016D0100000001000000000D010000' +
    '000000000AC900010003000000060001EF0005A6000A190000000000000000000000000000000000030A0C00FFFFFF00' +
    '0200000000000000000000000000000005B5B7'

/*
 * The appliance's own state frames from the same run, so a whole scenario can be replayed out
 * of one capture rather than assembled from several.
 *   t+430.9s - the app switched the appliance to dry; 0x1f9=1, 0x1fe=46, 0x1fa=8, 0x348=1
 *   t+138.5s / t+192.0s - the two setpoint moves that made the compressor stop and restart,
 *              0x1fe=60 (30.0 C) and 0x1fe=36 (18.0 C). Quoted to show the experiment really
 *              is what the owner said it was; the action does not depend on 0x1fe.
 */
const STATE_HVAC_TO_DRY_HEX = '000004000000A702049D0F7E417F902E7E8881808D80D201C48D5A9F'
const STATE_HVAC_SETPOINT_30_HEX = '000004000000A7020470057F903CC4834753'
const STATE_HVAC_SETPOINT_18_HEX = '000004000000A7020478057F9024C4833E3C'

/*
 * stand-capture.jsonl t+4327.8s: 0x1f7=0, the falling half of the only real power cycle in the
 * corpus. Its rising half at t+4340.5s is already quoted above as STATE_ALLCLEAN_RUNNING_HEX -
 * one frame, two facts, because the owner switched the appliance on and started all-clean in
 * the same action.
 */
const STATE_POWER_OFF_HEX = '000004000000A70204AC117DC07E407F90327E86D2008F40E880C48F64F0'

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
        // Power is a primary measurement too, and needs force_update or a Riemann sum over
        // it staircases: the appliance refreshes slower than the profile polls.
        assert.ok(!components.energy_current?.entity_category, 'power is not diagnostic')
        assert.equal(components.energy_current?.force_update, true)

        // Names the user reads on the device page.
        assert.equal(components.display?.name, 'Display Light')
        assert.equal(components.jet?.name, 'Jet cool')

        /*
         * The LG app sets this over the private command channel (command 0x0c), never by a
         * TLV write, so it was first exposed read-only. A TLV write was then tried on the
         * appliance and does take effect, hence a writable select.
         */
        assert.equal(components.humiditydisplay?.platform, 'select')
        assert.deepEqual(components.humiditydisplay?.options, ['while running', 'always'])

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
        assert.deepEqual(components.changeddate, { platform: 'sensor' }, 'changed-date sensor marked for removal')
        assert.ok(!components.filterchangeddate, 'no filter changed-date sensor (topic name)')

        // The reset button is back, on the same unique_id, now driving a TLV write.
        assert.equal(components.filterreset?.platform, 'button')
        assert.equal(components.filterreset?.unique_id, '$deviceid-filterreset')
        assert.equal(components.filterreset?.entity_category, 'diagnostic')
        assert.ok(dev.fields_by_ha['filterreset'], 'filter reset write path exists')

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

        assert.equal(ha.getProperty(DEVICE_ID, 'energy_current', 'state'), 350.1) // 0x2B3=3501, tenths of a W
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
        assert.equal(ha.getProperty(DEVICE_ID, 'energy_current', 'state'), 29.7) // 0x2B3=297, tenths of a W

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

    /*
     * 0x1FB has TWO jobs and exactly ONE field. addSelectField() would have registered its own
     * field for the tag and silently replaced the temp_step sync, which is why the profile
     * builds this select by hand. The point of this test is that both jobs still happen from
     * the one field, so it asserts them together rather than in separate tests.
     */
    test('the temperature step select publishes AND still moves the climate temp_step', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        const climate = () => ha.devices[DEVICE_ID].config!.components.climate as Record<string, unknown>

        // The dump carried 0x1FB=0: the select reads it out, and so does the climate card.
        assert.equal(ha.getProperty(DEVICE_ID, 'tempstep', 'state'), '0.5')
        assert.equal(climate().temp_step, 0.5)

        thinq.emit('data', buf(STATE_TEMPSTEP_1C_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'tempstep', 'state'), '1') // 0x1FB=1
        assert.equal(climate().temp_step, 1, 'the select did not take over the temp_step sync')
        assert.equal(climate().precision, 1)

        thinq.emit('data', buf(STATE_TEMPSTEP_05C_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'tempstep', 'state'), '0.5') // 0x1FB=0
        assert.equal(climate().temp_step, 0.5)

        dev.drop()
    })

    test('HA write tempstep emits a bare 0x1FB, and an unknown option sends nothing', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'tempstep', 'command', '1')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_TEMPSTEP_1C_HEX.toUpperCase())

        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'tempstep', 'command', '0.5')
        assert.equal(hex(thinq.outbox[0]), WRITE_TEMPSTEP_05C_HEX.toUpperCase())

        /*
         * The LG app pairs each of its own writes with 0x1FC = 0 (see the fixture comment
         * above); we deliberately do not, because the appliance never reports 0x1FC. This is
         * the assertion that would have to change if that ever turns out to matter.
         */
        const ours = buf(WRITE_TEMPSTEP_05C_HEX)
        assert.equal(hex(ours.subarray(11, ours.length - 2)), '7EC0', 'one TLV, no 0x1FC')

        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'tempstep', 'command', '0.25')
        assert.equal(thinq.outbox.length, 0, 'no bogus resolution written')

        dev.drop()
    })

    // --- sleep timer, 0x21A ---

    test('the sleep timer reads minutes as hours, rounding up', (t) => {
        const { ha, dev } = buildReadyDevice(t)

        // 0x21A=0 in the comprehensive dump - the only reading of this tag in any capture.
        assert.equal(ha.getProperty(DEVICE_ID, 'sleeptimer', 'state'), 0)

        /*
         * No captured frame carries a running timer, so these go through processKeyValue(),
         * which is the exact entry point processTLV() calls for every tag of every frame.
         *
         * These cases assert the CONVERSION, which is this profile's own arithmetic, and
         * nothing more. The minute scale itself is not attested on this appliance - see the
         * sleep-timer note in the profile - so read the 900 case as "the top of the range the
         * owner reports and RAC_056905_WW uses", not as a measurement.
         *
         * 61 minutes is the case that fixes the rounding direction: an hour and a bit left
         * must not display as one hour, or HA would show the timer expiring early.
         */
        const cases: [number, number][] = [
            [15, 0.25],
            [61, 1.25],
            [150, 2.5],
            [900, 15], // 15 h, the top of the declared range - reported, not captured
        ]
        for (const [minutes, hours] of cases) {
            dev.processKeyValue(0x21a, minutes)
            assert.equal(ha.getProperty(DEVICE_ID, 'sleeptimer', 'state'), hours, `${minutes} min`)
        }

        dev.drop()
    })

    test('HA write sleeptimer converts hours back to minutes, exactly', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        // 2.5 h -> 150 min. The payload is 869096: tag 0x21A, one value byte, 0x96 = 150.
        ha.setProperty(DEVICE_ID, 'sleeptimer', 'command', '2.5')
        assert.equal(thinq.outbox.length, 1, 'exactly one frame')
        assert.equal(hex(thinq.outbox[0]), WRITE_SLEEPTIMER_25H_HEX.toUpperCase())

        // 15 h -> 900 min, which needs two value bytes rather than one.
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'sleeptimer', 'command', '15')
        assert.equal(hex(thinq.outbox[0]), WRITE_SLEEPTIMER_15H_HEX.toUpperCase())

        // 0 h cancels it, and must still go out - it is how the timer is switched off.
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'sleeptimer', 'command', '0')
        assert.equal(hex(thinq.outbox[0]), WRITE_SLEEPTIMER_OFF_HEX.toUpperCase())

        // The value really reached the appliance as minutes, not as hours.
        assert.equal(dev.raw_clip_state[0x21a], 0)
        ha.setProperty(DEVICE_ID, 'sleeptimer', 'command', '2.5')
        assert.equal(dev.raw_clip_state[0x21a], 150, 'stored in minutes')

        dev.drop()
    })

    // --- AI dry, 0x225 ---

    test('AI dry remaining counts down in MINUTES and drives the running flag', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        /*
         * The dump was taken while the appliance was cooling: the AI dry ENABLE switch is on,
         * and no cycle is running. That pair is the whole reason these are two entities - a
         * profile that published only 0x20E would claim a dry cycle was in progress here.
         */
        assert.equal(ha.getProperty(DEVICE_ID, 'aidry', 'state'), 'ON') // 0x20E=255, the setting
        assert.equal(ha.getProperty(DEVICE_ID, 'aidryremain', 'state'), 0) // 0x225=0
        assert.equal(ha.getProperty(DEVICE_ID, 'aidryrunning', 'state'), 'OFF')

        /*
         * A real cycle, frame by frame, from aidry-run.jsonl. The first frame is the one that
         * switches the appliance off and starts the dry in the same breath.
         */
        thinq.emit('data', buf(STATE_AIDRY_START_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'aidryremain', 'state'), 32) // 0x225=32
        assert.equal(ha.getProperty(DEVICE_ID, 'aidryrunning', 'state'), 'ON')
        // ... with the appliance itself off. The cycle runs after shutdown, not during cooling.
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'off') // 0x1F7=0
        // The enable switch has not moved, and must not be confused with the running flag.
        assert.equal(ha.getProperty(DEVICE_ID, 'aidry', 'state'), 'ON')

        const ticks: [string, number][] = [
            [STATE_AIDRY_REMAIN_31_HEX, 31],
            [STATE_AIDRY_REMAIN_30_HEX, 30],
            [STATE_AIDRY_REMAIN_29_HEX, 29],
            /*
             * ... then the capture stops and resumes, so the cycle reappears at 19. That is a
             * recording gap, not a jump the appliance made; the five ticks that follow are
             * from the same real cycle and are the second half of the rate evidence.
             */
            ...STATE_AIDRY_TICKS_19_TO_15,
        ]
        for (const [frame, expected] of ticks) {
            thinq.emit('data', buf(frame))
            assert.equal(ha.getProperty(DEVICE_ID, 'aidryremain', 'state'), expected, `${expected} min left`)
            assert.equal(ha.getProperty(DEVICE_ID, 'aidryrunning', 'state'), 'ON', `${expected} min: running`)
        }

        /*
         * And back to no cycle, on the appliance's own cycle-end frame rather than on the
         * comprehensive dump: a real OFF edge, three tags wide, following a real ON state.
         * The dump would reset all 94 tags at once and so could not show that the running
         * flag cleared because THIS tag reached 0.
         */
        thinq.emit('data', buf(STATE_AIDRY_END_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'aidryremain', 'state'), 0)
        assert.equal(ha.getProperty(DEVICE_ID, 'aidryrunning', 'state'), 'OFF')
        // the same frame resets the wind direction - the appliance does that as the cycle ends
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_state'), 'focus') // 0x2a3=1

        dev.drop()
    })

    test('the two AI dry sensors stay read-only - only the cancel button writes', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>

        /*
         * The countdown and the running flag are the appliance reporting, not settings, so
         * neither may be written. Cancelling is a separate entity - see the button test below -
         * because a cancel is not "set the remaining time to 0 in HA": it is a frame the
         * appliance may act on or ignore, and the sensors must keep showing what it says.
         */
        assert.ok(!components.aidryremain?.command_topic, 'aidryremain is read-only')
        assert.ok(!components.aidryrunning?.command_topic, 'aidryrunning is read-only')
        assert.equal(dev.fields_by_ha['aidryrunning-'], undefined, 'aidryrunning has no field at all')
        assert.equal(dev.fields_by_ha['aidryremain-']?.writable, false, 'aidryremain field is not writable')

        // Nothing reaches the wire even if something does try to write it.
        dev.setProperty('aidryremain-', '5')
        assert.equal(thinq.outbox.length, 0, 'no frame emitted')

        dev.drop()
    })

    test('the AI dry cancel writes 0 to 0x225, exactly as the LG app does', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        // Put a real cycle in progress first, so there is something for the cancel to stop.
        thinq.emit('data', buf(STATE_AIDRY_START_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'aidryremain', 'state'), 32)
        assert.equal(ha.getProperty(DEVICE_ID, 'aidryrunning', 'state'), 'ON')
        thinq.outbox.length = 0

        ha.emit('setProperty', DEVICE_ID, 'aidrycancel', 'PRESS')

        /*
         * The cancel is captured, from aidry-run.jsonl, and this asserts our bytes against the
         * app's own:
         *
         *   TX 010104000000650201000289403d4f       0x225 = 0                    (t+1021.3s)
         *   rx 0201040000008701100000ec3c           acknowledgement              (t+1021.5s)
         *   rx STATE_AIDRY_END_HEX above            0x225 = 0, the cycle is over (t+1021.6s)
         *   operator: "지금 15분 남음" (15 minutes left now, t+1019.5s), "중단 눌렀음" (pressed
         *   stop, t+1025.3s), "중단 됨 - 화면에서 건조 표시 사라짐" (stopped, drying indicator
         *   gone from the display, t+1039.3s)
         *
         * Ours differs from the app's in buf[9] only - the sequence byte, which TLVDevice
         * hardcodes to 1 where the app happened to send 0 - and in the CRC that follows from
         * it. The TLV payload 8940 (tag 0x225, value 0) is identical, byte for byte, which is
         * the same relationship the filter reset has to its captured frame.
         */
        assert.equal(thinq.outbox.length, 1, 'exactly one frame')
        assert.equal(hex(thinq.outbox[0]).toLowerCase(), '010104000000650201010289404bfb')
        const app = buf('010104000000650201000289403d4f')
        const ours = thinq.outbox[0]
        assert.equal(ours.length, app.length)
        const differing = [...app.keys()].filter((i) => app[i] !== ours[i])
        assert.deepEqual(differing, [9, 13, 14], 'only the sequence byte and the CRC differ')
        assert.equal(hex(ours.subarray(11, 13)), '8940', 'identical TLV payload')
        assert.equal(thinq.outbox.filter((frame) => frame[1] === 0xff).length, 0, 'not a private command')

        /*
         * The cancel must not fake the outcome locally. Until the appliance answers, the
         * sensors still say a cycle is running with 32 minutes left, and raw_clip_state is
         * untouched - write_callback returns false precisely so the default write path does
         * not stamp 0 into it.
         */
        assert.equal(ha.getProperty(DEVICE_ID, 'aidryremain', 'state'), 32, 'countdown not faked')
        assert.equal(ha.getProperty(DEVICE_ID, 'aidryrunning', 'state'), 'ON', 'still shown as running')
        assert.equal(dev.raw_clip_state[0x225], 32, 'raw state not stamped locally')

        // The appliance's own reply is what moves them - the frame it really sent, 0.3 s later.
        thinq.emit('data', buf(STATE_AIDRY_END_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'aidryremain', 'state'), 0)
        assert.equal(ha.getProperty(DEVICE_ID, 'aidryrunning', 'state'), 'OFF')

        /*
         * The cancel stops the CYCLE, not the standing preference: 0x20e is untouched, so the
         * appliance will start another dry the next time it is switched off. Confusing the two
         * is the mistake this pair of entities exists to prevent.
         */
        assert.equal(ha.getProperty(DEVICE_ID, 'aidry', 'state'), 'ON', 'the enable switch is not a cycle')

        dev.drop()
    })

    test('the cancel button is diagnostic and carries no TLV id of its own', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>

        assert.equal(components.aidrycancel?.platform, 'button')
        assert.equal(components.aidrycancel?.unique_id, '$deviceid-aidrycancel')
        assert.equal(components.aidrycancel?.entity_category, 'diagnostic')
        assert.equal(components.aidrycancel?.command_topic, '$this/aidrycancel/set')

        /*
         * No `id` key, for the same reason the filter reset has none: addField would take over
         * fields_by_id[0x225] and replace the 'aidryremain' field, killing that sensor and the
         * derived 'aidryrunning' with it. Without an id, the default write path cannot stamp
         * raw_clip_state even if write_callback's return value were changed by a later edit.
         */
        assert.equal(dev.fields_by_ha['aidrycancel']?.id, undefined, 'cancel owns no tag')
        assert.equal(dev.fields_by_id[0x225]?.comp, 'aidryremain', '0x225 still belongs to the sensor')

        dev.drop()
    })

    // --- hvac_action, from the 0xa8 record ---

    test('hvac_action is published on an action_topic and stays silent until a 0xa8 arrives', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        const climate = ha.devices[DEVICE_ID].config!.components.climate as Record<string, unknown>

        assert.equal(climate.action_topic, '$this/climate-action')

        /*
         * The comprehensive dump has already been applied, so power and mode are known - but
         * the compressor flag is not, and 'cooling' and 'idle' are both consistent with what
         * the appliance has said so far. Publishing NOTHING is the point: HA shows no action
         * rather than a guess. A profile that defaulted the flag to "running", as RAC does when
         * it has no tag to read, would claim 'cooling' here and be wrong for the minute a
         * compressor typically takes to start.
         */
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool') // 0x1f9=0, power ON
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), undefined, 'no action guessed')

        /*
         * And this is why the guess would have been wrong - shown with the actual frame the
         * actual appliance actually sent at power-on, hvac-action.jsonl t+4.5s, rather than
         * with any later frame that happens to read 0. It is the FIRST 0xa8 of that capture,
         * 2.7 s after the connection came up and 4.5 s before the owner wrote "냉방 18도 -
         * 압축기 돌 것" (cooling 18 C - the compressor WILL run). It says the compressor is not
         * running, and the metered power agrees: 25.5 W here, ramping to 88.2 W over the next
         * minute - the indoor fan alone - and only reaching 943.2 W at t+77.8s. 'idle' is the
         * truth for those 73 s. A profile that defaulted the flag to running, or that read the
         * demand byte @173 instead, would have claimed 'cooling' for all of them.
         */
        thinq.emit('data', buf(A8_POWERON_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'idle', 'idle from cold, not cooling')

        thinq.emit('data', buf(A8_COOLING_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'cooling')

        dev.drop()
    })

    test('the compressor stopping and restarting moves hvac_action between cooling and idle', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        /*
         * hvac-action.jsonl replayed in capture order. This is the experiment the owner ran:
         * raise the setpoint until the compressor stops, lower it until it restarts, with the
         * outdoor unit metered at 0 W in the middle.
         */
        thinq.emit('data', buf(A8_COOLING_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'cooling')

        // Setpoint to 30 C. The action must not move yet - the compressor is still running.
        thinq.emit('data', buf(STATE_HVAC_SETPOINT_30_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 30) // 0x1fe=60
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'cooling', 'setpoint alone proves nothing')

        // ... and now the appliance says the compressor stopped.
        thinq.emit('data', buf(A8_STOPPED_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'idle')
        // hvac_mode is unchanged: the appliance is still SET to cool, it just is not cooling.
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool')

        thinq.emit('data', buf(STATE_HVAC_SETPOINT_18_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 18) // 0x1fe=36
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'idle', 'not running until it says so')

        /*
         * t+337.3s, 145 s after that setpoint move. Still 'idle', and this is the one step of
         * the replay the owner did not label - his note at t+198.1s is the prediction "다시 돌
         * 것" (it will run again). Coil temperature is at the corpus maximum and both Hz and
         * EEV read 0 here, so 'idle' is what the appliance's own telemetry says; the byte this
         * profile deliberately does not read, @173, is 1 in this frame. If a future capture
         * ever pins a compressor start to a frame like this one, this is the assertion that
         * has to change - it is an inference, not an observation.
         */
        thinq.emit('data', buf(A8_NOT_YET_RESTARTED_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'idle', 'still not cooling')

        /*
         * t+433.1s, and NOW it is observed: "다시 도는 중" (running again) at t+420.1s, with
         * 1167.6 W metered. This is the frame that closes the experiment.
         */
        thinq.emit('data', buf(A8_RUNNING_AGAIN_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'cooling')

        dev.drop()
    })

    test('a mode change republishes hvac_action without waiting for the next 0xa8', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(A8_COOLING_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'cooling')

        /*
         * The 0xa8 records arrive every 20 .. 100 s - here 42 s separate the mode change at
         * t+430.9s from the next record at t+473.0s. If the action were only recomputed when
         * one lands, HA would show 'cooling' throughout a dry cycle for the whole of that gap.
         */
        thinq.emit('data', buf(STATE_HVAC_TO_DRY_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'dry') // 0x1f9=1
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'drying', 'republished on the mode change')

        // The record that eventually arrives agrees - it was captured while drying.
        thinq.emit('data', buf(A8_DRYING_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'drying')

        dev.drop()
    })

    test('power off beats the compressor flag, which lags behind it', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(A8_COOLING_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'cooling')

        // aidry-run.jsonl t+2.9s: the appliance is switched off. Published from the TLV alone.
        thinq.emit('data', buf(STATE_AIDRY_START_HEX)) // 0x1f7=0
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'off')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'off')

        /*
         * t+5.1s, 2.2 s later on the real wire: the appliance reports the compressor STILL
         * RUNNING while it is switched off. Testing the flag before power would publish
         * 'cooling' for a machine the owner had just turned off.
         */
        thinq.emit('data', buf(A8_RUNNING_WHILE_OFF_HEX)) // @160=1
        assert.equal(dev.compressorRunning, true, 'the flag really is set in that frame')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'off', 'power wins')

        dev.drop()
    })

    test('a compressor reading from before an off period is discarded at the next power-on', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        /*
         * 'off' winning over the flag protects the off period itself and nothing after it. The
         * flag keeps its value across the whole off period, so unless it is thrown away the
         * state frame that reports 0x1f7 = 1 recomputes the action from a reading taken before
         * the appliance was switched off, and publishes 'cooling' the instant it comes back.
         *
         * Replayed from the real power cycle in stand-capture.jsonl - 0x1f7 = 0 at t+4327.8s,
         * 0x1f7 = 1 at t+4340.5s - with one substitution, argued below.
         */
        thinq.emit('data', buf(A8_COOLING_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'cooling')

        thinq.emit('data', buf(STATE_POWER_OFF_HEX)) // 0x1f7=0
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'off')

        /*
         * The substitution, and the reason clearing on the FALLING edge would not be enough.
         * 0xa8 records keep arriving while the appliance is off, and they can still report a
         * turning compressor: this is aidry-run.jsonl t+5.1s, 2.2 s after that capture's own
         * 0x1f7 = 0. A falling-edge clear would be undone right here.
         *
         * stand-capture's own off-window record, 2.1 s after the power-off, happens to read 0 -
         * which is the only reason a replay of that capture alone produces the right answer.
         * That is an accident of one 12.7 s off window, not a property of the appliance: in
         * aidry-run the flag needs 11.1 s to reach 0 and the next record after that is 960 s
         * later. The test must not depend on it, so it uses the frame that does not cooperate.
         */
        thinq.emit('data', buf(A8_RUNNING_WHILE_OFF_HEX)) // @160=1, arriving while off
        assert.equal(dev.compressorRunning, true, 'the appliance really does say 1 while off')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'off', 'still off, as before')

        /*
         * And back on, with NO 0xa8 in between - a fast off/on, a dropped message, or simply an
         * off window shorter than the ~2 s gap between frames. The stale reading must not be
         * republished: nothing is known about the run that is now starting, so nothing is said
         * about it, exactly as at startup. HA goes on showing 'off' until a fresh record lands,
         * 3.3 s later in this capture.
         */
        thinq.emit('data', buf(STATE_ALLCLEAN_RUNNING_HEX)) // t+4340.5s, 0x1f7=1 0x1f9=0
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool', 'the unit is on again')
        assert.equal(dev.compressorRunning, undefined, 'the pre-off reading was discarded')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'off', 'no invented cooling')

        // The next record settles it, and it is the record that decides - not the stale flag.
        thinq.emit('data', buf(A8_STOPPED_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'idle')

        dev.drop()
    })

    /*
     * The same thing, but with the user pressing the button in HA rather than on the remote -
     * which is the likelier of the two and does NOT reach the appliance-side path above.
     *
     * setProperty() stamps the written value into raw_clip_state before it sends anything, so
     * by the time the appliance echoes the change back, power has already read 1 for some time.
     * An edge detector that only watches incoming frames sees no transition at all in this
     * case, and would carry the pre-off compressor reading straight through the power cycle.
     * Both HA-side routes are covered because they set power in different places: the power
     * switch through TLVDevice.setProperty(), the mode select through 0x1f9's write_attach.
     */
    for (const [what, prop, value] of [
        ['the power switch', 'power_command', 'ON'],
        ['a mode select while off', 'mode_command', 'cool'],
    ] as const) {
        test(`a compressor reading from before an off period is discarded when HA turns it on with ${what}`, (t) => {
            const { ha, thinq, dev } = buildReadyDevice(t)

            thinq.emit('data', buf(A8_COOLING_HEX))
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'cooling')

            thinq.emit('data', buf(STATE_POWER_OFF_HEX)) // 0x1f7=0
            thinq.emit('data', buf(A8_RUNNING_WHILE_OFF_HEX)) // @160=1, arriving while off
            assert.equal(dev.compressorRunning, true)
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'off')

            ha.setProperty(DEVICE_ID, 'climate', prop, value)
            assert.equal(dev.raw_clip_state[0x1f7], 1, 'the write path turns power on optimistically')
            assert.equal(dev.compressorRunning, undefined, 'and the stale reading goes with it')
            assert.notEqual(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'cooling', 'nothing invented')

            // The appliance echoes the change back. Still nothing invented from the old reading.
            thinq.emit('data', buf(STATE_ALLCLEAN_RUNNING_HEX)) // 0x1f7=1 0x1f9=0
            assert.equal(dev.compressorRunning, undefined, 'and the echo does not resurrect it')
            assert.notEqual(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'cooling', 'still nothing invented')

            thinq.emit('data', buf(A8_STOPPED_HEX))
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'idle', 'the record decides')

            dev.drop()
        })
    }

    test('air-clean reports fan, even while the compressor is still winding down', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(A8_COOLING_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'cooling')

        // stand-capture.jsonl t+585.5s: switched to air-clean, which HA calls fan_only.
        thinq.emit('data', buf(STATE_MODE_AIRCLEAN_HEX)) // 0x1f9=5
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'fan_only')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'fan')

        /*
         * t+587.5s, 2.0 s later: the compressor has not stopped yet. Mode 5 has to be tested
         * before the flag or this publishes 'cooling' while the appliance air-cleans.
         */
        thinq.emit('data', buf(A8_RUNNING_WHILE_AIRCLEAN_HEX)) // @160=1
        assert.equal(dev.compressorRunning, true, 'the flag really is set in that frame')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'fan', 'mode wins')

        dev.drop()
    })

    test('the short 0xa8 frame changes nothing and cannot be read past its end', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        /*
         * Before any long record: the short frame must not leave `compressorRunning` set from
         * a byte that does not exist. buf[160] of a 15-byte buffer is `undefined`, and
         * `undefined !== 0` is true - so a predicate that let this frame through would latch
         * the compressor ON forever, which is exactly the bug the length test prevents.
         */
        assert.equal(dev.compressorRunning, undefined)
        thinq.emit('data', buf(A8_SHORT_HEX))
        assert.equal(dev.compressorRunning, undefined, 'not latched from a byte past the end')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), undefined, 'nothing published')

        // And after one: it must not disturb a good reading either, in either direction.
        thinq.emit('data', buf(A8_STOPPED_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'idle')
        const before = { ...ha.devices[DEVICE_ID].properties }

        thinq.emit('data', buf(A8_SHORT_HEX))
        assert.equal(dev.compressorRunning, false, 'flag untouched')
        assert.deepEqual(ha.devices[DEVICE_ID].properties, before, 'no property moved')

        thinq.emit('data', buf(A8_COOLING_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'cooling', 'still tracking')

        dev.drop()
    })

    test('the 0xa8 length test is exact, not a lower bound', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        /*
         * The short frame above is rejected by buf[10] = 0x02 alone, so it does not exercise
         * the length test at all. These two do. A truncated long frame keeps buf[10] = 0xff and
         * is still longer than the offset, so `length > OFFSET` or `length >= A8_FRAME_LENGTH`
         * would both accept one of them - and then decode a byte out of a frame whose fields
         * are not where they are believed to be. There is no evidence any such frame exists;
         * that is the point. The profile decodes a fixed-offset struct on the strength of four
         * captures of one firmware, so it accepts only the shape those captures contain.
         */
        const truncated = buf(A8_COOLING_HEX).subarray(0, 200)
        assert.equal(truncated[10], 0xff, 'still looks like a long record')
        assert.equal(truncated[160], 1, 'and offset 160 is still in range and still reads 1')

        thinq.emit('data', truncated)
        assert.equal(dev.compressorRunning, undefined, 'not decoded from a truncated frame')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), undefined, 'nothing published')

        // Over-long, for the same reason in the other direction.
        thinq.emit('data', Buffer.concat([buf(A8_COOLING_HEX), Buffer.from([0x00])]))
        assert.equal(dev.compressorRunning, undefined, 'nor from an over-long one')

        // The real frame, unmodified, is still accepted - the test above is not vacuous.
        thinq.emit('data', buf(A8_COOLING_HEX))
        assert.equal(dev.compressorRunning, true)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'cooling')

        dev.drop()
    })

    test('only HA-valid hvac_action strings are ever published', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        /*
         * There is no analogue of RAC_056905_WW's `action = 'None'`, which is not an HA
         * hvac_action value and exists for an auto mode this model does not have. Replaying
         * every action-bearing fixture in the file must only ever produce these five.
         */
        const valid = ['off', 'idle', 'cooling', 'drying', 'fan']
        const frames = [
            A8_COOLING_HEX,
            STATE_HVAC_SETPOINT_30_HEX,
            A8_STOPPED_HEX,
            A8_POWERON_HEX,
            A8_NOT_YET_RESTARTED_HEX,
            A8_RUNNING_AGAIN_HEX,
            STATE_HVAC_TO_DRY_HEX,
            A8_DRYING_HEX,
            STATE_MODE_AIRCLEAN_HEX,
            A8_RUNNING_WHILE_AIRCLEAN_HEX,
            STATE_AIDRY_START_HEX,
            A8_RUNNING_WHILE_OFF_HEX,
            A8_SHORT_HEX,
            STATE_MODE_COOL_HEX,
            STATE_MODE_DRY_HEX,
            QUERY_RESPONSE_HEX,
        ]
        const seen = new Set<string>()
        for (const frame of frames) {
            thinq.emit('data', buf(frame))
            const action = ha.getProperty(DEVICE_ID, 'climate', 'action')
            if (action !== undefined) seen.add(String(action))
        }
        for (const action of seen) assert.ok(valid.includes(action), `${action} is a valid hvac_action`)
        // named explicitly, because membership alone cannot distinguish "never published it"
        // from "never reached that state": 'None' is RAC's, and must never appear here.
        assert.ok(!seen.has('None'), "RAC's 'None' is not an HA hvac_action and is not copied")
        // and the run really did exercise the interesting ones rather than passing vacuously
        assert.ok(seen.has('cooling') && seen.has('drying') && seen.has('fan') && seen.has('off'))

        dev.drop()
    })

    // --- entity classification on the HA device page ---

    test('the three new entities are published with the right platform, unit and category', (t) => {
        enableMockTimers(t)
        const { ha, dev } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>

        // Sleep timer: an HA number in hours, filed under Controls - the owner sets it.
        assert.equal(components.sleeptimer?.platform, 'number')
        assert.equal(components.sleeptimer?.device_class, 'duration')
        assert.equal(components.sleeptimer?.unit_of_measurement, 'h')
        assert.equal(components.sleeptimer?.min, 0)
        assert.equal(components.sleeptimer?.max, 15)
        assert.equal(components.sleeptimer?.step, 0.25)
        assert.equal(components.sleeptimer?.mode, 'slider')
        assert.ok(!('entity_category' in components.sleeptimer), 'sleeptimer is a control')

        /*
         * AI dry remaining is in MINUTES on this model - see the captured cycle above. RAC
         * publishes the same tag in '%'; copying that here would be wrong by a factor of the
         * cycle length, so the unit is asserted rather than left to a reviewer's eye.
         */
        assert.equal(components.aidryremain?.platform, 'sensor')
        assert.equal(components.aidryremain?.device_class, 'duration')
        assert.equal(components.aidryremain?.unit_of_measurement, 'min')
        assert.notEqual(components.aidryremain?.unit_of_measurement, '%')
        assert.equal(components.aidryremain?.state_class, 'measurement')
        assert.equal(components.aidryremain?.icon, 'mdi:hair-dryer-outline')
        assert.equal(components.aidryremain?.entity_category, 'diagnostic')

        assert.equal(components.aidryrunning?.platform, 'binary_sensor')
        assert.equal(components.aidryrunning?.icon, 'mdi:hair-dryer')
        assert.equal(components.aidryrunning?.entity_category, 'diagnostic')

        // Temperature step: a control the owner can move, filed with the readings.
        assert.equal(components.tempstep?.platform, 'select')
        assert.deepEqual(components.tempstep?.options, ['0.5', '1'])
        assert.equal(components.tempstep?.entity_category, 'diagnostic')
        assert.ok(components.tempstep?.command_topic, 'tempstep is writable')

        /*
         * The two HAND-TYPED unique_ids in this profile, asserted here because they are the
         * only two that can drift. Every other component is built by addSwitchField() /
         * addSelectField() / addSensorField() / addTimerField(), which compute the unique_id
         * as '$deviceid-' + the component key, so key and id cannot diverge by construction.
         * 'tempstep' and 'aidryrunning' are written out by hand next to their key, and a typo
         * there orphans a live entity and loses the owner's history on an appliance that is
         * already in daily use. The rename test below covers the derived ones.
         */
        assert.equal(components.tempstep?.unique_id, '$deviceid-tempstep')
        assert.equal(components.aidryrunning?.unique_id, '$deviceid-aidryrunning')
        assert.equal(components.aidryrunning?.state_topic, '$this/aidryrunning')

        dev.drop()
    })

    /*
     * NO TURN-ON / TURN-OFF TIMERS on this model, and this is here so that nobody adds them
     * from RAC_056905_WW's tag list alone. RAC gates its 0x21C / 0x21B pair on 0x2D3 & 4, and
     * this appliance's capability reply carries 0x2D3 = 282643 = 0x45013, in which that bit is
     * clear - while bit 0, the one RAC gates the sleep timer on, is set.
     */
    test('the turn-on and turn-off timers do not exist', (t) => {
        enableMockTimers(t)
        const { ha, dev } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>

        // By tag, which is what would actually have to be registered - a key name is arbitrary.
        assert.equal(dev.fields_by_id[0x21b], undefined, 'no field for 0x21B (turn-off timer)')
        assert.equal(dev.fields_by_id[0x21c], undefined, 'no field for 0x21C (turn-on timer)')

        // And by shape: the sleep timer is the only number entity this profile publishes.
        const numbers = Object.keys(components).filter((key) => components[key].platform === 'number')
        assert.deepEqual(numbers, ['sleeptimer'], 'sleeptimer is the only number entity')

        dev.drop()
    })

    /*
     * HA files an entity on the device page by entity_category: 'config' under
     * "Configuration", 'diagnostic' under "Diagnostic", and NO KEY AT ALL under "Controls".
     * There is no category string meaning "Controls", so `in` is the assertion, not a
     * truthiness test - `entity_category: undefined` would pass the latter while still putting
     * the key in the object HA's discovery payload is built from.
     */
    test('the everyday airflow controls carry no entity_category key at all', (t) => {
        enableMockTimers(t)
        const { ha, dev } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>

        for (const name of ['airclean', 'onesidewind', 'spacefit']) {
            assert.ok(components[name], `${name} exists`)
            assert.ok(!('entity_category' in components[name]), `${name} has no entity_category key`)
        }

        // The switches around them are untouched: everything else is still a setting.
        for (const name of ['jet', 'quiet', 'uvnano', 'childlock', 'smartcare', 'aidry', 'display', 'beep']) {
            assert.equal(components[name]?.entity_category, 'config', `${name} is config`)
        }
        // ... and the humidity display option moved the other way, to the readings.
        assert.equal(components.humiditydisplay?.entity_category, 'diagnostic')
        // The cleaning cycles were already diagnostic and stay there.
        assert.equal(components.hxclean?.entity_category, 'diagnostic')
        assert.equal(components.allclean?.entity_category, 'diagnostic')

        dev.drop()
    })

    /*
     * Display strings only. The component keys - and therefore the unique_ids, and therefore
     * HA's entity_ids and the owner's history - must not move, so each unique_id is asserted
     * next to the name it now carries.
     */
    test('the renamed entities keep their unique_ids', (t) => {
        enableMockTimers(t)
        const { ha, dev } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>

        // was "All clean"
        assert.equal(components.allclean?.name, 'Cleaning - ALL')
        assert.equal(components.allclean?.unique_id, '$deviceid-allclean')

        // was "Heat exchanger clean"; the two now sort together in HA's entity list
        assert.equal(components.hxclean?.name, 'Cleaning - Heat exchanger')
        assert.equal(components.hxclean?.unique_id, '$deviceid-hxclean')

        // was "Product beep", now the parallel of the display switch's "Display Light"
        assert.equal(components.beep?.name, 'Beep Sound')
        assert.equal(components.beep?.unique_id, '$deviceid-beep')
        assert.equal(components.display?.name, 'Display Light')

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

        dev.drop()
    })

    test('the filter reset writes 0 to 0x355, exactly as the LG app does', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'filterremaining', 'state'), 2442)
        thinq.outbox.length = 0

        ha.emit('setProperty', DEVICE_ID, 'filterreset', 'PRESS')

        /*
         * The app's own frame was 0101040000006502010002d540769d; ours differs only in buf[9],
         * the sequence byte, which TLVDevice hardcodes to 1 where the app happened to send 0 -
         * and in the CRC that follows from it. The TLV payload D540 (tag 0x355, value 0) is
         * identical. Nothing else goes out: no private command, no attached trio.
         */
        assert.equal(thinq.outbox.length, 1, 'exactly one frame')
        assert.equal(hex(thinq.outbox[0]).toLowerCase(), '0101040000006502010102d5400029')
        assert.equal(thinq.outbox.filter((frame) => frame[1] === 0xff).length, 0, 'not a private command')

        /*
         * The reset must not fake the outcome locally. Until the appliance answers, the
         * sensors still read what it last reported.
         */
        assert.equal(ha.getProperty(DEVICE_ID, 'filterremaining', 'state'), 2442)
        assert.equal(ha.getProperty(DEVICE_ID, 'filterused', 'state'), 558)

        // The appliance's reply is what moves them - captured verbatim after a real reset.
        thinq.emit('data', buf('000004000000A70204C606D5600BB8C48445B1')) // 0x355=3000
        assert.equal(ha.getProperty(DEVICE_ID, 'filterremaining', 'state'), 3000)
        assert.equal(ha.getProperty(DEVICE_ID, 'filterused', 'state'), 0)

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

    test("the appliance's real capability reply is recognised", (t) => {
        enableMockTimers(t)
        const { thinq, dev } = makeDevice()

        thinq.emit('data', buf(CAPS_RESPONSE_REAL_HEX))

        // 0x2da is present, so the retry loop stops and the values query goes out.
        assert.equal(dev.query_caps_timeout, undefined, 'recognised as the capability reply')
        assert.equal(dev.raw_clip_state[0x2da], 3485736)

        /*
         * The appliance declares its own setpoint range here. min_temp / max_temp in the
         * climate component are hardcoded to these values; if this assertion ever fails on
         * another unit, the hardcoding is what has to change.
         */
        assert.equal(dev.raw_clip_state[0x2e1], 36, 'declared minimum, 18.0 C')
        assert.equal(dev.raw_clip_state[0x2e2], 60, 'declared maximum, 30.0 C')

        /*
         * 0x2d7 appears three times, once per supported mode; raw_clip_state keeps the last,
         * which is 5 - air-clean. That the appliance's own list ends at 5 and not at 6 is
         * independent confirmation of the mode table, which was otherwise derived by
         * pressing buttons on the remote: no auto (6) and no heat (4).
         */
        assert.equal(dev.raw_clip_state[0x2d7], 5)

        dev.drop()
    })
})
