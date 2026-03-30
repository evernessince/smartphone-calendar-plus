/**
 * smartphone-calendaria — Main Entry Point
 *
 * Integrates Calendaria with Smartphone Widget:
 *  1. Patches SmartphoneTime (now, getDateObject, getCalendarConfig) to read from Calendaria.
 *  2. Bridges time-change hooks to directly update the phone's clock display.
 *  3. Syncs Calendaria weather → phone weather-data setting (debounced).
 *  4. Resets the Calendaria stopwatch if stuck running on load.
 *  5. Registers CalendariaPhoneApp as the "calendar" app (replaces built-in).
 *
 * @module calendaria-phone-app
 */

import { CalendariaPhoneApp } from './CalendariaPhoneApp.mjs';

const MODULE_ID = 'calendaria-phone-app';

/* ================================================================== */
/*  Widget instance helper (cached)                                    */
/* ================================================================== */

let _SW = null;
let _cachedInstance = null;

/**
 * Get the SmartphoneWidget WidgetManager instance.
 * Caches the class reference and the resolved instance.
 * @returns {Promise<object|null>}
 */
async function getWidgetInstance() {
    if (!_SW) {
        try {
            const mod = await import('/modules/smartphone-widget/scripts/smartphone-widget.js');
            _SW = mod.SmartphoneWidget;
        } catch (e) {
            console.warn(`${MODULE_ID} | Cannot import SmartphoneWidget:`, e);
            return null;
        }
    }
    try {
        _cachedInstance = await _SW.getInstance();
        return _cachedInstance;
    } catch {
        return _cachedInstance; // Return stale if getInstance fails
    }
}

/* ================================================================== */
/*  Debounce utility                                                   */
/* ================================================================== */

/**
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function}
 */
function debounce(fn, ms) {
    let timer = null;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
    };
}

/* ================================================================== */
/*  App registration (setup hook)                                      */
/* ================================================================== */

Hooks.once('setup', () => {
    const swApi = game.modules.get('smartphone-widget')?.api;
    if (!swApi) {
        console.error(`${MODULE_ID} | smartphone-widget module not found.`);
        return;
    }

    swApi.registerApp({
        id: 'calendar',
        name: game.i18n.localize('SMCAL.appName'),
        icon: 'fas fa-calendar-alt',
        color: '#3b82f6',
        category: 'utility',
        appClass: CalendariaPhoneApp,
        defaultInstalled: true
    });

    console.log(`${MODULE_ID} | Calendaria calendar app registered.`);
});

/* ================================================================== */
/*  Main initialization (ready hook)                                   */
/* ================================================================== */

Hooks.once('ready', async () => {
    if (typeof CALENDARIA === 'undefined' || !CALENDARIA?.api) {
        console.error(`${MODULE_ID} | Calendaria not found, skipping patches.`);
        return;
    }

    const cApi = CALENDARIA.api;

    // ==================================================================
    //  1. RESET STUCK STOPWATCH
    // ==================================================================
    if (game.user.isGM) {
        try {
            const state = game.settings.get('calendaria', 'stopwatchState');
            if (state?.running) {
                await game.settings.set('calendaria', 'stopwatchState', {
                    running: false,
                    mode: state.mode ?? 'gametime',
                    elapsedMs: 0,
                    elapsedGameSeconds: 0,
                    savedAt: 0,
                    savedWorldTime: 0,
                    laps: [],
                    notification: null,
                    notificationThreshold: null,
                    notificationFired: false
                });
                try { cApi.hideStopwatch(); } catch { /* may not be rendered yet */ }
                console.log(`${MODULE_ID} | Stopwatch state force-reset.`);
            }
        } catch (e) {
            console.warn(`${MODULE_ID} | Could not reset stopwatch:`, e);
        }
    }

    // ==================================================================
    //  2. PATCH SmartphoneTime
    // ==================================================================
    try {
        const mod = await import('/modules/smartphone-widget/scripts/core/SmartphoneTime.js');
        const ST = mod.SmartphoneTime;

        // ---- Patch now() ----
        const originalNow = ST.now.bind(ST);
        ST.now = function () {
            if (typeof CALENDARIA !== 'undefined' && CALENDARIA?.api) {
                return game.time.worldTime * 1000;
            }
            return originalNow();
        };

        // ---- Patch getDateObject() ----
        const originalGetDateObject = ST.getDateObject.bind(ST);
        ST.getDateObject = function (timestamp) {
            if (typeof CALENDARIA === 'undefined' || !CALENDARIA?.api) {
                return originalGetDateObject(timestamp);
            }
            try {
                const api = CALENDARIA.api;
                const worldTimeMs = game.time.worldTime * 1000;
                let dt;
                if (typeof timestamp !== 'number' || Math.abs(timestamp - worldTimeMs) < 1000) {
                    dt = api.getCurrentDateTime();
                } else {
                    dt = api.timestampToDate(timestamp / 1000);
                }
                if (dt) {
                    let weekday = dt.weekday;
                    if (weekday == null) {
                        try { weekday = api.dayOfWeek({ year: dt.year, month: dt.month, day: dt.day }); }
                        catch { weekday = 0; }
                    }
                    return {
                        year:    dt.year,
                        month:   dt.month,
                        day:     dt.day,
                        hour:    dt.hour   ?? 0,
                        minute:  dt.minute ?? 0,
                        second:  dt.second ?? 0,
                        weekday: weekday ?? 0
                    };
                }
            } catch (e) {
                console.error(`${MODULE_ID} | getDateObject patch error:`, e);
            }
            return originalGetDateObject(timestamp);
        };

        // ---- Patch getCalendarConfig() ----
        const originalGetCalendarConfig = ST.getCalendarConfig?.bind(ST);
        ST.getCalendarConfig = function () {
            if (typeof CALENDARIA !== 'undefined' && CALENDARIA?.api) {
                try {
                    const cal = CALENDARIA.api.getActiveCalendar();
                    const monthsRaw = cal.months?.values ?? {};
                    const daysRaw = cal.days?.values ?? {};
                    const months = Object.values(monthsRaw)
                        .sort((a, b) => a.ordinal - b.ordinal)
                        .map(m => ({
                            name: m.name,
                            abbreviation: m.abbreviation,
                            days: m.days,
                            leapDays: m.leapDays ?? null
                        }));
                    const weekdays = Object.values(daysRaw)
                        .sort((a, b) => a.ordinal - b.ordinal)
                        .map(d => ({
                            name: d.name,
                            abbreviation: d.abbreviation
                        }));
                    return { months, weekdays };
                } catch (e) {
                    console.error(`${MODULE_ID} | getCalendarConfig patch error:`, e);
                }
            }
            return originalGetCalendarConfig ? originalGetCalendarConfig() : { months: [], weekdays: [] };
        };

        console.log(`${MODULE_ID} | SmartphoneTime patched.`);
    } catch (err) {
        console.error(`${MODULE_ID} | Failed to patch SmartphoneTime:`, err);
    }

    // ==================================================================
    //  3. REALTIME CLOCK + CALENDAR UPDATES
    // ==================================================================
    try {
        /**
         * Synchronously refresh the phone clock and calendar app.
         * Wrapped to be safe for hook registration (no unhandled promise rejections).
         */
        function refreshPhoneTime() {
            getWidgetInstance().then(inst => {
                if (!inst) return;
                // Update status bar clock
                if (inst._clock) {
                    try { inst._clock.updateClockDisplay(); } catch { /* */ }
                    try { inst._clock.handleTimeUpdate(); } catch { /* */ }
                }
            }).catch(() => { /* widget not available */ });
        }

        // Bridge Calendaria and core time hooks → phone clock
        Hooks.on(cApi.hooks.DATE_TIME_CHANGE, refreshPhoneTime);
        Hooks.on('updateWorldTime', refreshPhoneTime);

        // Also fire the SmartphoneTime hook for any other listeners
        const stMod = await import('/modules/smartphone-widget/scripts/core/SmartphoneTime.js');
        const hookName = stMod.SmartphoneTime.HOOK_NAME;
        if (hookName) {
            Hooks.on(cApi.hooks.DATE_TIME_CHANGE, () => Hooks.callAll(hookName));
            Hooks.on('updateWorldTime', () => Hooks.callAll(hookName));
        }

        // When Calendaria finishes initializing, force-refresh everything
        Hooks.on(cApi.hooks.READY, () => {
            refreshPhoneTime();
            getWidgetInstance().then(inst => {
                if (!inst) return;
                const calApp = inst.apps?.get('calendar');
                if (calApp) {
                    calApp._initialized = false;
                    if (inst.currentApp === 'calendar') calApp.render();
                }
            }).catch(() => {});
        });

        console.log(`${MODULE_ID} | Realtime clock bridge active.`);
    } catch (err) {
        console.error(`${MODULE_ID} | Failed to set up clock bridge:`, err);
    }

    // ==================================================================
    //  4. WEATHER SYNC: Calendaria → Phone weather-data (debounced)
    // ==================================================================
    try {
        /**
         * Calendaria wind speed is an integer 0-5:
         *   0 = calm, 1 = light, 2 = moderate, 3 = strong, 4 = severe, 5 = extreme
         *
         * Mapped to approximate m/s values (the phone UI displays "m/s"):
         *   0 →  0-1  m/s  (midpoint 1)   — calm, smoke rises vertically
         *   1 →  2-5  m/s  (midpoint 3)   — light breeze, leaves rustle
         *   2 →  6-11 m/s  (midpoint 8)   — moderate, small branches move
         *   3 → 12-17 m/s  (midpoint 14)  — strong/windy, whole trees sway
         *   4 → 18-32 m/s  (midpoint 25)  — severe, structural damage possible
         *   5 → 33+   m/s  (midpoint 40)  — extreme (hurricane/tornado force)
         */
        const WIND_MS = Object.freeze([1, 3, 8, 14, 25, 40]);

        /**
         * Convert Calendaria's integer wind speed (0-5) to m/s for display.
         * @param {number} level - 0-5 wind level
         * @returns {number} Wind speed in m/s
         */
        function convertWindSpeed(level) {
            const idx = Math.max(0, Math.min(5, level ?? 0));
            return WIND_MS[idx];
        }

        /**
         * Base humidity by climate zone (annual average %).
         * Sources: general climatology ranges for each biome.
         *
         * Climate zones from Calendaria: arctic, subarctic, temperate,
         * subtropical, tropical, arid, polar
         */
        const ZONE_BASE_HUMIDITY = Object.freeze({
            tropical:    80,
            subtropical: 70,
            temperate:   60,
            subarctic:   55,
            arctic:      50,
            polar:       45,
            arid:        20,
        });

        /**
         * Seasonal humidity modifier (additive %).
         * Seasons from Calendaria: spring, summer, autumn/fall, winter
         */
        const SEASON_HUMIDITY_MOD = Object.freeze({
            spring:  +5,
            summer:  -5,
            autumn:  +5,
            fall:    +5,
            winter:  +0,
        });

        /**
         * Precipitation type humidity boost (additive %).
         * More intense / wetter precip types push humidity higher.
         */
        const PRECIP_HUMIDITY_BOOST = Object.freeze({
            none:        0,
            drizzle:    10,
            rain:       20,
            downpour:   30,
            thunderstorm: 25,
            sleet:      15,
            snow:       10,
            hail:       15,
            blizzard:   20,
            fog:        25,
            mist:       20,
        });

        /**
         * Estimate humidity from climate zone, season, precipitation, and
         * weather intensity. Clamps to 5-99%.
         *
         * @param {object} params
         * @param {string} params.zone       - Climate zone id (e.g. "temperate")
         * @param {string} params.seasonType - Season type (e.g. "spring")
         * @param {string} params.precipType - Precipitation type (e.g. "drizzle")
         * @param {number} params.precipIntensity - 0-1 precipitation intensity
         * @param {number} params.windLevel   - 0-5 wind speed level
         * @param {number} params.tempC       - Temperature in Celsius
         * @returns {number} Estimated humidity percentage (5-99)
         */
        function estimateHumidity({ zone, seasonType, precipType, precipIntensity, windLevel, tempC }) {
            // Start with base humidity from climate zone
            let h = ZONE_BASE_HUMIDITY[zone] ?? ZONE_BASE_HUMIDITY.temperate;

            // Seasonal modifier
            const seasonKey = (seasonType || '').toLowerCase();
            h += SEASON_HUMIDITY_MOD[seasonKey] ?? 0;

            // Precipitation type boost
            const pType = (precipType || 'none').toLowerCase();
            h += PRECIP_HUMIDITY_BOOST[pType] ?? 0;

            // Precipitation intensity scaling (0-1 → 0-15% additional)
            h += Math.round((precipIntensity ?? 0) * 15);

            // High wind reduces humidity slightly (evaporative effect)
            if (windLevel >= 3) h -= 5;
            if (windLevel >= 5) h -= 5;

            // Extreme temperatures push humidity to edges
            // Very hot + dry zone → lower; cold → slightly higher (relative)
            if (tempC > 35 && zone === 'arid') h -= 10;
            if (tempC < -10) h += 5;

            // Clamp to realistic range
            return Math.max(5, Math.min(99, Math.round(h)));
        }

        /** Previous weather hash — only write to settings when something changed. */
        let _lastWeatherHash = '';

        /**
         * Map Calendaria weather → phone weather-data format.
         * Only the GM writes settings; all clients read.
         */
        function _syncWeatherImpl() {
            if (!game.user.isGM) return;
            try {
                const cw = cApi.getCurrentWeather();
                if (!cw) return;

                const tempC = cw.temperature ?? 0;
                const unit = game.settings.get('smartphone-widget', 'weatherUnit') || 'F';
                const temp = unit === 'F' ? Math.round(tempC * 9 / 5 + 32) : tempC;

                // High/low — ±4°C spread, converted to user's unit
                const highC = tempC + 4, lowC = tempC - 4;
                const high = unit === 'F' ? Math.round(highC * 9 / 5 + 32) : highC;
                const low = unit === 'F' ? Math.round(lowC * 9 / 5 + 32) : lowC;

                // Localize the weather label
                const condition = game.i18n.localize(cw.label) || cw.id || 'Unknown';

                // Normalize icon: "fa-sun" → "fas fa-sun"
                let icon = 'fas fa-cloud';
                if (cw.icon) {
                    icon = /^fa[srlbd] /.test(cw.icon) ? cw.icon : `fas ${cw.icon}`;
                }

                // Wind — convert 0-5 integer to display speed
                const windLevel = cw.wind?.speed ?? 0;
                const windSpeed = convertWindSpeed(windLevel);

                // Precipitation — convert intensity 0-1 to percentage
                const precipIntensity = cw.precipitation?.intensity ?? 0;
                const precip = Math.round(precipIntensity * 100);

                // Climate zone from active calendar's weather config
                let zone = 'temperate';
                try {
                    zone = cApi.getActiveCalendar()?.weather?.activeZone || 'temperate';
                } catch { /* use default */ }

                // Season
                let seasonType = '';
                try {
                    seasonType = cApi.getCurrentSeason()?.seasonalType || '';
                } catch { /* use default */ }

                // Humidity — estimated from climate, season, precipitation, wind, temp
                const humidity = estimateHumidity({
                    zone,
                    seasonType,
                    precipType: cw.precipitation?.type ?? 'none',
                    precipIntensity,
                    windLevel,
                    tempC
                });

                const isNight = !cApi.isDaytime();
                const location = game.scenes.active?.name || '';

                // Build data and check if anything changed
                const weatherData = {
                    temp, condition, isNight, icon, location,
                    high, low, humidity, wind: windSpeed, precip,
                    source: 'calendaria'
                };

                const hash = JSON.stringify(weatherData);
                if (hash === _lastWeatherHash) return; // No change
                _lastWeatherHash = hash;

                game.settings.set('smartphone-widget', 'weather-data', weatherData);
            } catch (e) {
                console.error(`${MODULE_ID} | Weather sync error:`, e);
            }
        }

        // Debounce weather sync — prevent flooding settings on rapid time ticks
        const syncWeather = debounce(_syncWeatherImpl, 500);

        // Sync on startup (immediate, not debounced)
        _syncWeatherImpl();

        // Sync on relevant Calendaria events
        Hooks.on(cApi.hooks.WEATHER_CHANGE, syncWeather);
        Hooks.on(cApi.hooks.DATE_TIME_CHANGE, syncWeather);
        Hooks.on(cApi.hooks.SUNRISE, syncWeather);
        Hooks.on(cApi.hooks.SUNSET, syncWeather);

        console.log(`${MODULE_ID} | Weather sync active.`);
    } catch (err) {
        console.error(`${MODULE_ID} | Failed to set up weather sync:`, err);
    }

    // ==================================================================
    //  5. LOCK WEATHER SOURCE
    // ==================================================================
    try {
        if (game.user.isGM) {
            const currentWeather = game.settings.get('smartphone-widget', 'weather-data') || {};
            if (currentWeather.source !== 'calendaria') {
                currentWeather.source = 'calendaria';
                await game.settings.set('smartphone-widget', 'weather-data', currentWeather);
            }
        }
        console.log(`${MODULE_ID} | Weather source locked to Calendaria.`);
    } catch (err) {
        console.error(`${MODULE_ID} | Failed to lock weather source:`, err);
    }

    // ==================================================================
    //  6. PATCH WeatherApp: wind in mph + proper "feels like" temperature
    // ==================================================================
    try {
        const weatherMod = await import('/modules/smartphone-widget/scripts/apps/WeatherApp.js');
        const WA = weatherMod.WeatherApp;

        if (WA?.prototype?.render) {
            const originalRender = WA.prototype.render;

            /**
             * Convert m/s to mph.
             * @param {number} ms - Speed in m/s
             * @returns {number} Speed in mph (rounded)
             */
            function msToMph(ms) {
                return Math.round((ms ?? 0) * 2.237);
            }

            /**
             * Calculate "feels like" temperature using standard meteorological formulas.
             *
             * Uses NWS Wind Chill (when cold + windy) and Rothfusz Heat Index
             * (when hot + humid), with smooth transitions between regimes.
             *
             * @param {number} tempF    - Air temperature in °F
             * @param {number} windMph  - Wind speed in mph
             * @param {number} humidity - Relative humidity (0-100)
             * @returns {number} Feels-like temperature in °F (rounded)
             */
            function calcFeelsLikeF(tempF, windMph, humidity) {
                // Wind Chill: applies when temp ≤ 50°F and wind > 3 mph
                // NWS Wind Chill formula
                if (tempF <= 50 && windMph > 3) {
                    const wc = 35.74
                        + 0.6215 * tempF
                        - 35.75 * Math.pow(windMph, 0.16)
                        + 0.4275 * tempF * Math.pow(windMph, 0.16);
                    return Math.round(Math.min(wc, tempF));
                }

                // Heat Index: applies when temp ≥ 80°F and humidity ≥ 40%
                // Rothfusz regression equation
                if (tempF >= 80 && humidity >= 40) {
                    const T = tempF, R = humidity;
                    let hi = -42.379
                        + 2.04901523 * T
                        + 10.14333127 * R
                        - 0.22475541 * T * R
                        - 0.00683783 * T * T
                        - 0.05481717 * R * R
                        + 0.00122874 * T * T * R
                        + 0.00085282 * T * R * R
                        - 0.00000199 * T * T * R * R;

                    // Low humidity adjustment
                    if (R < 13 && T >= 80 && T <= 112) {
                        hi -= ((13 - R) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
                    }
                    // High humidity adjustment
                    if (R > 85 && T >= 80 && T <= 87) {
                        hi += ((R - 85) / 10) * ((87 - T) / 5);
                    }

                    return Math.round(Math.max(hi, tempF));
                }

                // Mild range (50-80°F) — combined wind cooling + humidity warming
                //
                // Wind cooling: scales linearly with wind speed, tapers to zero
                // at 90°F. At 70°F + 56 mph ≈ 5°F drop. At 55°F + 56 mph ≈ 8°F.
                // Uses max() to ensure the taper factor doesn't go negative.
                //
                // Humidity warming: above 65°F, high humidity makes it feel
                // warmer (mugginess). Scales with both humidity and temp.
                let feels = tempF;

                // Wind cooling — effective from below 90°F when wind > 3 mph
                if (windMph > 3) {
                    const taper = Math.max(0, (90 - tempF) / 40); // 1.0 at 50°F, 0.25 at 80°F, 0 at 90°F
                    const windCooling = windMph * 0.15 * taper;
                    feels -= windCooling;
                }

                // Humidity warming — muggy conditions above 65°F
                if (humidity > 50 && tempF > 65) {
                    const humidityExcess = (humidity - 50) / 50; // 0-1 scale
                    const tempFactor = (tempF - 65) / 15;        // 0 at 65°F, 1 at 80°F
                    const humidityWarming = humidityExcess * tempFactor * 4; // up to ~4°F
                    feels += humidityWarming;
                }

                return Math.round(feels);
            }

            /**
             * Convert °C to °F.
             */
            function cToF(c) { return c * 9 / 5 + 32; }
            function fToC(f) { return (f - 32) * 5 / 9; }

            WA.prototype.render = async function () {
                // Call original render first to populate this.data and all DOM
                await originalRender.call(this);

                // Now patch the rendered DOM in-place
                if (!this.element) return;

                const currentUnit = game.settings.get('smartphone-widget', 'weatherUnit') || 'C';
                const windMs = this.data?.wind ?? 0;
                const windMph = msToMph(windMs);
                const tempRaw = this.data?.temp;
                const humidity = this.data?.humidity ?? 50;

                // --- Patch wind display: m/s → mph ---
                const windValueEl = this.element.querySelector('.weather-grid .grid-item:nth-child(2) .value');
                if (windValueEl) {
                    windValueEl.textContent = `${windMph} mph`;
                }

                // --- Patch "feels like" display ---
                const feelsEl = this.element.querySelector('.weather-grid .grid-item:nth-child(4) .value');
                if (feelsEl && tempRaw != null) {
                    // Convert temp to °F for formula regardless of display unit
                    const tempF = currentUnit === 'F' ? tempRaw : cToF(tempRaw);
                    const feelsF = calcFeelsLikeF(tempF, windMph, humidity);

                    // Convert back to display unit
                    const feelsDisplay = currentUnit === 'F'
                        ? feelsF
                        : Math.round(fToC(feelsF));

                    feelsEl.textContent = `${feelsDisplay}°`;
                }
            };

            console.log(`${MODULE_ID} | WeatherApp patched (wind mph + feels-like).`);
        }
    } catch (err) {
        console.error(`${MODULE_ID} | Failed to patch WeatherApp:`, err);
    }
});
