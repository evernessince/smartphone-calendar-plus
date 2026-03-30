# Smartphone Widget – Calendaria Integration

A Foundry VTT v13 module that fully integrates [Calendaria](https://github.com/Sayshal/Calendaria) with the [Smartphone Widget](https://foundryvtt.com/packages/smartphone-widget), replacing the built-in calendar app and syncing time, weather, and notes between the two systems.

## Requirements

- **Foundry VTT** v13+
- **Smartphone Widget** module (active)
- **Calendaria** module (active)

## Installation

1. Download or clone this repository into your Foundry `Data/modules/` directory.
2. The folder name **must** be `calendaria-phone-app` (matching the module ID).
3. Enable the module in your world's Module Management screen.

```
Data/modules/calendaria-phone-app/
├── module.json
├── lang/
│   └── en.json
└── scripts/
    ├── main.mjs
    └── CalendariaPhoneApp.mjs
```

## Features

### Calendar App Replacement

The module registers a new calendar app under the same `"calendar"` ID used by the built-in Smartphone Widget calendar, fully replacing it. The new app is powered entirely by Calendaria's API.

- **Monthly grid view** with day cells, weekday headers, and month/year navigation — all pulled from Calendaria's active calendar configuration (supports any calendar system, not just Gregorian).
- **Today button** jumps back to the current in-world date.
- **Date picker** overlay for quick year/month selection.
- **Event dot indicators** on days that have Calendaria notes.
- **Selected day detail panel** showing all visible notes for that date.

### Full Calendaria Notes Integration

Notes are read, created, and deleted through Calendaria's journal-based notes system — not a separate settings store. Everything stays in sync with Calendaria's BigCal, MiniCal, and HUD.

- **View notes** for any date with title, time, color, and icon.
- **Create notes** from the phone with title, time (or all-day), memo, color, category, and GM-only toggle.
- **Delete notes** with a confirmation dialog (uses Foundry's `Dialog.confirm`).
- **Open notes in Calendaria** via a quick-link button that launches Calendaria's native note editor.
- **GM-only note filtering** — notes marked as GM-only in Calendaria are never shown to players, either in the day detail view or as dot indicators on the grid. The "GM Only" checkbox in the create form only appears for GMs.
- **Realtime note sync** — creating, editing, or deleting a note in Calendaria immediately updates the phone's calendar view via `calendaria.noteCreated`, `calendaria.noteDeleted`, and `calendaria.noteUpdated` hooks.
- **Category support** — the create form shows all categories defined in Calendaria (Holiday, Quest, Session, Combat, etc.) as a dropdown.

### GM Time Controls

When logged in as GM, the calendar app shows collapsible control panels:

- **Time-of-day shortcuts** — Morning, Midday, Evening, Midnight buttons that advance time to the next occurrence of that hour (uses `CALENDARIA.api.advanceTimeToPreset` with manual fallback).
- **Set date to selected** — jumps the world time to whatever date the GM has selected on the grid, preserving the current time-of-day.
- **Time manipulation** — advance or rewind by ±1 or ±5 of any unit (minutes, hours, days, months, years) via `CALENDARIA.api.advanceTime`.

### Status Bar Clock Sync

The Smartphone Widget's built-in `SmartphoneTime` class doesn't natively support Calendaria. This module monkey-patches three static methods to bridge the gap:

- **`SmartphoneTime.now()`** — returns `game.time.worldTime * 1000` (which Calendaria drives) instead of reading from the internal settings store.
- **`SmartphoneTime.getDateObject(timestamp)`** — converts timestamps via `CALENDARIA.api.getCurrentDateTime()` and `CALENDARIA.api.timestampToDate()` instead of using `game.time.calendar.timeToComponents()` (which has yearZero offset mismatches).
- **`SmartphoneTime.getCalendarConfig()`** — returns month and weekday names/abbreviations from Calendaria's active calendar.

The phone's `WidgetClock` doesn't listen to the `smartphoneTimeChanged` hook, so the module also directly calls `updateClockDisplay()` and `handleTimeUpdate()` on the widget instance whenever Calendaria fires `calendaria.dateTimeChange` or the core `updateWorldTime` hook fires. This keeps the status bar clock updating in realtime as time advances.

A `calendaria.ready` hook listener force-refreshes both the clock and the calendar app when Calendaria finishes initializing, solving the startup timing issue where the phone would show `year: 0` if our module loaded before Calendaria was ready.

### Weather Sync

Calendaria's weather system is automatically synced to the Smartphone Widget's weather app. The GM client writes to the `weather-data` setting; all clients read it.

**Data mapping:**

| Calendaria Source | Phone Field | Conversion |
|---|---|---|
| `getCurrentWeather().temperature` | `temp`, `high`, `low` | °C → °F (if unit is F). High/low estimated as ±4°C from current. |
| `getCurrentWeather().label` | `condition` | Localized via `game.i18n.localize()` — works for all Calendaria weather types including custom ones. |
| `getCurrentWeather().icon` | `icon` | Normalized from `"fa-sun"` to `"fas fa-sun"`. |
| `getCurrentWeather().wind.speed` | `wind` | Integer 0-5 converted to m/s (see Wind Speed Conversion below). |
| `getCurrentWeather().precipitation.intensity` | `precip` | 0-1 float → 0-100 percentage. |
| Climate zone + season + precipitation | `humidity` | Estimated (see Humidity Estimation below). |
| `isDaytime()` | `isNight` | Boolean inversion. |
| `game.scenes.active.name` | `location` | Active scene name. |

**Sync triggers:** `calendaria.weatherChange`, `calendaria.dateTimeChange`, `calendaria.sunrise`, `calendaria.sunset`. Debounced at 500ms to prevent flooding settings on rapid time ticks. Only writes when data has actually changed (JSON hash comparison).

The weather source is locked to `"calendaria"` on startup so the phone's native weather controls don't overwrite Calendaria data.

### Wind Speed Conversion

Calendaria uses an integer 0-5 scale. The module converts to realistic m/s values:

| Level | Label | m/s | Real-World Equivalent |
|---|---|---|---|
| 0 | Calm | 1 | Smoke rises vertically |
| 1 | Light | 3 | Leaves rustle |
| 2 | Moderate | 8 | Small branches move |
| 3 | Strong | 14 | Whole trees sway |
| 4 | Severe | 25 | Structural damage possible |
| 5 | Extreme | 40 | Hurricane / tornado force |

The phone's weather app display is patched to show wind in **mph** (converted from the stored m/s value).

### Humidity Estimation

Calendaria doesn't provide humidity data. The module estimates it from four layered factors:

1. **Climate zone base** — from `getActiveCalendar().weather.activeZone`:
   - Tropical: 80%, Subtropical: 70%, Temperate: 60%, Subarctic: 55%, Arctic: 50%, Polar: 45%, Arid: 20%

2. **Seasonal modifier** — from `getCurrentSeason().seasonalType`:
   - Spring/Autumn: +5%, Summer: -5%, Winter: +0%

3. **Precipitation boost** — from `precipitation.type` and `precipitation.intensity`:
   - Drizzle: +10%, Rain: +20%, Downpour: +30%, Thunderstorm: +25%, Fog: +25%, Mist: +20%, Snow/Sleet: +10-15%, Blizzard: +20%
   - Plus intensity scaling: 0-1 → 0-15% additional

4. **Environmental adjustments**:
   - High wind (level ≥3): -5%, Extreme wind (level 5): additional -5%
   - Arid + very hot (>35°C): -10%
   - Deep cold (<-10°C): +5%

Result is clamped to 5-99%.

### "Feels Like" Temperature

The built-in weather app calculates "feels like" as `temp - 1` regardless of conditions. This module patches it with real meteorological formulas:

| Condition | Formula |
|---|---|
| **Cold + windy** (≤50°F, wind >3 mph) | NWS Wind Chill Index |
| **Hot + humid** (≥80°F, humidity ≥40%) | Rothfusz Heat Index with NWS adjustments |
| **Mild range** (50-80°F) | Wind cooling with linear taper (strongest at 50°F, fades by 90°F) + humidity warming above 65°F |

Examples at 80% humidity:

| Temp | Wind | Feels Like | Effect |
|---|---|---|---|
| 70°F | 56 mph (severe) | 67°F | Wind cooling in mild range |
| 45°F | 31 mph (strong) | 35°F | NWS wind chill |
| 85°F | 8 mph (light) | 95°F | Heat index from humidity |
| 60°F | 0 mph (calm) | 60°F | No adjustment |

### Stopwatch Auto-Reset

If Calendaria's stopwatch is stuck in a `running: true` state on session load, the module force-resets it by writing a clean state to the `calendaria.stopwatchState` setting and calling `hideStopwatch()`.

### Smart Date Tracking

The calendar app doesn't aggressively override user navigation:

- If the user manually selects a day, navigates months, or picks a date, their selection is preserved even as world time advances.
- The "Today" button clears the manual selection and re-enables auto-follow.
- The app lazily initializes its date on first render (not in the constructor) to avoid reading stale data before Calendaria is ready.

### Security

- All user-provided strings (note titles, IDs, category labels, month names) are HTML-escaped before template insertion to prevent XSS.
- Note content sent to `createNote` is also escaped.
- GM-only notes are filtered client-side as a defense-in-depth measure on top of whatever Calendaria does server-side.

## Architecture

```
main.mjs
├── App registration (setup hook)
├── Stopwatch reset (ready hook, GM only)
├── SmartphoneTime patches (now, getDateObject, getCalendarConfig)
├── Realtime clock bridge (hook → WidgetClock.updateClockDisplay)
├── Weather sync (Calendaria → phone weather-data, debounced)
├── Weather source lock
└── WeatherApp render patch (wind mph + feels-like)

CalendariaPhoneApp.mjs (extends BaseApp)
├── Lazy date initialization (_ensureCurrentDate)
├── Hook management (register/unregister with safe cleanup)
├── Rendering (calendar view, grid, day info, notes, event form, date picker, GM controls)
├── Listener management (split into 5 focused methods)
├── Note CRUD (create, delete, open in Calendaria)
└── GM time controls (shortcuts, advance, set date)
```

## License

MIT
