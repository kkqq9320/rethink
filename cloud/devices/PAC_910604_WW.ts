import TLVDevice, { FieldDefinition } from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { ClimateComponent, ComponentInfo, DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import log from '@/util/logging'
import HADevice from './base'

/**
 * LG stand (floor-standing) Air Conditioner
 * ThinQ model PAC_910604_WW (swVersion 310917, deviceType 401, platform thinq2)
 *
 * QUIRK: this appliance does not use the usual 0x87 frame marker at buf[6], and it is not
 * even consistent about what it does use. All 143 state frames in the reference capture
 * are marked 0xa7, so the base class' processData() drops every one of them. On the
 * private command channel the two command acknowledgements in the capture are marked 0x87,
 * but the two data responses - the appliance answering a read - are marked 0x65, echoing
 * the marker of the request they answer. processData() below therefore widens the
 * marker test on all three branches, still accepting 0x87 everywhere so that a firmware
 * behaving like every other model keeps working, and delegates anything it does not
 * recognise to the base class, following POT_056905_WW's override.
 *
 * The supported mode set is unusually small: cool, dry and air-clean/fan only. There is
 * no heat, no auto and no vertical swing on this model - injecting 0x1f9 = 2 was ignored
 * by the appliance.
 */

/*
 * ClimateComponent does not declare `modes` (HA's list of supported HVAC modes) because
 * every other AC profile is happy with HA's default list. This model supports only three
 * of them, so it has to spell the list out.
 */
type StandClimateComponent = ClimateComponent & { modes?: string[] }
type StandDiscovery = DeviceDiscovery & { components: { climate: StandClimateComponent } }

type SwitchOptions = {
    /* raw TLV value written for 'ON' (default 1) */
    onValue?: number
    /* raw TLV value written for 'OFF' (default 0) */
    offValue?: number
    /* raw TLV value that reads back as 'ON', when it differs from onValue */
    readOnValue?: number
    /* HA entity_category; 'config' unless the control is really a maintenance function */
    entityCategory?: string
}

export default class Device extends TLVDevice {
    readonly deviceConfig: StandDiscovery

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        /*
         * Unlike RAC_056905_WW this profile builds its configuration up front instead of
         * waiting for a capability response. Nothing here is gated on capability bits, so
         * every entity exists from the first connect.
         *
         * This appliance does answer a capability query - a live probe got a 174-byte,
         * 54-TLV reply, see isCapsResponse() below. It is simply not needed to publish these
         * components, and its contents were never recorded in full, which is why processTLV()
         * below keeps it away from the filter counters.
         */
        const config: StandDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Stand Air Conditioner' }),
            components: {
                climate: {
                    platform: 'climate',
                    unique_id: '$deviceid-climate',
                    name: null,
                    temperature_unit: 'C',
                    /* kept in sync with 0x1fb, see updateTempStep() */
                    temp_step: 0.5,
                    precision: 0.5,
                    /* 0x1fe is degrees * 2 and ranges over 36 .. 60 */
                    min_temp: 18,
                    max_temp: 30,
                    modes: ['off', 'cool', 'dry', 'fan_only'],
                    /* raw 2 .. 6 are the appliance's 1단 .. 5단; named as in RAC_056905_WW */
                    fan_modes: ['very low', 'low', 'medium', 'high', 'very high', 'auto'],
                    /* sideways airflow aim, not oscillation - see 0x2a3 below */
                    swing_horizontal_modes: ['focus', 'wide', 'left', 'right', 'split'],
                } satisfies StandClimateComponent,
            },
        })
        this.deviceConfig = config

        this.addField(config, {
            id: 0x1fd,
            name: 'current_temperature',
            comp: 'climate',
            state_topic: 'topic',
            writable: false,
            read_xform: (raw) => raw / 2,
        })

        this.addField(config, {
            id: 0x1f7,
            name: 'power',
            comp: 'climate',
            readable: false,
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            /* the appliance was never observed being sent a bare 0x1f7, so mirror RAC */
            write_attach: (raw) => (raw ? [0x1f9, 0x1fa, 0x1fe] : []),
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            read_callback: () => {
                // publish it as the climate mode instead
                this.processKeyValue(0x1f9, this.raw_clip_state[0x1f9])
                return false
            },
        })

        this.addField(config, {
            id: 0x1f9,
            name: 'mode',
            comp: 'climate',
            read_xform: (raw) => {
                /* 2 (fan only on other models) is rejected by this appliance */
                const modes2ha: Record<number, string> = { 0: 'cool', 1: 'dry', 5: 'fan_only' }
                if (this.raw_clip_state[0x1f7] === 0) return 'off'
                return modes2ha[raw]
            },
            write_xform: (val) => {
                const modes2clip: Record<string, number> = { cool: 0, dry: 1, fan_only: 5 }
                if (val === 'off') {
                    // Call function power (0x1f7) with value OFF
                    this.setProperty('climate-power', 'OFF')
                    return null
                }
                return modes2clip[val]
            },
            /*
             * The LG app always writes the trio 0x1f9, 0x1fa, 0x1fe together, and it only
             * ever did so with the appliance already running - the capture contains no
             * write of 0x1f7 at all, so what a bare mode write does to a powered-off
             * appliance is unverified. HA semantics are not ambiguous though: selecting an
             * hvac_mode while the entity reads 'off' means "turn on in that mode", so add
             * the power tag in exactly that case. While the appliance is on, the frame
             * stays byte-identical to the app's.
             *
             * The mutation has to happen here rather than in write_xform: setProperty()
             * calls write_xform first and only reads raw_clip_state after write_attach has
             * returned, so setting it earlier would destroy the previous power reading this
             * test depends on, and attaching 0x1f7 without setting it would send 0x1f7 = 0
             * and switch the appliance off.
             */
            write_attach: () => {
                if (this.raw_clip_state[0x1f7] === 1) return [0x1fa, 0x1fe]

                this.raw_clip_state[0x1f7] = 1
                return [0x1f7, 0x1fa, 0x1fe]
            },
        })

        this.addField(config, {
            id: 0x1fa,
            name: 'fan_mode',
            comp: 'climate',
            /*
             * 2 .. 6 are the five speeds the user can pick. 7 and 8 are not selectable:
             * they are the appliance saying "I am driving the fan myself right now" - 8 in
             * dry mode, 7 while jet mode runs. Confirmed on hardware: in both states the
             * fan control is greyed out on the appliance and in the LG app.
             *
             * Both must map to 'auto'. Discarding 7 (as this did originally) leaves HA
             * displaying whatever speed was selected before jet was switched on, which is
             * not what the appliance is doing.
             *
             * 'auto' stays writable because HA offers no way to publish a read-only member
             * of fan_modes; writing it sends 8, which is what the app sends when it puts the
             * appliance into dry.
             */
            read_xform: (raw) => {
                const modes2ha = [
                    undefined,
                    undefined,
                    'very low',
                    'low',
                    'medium',
                    'high',
                    'very high',
                    'auto', // 7: jet mode drives the fan
                    'auto', // 8: dry mode drives the fan
                ]
                return modes2ha[raw]
            },
            write_xform: (val) => {
                const modes2clip: Record<string, number> = {
                    'very low': 2,
                    low: 3,
                    medium: 4,
                    high: 5,
                    'very high': 6,
                    auto: 8,
                }
                return modes2clip[val]
            },
            write_attach: [0x1f9, 0x1fe],
        })

        this.addField(config, {
            id: 0x1fe,
            name: 'temperature',
            comp: 'climate',
            read_xform: (raw) => raw / 2,
            write_xform: (valStr) => {
                const val = Math.round(Number(valStr) * 2)
                if (val < 36) return 36
                if (val > 60) return 60
                return val
            },
            write_attach: [0x1f9, 0x1fa],
        })

        /*
         * 0x2a3 aims the airflow sideways; it is not an oscillation setting, and this model
         * has no vertical louvre control at all. So it belongs on swing_horizontal_mode -
         * the same place RAC_056905_WW puts its left/right vane - and swing_modes is left
         * undeclared rather than misused.
         */
        this.addField(config, {
            id: 0x2a3,
            name: 'swing_horizontal_mode',
            comp: 'climate',
            read_xform: (raw) => {
                const modes2ha: Record<number, string> = {
                    1: 'focus',
                    2: 'wide',
                    3: 'left',
                    4: 'right',
                    5: 'split',
                }
                return modes2ha[raw]
            },
            write_xform: (val) => {
                const modes2clip: Record<string, number> = {
                    focus: 1,
                    wide: 2,
                    left: 3,
                    right: 4,
                    split: 5,
                }
                return modes2clip[val]
            },
        })

        /*
         * 0x1fb selects the resolution of 0x1fe: 0 => 0.5 C, 1 => 1 C. It is exposed as the
         * climate component's temp_step rather than as an entity of its own, so autoreg is
         * off and the read callback suppresses the (topic-less) publish.
         *
         * Not writable: the LG app always writes it paired with 0x1fc, whose meaning is
         * unknown and which this appliance never reports, so write_attach could not fill
         * it in from raw_clip_state.
         */
        this.addField(
            config,
            {
                id: 0x1fb,
                name: 'temp_step',
                comp: 'climate',
                writable: false,
                read_callback: (raw) => {
                    this.updateTempStep(Number(raw))
                    return false
                },
            },
            false,
        )

        /*
         * None of these switches is declared optimistic, unlike RAC_056905_WW's. RAC needs
         * it because its write_callback can silently drop a write that the appliance would
         * reject in the current mode; here every write goes out unconditionally and the
         * appliance echoes the resulting value back, so letting the real state win is both
         * simpler and more honest.
         */
        this.addSwitchField(config, 0x236, 'jet', 'Jet cool', 'mdi:wind-power')
        this.addSwitchField(config, 0x29d, 'quiet', 'Quiet mode', 'mdi:volume-off')
        this.addSwitchField(config, 0x2a2, 'uvnano', 'UVnano', 'mdi:bacteria')
        this.addSwitchField(config, 0x1be, 'spacefit', 'Space-fit wind', 'mdi:arrow-expand-horizontal')
        this.addSwitchField(config, 0x20f, 'airclean', 'Air purify', 'mdi:air-purifier')
        this.addSwitchField(config, 0x3a9, 'childlock', 'Child lock', 'mdi:lock')
        /* the appliance mirrors this into 0x25e, which needs no entity of its own */
        this.addSwitchField(config, 0x23e, 'smartcare', 'Smart care', 'mdi:auto-fix')
        /* AI dry enable is 0 / 255 rather than the usual 0 / 1 */
        this.addSwitchField(config, 0x20e, 'aidry', 'AI dry', 'mdi:hair-dryer', { onValue: 255 })

        /*
         * INVERTED polarity, same as the wall unit RAC_056905_WW: the appliance stores
         * 1 = display off / muted. Confirmed by the operator-annotated capture, where
         * "제품 화면 OFF" produced 0x21f = 1 and "제품 소리 OFF" produced 0x3a0 = 1.
         */
        this.addSwitchField(config, 0x21f, 'display', 'Display Light', 'mdi:television-ambient-light', {
            onValue: 0,
            offValue: 1,
        })
        this.addSwitchField(config, 0x3a0, 'beep', 'Product beep', 'mdi:volume-high', { onValue: 0, offValue: 1 })

        /*
         * The cleaning cycles are start/stop pairs with a readable running state, so they
         * are switches rather than buttons. Both drive other fields (power, fan, wind
         * direction, smart care) by themselves while they run.
         *
         * 0x3a2 reads back 1 while the heat exchanger clean runs and 255 while the all
         * clean cycle runs, hence the exact comparison rather than a truthiness test.
         *
         * They are diagnostic rather than config: these are occasional maintenance cycles,
         * not settings, and they do not belong next to the everyday controls.
         */
        this.addSwitchField(config, 0x3a2, 'hxclean', 'Heat exchanger clean', 'mdi:heating-coil', {
            entityCategory: 'diagnostic',
        })
        this.addSwitchField(config, 0x165, 'allclean', 'All clean', 'mdi:spray-bottle', {
            onValue: 100,
            readOnValue: 2,
            entityCategory: 'diagnostic',
        })

        this.addSelectField(config, 0x2a8, 'onesidewind', 'One-side wind', 'mdi:arrow-left-right', [
            'off',
            'left',
            'right',
        ])
        /* raw 2 .. 6 are the appliance's 1단 .. 5단 */
        this.addSelectField(
            config,
            0x1f2,
            'aidrylevel',
            'AI dry level',
            'mdi:hair-dryer-outline',
            ['1', '2', '3', '4', '5'],
            2,
        )
        /*
         * Read-only. Every other writable tag in this profile has a captured LG-app TLV
         * write behind it; 0x337 has none. The app does change this setting, but over the
         * private command channel rather than by TLV: the capture has it send private
         * command 0x0c (cmd_sub 0x01, 4-byte payload 0 or 1), after which the appliance
         * reports the new 0x337 in a state frame. A TLV write of 0x337 is therefore
         * unattested, and making this a writable select would mean building a private
         * channel write path, so it stays read-only. It is a sensor rather than a read-only
         * select because HA's MQTT select requires a command topic.
         */
        /*
         * 0x336 is the indoor relative humidity and 0x337 is the appliance's on-panel
         * display option for it - they are a value/display pair, hence declared together.
         *
         * 0x336 is a plain integer percentage, no scaling. Confirmed over 30 samples
         * spanning 55 .. 70: it falls while cooling (62 -> 60) and while AI-dry runs
         * (67 -> 63), and rises during air-clean (60 -> 70).
         */
        this.addSensorField(config, 0x336, 'humidity', 'Humidity', undefined, {
            device_class: 'humidity',
            unit_of_measurement: '%',
            state_class: 'measurement',
            suggested_display_precision: 0,
            /* a room measurement, not diagnostics - override addSensorField's default */
            entity_category: undefined,
        })

        /*
         * The LG app changes this over the private command channel rather than with a TLV
         * write, so it was first exposed read-only. A TLV write was then tried against the
         * appliance and does take effect, so it is a proper select.
         */
        this.addSelectField(config, 0x337, 'humiditydisplay', 'Humidity display', 'mdi:water-percent', [
            'while running',
            'always',
        ])

        /*
         * force_update matters here: the appliance refreshes 0x2b3 less often than the
         * profile polls, so without it a Riemann sum over this sensor produces a staircase
         * rather than an energy total.
         *
         * On this model 0x2b3 is in tenths of a watt, unlike RAC_056905_WW where it is whole
         * watts. Taken raw the appliance would claim 10085 W at full load, which no single
         * indoor unit draws; a tenth of that, 1008 W, is exactly right for a stand unit.
         * The rest of the range agrees: 72 .. 251 raw while only the fan runs is 7 .. 25 W,
         * and 2556 .. 3501 raw under partial cooling load is 256 .. 350 W.
         *
         * There is no additive bias to remove. RAC applies max(5, raw - 60) because that
         * appliance never reports a true zero; this one reports exactly 0 the moment it
         * stops, so subtracting anything would be wrong.
         *
         * Note for whoever sums these across a house: the figure is this indoor unit's share
         * of the outdoor compressor and excludes the indoor fan, so the units will not add
         * up to the real total. It is for apportioning between rooms.
         */
        this.addSensorField(
            config,
            0x2b3,
            'energy_current',
            'Power',
            undefined,
            {
                device_class: 'power',
                unit_of_measurement: 'W',
                state_class: 'measurement',
                suggested_display_precision: 0,
                force_update: true,
                /* a primary measurement, not diagnostics - override addSensorField's default */
                entity_category: undefined,
            },
            (raw) => raw / 10,
        )
        this.addSensorField(config, 0x221, 'error', 'Error code', 'mdi:alert')

        /*
         * The filter counters are ordinary TLV tags on this model:
         *   0x356 is the filter's rated life in hours. Observed once, at 3000, in the
         *     comprehensive dump - the only frame in the capture that carries it.
         *   0x355 is how many of those hours are LEFT, and it counts DOWN. Observed twice:
         *     2442 in the dump, then 2441 in a one-tag change notification.
         *
         * Confirmed numerically against the appliance's own LG ThinQ app, which showed
         * 2438 h remaining and 562 h used - and 2438 + 562 = 3000 exactly. The app reading
         * is a day newer than the capture's 2442, i.e. 4 h of runtime apart, which is one
         * summer day on this appliance.
         *
         * Hours *used* is the number a filter reminder is actually built on, and no tag
         * carries it, so it is derived as 0x356 - 0x355 and published from a read callback
         * on both tags: the comprehensive dump carries the pair in one frame (0x356 first),
         * and a change notification may carry either one alone.
         */
        const filterSensorExtra = { device_class: 'duration', unit_of_measurement: 'h' }
        const publishUsed = () => {
            this.publishFilterUsed()
            /* let the primary sensor publish as usual */
            return true
        }
        this.addSensorField(
            config,
            0x356,
            'filterlife',
            'Filter life time',
            'mdi:air-filter',
            filterSensorExtra,
            undefined,
            publishUsed,
        )
        this.addSensorField(
            config,
            0x355,
            'filterremaining',
            'Filter remaining time',
            'mdi:air-filter',
            filterSensorExtra,
            undefined,
            publishUsed,
        )

        /* Derived, so it has no tag and therefore no field - see publishFilterUsed(). */
        const filterUsed = {
            platform: 'sensor',
            unique_id: '$deviceid-filterused',
            state_topic: '$this/filterused',
            name: 'Filter used time',
            icon: 'mdi:air-filter',
            device_class: 'duration',
            unit_of_measurement: 'h',
            state_class: 'total_increasing',
            entity_category: 'diagnostic',
        }
        config['components']['filterused'] = filterUsed

        /*
         * Resetting the filter counter is a plain TLV write of 0 to 0x355; the appliance
         * answers by reporting 0x355 = 0x356, i.e. a full life again. Captured from the LG
         * app doing exactly this:
         *
         *   TX 0101040000006502010002d540769d   0x355 = 0
         *   rx 0201040000008701100000ec3c       acknowledgement
         *   rx 000004000000a70204c606d5600bb8…  0x355 = 3000
         *
         * An earlier version of this profile drove the reset over the private command
         * channel, copied from RAC_056905_WW. That was wrong - the private channel's
         * counter is a different one - and it is why the button was withdrawn for a
         * release. The unique_id is unchanged, so installations that saw the withdrawn
         * button get this one wired up in its place rather than a second entity.
         *
         * It goes through fields_by_ha directly rather than addField, because addField
         * would take over fields_by_id[0x355] and break the filterremaining sensor. The
         * write_callback sends the frame itself and returns false so the default path does
         * not also stamp 0 into raw_clip_state - the appliance's own reply is what should
         * update the sensors.
         */
        const filterReset = {
            platform: 'button',
            unique_id: '$deviceid-filterreset',
            command_topic: '$this/filterreset/set',
            name: 'Reset filter usage',
            icon: 'mdi:air-filter',
            entity_category: 'diagnostic',
        }
        config['components']['filterreset'] = filterReset
        this.fields_by_ha['filterreset'] = {
            name: '',
            comp: '',
            write_xform: (val) => (val === 'PRESS' ? 0 : null),
            write_callback: () => {
                log('status', this.id, 'resetting the filter counter')
                this.send([1, 1, 2, 1, 1], [{ t: 0x355, v: 0 }])
                return false
            },
        }

        /*
         * MIGRATION. The previous version published a 'changeddate' component - the private
         * channel's filter-changed date - that no longer exists. It was really created, and
         * dropping it from the payload does NOT remove it, it only stops updating it.
         *
         * HA removes a component when the payload carries its key with the platform and
         * NOTHING else: mqtt/discovery.py pops the platform and treats what is left, if it
         * is empty, as a removal. Adding unique_id - or any other key - silently turns the
         * removal back into a registration, so do not "fix" the cast by filling it in.
         *
         * Safe to delete once every installation has run this version once.
         */
        config['components']['changeddate'] = { platform: 'sensor' } as ComponentInfo

        /*
         * Vertical swing genuinely does not exist on this model - it has no such control,
         * so there is no analogue of RAC's 0x321 / 0x322.
         *
         * Refrigerant / ODU telemetry (0x2f9, 0x2fa, 0x32c, 0x332, 0x330, 0x32e, 0x331) is
         * absent from the reference capture, but that is NOT evidence the appliance lacks
         * it: a values query (TLV 0x1f5 = 2) is never sent in the capture, and on RAC that
         * query is the only path by which those tags arrive. The same reasoning already
         * produced two wrong "not supported" conclusions on this appliance - the capability
         * response and the private command channel both turned out to answer once something
         * actually asked. Treat this as unqueried, not unsupported. (Answering is not the
         * same as answering usefully: see the filter note below.)
         *
         * There is also a positive hint: the 307-byte 0xa8 records this profile ignores are
         * a fixed-offset mirror of the same state (offset 261 tracks 0x2b3 in 51 of 52
         * frames across 32 distinct values), and they contain a byte at offset 175 that
         * behaves exactly like an evaporator coil temperature - it falls as compressor
         * power ramps and recovers monotonically over 13 samples after shutdown. It is
         * deliberately NOT mapped here: there is no ground truth to calibrate it against,
         * and RAC's racPipeTemp table belongs to a different model.
         *
         * Seen in the capture but not understood, so left without entities:
         * 0x348 (mirrors 0x1f9), 0x279, 0x27a, 0x232, 0x233.
         *
         * 0x312 must never become an entity: it is the frame's own length field, matching
         * payload-minus-encoding-size in 123 of 123 frames. It is the most-observed tag in
         * the capture and therefore the most tempting false positive.
         *
         * NO PRIVATE-CHANNEL FILTER SUPPORT HERE, deliberately. This profile used to copy
         * RAC_056905_WW's filter handling - sendPrivCommand(0x02, 0x02), then decode used /
         * life / changed-date out of the reply, plus a reset button. That channel does
         * answer on this appliance: a live probe came back and RAC's decode applied
         * unmodified, yielding used = 0 h, life = 720 h, changed date = 0. Those numbers are
         * simply not this appliance's filter. Its own app reports a 3000 h part with 562 h
         * used, which is exactly what 0x356 / 0x355 above carry. What the 720 h counter
         * counts is unidentified - it is not the user-visible filter, and nothing else about
         * it is known - so it is not published, and the reset button is gone with it: its
         * target was never verified and pressing it would have written a lifetime that
         * contradicts the appliance's own display.
         */

        this.setConfig(config)
    }

    start() {
        super.start()

        // we want to be informed about all TLV changes - set an empty blacklist
        this.thinq.send('setMaskingInfo', 0, { blacklist_tlv: '1200' })
    }

    /* No drop() override: nothing here owns a timer, so TLVDevice.drop() is the whole job. */

    /*
     * Frame markers observed at buf[6] in the device -> cloud direction:
     *   0xa7  every one of the 143 state frames in the capture,
     *   0x87  both private command acknowledgements in the capture (buf[7] 0xfd, buf[8]
     *         0x10), and the one live private-channel read reply this appliance was ever
     *         probed with,
     *   0x65  both 18-byte private data responses in the capture, which answer a read of
     *         private command 0x0c and echo the request's own marker.
     *
     * The capture holds two more frames with buf[7] 0xfd and buf[8] 0x03: 190-byte ones
     * marked 0x87, carrying command 0x15 with buf[1] 0x00 rather than the 0xff a data
     * response uses. They match no branch here and none in the base class either. Nothing
     * is known about them, so they are deliberately left unhandled rather than guessed at.
     *
     * The three branches below are the base class' (tlv_device.ts processData) with the
     * marker test widened and an early return added. Each widened branch is a superset of
     * the base class' branch, so the delegation at the end only ever sees frames the base
     * class would have ignored as well; nothing is processed twice. Note that neither
     * private branch was observed with 0xa7 and neither state frame with 0x65 - both
     * markers are accepted on both channels anyway, because this appliance has already
     * demonstrated that its marker is not uniform, and a wrong-but-accepted marker can only
     * match a frame that satisfies every other structural test.
     *
     * The two private-channel branches classify frames this profile itself has no use for -
     * it sends no private commands (see the filter note in the constructor) - and hand them
     * to TLVDevice's processPrivData() / processPrivDataCmdResp() hooks, which are no-ops
     * unless a subclass overrides them. They are kept because the marker widening is the
     * only place this appliance's non-uniform framing is written down, and re-deriving it
     * would mean re-capturing the appliance.
     */
    processData(buf: Buffer) {
        /* state frame */
        if (
            buf[2] === 0x04 &&
            buf[3] === 0x00 &&
            buf[4] === 0x00 &&
            buf[5] === 0x00 &&
            (buf[6] === 0x87 || buf[6] === 0xa7) &&
            buf[7] === 0x02 &&
            (buf[8] === 0x01 || buf[8] === 0x04) &&
            buf[10] === buf.length - 13
        ) {
            this.processTLV(TLV.parse(buf.subarray(11, buf.length - 2)))
            return
        }

        /* private data response - the appliance answering a private-channel read */
        if (
            buf[1] === 0xff &&
            buf[2] === 0x04 &&
            buf[3] === 0x00 &&
            buf[4] === 0x00 &&
            buf[5] === 0x00 &&
            (buf[6] === 0x87 || buf[6] === 0x65) &&
            buf[7] === 0xfd &&
            buf[8] === 0x03 &&
            buf[10] === buf.length - 13
        ) {
            this.processPrivData(buf[0], buf[9], buf.subarray(11, buf.length - 2))
            return
        }

        /* private command acknowledgement - the appliance confirming a private-channel write */
        if (
            (buf[0] === 0x02 || buf[0] === 0x03) &&
            buf[2] === 0x04 &&
            buf[3] === 0x00 &&
            buf[4] === 0x00 &&
            buf[5] === 0x00 &&
            (buf[6] === 0x87 || buf[6] === 0x65) &&
            buf[7] === 0xfd &&
            buf[8] === 0x10 &&
            buf[9] === 0x00 &&
            buf[10] === 0x05 &&
            buf[11] === 0xfe &&
            buf[12] != null
        ) {
            this.processPrivDataCmdResp(buf[0] === 0x02, buf[1], buf[12], buf.subarray(13, buf.length - 2))
            return
        }

        super.processData(buf)
    }

    /*
     * Keep the capability reply away from the filter counters.
     *
     * TLVDevice.processTLV() dispatches every tag of every accepted frame to its field
     * before it decides whether the frame is a capability reply, and the capability reply is
     * the first frame this profile ever sees: the constructor queries for it and retries
     * every 15 s until it answers. What its 54 TLVs contain is unknown - only ten of the
     * tags were ever written down and the frame was never recorded in full - so whether
     * 0x355 / 0x356 appear in it, and with what meaning if they do, cannot be answered from
     * anything on file. The old private-channel filter code was structurally immune to this;
     * sourcing the counters from TLV tags gives that immunity up unless it is restored here.
     *
     * A capability declaration is not a reading. Dropping the pair costs nothing if the
     * reply does not carry them, and stops a declared range or default from being published
     * as the user's filter if it does. That matters most for the derived 'filterused', which
     * is state_class total_increasing: a wrong value there is not merely overwritten by the
     * next state frame, it stays in HA's long-term statistics.
     *
     * Only the two tags are stripped, not the whole frame: the same reply carries 0x2e1 /
     * 0x2e2 - the appliance's own setpoint range - and reading those out of raw_clip_state
     * is the obvious next improvement, see isCapsResponse() below.
     */
    processTLV(tlvArray: TLV.TLV[]) {
        if (this.isCapsResponse(tlvArray)) tlvArray = tlvArray.filter(({ t }) => t !== 0x355 && t !== 0x356)

        super.processTLV(tlvArray)
    }

    /*
     * Verified on real hardware. queryCaps() (TLV 0x1f5 = 1) was issued to a live
     * PAC_910604_WW and the appliance answered with a 174-byte frame carrying 54 TLVs,
     * 0x2da among them - so keying on 0x2da matches RAC_056905_WW and POT_056905_WW and is
     * correct for this model too.
     *
     * The capability reply also answers a question RAC_056905_WW leaves open. It carries
     * 0x2e1 = 36 and 0x2e2 = 60, i.e. the appliance declares its own setpoint range as
     * 18.0 .. 30.0 C - exactly the range measured from the remote, and exactly what the
     * "some devices report these temp ranges via tags 0x2e1 - 0x2ec" TODO in
     * RAC_056905_WW.ts predicted. min_temp / max_temp above are hardcoded to those values
     * rather than read from capabilities, because doing it properly means rebuilding the
     * climate component after caps arrive and belongs in a change that fixes it for every
     * AC profile, not just this one.
     *
     * The reply further declares the supported modes as three 0x2d7 entries valued 0, 1
     * and 5 - cool, dry and air-clean/fan - independently confirming the mode table above,
     * which was derived by pressing buttons on the remote.
     */
    isCapsResponse(tlvArray: TLV.TLV[]) {
        /* eeprom checksum */
        return tlvArray.some(({ t }) => t === 0x2da)
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        /* power - present in the appliance's 94-tag comprehensive state dump */
        return tlvArray.length >= 10 && tlvArray.some(({ t }) => t === 0x1f7)
    }

    /* 0x1fb: 0 => 0.5 C, 1 => 1 C. Republish the discovery config when it changes. */
    updateTempStep(raw: number) {
        const step = raw === 1 ? 1 : 0.5
        const climate = this.deviceConfig.components.climate
        if (climate.temp_step === step) return

        log('status', this.id, 'temperature step changed to', step)
        climate.temp_step = step
        climate.precision = step
        this.setConfig(this.deviceConfig)
    }

    /*
     * 'used' has no tag of its own: it is 0x356 (rated life) minus 0x355 (hours left), and
     * both read callbacks call this because either tag can arrive first - the comprehensive
     * dump orders 0x356 before 0x355, but a change notification may carry 0x355 alone.
     *
     * Nothing is published until both are known, so a lone 0x355 cannot briefly publish a
     * value derived from a missing life. A negative result would mean the pair disagrees,
     * for which there is no precedent in the two samples on file - 0x356 seen once at 3000,
     * 0x355 seen at 2442 and then 2441 - so it is dropped rather than shown as a nonsensical
     * filter reading.
     *
     * Dropping is not clearing: publishProperty retains, so whatever was published last
     * stays live in the broker and HA goes on showing it, next to a 'filterlife' and
     * 'filterremaining' that did publish. That is what the log line is for - a reading that
     * silently stops tracking is how a wrong filter number survives unnoticed. It still
     * beats the alternative: clamping to 0 would read as "brand-new filter", which is
     * actively misleading rather than merely stale.
     */
    publishFilterUsed() {
        const life = this.raw_clip_state[0x356]
        const remaining = this.raw_clip_state[0x355]
        if (life === undefined || remaining === undefined) return

        const used = life - remaining
        if (used < 0) {
            log('status', this.id, 'filter counters disagree, not publishing used:', life, remaining)
            return
        }

        this.HA.publishProperty(this.id, 'filterused', used)
    }

    addSwitchField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        options: SwitchOptions = {},
    ) {
        const onValue = options.onValue ?? 1
        const offValue = options.offValue ?? 0
        const readOnValue = options.readOnValue ?? onValue

        const comp = {
            platform: 'switch',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            entity_category: options.entityCategory ?? 'config',
        }
        config['components'][name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            write_xform: (val) => (val === 'ON' ? onValue : offValue),
            read_xform: (raw) => (raw === readOnValue ? 'ON' : 'OFF'),
        })
    }

    /* `options[raw - rawBase]` names each raw value; a raw value outside the list is discarded */
    addSelectField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        options: string[],
        rawBase: number = 0,
    ) {
        const comp = {
            platform: 'select',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            entity_category: 'config',
            options: options,
        }
        config['components'][name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            read_xform: (raw) => options[raw - rawBase],
            write_xform: (val) => {
                const index = options.indexOf(val)
                /* null cancels the write rather than sending a bogus value */
                if (index < 0) return null
                return index + rawBase
            },
        })
    }

    addSensorField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon?: string,
        extra?: Record<string, unknown>,
        read_xform?: FieldDefinition['read_xform'],
        /* must return true, or this sensor stops publishing - see FieldDefinition */
        read_callback?: FieldDefinition['read_callback'],
    ) {
        const comp = {
            icon: icon ?? undefined,
            platform: 'sensor',
            unique_id: '$deviceid-' + name,
            name: desc,
            entity_category: 'diagnostic',
            ...extra,
        }
        config['components'][name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            writable: false,
            read_xform: read_xform,
            read_callback: read_callback,
        })
    }
}
