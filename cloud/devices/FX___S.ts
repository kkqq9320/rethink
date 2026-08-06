import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type ComponentInfo, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import log from '@/util/logging'

// LG front-load washer sold in Korea. Retail model FX25VSR.AKOR2; it reports modelId "FX___S" (sw
// 2.11.246), which is what we match on - the underscores are LG's family wildcard, the same shape as
// F_V8_Y___W.B_2QEUK and 2REF11EIDA__4, so sibling FX models may report the same id. Whether their
// frame layout is identical has not been checked, and the diagnostic sensors below exist partly so a
// mismatch shows up as an unnamed value rather than as silently wrong state.
//
// This model does NOT share a layout with any of the existing washer handlers: F3L2CYU__/T1789EFH_F
// discriminate on buf[1]==0xEC with 25/27-byte records, the EU F_V*/Y_V* handlers parse a flat 80/53-byte
// frame. FX___S wraps everything in a second envelope and carries a 66-byte record. Everything below was
// derived from live captures (washer-capture-20260730.jsonl, washer-cycle-20260730.jsonl) taken while the
// owner drove the appliance and the LG app, naming each action as they made it; every value here is
// backed by an operation whose label was written down before the bytes were read.
//
// FRAMING. AABBDevice strips "AA <len8>" and "<cksum> BB", so buf[0] is the direction byte (0x20 from
// the appliance) and buf[1] is the message type. When the original length byte was 0xFF the real length
// is a 16-bit field that follows the type, which is how we tell the two forms apart:
//
//   short:     20 <type> <payload...>
//   extended:  20 <type> <len16> <payload...>          len16 == buf.length + 4
//
// Message types seen from the appliance, censused across all three washer captures with
// tools/aabb-survey.ts - the appliance sends thirteen and this handler dispatches on four:
//
//   0x0A  2184x   tunnel, see below
//   0x4D   527x   the appliance declaring its own course table, see processCourseTable
//   0xE6   136x   reply to a settings write
//   0x3E    90x   the appliance's own energy meter, one report every ~15 min, see
//                 processEnergyReport
//
//   0xD8   164x   one byte that follows the power state, sent unprompted. NOT used: it leads the
//                 state record by 16 s in one measured transition and trails it by 31 s in another
//   0xE2    29x   71 bytes, sent ten times over ~14 s, 30 s before a cycle reaches Complete - so
//                 there is one payload per completed cycle and no more. Decoded but NOT published:
//                 the course (@9 = @24), the four options as they were SELECTED (@5-@8, which the
//                 state record loses as it consumes them), the nominal minutes (@18 = @20) and the
//                 cycle's energy in Wh (@22, which agrees with 0x3E's total). Everything here is
//                 already published from frames that arrive sooner, except the as-selected options
//   0x31    11x   99 bytes, every byte identical in all eleven. A fixed declaration of something
//   0x88     2x   37 bytes, likewise constant
//   0x00   696x / 0xC3 286x / 0x7F 235x / 0x72 23x / 0x19 20x
//                 short acks and handshake bytes. 0xC3 and 0x19 never vary at all; 0x7F carries
//                 one byte that is only ever 3 or 4, 0x72 two that are {0,1} and {0,145,200,201}
//
// TUNNEL (0x0A). payload = 00 <id16> 00 01 <flag> <inner> <innerlen16> 00 <data>
//   inner 0x03  6 or 17 bytes  heartbeat, ~1.5 s, only while powered on
//   inner 0xEC  134 bytes      state: <record 66B = previous> 00 <record 66B = current> <trailing byte>
//   inner 0x86/0x87            the app browsing the course table; read-only, not decoded
//   inner 0x02  78 bytes       ~5 min telemetry (temperature/water-level shaped), not decoded. Keeps
//                              arriving after 0xEC stops, so it is the better liveness signal.
//
// The stacked-record layout is not an assumption: across consecutive 0xEC frames the current record of
// frame N is byte-identical to the previous record of frame N+1.
//
// SETTINGS REPLY (0xE6). payload = 00 02 01 FF <n> [<key> <status>]*n 00 <record 66B>
// The per-key status is 0x00 when that key was actually applied and 0x11 when it already held the value,
// which is what makes a write verifiable rather than assumed.

const FROM_DEVICE = 0x20
const MSG_TUNNEL = 0x0a
const MSG_SETTINGS_REPLY = 0xe6
const INNER_STATE = 0xec
// The same record without a preceding "previous" one, sent once immediately after the appliance
// (re)connects - there is no prior state to diff against yet. Without it a restart leaves every entity
// unknown until the appliance next changes state, which on an idle washer can be a very long time.
const INNER_STATE_SINGLE = 0xeb

// The appliance's own declaration of what sits on its dial. It arrives unprompted, which had to be
// established before reading it: washer-poweron-test.jsonl contains three outgoing frames in total, all
// of them settings writes from here - no query of ours, and none of the LG cloud's course-browsing
// traffic either - yet 167 of these arrived across its five connections. One burst elsewhere does
// follow the app browsing courses, which makes it look like a reply; the zero-outgoing captures are
// what settle it. Even if a query would also produce it, there is no reason to send one.
const MSG_COURSE_TABLE = 0x4d
/* The appliance's ~15-minute energy report - see processEnergyReport(). */
const MSG_ENERGY = 0x3e
/* Always exactly this long: 20 3E <u16 Wh since last> <u16 Wh total> <report number>. */
const ENERGY_LEN = 7
// Three variants share this message type and the first byte tells them apart. 0x03 is the dial;
// 0x02 carries the two extended courses' default settings (decoded - it is where the record's
// base-course byte was confirmed - but deliberately unused, see setExtendedCourse); 0x01 is a
// five-byte frame that has not been decoded.
const TABLE_COURSE_LIST = 0x03
// Byte 1 reads 02 on both four-byte-header variants and nothing explains it, so it is required exactly
// as observed - a frame that differs there may be some other table, and reading one of those as the
// dial would invent courses.
//
// Byte 2 is a REVISION COUNTER, and requiring it was a bug worth keeping the story of. It read 0x16 in
// every capture and was pinned to it on those grounds. Then the owner edited the dial - twenty courses
// added - and the next declaration came with 0x17 and thirty entries, and this handler threw it away:
// the whole point of reading the declaration is to notice that kind of change, and the guard was blind
// to exactly it.
//
// A second edit settled what the byte is. Ten courses were taken back off, and it went to 0x18 while
// the count went DOWN to twenty - so it does not describe the contents, it counts the edits. It is
// still not compared: what guards the frame is the length check below, which is the strong one, since
// a count that disagrees with the frame cannot be read as courses.
const TABLE_KIND = 0x02
// Marks the entries reached through the 0xFF escape. It partitions the ten declared courses exactly as
// the escape requirement does: the two 0x00 entries are Normal 1 and Towels 1, the two that were found
// by hand to need it.
const TABLE_KIND_EXTENDED = 0x00

const RECORD_LEN = 66
// data = <record> <1 byte separator> <record>; the current state is the second one.
const CURRENT_RECORD_OFFSET = RECORD_LEN + 1

// ---------------------------------------------------------------------------------------------------
// Record offsets. The four option bytes are the appliance's REMAINING WORK, not the selected settings:
// while idle they equal what was selected, and during a cycle each drops to 0 as its stage completes.
// That is what identified the phase codes - o0 cleared entering phase 12, o2 counted 2->1->0 during it,
// o3 cleared entering 42. Re-verified on a second course (Rinse+Spin started with o0 already 0 and
// skipped the wash phases entirely).
const OFF_WASH = 0 // key 0x1E
const OFF_WATER_TEMP = 1 // key 0x1F
const OFF_RINSE = 2 // key 0x20, duplicated at offset 26
const OFF_SPIN = 3 // key 0x21
const OFF_COURSE = 4 // key 0x0A (0xFF = extended, real course at offset 22)
const OFF_REMAIN_H = 12
const OFF_REMAIN_M = 13
const OFF_TOTAL_H = 14
const OFF_TOTAL_M = 15
// The delay-end reservation, as a 16-bit big-endian count of MINUTES until the cycle finishes, and a
// flag that says one is set. Labelled by the owner setting 5 h and then 5 h 30 in the LG app while a
// capture ran: the record went to 300 and then 330, which is exactly what those are in minutes, and
// the write frame carried the same numbers. A third value settles it from data that predates the
// hypothesis - washer-cycle-20260730.jsonl holds one record at 210 (3 h 30, the shortest the appliance
// allows plus a half hour), and that is the ONLY other record in 750 where the flag below is set.
const OFF_RESERVE_HI = 10
const OFF_RESERVE_LO = 11
// Bit 0x80 of this byte, set in every record that carries a reservation and in no other - three
// occurrences across four captures, against 747 records with both at zero.
const OFF_RESERVE_FLAG = 38
const RESERVE_SET = 0x80
// The model JSON's `reserveTimeHour` is a range of 3..19 with `reserve30min` true, so the appliance
// takes half hours from three to nineteen. Zero is what the app sends when there is no reservation.
const RESERVE_MIN_MINUTES = 180
const RESERVE_MAX_MINUTES = 19 * 60
const RESERVE_STEP_MINUTES = 30

const OFF_COURSE_EXT = 22 // key 0x0B
const OFF_PHASE = 20
const OFF_PHASE_PREV = 21
const OFF_CYCLES = 27
const OFF_BEEP = 28
const OFF_FLAGS = 36
// Steam sits in its own byte rather than the flags one. Found by toggling steam on the Normal course
// and watching this bit follow it; it also matches the Towels 1 selection, which switches steam on.
const OFF_STEAM = 34
const STEAM_ON = 0x10

// Bit 0x10 was originally read as "a cycle is loaded", because it was set for the whole of a wash and
// stayed set after it finished. It is remote control: the owner had switched remote control on in order
// to start that wash from the app, and left it on. Toggling it by hand on the panel moves this bit and
// nothing else, and the door lock follows a few seconds later.
const FLAG_REMOTE_CONTROL = 0x10
const FLAG_CHILD_LOCK = 0x20
// Set while the drum is actually turning. It clears on pause, but it ALSO clears and re-sets on its
// own mid-cycle (measured twice, with no command in between and the remaining time still counting down),
// so it must not be used to mean "paused" - that is PHASE_PAUSED and nothing else.
//
// It is NOT only the drum, and settling that took two attempts. Arming a reservation sets this bit;
// the first time that was seen it was one record, and the owner's explanation - the appliance tumbles
// briefly to sense the load when a cycle is armed - fitted it just as well, so nothing was changed.
//
// The measurement that separates them: a reservation armed with the door shut on 2026-08-04 at
// 18:45:18 and left alone. It counts down a minute at a time, so records arrive every minute, and
// across five of them spanning three minutes this bit never cleared. A sensing tumble ends, and the
// record that ended it would have said so. The drum is not turning for the seven hours that follow.
//
// So RESERVED is suppressed where it is published, rather than the bit being renamed: what it means
// in the phases that were measured is unchanged, including clearing and re-setting mid-wash on its
// own. Across every capture it is set in phases 3, 7, 11, 12, 14, 37 and 40, and clear in 42 and 47.
const FLAG_DRUM_ACTIVE = 0x80

// One byte each, found by toggling them on the panel one at a time with a pause in between - the run
// that finally separated them from each other after an earlier attempt did all of it inside 20 seconds
// and left five interleaved signals that could not be told apart.
const OFF_DOOR_LOCK = 37 // whole byte: 1 while locked. Follows remote control on its own.
const OFF_WRINKLE_CARE = 35
const WRINKLE_CARE_ON = 0x80
const OFF_TURBOSHOT = 33
const TURBOSHOT_ON = 0x20
// "Laundry care when the cycle ends". Toggling it from the app moves this bit, so key 0x57 is a setting
// rather than a one-shot action - pressing it while the appliance sits on Complete simply makes it act
// on the setting straight away, which is what it looked like the first time it was seen.
const OFF_LAUNDRY_CARE = 46
const LAUNDRY_CARE_ON = 0x08

const PHASE_OFF = 0
const PHASE_STANDBY = 1
const PHASE_PAUSED = 2
const PHASE_DONE = 42
const PHASE_CARE = 47
// A delay-end reservation is set and counting down. Declared by the model JSON, not yet seen here -
// nothing keys off it beyond its name, so an appliance that never reaches it loses nothing.
const PHASE_RESERVED = 7

// Phase codes, named as LG names them. Every one of these was pinned by laying our phase byte and the
// LG cloud's own status for the same appliance on one clock, across three washes - 2026-07-30 (the
// capture, aligned to the cloud's history for those minutes) and two on 2026-08-03 (both timelines
// straight out of Home Assistant's recorder). Each of our transitions has exactly one cloud transition
// beside it, and where two of our codes carry the same name the cloud does not move at all, which is
// what makes the pairing 1:1 rather than a guess:
//
//   ours       LG           evidence
//   0          power_off    all three
//   1          initial      all three
//   2          pause        7/30, twice; the second matched to 0.5 s
//   3          detecting    7/30, matched to 0.02 s
//   37         detecting    7/30 and 8/03; no cloud transition, it was already detecting
//   11         running      all three, five times
//   40         detecting    all three, five times - the appliance re-senses mid-wash
//   12         rinsing      all three
//   14         spinning     all three
//   42         end          all three
//   47         refreshing   7/30, twice
//
// The 7/30 capture's clock runs 13 s ahead of Home Assistant's, which shows up as a CONSTANT offset -
// six transitions match to under a second once it is applied, including two that match exactly. A
// semantic mismatch would not be constant, which is why the offset is a clock and not a doubt.
//
// The cloud is the LABEL SOURCE, not the judge: our byte is the measurement and LG's name is what they
// call it. Renaming these to LG's vocabulary is deliberate - the same appliance is also visible through
// the official integration, and two names for one stage is worse than either name.
//
// LG's own model JSON for this appliance settles the rest. Its `MonitoringValue.state` declares 33
// states with an index each, and THE INDEX IS THIS BYTE: all eleven values ever measured here are
// declared, at exactly the number we measured, including the two that were pinned only by the clock
// alignment above (3 = DETECTING, 11 = RUNNING). Eleven of eleven, from a source that has no idea what
// we captured.
//
// So the values below that were never observed come from that declaration rather than from a guess,
// and they exist to stop a state this appliance can reach reading as `unknown`. Two are worth naming:
//
//   7   RESERVED    a delay-end reservation is set and counting down
//   16  END         a finished cycle. We only ever see 42, which the JSON calls
//                   END_REMOTE_MAINTAIN_ON - this owner leaves remote control on. A machine with it
//                   off looks likely to finish on 16 instead, which used to publish `unknown`.
//
// Where the JSON is finer than the cloud, the cloud's coarser word is kept, because matching the
// official integration is the whole point of this vocabulary: 37 is CLOTHING_RECOGNITION and 40 is
// POLLUTION_DETECTING, and the cloud reports both as `detecting`. 42 is END_REMOTE_MAINTAIN_ON and
// 47 is LAUNDRYCARE, reported as `end` and `refreshing`.
const STATUS: Record<number, string> = {
    [PHASE_OFF]: 'power_off',
    [PHASE_STANDBY]: 'initial',
    [PHASE_PAUSED]: 'pause',
    3: 'detecting',
    37: 'detecting',
    11: 'running',
    40: 'detecting',
    12: 'rinsing',
    14: 'spinning',
    [PHASE_DONE]: 'end',
    [PHASE_CARE]: 'refreshing',
    // Declared by the model JSON, never seen on this appliance.
    5: 'add_drain',
    6: 'detergent_amount',
    [PHASE_RESERVED]: 'reserved',
    8: 'soak',
    9: 'prewash',
    13: 'rinsehold',
    15: 'drying',
    16: 'end',
    21: 'refreshing',
    23: 'error_auto_off',
    27: 'frozen_prevent_initial',
    28: 'frozen_prevent_pause',
    29: 'frozen_prevent_running',
    34: 'audible_diagnosis',
    35: 'auto_dt_open_pause',
    36: 'confirm_start_for_control',
    38: 'detergent_input',
    39: 'softener_input',
    41: 'tub_cleaning',
    43: 'steam',
    48: 'ezdispense_cleaning',
    49: 'end_waiting',
}
const STATUS_OPTIONS = [...new Set(Object.values(STATUS))].concat('unknown')

// Remaining/total time only mean anything while a wash is under way. At PHASE_DONE the counter stops at
// 1 minute rather than reaching 0, and Laundry care leaves the previous cycle's values untouched - both
// would otherwise show a permanent "1 minute left" in Home Assistant.
const TIMED_PHASES = new Set([3, 37, 11, 40, 12, 14, PHASE_PAUSED])

// Phases in which the appliance is actually working. Paused is deliberately excluded - `status` already
// says Paused, and a "Running" sensor that stays on through a pause is no use in an automation.
const ACTIVE_PHASES = new Set([3, 37, 11, 40, 12, 14, PHASE_CARE])

// Phases in which no cycle is under way any more, so `current_course` reads as a leftover rather than as
// information - the course byte itself survives the cycle, the finished state and being powered off.
//
// The owner asked for 0 and 42. Laundry care (47) is in here as well because it only ever follows 42:
// clearing at 42, restoring the name for the length of the care run and clearing it again at 0 would
// flicker the sensor through "-" -> "AI Wash" -> "-" on every cycle that ends with care switched on.
// Nothing before the wash is included - standby has a course selected and waiting, which is the one
// moment the name matters most.
const FINISHED_PHASES = new Set([PHASE_OFF, PHASE_DONE, PHASE_CARE])
// Deliberately not '' or 'none': the sensor has no device_class, so this is what shows on the dashboard.
const COURSE_CLEARED = '-'

// ---------------------------------------------------------------------------------------------------
// Settings keys, all confirmed by single-variable writes made from the LG app.
const KEY_COURSE = 0x0a
const KEY_COURSE_EXT = 0x0b
const KEY_POWER = 0x02
const KEY_OPERATION = 0x03
const KEY_BEEP = 0x13
const KEY_WASH = 0x1e
const KEY_WATER_TEMP = 0x1f
const KEY_RINSE = 0x20
const KEY_SPIN = 0x21
const KEY_TURBOWASH = 0x35
const KEY_STEAM = 0x3e
const KEY_LAUNDRY_CARE = 0x57
// The one key that carries a SIXTEEN-bit value. That is why the option write always looked like it had
// a stray zero on the end: `7f 00 00` is this key holding no reservation, not a key and a trailing
// byte. It also makes the model JSON's `courseDownloadDataLength: 21` come out exactly - nine one-byte
// pairs (18) plus this three-byte entry.
const KEY_RESERVE = 0x7f
// Seen in every captured option write, always zero, never explained. Reproduced as captured.
const KEY_UNKNOWN_43 = 0x43

const OP_START = 0x01
const OP_PAUSE = 0x02
const OP_RESUME = 0x03

const COURSE_EXTENDED = 0xff
// Not a dial position. Twelve captured records carry 0 here and every one of them has the appliance
// powered off, while most powered-off records keep reporting the real course - so this is the appliance
// reporting nothing, not a course, and the dial it declares for itself contains no course 0. Treating it
// as one put a selectable "#0" in the course select. Found by replaying the captures through the handler;
// the unit tests had not caught it because no fixture happened to carry a zero course.
const COURSE_NONE = 0

// ---------------------------------------------------------------------------------------------------
// Which controls a course actually lets you touch, and with which values.
//
// THIS IS OBSERVATION, NOT CAPABILITY DATA. The appliance never declares it. The 0x86 message the app
// exchanges while browsing courses turned out to be a device-wide feature list (length-prefixed ASCII
// keys like "201-2-1"), not a per-course mask, so unlike the air conditioners - which do answer with a
// capability bitmap - there is nothing here to read. Every row below comes from the owner working the
// panel and reporting which buttons did nothing.
//
// Deriving it from the traffic alone does not work, in either direction: a sweep that stops early
// under-reports, and side effects over-report - setting wash to none drags water temperature to none
// with it, which reads exactly like "temperature is selectable" if you only look at the bytes.
//
// `null` means the control is locked on that course. An absent key means the full range is available.
// Consequently this can be wrong, and it is advisory only: it drives a diagnostic sensor and nothing
// else. A write the appliance rejects simply leaves the record unchanged, which the raw options sensor
// makes visible.
type CourseLimits = {
    wash?: number[] | null
    water_temp?: number[] | null
    rinse?: number[] | null
    spin?: number[] | null
    steam?: false
}
const COURSE_LIMITS: Record<string, CourseLimits> = {
    114: { wash: [3, 7], steam: false }, // 인공지능세탁
    46: {}, // 표준 - the permissive one, everything on full range
    'ext:245': {}, // 표준1
    'ext:246': {}, // 타월1
    94: { wash: [0, 3], water_temp: null, spin: [0, 1, 2], steam: false }, // 울/섬세
    27: { wash: [0, 1, 3], water_temp: [2, 3, 8], spin: [0, 1, 2, 4], steam: false }, // 이불
    135: { wash: [0, 3], water_temp: null, steam: false }, // 쾌속스팀살균 - steam is driven by the
    // appliance here rather than by the user: its bit follows the wash stage on its own.
    55: { wash: null, water_temp: null, steam: false }, // 헹굼+탈수
    85: { wash: null, water_temp: null, rinse: null, spin: null, steam: false }, // 통살균 - nothing
    134: { wash: null, water_temp: null, rinse: null, spin: null, steam: false }, // 급속통헹굼 - nothing
}

// The whole dial, named by sweeping it one position at a time through a full revolution and writing the
// names down in order. The alignment is self-checking: the sweep started and ended on the same position
// and came back to the same value, and three of the courses had already been identified independently
// (Towels 1 and Tub Clean from the app, Rinse + Spin from a cycle that was actually run) - all three
// landed where the sweep said they would.
//
// A course that is not listed here leaves the select untouched and shows up in `current_course` as its
// raw number, so a dial position that has not been swept is visible rather than silently missing.
//
// This is a table of NAMES, not of what exists. Which courses exist, in which order, and which need the
// escape is something the appliance declares for itself (processCourseTable); the declaration cannot
// supply names, because it only carries numbers.
const COURSE: Record<number, string> = {
    // Named by LG's own model JSON, numbered by this appliance. The numbers came from the dial: the
    // owner put every course back on it and read the panel off in order, and the declaration that
    // followed (0x4D, 30 entries) carried the same twenty ids in the same order - two independent
    // readings agreeing 20 for 20. Between them, every one of the 25 courses LG declares for this
    // model now has a number.
    0x05: 'ALLERGYCARE', // 알러지케어
    0x06: 'ANSIMCOLD', // 찬물 세탁
    0x08: 'BABYCARE', // 아기옷
    0x12: 'COLORCARE', // 컬러 케어
    0x1b: 'DUVET', // 이불, 98 min. LG calls it DUVET, not BEDDING - its own JSON says so
    0x2e: 'NORMAL', // 표준, 35 min
    0x36: 'REFRESH', // 스팀리프레쉬
    0x37: 'RINSE_SPIN', // 헹굼+탈수, 25 min
    0x38: 'RINSEONLY', // 헹굼 단독
    0x41: 'SILENT', // 조용조용
    0x46: 'SOAK', // 찌든 때
    0x4a: 'SPEEDWASH', // 소량급속
    0x4c: 'SPEEDBOIL', // 알뜰삶음
    0x4e: 'SPIN_ONLY', // 탈수 단독
    0x4f: 'SPORTS_WEARS', // 기능성의류
    0x55: 'TUB_CLEAN', // 통살균, 124 min
    0x59: 'WASHONLY', // 세탁 단독
    0x5e: 'WOOL', // 울/섬세, 53 min
    0x66: 'CLOTH_CARE', // 옷감 보호
    0x69: 'KIDS_WEAR', // 키즈옷
    0x6a: 'RAINY_DAY', // 장마철세탁
    0x6c: 'SHIRT', // 셔츠
    0x6d: 'SINGLE_GARMENTS', // 한벌 세탁
    0x71: 'SWEAT_STAIN', // 땀얼룩 제거
    0x72: 'AI_COURSE', // 인공지능세탁, 36 min

    // On the appliance, absent from LG's Course AND SmartCourse lists for this model. The names are
    // the panel's own words in the same shape as the keys above, so they are OURS - but 타월 is no
    // longer a guess: TOWELS_1 declares course 84 as its base (see COURSE_EXT), and putting 타월 back
    // on the dial produced exactly 84.
    0x54: 'TOWELS', // 타월
    0x87: 'QUICK_STEAM_SANITIZE', // 쾌속스팀살균, 64 min
    0x86: 'QUICK_TUB_RINSE', // 급속통헹굼, 12 min
}

// Reached through the 0xFF escape, with the real identifier in the second key. Selecting one needs a
// write carrying both keys at once; the only capture of that shape also carried all eight option keys,
// so that is the form `setExtendedCourse` reproduces rather than a guessed two-key frame - the two-key
// form on its own has never been seen on the wire. (These were briefly treated as read-only, on the
// grounds that no such write had been captured. It had been: the app selecting Towels 1.)
// The two reached through the 0xFF escape. Each declares a BASE course and a set of option overrides
// (0x4D's 42-byte variant): 0xf5 is built on 46 = NORMAL and 0xf6 on 84 = TOWELS, which is where the
// suffix comes from. Neither appears in any list LG publishes for this model, so the names are ours,
// but the courses they derive from are the appliance's own word.
const COURSE_EXT: Record<number, string> = {
    0xf5: 'NORMAL_1', // 표준1, 68 min - base NORMAL
    0xf6: 'TOWELS_1', // 타월1, 82 min - base TOWELS
}

// All four option scales were read off the panel by stepping each control through a full cycle on
// several courses and writing the displayed names down in order, with the sweep returning to its
// starting value so the alignment checks itself.
//
// Water temperature took two corrections. The capture session's notes had 0x05 as 40 degrees; it is 60.
// Then 0x00 was taken for the cold setting; it is not - cold is 0x08, and 0x00 means the stage is not
// used at all, which is why it appears exactly when the wash stage is set to none. There is a 30-degree
// setting after all.
const WATER_TEMP: Record<number, string> = { 0x00: 'none', 0x02: '30', 0x03: '40', 0x05: '60', 0x08: 'cold' }

// 0x02 and 0x04 have never appeared on any course swept so far.
const WASH: Record<number, string> = {
    0x00: 'none',
    0x01: 'light_soil',
    0x03: 'normal',
    0x05: 'intensive',
    0x06: 'pre_wash',
    0x07: 'soak',
}

// The gaps (0x03, 0x05, 0x07) are unused rather than unobserved - the dial steps straight over them.
const SPIN: Record<number, string> = {
    0x00: 'none',
    0x01: 'delicate',
    0x02: 'low',
    0x04: 'medium',
    0x06: 'high',
    0x08: 'dry_fit',
}
const BEEP: Record<number, string> = { 0: 'mute', 1: 'low', 2: 'medium', 3: 'high', 4: 'very_high' }
// Rinse is the count itself, and 0 means the stage is skipped. 0-5 were all stepped through.
const RINSE = [0, 1, 2, 3, 4, 5]

function invert(map: Record<number, string>): Record<string, number> {
    return Object.fromEntries(Object.entries(map).map(([k, v]) => [v, Number(k)]))
}
const WASH_BY_NAME = invert(WASH)
const WATER_TEMP_BY_NAME = invert(WATER_TEMP)
const SPIN_BY_NAME = invert(SPIN)
const BEEP_BY_NAME = invert(BEEP)
// The names this handler published before it moved to LG's keys. Writes still accept them, because a
// command is unambiguous - two names cannot mean two different courses - so an automation that SETS a
// course keeps working. Only comparisons against the published state have to be updated. Nothing
// publishes these, and they can go once this owner's automations no longer mention them.
const LEGACY_COURSE_NAMES: Record<string, number> = {
    'AI Wash': 0x72,
    'Wool / Delicates': 0x5e,
    Normal: 0x2e,
    'Tub Clean': 0x55,
    Bedding: 0x1b,
    'Quick Steam Sanitize': 0x87,
    'Rinse + Spin': 0x37,
    'Quick Tub Rinse': 0x86,
}
const LEGACY_COURSE_EXT_NAMES: Record<string, number> = { 'Normal 1': 0xf5, 'Towels 1': 0xf6 }

const COURSE_BY_NAME = { ...invert(COURSE), ...LEGACY_COURSE_NAMES }
const COURSE_EXT_BY_NAME = { ...invert(COURSE_EXT), ...LEGACY_COURSE_EXT_NAMES }

export default class Device extends AABBDevice {
    /** Wh reported by each of the appliance's ~15-minute energy reports, index 0 = report 1. */
    energyReports: number[] = []
    /** Wh since the current cycle started, as the appliance last reported it. */
    energyTotal: number | undefined
    /** The finish time last published while a cycle runs, so a re-anchored one under a minute away is not. */
    endTimePredicted: number | undefined

    /**
     * Remote control gates STARTING the machine, not writing settings to it. Settings writes are
     * accepted with it switched off - a hundred and six of them applied that way across the captures,
     * which is the whole course and option sweep - and the owner confirms the app's "send to washer"
     * works without it, after which start has to be pressed on the appliance.
     *
     * It can only be switched on at the appliance itself, which is the point of it, so there is no way
     * to fix that from here and refusing to send would be worse than sending. All this does is leave a
     * line in the log for the two commands it really does block.
     */
    remoteControl = false

    /** Last state record seen, so an extended-course write can carry the options along with it. */
    lastRecord: Buffer | undefined

    /**
     * Courses the select currently offers. Seeded from the named table, then grown from two sources:
     * the appliance's own declaration of its dial (processCourseTable), and any course seen in a state
     * record. Either way an unrecognised one is added under its number, so a dial position that was
     * never swept - or a sibling model's extra course - is selectable without waiting for the table to
     * be updated.
     *
     * Nothing is ever removed, and the reasons changed under measurement on 2026-08-06.
     *
     * "Courses do not disappear from a dial" is FALSE - the dial is the owner's own selection, and
     * they took ten courses off it while this was running. But keeping them is better than it was:
     * a course that is off the dial can still be SELECTED by writing its number. Measured on three,
     * two of which are not the base of any extended course - 108 and 113 were accepted with status
     * 0x00 and came back in the record with their own default options. So the list outliving the
     * dial is not a list of dead entries; it is the appliance's full vocabulary, and Home Assistant
     * can reach courses the physical dial no longer offers.
     *
     * The other reason still holds on its own: dropping a course would break any automation naming
     * it.
     */
    courseOptions = [...Object.values(COURSE), ...Object.values(COURSE_EXT)]

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: '',
                        icon: 'mdi:washing-machine',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: STATUS_OPTIONS,
                    },
                    // The phase enum is incomplete (3/37 are not pinned to a named stage, and only four
                    // courses have been run). Exposing the raw byte lets an unnamed phase be identified
                    // from history instead of vanishing into "Unknown".
                    status_code: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status-code',
                        state_topic: '$this/status_code',
                        name: 'Status code',
                        icon: 'mdi:numeric',
                        entity_category: 'diagnostic',
                    },
                    // These two published 0x3E as a per-stage TIME plan. It is an energy meter -
                    // see processEnergyReport() - so they are withdrawn rather than repurposed: an
                    // entity that changes from minutes to watt-hours under the same name is worse
                    // than one that goes away. Publishing the key with nothing but `platform` is
                    // what withdraws it; omitting the key entirely would only stop a fresh install
                    // creating one and leave every existing entity live forever, and an empty
                    // object is rejected outright because `platform` is required by the schema.
                    //
                    // The cast is load-bearing: mqtt/discovery.py pops `platform` and reads what
                    // is left, if it is empty, as a removal. Adding `unique_id` - or anything else
                    // - silently turns the removal back into a registration, so do not "fix" this
                    // by filling the type in. Safe to delete once every install has run this once.
                    cycle_plan: { platform: 'sensor' } as ComponentInfo,
                    cycle_plan_total: { platform: 'sensor' } as ComponentInfo,
                    // What 0x3E actually carries. The appliance under-reads the plug on the same
                    // outlet by about 10%, so this is the appliance's own account of itself rather
                    // than a calibrated meter - and it updates only every ~15 minutes.
                    energy: {
                        platform: 'sensor',
                        unique_id: '$deviceid-energy',
                        state_topic: '$this/energy',
                        name: 'Energy this cycle',
                        icon: 'mdi:lightning-bolt',
                        device_class: 'energy',
                        unit_of_measurement: 'Wh',
                        state_class: 'total_increasing',
                    },
                    energy_reports: {
                        platform: 'sensor',
                        unique_id: '$deviceid-energy-reports',
                        state_topic: '$this/energy_reports',
                        name: 'Energy per report',
                        icon: 'mdi:chart-histogram',
                        entity_category: 'diagnostic',
                    },
                    running: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-running',
                        state_topic: '$this/running',
                        name: 'Running',
                        device_class: 'running',
                    },
                    remote_control: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote-control',
                        state_topic: '$this/remote_control',
                        name: 'Remote control',
                        icon: 'mdi:cellphone-wireless',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door-lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        device_class: 'lock',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child-lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:account-lock',
                    },
                    wrinkle_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-wrinkle-care',
                        state_topic: '$this/wrinkle_care',
                        name: 'Wrinkle care',
                        icon: 'mdi:tshirt-crew',
                    },
                    drum_active: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-drum-active',
                        state_topic: '$this/drum_active',
                        name: 'Drum turning',
                        icon: 'mdi:rotate-3d-variant',
                        entity_category: 'diagnostic',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining-time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    total_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-total-time',
                        state_topic: '$this/total_time',
                        name: 'Total time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    // Counts down as the appliance works through the rinses, so it is genuinely useful
                    // while running - unlike the `rinse` select, which holds the selection.
                    rinse_remaining: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse-remaining',
                        state_topic: '$this/rinse_remaining',
                        name: 'Rinses remaining',
                        icon: 'mdi:water-sync',
                    },
                    // The select can only ever hold one of the courses we have names for, and this
                    // washer's dial has many more than the four that have been run. This always shows
                    // something - the name when we know it, `#114` when we do not - so the course is
                    // visible even before its number has been identified.
                    // An enum, with the same options as the select plus the placeholder it shows when
                    // nothing is running. That makes Home Assistant validate it and give it the enum
                    // treatment, and it is only safe because every label this can publish is added to
                    // the list before it is published - see registerCourse.
                    current_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-current-course',
                        state_topic: '$this/current_course',
                        name: 'Current course',
                        icon: 'mdi:playlist-check',
                        device_class: 'enum',
                        options: [COURSE_CLEARED, ...this.courseOptions],
                    },
                    end_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-end-time',
                        state_topic: '$this/end_time',
                        // Not "Finishes at" any more: since the timestamp is latched at Complete and
                        // kept, this entity holds a time in the past for most of the day and a
                        // prediction only while a cycle runs. A name in the present tense was right
                        // for one of those and wrong for the other.
                        name: 'Finish time',
                        device_class: 'timestamp',
                    },
                    available_options: {
                        platform: 'sensor',
                        unique_id: '$deviceid-available-options',
                        state_topic: '$this/available_options',
                        json_attributes_topic: '$this/available_options_attrs',
                        name: 'Adjustable options',
                        icon: 'mdi:tune-variant',
                        entity_category: 'diagnostic',
                    },
                    options_raw: {
                        platform: 'sensor',
                        unique_id: '$deviceid-options-raw',
                        state_topic: '$this/options_raw',
                        name: 'Selected options (raw)',
                        icon: 'mdi:code-braces',
                        entity_category: 'diagnostic',
                    },
                    cycles: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycles',
                        state_topic: '$this/cycles',
                        name: 'Cycles',
                        icon: 'mdi:counter',
                        entity_category: 'diagnostic',
                    },
                    // The seven entities below WRITE the next cycle's settings, and Home Assistant sorts
                    // a device's entities by name, which scattered them among the readings. The shared
                    // "Course - " prefix groups them, and marks them as the ones that change something -
                    // the readings that describe the cycle (Current course, Cycle plan, Remaining time)
                    // deliberately keep their own names.
                    //
                    // This is a display change only: an entity_id is assigned when the entity is first
                    // created and is not re-derived when the name changes, so anything already pointing
                    // at select.lg_washer_course keeps working.
                    course: {
                        platform: 'select',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        command_topic: '$this/course/set',
                        name: 'Course - Select',
                        icon: 'mdi:playlist-check',
                        // Grows as the appliance declares its dial or reports a course we have no name
                        // for; see courseOptions. Republished by setCourseOptions when it does.
                        options: [...this.courseOptions],
                    },
                    wash: {
                        platform: 'select',
                        unique_id: '$deviceid-wash',
                        state_topic: '$this/wash',
                        command_topic: '$this/wash/set',
                        name: 'Course - Wash',
                        icon: 'mdi:washing-machine',
                        options: Object.values(WASH),
                    },
                    water_temp: {
                        platform: 'select',
                        unique_id: '$deviceid-water-temp',
                        state_topic: '$this/water_temp',
                        command_topic: '$this/water_temp/set',
                        name: 'Course - Water temperature',
                        icon: 'mdi:thermometer-water',
                        options: Object.values(WATER_TEMP),
                    },
                    rinse: {
                        platform: 'select',
                        unique_id: '$deviceid-rinse',
                        state_topic: '$this/rinse',
                        command_topic: '$this/rinse/set',
                        name: 'Course - Rinse',
                        icon: 'mdi:water',
                        options: RINSE.map(String),
                    },
                    spin: {
                        platform: 'select',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        command_topic: '$this/spin/set',
                        name: 'Course - Spin',
                        icon: 'mdi:rotate-right',
                        options: Object.values(SPIN),
                    },
                    turbowash: {
                        platform: 'switch',
                        unique_id: '$deviceid-turbowash',
                        state_topic: '$this/turbowash',
                        command_topic: '$this/turbowash/set',
                        name: 'Course - TurboShot',
                        icon: 'mdi:car-turbocharger',
                    },
                    steam: {
                        platform: 'switch',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        command_topic: '$this/steam/set',
                        name: 'Course - Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    beep: {
                        platform: 'select',
                        unique_id: '$deviceid-beep',
                        state_topic: '$this/beep',
                        command_topic: '$this/beep/set',
                        name: 'Beep volume',
                        icon: 'mdi:volume-high',
                        options: Object.values(BEEP),
                        entity_category: 'config',
                    },
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        payload_press: '',
                        name: 'Start',
                        icon: 'mdi:play-circle-outline',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: '',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },
                    resume: {
                        platform: 'button',
                        unique_id: '$deviceid-resume',
                        command_topic: '$this/resume/set',
                        payload_press: '',
                        name: 'Resume',
                        icon: 'mdi:play-pause',
                    },
                    // Hours until the cycle should FINISH, which is what this appliance's reservation
                    // means. Half hours, because the appliance takes them; 0 is no reservation. The
                    // range starts at 0 rather than at the appliance's 3 so that the entity can say
                    // "none" at all - setProperty refuses the impossible gap in between rather than
                    // sending something the appliance declares invalid.
                    reservation: {
                        platform: 'number',
                        unique_id: '$deviceid-reservation',
                        state_topic: '$this/reservation',
                        command_topic: '$this/reservation/set',
                        name: 'Course - Reservation',
                        icon: 'mdi:timer-sand',
                        min: 0,
                        max: 19,
                        step: 0.5,
                        unit_of_measurement: 'h',
                        mode: 'box',
                    },
                    laundry_care: {
                        platform: 'switch',
                        unique_id: '$deviceid-laundry-care',
                        state_topic: '$this/laundry_care',
                        command_topic: '$this/laundry_care/set',
                        name: 'Laundry care when done',
                        icon: 'mdi:tumble-dryer',
                    },
                },
            }),
        )
    }

    /**
     * Switching the appliance off at the panel makes it drop its connection, so rethink drops the
     * device and every entity would go unavailable - which reads as "the washer has fallen off the
     * network" when it has simply been switched off, and hides the perfectly good state we already
     * hold. If the last thing it told us was that it was off, keep that on screen instead.
     *
     * The cost is deliberate: a washer that is switched off and then loses power or Wi-Fi keeps
     * reading "off" rather than going unavailable, because from here the two are indistinguishable.
     * A drop from any other state is still an unexpected one and is reported. rethink's own LWT
     * (`$rethink/availability`, combined with `availability_mode: 'all'`) still takes every entity
     * unavailable if the server itself goes away, so this only suppresses the per-device signal.
     */
    override drop() {
        if (this.lastRecord?.[OFF_PHASE] === PHASE_OFF) return
        super.drop()
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== FROM_DEVICE || buf.length < 4) return

        const type = buf[1]
        // The 0xFF "extended length" form carries a 16-bit total length after the type byte. AABBDevice
        // has already removed the 4 envelope bytes, hence the +4.
        const extended = buf.readUInt16BE(2) === buf.length + 4
        const payload = extended ? buf.subarray(4) : buf.subarray(2)

        if (type === MSG_TUNNEL) {
            if (payload.length < 10) return

            const data = payload.subarray(10)
            // 0xEC stacks the previous record ahead of the current one; 0xEB carries the current one
            // alone. Same 66-byte layout either way.
            const offset =
                payload[6] === INNER_STATE ? CURRENT_RECORD_OFFSET : payload[6] === INNER_STATE_SINGLE ? 0 : -1
            if (offset < 0 || data.length < offset + RECORD_LEN) return
            this.processRecord(data.subarray(offset, offset + RECORD_LEN))
        } else if (type === MSG_SETTINGS_REPLY) {
            // 00 02 01 FF <n> [<key> <status>]*n 00 <record>
            if (payload.length < 5) return
            const start = 5 + payload[4] * 2 + 1
            if (payload.length < start + RECORD_LEN) return
            this.processRecord(payload.subarray(start, start + RECORD_LEN))
        } else if (type === MSG_COURSE_TABLE) {
            this.processCourseTable(payload)
        } else if (type === MSG_ENERGY && buf.length === ENERGY_LEN) {
            /*
             * Read from `buf`, NOT from `payload`. The extended-length test above is a heuristic -
             * "the u16 after the type equals the frame length + 4" - and on this message that u16
             * is a watt-hour count. A report of exactly 11 Wh therefore reads as extended, four
             * bytes get eaten, and the report is mangled.
             *
             * That is not hypothetical: a report in washer-cycle-20260730.jsonl carries 11, and the
             * first version of this decode dropped it. These frames are a fixed seven bytes and are
             * never extended, so the length check replaces the guess.
             */
            this.processEnergyReport(buf.subarray(2))
        }
    }

    /**
     * The appliance's own energy meter, reported every ~15 minutes.
     *
     *     20 3E | <u16 Wh since the last report> | <u16 Wh cumulative> | <report number, from 1>
     *
     * THIS WAS READ AS A TIME PLAN AND IT IS NOT ONE. The first decode had the right structure -
     * the second field really is the running sum of the first - and the wrong unit, because it
     * only ever looked at the payloads and never at when they arrived. They arrive one at a time,
     * 14:46 to 15:20 apart, for as long as the appliance is powered; a plan would arrive at once
     * and before the cycle. What settled the unit was the smart plug on this appliance's outlet:
     *
     *   2026-07-30, AI Wash    report 2 said 94   plug: 1880-2018 W for three minutes ~= 95 Wh,
     *                                             and its own kWh counter moved +0.10 in the window
     *   2026-08-04, Normal     cycle total 164    plug: +0.18 kWh over the cycle (+-10, it counts
     *                                             in hundredths), so ~180 Wh
     *
     * The appliance reads about 10% under the plug, consistently, which is what metering only the
     * heater and the motor rather than the whole appliance looks like. What is not in doubt is the
     * scale: the same cycle ran 28.7 minutes and the old decode published its total as "167 min".
     *
     * The counter resets to zero when a cycle starts - report 1 of the 2026-08-04 cycle carried
     * 140/140 - and keeps running afterwards while the appliance idles, at about 3 Wh per report.
     *
     * Cross-check, from a different frame: 0xE2 (sent 30 s before the cycle finishes) carries the
     * same total at @22. On 2026-08-04 both said 164, and 0xE2's two older samples - 128 and 33 -
     * each match their cycle's 0x3E cumulative at that moment. That field had been undecoded.
     *
     * Report 2 of that cycle arrived one second after the appliance reached Complete, which is
     * either the 15-minute cadence landing there by chance or the cycle end forcing a report. Two
     * readings, one sample, so it is not settled either way.
     */
    processEnergyReport(payload: Buffer) {
        const delta = payload.readUInt16BE(0)
        const total = payload.readUInt16BE(2)
        const report = payload[4]

        if (report === 1) this.energyReports = []
        this.energyReports[report - 1] = delta
        this.energyTotal = total

        // Home Assistant's statistics treat a drop as a meter reset, which is exactly what the
        // appliance does at the start of every cycle, so the per-cycle totals still add up.
        this.publishProperty('energy', total)
        this.publishProperty('energy_reports', this.energyReports.map((wh) => wh ?? '?').join('/'))
    }

    /**
     * The appliance declares its own dial: every course on it, in dial order, each marked as needing the
     * 0xFF escape or not. All ten it declares matched the ten found by sweeping the dial by hand, in the
     * same order, and the two it marks are exactly the two that need the escape - so the hand-built
     * table and the appliance's own account of itself agree completely.
     *
     * What this contributes is EXISTENCE, which the handler previously only had by hardcoding it. It can
     * only grow the list, never replace it, because the declaration is late (26-109 s after the
     * appliance connects) and in four measured connection windows it never arrived at all. So the named
     * table still seeds the select and this improves on it when it turns up.
     *
     * Names are not in here - the appliance sends numbers - so an undeclared name stays offered and an
     * unnamed declaration is offered under its number.
     */
    processCourseTable(payload: Buffer) {
        if (payload.length < 4 || payload[0] !== TABLE_COURSE_LIST) return
        if (payload[1] !== TABLE_KIND) return
        const count = payload[3]
        // The declared count and the frame length must agree exactly. This is the only real guard: a
        // sibling model laying the table out differently has to fall through to the named table rather
        // than have whatever it sent read as course numbers.
        if (payload.length !== 4 + count * 2) return

        const declared: string[] = []
        for (let i = 0; i < count; i++) {
            const kind = payload[4 + i * 2]
            const id = payload[5 + i * 2]
            // Named through the same path as a course read from a state record, so one course cannot end
            // up under two different labels depending on which frame it arrived in.
            declared.push(this.courseLabel(kind === TABLE_KIND_EXTENDED ? COURSE_EXTENDED : id, id))
        }

        // Declared order is dial order, which is the more useful one to offer. Anything already on the
        // list that was not declared keeps its place after it rather than being dropped.
        const merged = [...declared, ...this.courseOptions.filter((course) => !declared.includes(course))]
        if (merged.length === this.courseOptions.length && merged.every((c, i) => c === this.courseOptions[i])) return

        log('status', `${this.id}: the appliance declares ${count} courses: ${declared.join(', ')}`)
        this.setCourseOptions(merged)
    }

    processRecord(rec: Buffer) {
        // Kept before lastRecord is overwritten: the finish timestamp latches on the MOVE into
        // Complete, not on being in it, and every frame afterwards repeats the same phase.
        const previousPhase = this.lastRecord?.[OFF_PHASE]
        this.lastRecord = rec
        const phase = rec[OFF_PHASE]
        const flags = rec[OFF_FLAGS]

        this.publishProperty('power', phase === PHASE_OFF ? 'OFF' : 'ON')
        // Lower case: this sensor declares device_class 'enum', and Home Assistant rejects a state that
        // is not one of the declared options - 'Unknown' was not one of them, 'unknown' is.
        this.publishProperty('status', STATUS[phase] ?? 'unknown')
        this.publishProperty('status_code', phase)
        this.publishProperty('running', ACTIVE_PHASES.has(phase) ? 'ON' : 'OFF')
        // Not while a reservation waits: the bit is set for the whole of it - see FLAG_DRUM_ACTIVE.
        this.publishProperty('drum_active', flags & FLAG_DRUM_ACTIVE && phase !== PHASE_RESERVED ? 'ON' : 'OFF')
        this.remoteControl = (flags & FLAG_REMOTE_CONTROL) !== 0
        this.publishProperty('remote_control', this.remoteControl ? 'ON' : 'OFF')
        this.publishProperty('child_lock', flags & FLAG_CHILD_LOCK ? 'ON' : 'OFF')
        // device_class 'lock' is inverted by Home Assistant's convention: on means unlocked.
        this.publishProperty('door_lock', rec[OFF_DOOR_LOCK] ? 'OFF' : 'ON')
        this.publishProperty('wrinkle_care', rec[OFF_WRINKLE_CARE] & WRINKLE_CARE_ON ? 'ON' : 'OFF')
        this.publishProperty('turbowash', rec[OFF_TURBOSHOT] & TURBOSHOT_ON ? 'ON' : 'OFF')
        this.publishProperty('laundry_care', rec[OFF_LAUNDRY_CARE] & LAUNDRY_CARE_ON ? 'ON' : 'OFF')
        // Published in hours because that is the unit the appliance's own panel and app use, and
        // because a number entity reading 330 would invite someone to write 330 back.
        const reserveMinutes = (rec[OFF_RESERVE_HI] << 8) | rec[OFF_RESERVE_LO]
        this.publishProperty(
            'reservation',
            rec[OFF_RESERVE_FLAG] & RESERVE_SET ? Math.round((reserveMinutes / 60) * 2) / 2 : 0,
        )
        this.publishProperty('cycles', String(rec[OFF_CYCLES]))
        this.publishProperty('beep', BEEP[rec[OFF_BEEP]] ?? 'unknown')
        this.publishProperty('steam', rec[OFF_STEAM] & STEAM_ON ? 'ON' : 'OFF')

        // Only the wash clock counts down, so everything else would show a stale figure - and at the end
        // of a cycle the remaining-minutes byte sticks at 1 rather than reaching 0. The total is the
        // selected course's estimate though, which is worth seeing before pressing start, so it is
        // published whenever the appliance is on.
        const remaining = TIMED_PHASES.has(phase) ? rec[OFF_REMAIN_H] * 60 + rec[OFF_REMAIN_M] : 0
        this.publishProperty('remaining_time', remaining)

        /*
         * A reservation is a countdown too, and a much longer one, so the finish time below uses it
         * instead. Measured 2026-08-04 18:45 onwards: the reservation ticks down a minute at a time
         * (420, 419, 418, ...) while the remaining-minutes bytes hold the CYCLE's length - they read
         * 30 for a thirty-minute cycle seven hours away, so they are not what "finishes at" wants.
         *
         * Taking this as the time to the FINISH rather than to the start is LG's own framing - the
         * model JSON calls the feature `endReserveTime` and the appliance's panel calls it 종료 예약.
         * It has not been watched all the way down, and the check when it is: the cycle should start
         * when this counter reaches the cycle's own length, which is the 30 above, not at zero.
         */
        const untilFinish = phase === PHASE_RESERVED && rec[OFF_RESERVE_FLAG] & RESERVE_SET ? reserveMinutes : remaining

        /*
         * The finish time, which is a timestamp all the way through rather than a countdown that
         * gives up. While a cycle runs it is the PREDICTED finish, recomputed only when the minute
         * count actually moves - doing it on every frame would push a slightly different timestamp
         * several times a second and fill the recorder with noise. When the cycle reaches Complete
         * it is latched to that instant and left alone.
         *
         * It is never cleared. It used to publish 'None' the moment the clock stopped, which took
         * the sensor to unknown and threw away the one number worth keeping: Home Assistant renders
         * a `timestamp` entity relative to now, so a kept value reads "5 minutes ago" - the natural
         * answer to "when did the washing finish?" - while unknown answers nothing. The next cycle
         * overwrites it with its own prediction, and the retained MQTT value survives restarts.
         *
         * The latch is on the MOVE into Complete. Publishing on every frame that says Complete
         * would drag the timestamp along with now and it would read "0 minutes ago" forever. A
         * record that is already Complete when the first frame arrives (a restart while the washer
         * sits finished) is deliberately NOT latched - that instant is the restart, not the finish,
         * and the retained value already holds the real one.
         */
        if (untilFinish > 0) {
            /*
             * Only when it moves by a minute or more, because anything smaller is OUR noise rather
             * than the appliance's news. The countdown is in whole minutes and the appliance revises
             * it as it goes: measured over the 2026-08-04 cycle its ticks were 43 to 74 s apart and
             * it dropped two minutes at once twice. Re-anchoring "now + remaining" at each of those
             * lands on a slightly different instant every time, which published this entity 21 times
             * in a 29-minute cycle. With the minute of hysteresis the same cycle publishes 6 times,
             * over the same range - every genuine revision still gets through, and the wobble does
             * not. A revision the appliance actually made cannot be smaller than its own granularity.
             */
            const predicted = Date.now() + untilFinish * 60_000
            if (this.endTimePredicted === undefined || Math.abs(predicted - this.endTimePredicted) >= 60_000) {
                this.endTimePredicted = predicted
                // Published on the minute: the seconds carry no information, and a value that keeps
                // its seconds invites the same wobble back in through a template or a comparison.
                this.publishProperty('end_time', new Date(Math.round(predicted / 60_000) * 60_000).toISOString())
            }
        } else {
            // So the next cycle's first prediction always publishes, however close it happens to fall
            // to this one's.
            this.endTimePredicted = undefined
            if (phase === PHASE_DONE && previousPhase !== undefined && previousPhase !== PHASE_DONE) {
                // Not rounded: this one is a measured event rather than an estimate, and it is
                // published exactly once, so there is no wobble to suppress.
                this.publishProperty('end_time', new Date().toISOString())
            }
        }
        this.publishProperty('total_time', phase === PHASE_OFF ? 0 : rec[OFF_TOTAL_H] * 60 + rec[OFF_TOTAL_M])
        this.publishProperty('rinse_remaining', rec[OFF_RINSE])

        // The course byte is not consumed - it survives the cycle, the finished state and even powering
        // off - so it is always worth publishing, except when the byte identifying it reads 0. For an
        // extended course that is the second byte; no record has ever been seen taking the escape with a
        // zero identifier, but the same reasoning applies and the alternative is publishing "#ext0".
        const course = rec[OFF_COURSE]
        const identifier = course === COURSE_EXTENDED ? rec[OFF_COURSE_EXT] : course
        const label = identifier === COURSE_NONE ? undefined : this.courseLabel(course, rec[OFF_COURSE_EXT])
        if (label !== undefined) {
            this.registerCourse(label)
            this.publishProperty('course', label)
            // Depends only on which course is selected, so it is published in every phase, not just standby.
            this.publishLimits(course, rec[OFF_COURSE_EXT])
        }

        // The select holds the SELECTION and keeps it - it is what the next start will run, and '-' is
        // not one of its options, so Home Assistant would reject it. This sensor answers a different
        // question, "what is the washer doing", and once the answer is "nothing" the leftover name reads
        // as a cycle that is still on. It clears even when the course byte is absent, because a record
        // that reports neither a phase nor a course is the emptiest evidence there is that nothing is on.
        if (FINISHED_PHASES.has(phase)) this.publishProperty('current_course', COURSE_CLEARED)
        else if (label !== undefined) this.publishProperty('current_course', label)

        // The rest are consumed as the appliance works through them and read 0 from the first stage
        // onwards, so they only report the selection while it sits at standby. Anywhere else,
        // republishing would overwrite the selects with meaningless values; Home Assistant keeps the
        // last value published. Gating this on the 0x10 flag instead was wrong - it stays set after a
        // cycle finishes, so the selects went unpublished for as long as the washer sat on Complete.
        if (phase !== PHASE_STANDBY) return

        this.publishOption('wash', WASH[rec[OFF_WASH]])
        this.publishOption('water_temp', WATER_TEMP[rec[OFF_WATER_TEMP]])
        this.publishOption('rinse', RINSE.includes(rec[OFF_RINSE]) ? String(rec[OFF_RINSE]) : undefined)
        this.publishOption('spin', SPIN[rec[OFF_SPIN]])

        // Only four courses have been run on this appliance and the water-temperature/spin lists are
        // just as partial, so an unrecognised value is expected rather than exceptional. A select whose
        // state is not one of its own options is rejected by Home Assistant, so those are left holding
        // their previous value and the raw bytes are published here instead - the same escape hatch as
        // `status_code`, and the thing to read when naming a new course.
        this.publishProperty(
            'options_raw',
            `course=${course} ext=${rec[OFF_COURSE_EXT]} wash=${rec[OFF_WASH]} temp=${rec[OFF_WATER_TEMP]} rinse=${rec[OFF_RINSE]} spin=${rec[OFF_SPIN]} steam=${rec[OFF_STEAM]}`,
        )
    }

    courseLabel(course: number, ext: number) {
        if (course === COURSE_EXTENDED) return COURSE_EXT[ext] ?? `#ext${ext}`
        return COURSE[course] ?? `#${course}`
    }

    /** Add a course to the select and republish discovery, the once, when it is first seen. */
    registerCourse(label: string) {
        if (this.courseOptions.includes(label)) return
        this.setCourseOptions([...this.courseOptions, label])
    }

    /**
     * Put a new option list on the course select and republish discovery. Callers only ever grow the
     * list: withdrawing an option would break any automation naming it, and courses do not leave a dial.
     */
    setCourseOptions(options: string[]) {
        this.courseOptions = options
        const course = this.config?.components?.course as { options?: string[] } | undefined
        const current = this.config?.components?.current_course as { options?: string[] } | undefined
        if (!course) return
        course.options = [...options]
        // The sensor declares the same list, plus the placeholder. It is an enum, so a label that
        // reached it without being declared here would be rejected by Home Assistant.
        if (current) current.options = [COURSE_CLEARED, ...options]
        this.publishConfig()
    }

    /**
     * What the current course lets the user change. Advisory - see COURSE_LIMITS; the appliance does
     * not declare this, so it is a record of what was tried by hand rather than something authoritative.
     */
    publishLimits(course: number, ext?: number) {
        const limits = COURSE_LIMITS[course === COURSE_EXTENDED ? `ext:${ext}` : String(course)]
        if (!limits) {
            this.publishProperty('available_options', 'unknown')
            this.publishProperty('available_options_attrs', '{}')
            return
        }

        const named = (values: number[] | undefined | null, map: Record<number, string>) =>
            values === null ? null : (values ?? Object.keys(map).map(Number)).map((v) => map[v] ?? String(v))

        const attrs = {
            wash: named(limits.wash, WASH),
            water_temp: named(limits.water_temp, WATER_TEMP),
            rinse: limits.rinse === null ? null : (limits.rinse ?? RINSE).map(String),
            spin: named(limits.spin, SPIN),
            steam: limits.steam !== false,
        }
        const adjustable = Object.entries(attrs)
            .filter(([, v]) => (Array.isArray(v) ? v.length > 1 : v === true))
            .map(([k]) => k)

        this.publishProperty('available_options', adjustable.join(', ') || 'none')
        this.publishProperty('available_options_attrs', JSON.stringify(attrs))
    }

    /** Publish a select's state only when the appliance's value is one of the options we declared. */
    publishOption(prop: string, value: string | undefined) {
        if (value !== undefined) this.publishProperty(prop, value)
    }

    // f0 e5 00 02 01 ff 01 <key> <value>  - AABBDevice.send() reproduces the appliance's own framing and
    // checksum exactly; all eleven captured commands were rebuilt from it byte for byte.
    setField(key: number, value: number) {
        this.send(Buffer.from([0xf0, 0xe5, 0x00, 0x02, 0x01, 0xff, 0x01, key, value]))
    }

    /**
     * Extended courses cannot be selected with the course key alone - the escape value needs the real
     * identifier alongside it, in one frame. The only capture of that shape is the app selecting Towels
     * 1, and it carried all eight option keys as well, so that is what is reproduced here rather than a
     * guessed two-pair frame. The options come from the last record, which is what the app was sending
     * too: its own idea of the current selection.
     */
    setExtendedCourse(id: number) {
        const rec = this.lastRecord
        if (!rec) return
        this.send(
            Buffer.from([
                0xf0,
                0xe5,
                0x00,
                0x02,
                0x01,
                0xff,
                0x0a,
                KEY_COURSE,
                COURSE_EXTENDED,
                KEY_COURSE_EXT,
                id,
                KEY_WASH,
                rec[OFF_WASH],
                KEY_RINSE,
                rec[OFF_RINSE],
                KEY_SPIN,
                rec[OFF_SPIN],
                KEY_WATER_TEMP,
                rec[OFF_WATER_TEMP],
                KEY_TURBOWASH,
                rec[OFF_TURBOSHOT] & TURBOSHOT_ON ? 1 : 0,
                KEY_STEAM,
                rec[OFF_STEAM] & STEAM_ON ? 1 : 0,
                0x43,
                0x00,
                0x7f,
                0x00,
                0x00,
            ]),
        )
    }

    /**
     * Set (or clear) the delay-end reservation, in minutes.
     *
     * This reproduces the frame the LG app sent when the owner set 5 h and then 5 h 30 with a capture
     * running, byte for byte: eight entries, the last of which is the only 16-bit one this protocol
     * has. The other seven are the current options read back out of the last record, which is what the
     * app was doing too - it re-sends its idea of the whole selection every time.
     *
     *   f0 e5 00 02 01 ff 08  1e <wash> 20 <rinse> 21 <spin> 1f <temp>
     *                         35 <turbowash> 3e <steam> 43 00  7f <minutes:u16>
     *
     * A reservation is only STAGED by this. The appliance stayed on Standby through both writes and
     * never reached phase 7 (RESERVED), so something still has to start it - the same as setting a
     * course does not run it. Powering the appliance off clears the reservation: that is what happened
     * in the 2026-07-30 capture, where 210 minutes and the flag both went to zero on power-off.
     */
    setReservation(minutes: number) {
        const rec = this.lastRecord
        if (!rec) return
        this.send(
            Buffer.from([
                0xf0,
                0xe5,
                0x00,
                0x02,
                0x01,
                0xff,
                0x08,
                KEY_WASH,
                rec[OFF_WASH],
                KEY_RINSE,
                rec[OFF_RINSE],
                KEY_SPIN,
                rec[OFF_SPIN],
                KEY_WATER_TEMP,
                rec[OFF_WATER_TEMP],
                KEY_TURBOWASH,
                rec[OFF_TURBOSHOT] & TURBOSHOT_ON ? 1 : 0,
                KEY_STEAM,
                rec[OFF_STEAM] & STEAM_ON ? 1 : 0,
                KEY_UNKNOWN_43,
                0x00,
                KEY_RESERVE,
                (minutes >> 8) & 0xff,
                minutes & 0xff,
            ]),
        )
    }

    // Sent by the app immediately after an operation write, but only when the drum is actually about to
    // turn - a pause never carries it.
    trigger() {
        this.send(Buffer.from('f024100101', 'hex'))
    }

    setProperty(prop: string, mqttValue: string) {
        // Settings writes are accepted with remote control off - measured, a hundred of them applied
        // that way, and the owner confirms the app's "send to washer" works without it. What needs it
        // is starting the machine remotely, so the warning is limited to that.
        if (!this.remoteControl && (prop === 'start' || prop === 'resume')) {
            log('status', `${this.id}: ${prop} sent while remote control is off - press start on the appliance instead`)
        }

        switch (prop) {
            case 'power':
                return this.setField(KEY_POWER, mqttValue === 'ON' ? 1 : 0)
            case 'start':
                this.setField(KEY_OPERATION, OP_START)
                return this.trigger()
            case 'pause':
                return this.setField(KEY_OPERATION, OP_PAUSE)
            case 'resume':
                this.setField(KEY_OPERATION, OP_RESUME)
                return this.trigger()
            case 'laundry_care':
                return this.setField(KEY_LAUNDRY_CARE, mqttValue === 'ON' ? 1 : 0)
            case 'turbowash':
                return this.setField(KEY_TURBOWASH, mqttValue === 'ON' ? 1 : 0)
            case 'steam':
                return this.setField(KEY_STEAM, mqttValue === 'ON' ? 1 : 0)
            case 'rinse': {
                const count = Number(mqttValue)
                if (RINSE.includes(count)) this.setField(KEY_RINSE, count)
                return
            }
            case 'reservation': {
                // The entity offers 0 to 19 in half hours so that "no reservation" is expressible, but
                // the appliance's own declaration starts at 3 h. Rather than send something it says is
                // out of range, refuse it and say so - a rejected write leaves no trace otherwise.
                const minutes = Math.round(Number(mqttValue) * 60)
                if (!Number.isFinite(minutes) || minutes < 0) return
                if (minutes !== 0 && (minutes < RESERVE_MIN_MINUTES || minutes > RESERVE_MAX_MINUTES)) {
                    log(
                        'status',
                        `${this.id}: reservation ${mqttValue} h is outside the ${RESERVE_MIN_MINUTES / 60}-${RESERVE_MAX_MINUTES / 60} h this appliance declares; not sent`,
                    )
                    return
                }
                if (minutes % RESERVE_STEP_MINUTES !== 0) {
                    log('status', `${this.id}: reservation ${mqttValue} h is not a half hour; not sent`)
                    return
                }
                return this.setReservation(minutes)
            }
        }

        const selects: Record<string, [number, Record<string, number>]> = {
            course: [KEY_COURSE, COURSE_BY_NAME],
            wash: [KEY_WASH, WASH_BY_NAME],
            water_temp: [KEY_WATER_TEMP, WATER_TEMP_BY_NAME],
            spin: [KEY_SPIN, SPIN_BY_NAME],
            beep: [KEY_BEEP, BEEP_BY_NAME],
        }
        const select = selects[prop]
        if (!select) return
        const [key, byName] = select
        const value = byName[mqttValue]
        if (value !== undefined) return this.setField(key, value)

        if (prop !== 'course') return

        const ext = COURSE_EXT_BY_NAME[mqttValue]
        if (ext !== undefined) return this.setExtendedCourse(ext)

        // The auto-registered labels for courses we have no name for.
        const extNumber = /^#ext(\d+)$/.exec(mqttValue)
        if (extNumber) return this.setExtendedCourse(Number(extNumber[1]))
        const plain = /^#(\d+)$/.exec(mqttValue)
        if (plain) this.setField(KEY_COURSE, Number(plain[1]))
    }
}
