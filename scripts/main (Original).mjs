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

                // Wind & precipitation
                const windSpeed = cw.wind?.speed ?? 0;
                const precipRaw = cw.precipitation?.intensity ?? 0;
                const precip = Math.round(precipRaw * 100);

                // Humidity — derived from precipitation intensity and season
                let humidity = 50;
                const season = (cw.season || '').toLowerCase();
                if (precipRaw > 0.5) humidity = 85;
                else if (precipRaw > 0.2) humidity = 70;
                else if (precipRaw > 0) humidity = 60;
                else if (season.includes('summer')) humidity = 40;
                else if (season.includes('winter')) humidity = 65;

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
});
