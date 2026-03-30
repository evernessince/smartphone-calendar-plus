/**
 * CalendariaPhoneApp
 *
 * A smartphone-widget BaseApp that replaces the built-in calendar.
 * All time/calendar/note operations go through CALENDARIA.api.
 *
 * @module calendaria-phone-app
 */

import { BaseApp } from '/modules/smartphone-widget/scripts/apps/BaseApp.js';

/* ================================================================== */
/*  Constants                                                          */
/* ================================================================== */

const VIEW = Object.freeze({ CALENDAR: 'calendar', EVENT_FORM: 'eventForm' });
const MODULE_ID = 'calendaria-phone-app';
const I18N_PREFIX = 'SMCAL';
const DEFAULT_COLOR = '#4a9eff';

const COLORS = Object.freeze([
    '#4a9eff', '#ff6b6b', '#51cf66', '#fcc419',
    '#845ef7', '#20c997', '#f06595', '#868e96'
]);

const PRESETS = Object.freeze({
    morning:  { hour: 6,  icon: 'fas fa-sun',        label: 'Morning'  },
    midday:   { hour: 12, icon: 'fas fa-cloud-sun',  label: 'Midday'   },
    evening:  { hour: 18, icon: 'fas fa-cloud-moon', label: 'Evening'  },
    midnight: { hour: 0,  icon: 'fas fa-moon',       label: 'Midnight' },
});

const UNIT_MAP = Object.freeze({
    minutes: 'minute', hours: 'hour', days: 'day', months: 'month', years: 'year'
});

const UNIT_I18N = Object.freeze({
    minutes: `${I18N_PREFIX}.minutes`, hours: `${I18N_PREFIX}.hours`,
    days: `${I18N_PREFIX}.days`, months: `${I18N_PREFIX}.months`,
    years: `${I18N_PREFIX}.years`
});

/* ================================================================== */
/*  Utility helpers                                                    */
/* ================================================================== */

/** Safely get CALENDARIA.api — returns null if unavailable. */
function cApi() {
    return (typeof CALENDARIA !== 'undefined' && CALENDARIA?.api) ? CALENDARIA.api : null;
}

/** Current in-world date/time from Calendaria. Returns null if not ready. */
function currentDateTime() {
    return cApi()?.getCurrentDateTime?.() ?? null;
}

/** Escape a string for safe HTML attribute/text insertion. */
function esc(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Localize a key, returning fallback if missing. */
function loc(key, fallback) {
    const result = game.i18n.localize(key);
    return (result === key && fallback !== undefined) ? fallback : result;
}

/** Format hour:minute as "HH:MM". */
function fmtTime(h, m) {
    return `${String(h ?? 0).padStart(2, '0')}:${String(m ?? 0).padStart(2, '0')}`;
}

/* ================================================================== */
/*  Calendar data helpers (cached per call to avoid redundant work)    */
/* ================================================================== */

/** @type {{ months: object[]|null, weekdays: object[]|null }} */
const _cache = { months: null, weekdays: null, _tick: 0 };

function _invalidateCache() { _cache._tick++; _cache.months = null; _cache.weekdays = null; }

/** Ordered month array from active calendar. Cached until invalidated. */
function getMonths() {
    if (_cache.months) return _cache.months;
    const api = cApi();
    if (!api) return [];
    const raw = api.getActiveCalendar()?.months?.values ?? {};
    _cache.months = Object.values(raw).sort((a, b) => a.ordinal - b.ordinal);
    return _cache.months;
}

/** Ordered weekday array from active calendar. Cached until invalidated. */
function getWeekdays() {
    if (_cache.weekdays) return _cache.weekdays;
    const api = cApi();
    if (!api) return [];
    const raw = api.getActiveCalendar()?.days?.values ?? {};
    _cache.weekdays = Object.values(raw).sort((a, b) => a.ordinal - b.ordinal);
    return _cache.weekdays;
}

/** Month name by 1-based index. */
function getMonthName(index) {
    return getMonths()[index - 1]?.name ?? `Month ${index}`;
}

/** Days in a month (1-based month). Handles leap years. */
function getDaysInMonth(year, month) {
    const m = getMonths()[month - 1];
    if (!m) return 30;
    if (m.leapDays != null) {
        const cfg = cApi()?.getActiveCalendar()?.leapYearConfig;
        if (cfg && _isLeapYear(year, cfg)) return m.leapDays;
    }
    return m.days ?? 30;
}

function _isLeapYear(year, cfg) {
    if (!cfg || cfg.type === 'none') return false;
    if (cfg.type === 'gregorian') return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    if (cfg.interval) return year % cfg.interval === 0;
    return false;
}

/** Weekday index (0-based) for a date. Uses Calendaria API (object signature). */
function getWeekdayFor(year, month, day) {
    try { return cApi()?.dayOfWeek({ year, month, day }) ?? 0; }
    catch { return 0; }
}

/**
 * Filter notes: remove gmOnly notes for non-GM users.
 * @param {object[]} notes - Raw notes from Calendaria API.
 * @returns {object[]}
 */
function filterNotes(notes) {
    if (!Array.isArray(notes)) return [];
    return notes.filter(n => {
        if (!n.visible) return false;
        if (n.flagData?.gmOnly && !game.user.isGM) return false;
        return true;
    });
}

/* ================================================================== */
/*  CalendariaPhoneApp                                                 */
/* ================================================================== */

export class CalendariaPhoneApp extends BaseApp {

    /** @param {object} widget - The WidgetManager instance from smartphone-widget. */
    constructor(widget) {
        super(widget);

        /** Currently displayed year/month on the grid. */
        this.currentDisplayDate = { year: 0, month: 1 };
        /** User's selected date for detail view. */
        this.selectedDate = { year: 0, month: 1, day: 1 };
        /** Whether the user has manually selected a date (prevents auto-follow). */
        this._userSelected = false;
        /** Whether we've successfully read from Calendaria at least once. */
        this._initialized = false;

        this.currentView = VIEW.CALENDAR;
        this.editingNote = null;
        this.isPickingDate = false;
        this.gmTimeUnit = 'days';

        // Bound handler references for hook cleanup.
        this._onTimeChange = () => this._handleTimeChange();
        this._onNoteChange = () => this._handleNoteChange();
        /** Guard to prevent re-entrant renders from rapid hook firing. */
        this._rendering = false;
    }

    /* ================================================================
     *  Lifecycle (called by smartphone-widget framework)
     * ================================================================ */

    /** Called when the active phone changes. */
    async onPhoneChanged() {
        if (this.widget.currentApp === 'calendar') this.render();
    }

    /** Main render entry point. */
    async render() {
        if (this._rendering) return;
        this._rendering = true;
        try {
            this._ensureCurrentDate();
            _invalidateCache();
            this._safeOffHooks();
            this._registerHooks();

            const html = this.currentView === VIEW.EVENT_FORM
                ? this._renderEventForm()
                : this._renderCalendarView();
            this.updateContent(html);
        } finally {
            this._rendering = false;
        }
    }

    /** Cleanup when the app is closed / phone switches away. */
    cleanup() {
        super.cleanup();
        this._safeOffHooks();
    }

    /* ================================================================
     *  Hook management
     * ================================================================ */

    _registerHooks() {
        const api = cApi();
        if (!api) return;
        const h = api.hooks;
        Hooks.on(h.DATE_TIME_CHANGE, this._onTimeChange);
        Hooks.on(h.NOTE_CREATED, this._onNoteChange);
        Hooks.on(h.NOTE_DELETED, this._onNoteChange);
        Hooks.on(h.NOTE_UPDATED, this._onNoteChange);
    }

    /** Safely unregister hooks — won't throw if Calendaria is unavailable. */
    _safeOffHooks() {
        try {
            const api = cApi();
            if (!api) return;
            const h = api.hooks;
            Hooks.off(h.DATE_TIME_CHANGE, this._onTimeChange);
            Hooks.off(h.NOTE_CREATED, this._onNoteChange);
            Hooks.off(h.NOTE_DELETED, this._onNoteChange);
            Hooks.off(h.NOTE_UPDATED, this._onNoteChange);
        } catch (e) {
            console.warn(`${MODULE_ID} | _safeOffHooks:`, e);
        }
    }

    /* ================================================================
     *  Date initialization & hook handlers
     * ================================================================ */

    /**
     * Sync display/selected date from Calendaria if not yet initialized.
     * Only called at the start of render() — does not overwrite user selections.
     */
    _ensureCurrentDate() {
        const dt = currentDateTime();
        if (!dt || dt.year == null) return; // Calendaria not ready

        if (!this._initialized || this.currentDisplayDate.year === 0) {
            this.currentDisplayDate = { year: dt.year, month: dt.month };
            this.selectedDate = { year: dt.year, month: dt.month, day: dt.day };
            this._initialized = true;
            this._userSelected = false;
        }
    }

    /** Handle Calendaria time change. Only updates selectedDate if user hasn't manually navigated. */
    _handleTimeChange() {
        const dt = currentDateTime();
        if (!dt) return;

        // Always update the display month if it's changed
        if (dt.year !== this.currentDisplayDate.year || dt.month !== this.currentDisplayDate.month) {
            if (!this._userSelected) {
                this.currentDisplayDate = { year: dt.year, month: dt.month };
            }
        }

        // Only auto-follow the selected date if the user hasn't manually picked one
        if (!this._userSelected) {
            this.selectedDate = { year: dt.year, month: dt.month, day: dt.day };
        }

        if (this.widget.currentApp === 'calendar') this.render();
    }

    /** Handle note CRUD — re-render the calendar view (not the form). */
    _handleNoteChange() {
        if (this.widget.currentApp === 'calendar' && this.currentView === VIEW.CALENDAR) {
            this.render();
        }
    }

    /* ================================================================
     *  Rendering — Calendar view
     * ================================================================ */

    /** @returns {string} Full calendar view HTML. */
    _renderCalendarView() {
        const dt = currentDateTime() ?? { year: 0, month: 1, day: 1 };
        const mName = esc(getMonthName(this.currentDisplayDate.month));
        const appTitle = esc(this.getAppName('calendar', `${I18N_PREFIX}.appName`));

        return `
            <div class="calendar-app">
                <div class="app-header">
                    <h3>${appTitle}</h3>
                    <button class="today-btn" title="${esc(loc(`${I18N_PREFIX}.today`, 'Today'))}">
                        <i class="fas fa-calendar-day"></i>
                    </button>
                </div>
                <div class="calendar-main">
                    <div class="calendar-header">
                        <button class="nav-btn prev-month"><i class="fas fa-chevron-left"></i></button>
                        <span class="current-month">${this.currentDisplayDate.year} ${mName}</span>
                        <button class="nav-btn next-month"><i class="fas fa-chevron-right"></i></button>
                    </div>
                    ${this.isPickingDate ? this._renderDatePicker() : this._renderGrid(dt)}
                    ${!this.isPickingDate ? this._renderDayInfo() : ''}
                </div>
                ${game.user.isGM && !this.isPickingDate ? this._renderGmControls() : ''}
            </div>`;
    }

    /** @returns {string} Calendar grid HTML. */
    _renderGrid(today) {
        const weekdays = getWeekdays();
        const { year, month } = this.currentDisplayDate;
        const daysInMon = getDaysInMonth(year, month);
        const startDow = getWeekdayFor(year, month, 1);
        const numWd = weekdays.length || 7;

        // Load notes for dot indicators — filtered for permissions
        let monthNotes = [];
        try { monthNotes = filterNotes(cApi()?.getNotesForMonth(year, month)); } catch {}
        const noteDays = new Set();
        for (const n of monthNotes) {
            const sd = n.flagData?.startDate;
            if (sd) noteDays.add(sd.dayOfMonth + 1); // 0-based → 1-based
        }

        // Weekday headers
        let html = weekdays.map(d => {
            const label = esc((d.abbreviation || d.name || '?').slice(0, 2));
            return `<div class="weekday">${label}</div>`;
        }).join('');

        // Leading empties
        for (let i = 0; i < startDow; i++) html += `<div class="day empty"></div>`;

        // Day cells
        for (let d = 1; d <= daysInMon; d++) {
            const isToday = d === today.day && month === today.month && year === today.year;
            const isSel = d === this.selectedDate.day
                && month === this.selectedDate.month
                && year === this.selectedDate.year;
            const hasNotes = noteDays.has(d);

            let cls = 'day';
            if (isToday) cls += ' today';
            if (isSel) cls += ' selected';
            if (hasNotes) cls += ' has-events';

            const indicator = hasNotes ? '<span class="event-indicator"></span>' : '';
            html += `<div class="${cls}" data-day="${d}">${d}${indicator}</div>`;
        }

        // Trailing empties
        const total = startDow + daysInMon;
        const rem = total % numWd === 0 ? 0 : numWd - (total % numWd);
        for (let i = 0; i < rem; i++) html += `<div class="day empty"></div>`;

        return `<div class="calendar-grid">${html}</div>`;
    }

    /* ================================================================
     *  Rendering — Selected day info & notes
     * ================================================================ */

    /** @returns {string} Selected day detail panel HTML. */
    _renderDayInfo() {
        const { year, month, day } = this.selectedDate;
        const mName = esc(getMonthName(month));

        let notes = [];
        try { notes = filterNotes(cApi()?.getNotesForDate(year, month, day)); } catch {}

        const listHTML = notes.length > 0
            ? notes.map(n => this._renderNoteItem(n)).join('')
            : `<p class="no-events">${loc(`${I18N_PREFIX}.noEvents`, 'No events this day.')}</p>`;

        return `
            <div class="selected-day-info">
                <div class="selected-day-header">
                    <h4>${mName} ${day}</h4>
                    <button class="add-event-btn">
                        <i class="fas fa-plus"></i> ${loc(`${I18N_PREFIX}.addEvent`, 'Add Event')}
                    </button>
                </div>
                <div class="event-list">${listHTML}</div>
            </div>`;
    }

    /**
     * Render a single note item.
     * @param {object} note - Note object from Calendaria API.
     * @returns {string}
     */
    _renderNoteItem(note) {
        const fd = note.flagData ?? {};
        const color = esc(fd.color || DEFAULT_COLOR);
        const icon = esc(fd.icon || 'fas fa-calendar');
        const title = esc(note.name || '');
        const time = fd.allDay
            ? loc(`${I18N_PREFIX}.allDay`, 'All Day')
            : fmtTime(fd.startDate?.hour, fd.startDate?.minute);
        const canEdit = note.isOwner || game.user.isGM;
        const openTitle = esc(loc(`${I18N_PREFIX}.openInCalendaria`, 'Open in Calendaria'));

        return `
            <div class="event-item" data-note-id="${esc(note.id)}" data-journal-id="${esc(note.journalId)}">
                <div class="event-color-bar" style="background-color: ${color};"></div>
                <div class="event-details">
                    <span class="event-time">${time}</span>
                    <span class="event-title"><i class="${icon}"></i> ${title}</span>
                </div>
                <div class="event-actions">
                    ${canEdit ? `
                        <button class="open-note-btn" title="${openTitle}">
                            <i class="fas fa-external-link-alt"></i>
                        </button>
                        <button class="delete-note-btn"><i class="fas fa-trash"></i></button>
                    ` : ''}
                </div>
            </div>`;
    }

    /* ================================================================
     *  Rendering — Event form (create / edit)
     * ================================================================ */

    /** @returns {string} Event creation/edit form HTML. */
    _renderEventForm() {
        const isEdit = this.editingNote != null;
        const fd = this.editingNote?.flagData ?? {};
        const title = esc(isEdit ? this.editingNote.name : '');
        const hour = isEdit ? (fd.startDate?.hour ?? 12) : 12;
        const minute = isEdit ? (fd.startDate?.minute ?? 0) : 0;
        const color = fd.color || DEFAULT_COLOR;
        const allDay = isEdit ? (fd.allDay ?? true) : true;
        const gmOnly = isEdit ? (fd.gmOnly ?? false) : false;

        const categories = cApi()?.getCategories() ?? [];
        const selCats = new Set(fd.categories ?? []);

        const catOptions = categories.map(c =>
            `<option value="${esc(c.id)}" ${selCats.has(c.id) ? 'selected' : ''}>${esc(c.label)}</option>`
        ).join('');

        return `
            <div class="event-form-view">
                <div class="app-header">
                    <h3>${loc(isEdit ? `${I18N_PREFIX}.editEvent` : `${I18N_PREFIX}.addEvent`)}</h3>
                </div>
                <div class="event-form-content">
                    <div class="form-group">
                        <label>${loc(`${I18N_PREFIX}.title`)}</label>
                        <input type="text" id="smcal-title" value="${title}"
                               placeholder="${esc(loc(`${I18N_PREFIX}.eventTitlePlaceholder`))}">
                    </div>
                    <div class="form-group">
                        <label>
                            <input type="checkbox" id="smcal-allday" ${allDay ? 'checked' : ''}>
                            ${loc(`${I18N_PREFIX}.allDay`)}
                        </label>
                    </div>
                    <div class="form-group smcal-time-row" ${allDay ? 'style="display:none"' : ''}>
                        <label>${loc(`${I18N_PREFIX}.time`)}</label>
                        <div class="time-input-group">
                            <input type="number" id="smcal-hour" value="${hour}"
                                   min="0" max="23" class="time-input-hour">
                            <span>:</span>
                            <input type="number" id="smcal-minute"
                                   value="${String(minute).padStart(2, '0')}"
                                   min="0" max="59" class="time-input-minute">
                        </div>
                    </div>
                    <div class="form-group">
                        <label>${loc(`${I18N_PREFIX}.memo`)}</label>
                        <textarea id="smcal-memo" rows="3"
                                  placeholder="${esc(loc(`${I18N_PREFIX}.memoPlaceholder`))}"></textarea>
                    </div>
                    <div class="form-group">
                        <label>${loc(`${I18N_PREFIX}.color`)}</label>
                        ${this._renderColorPicker(color)}
                    </div>
                    <div class="form-group">
                        <label>${loc(`${I18N_PREFIX}.category`)}</label>
                        <select id="smcal-category">
                            <option value="">${loc(`${I18N_PREFIX}.none`)}</option>
                            ${catOptions}
                        </select>
                    </div>
                    ${game.user.isGM ? `
                        <div class="form-group">
                            <label>
                                <input type="checkbox" id="smcal-gmonly" ${gmOnly ? 'checked' : ''}>
                                ${loc(`${I18N_PREFIX}.gmOnly`)}
                            </label>
                        </div>
                    ` : ''}
                </div>
                <div class="event-form-footer">
                    <button class="cancel-btn">${loc(`${I18N_PREFIX}.cancel`)}</button>
                    <button class="save-btn">${loc(`${I18N_PREFIX}.save`)}</button>
                </div>
            </div>`;
    }

    /** @returns {string} Color picker HTML. */
    _renderColorPicker(selectedColor) {
        return `
            <div class="color-picker">
                ${COLORS.map(c => `
                    <button class="color-option ${c === selectedColor ? 'selected' : ''}"
                            data-color="${c}" style="background-color:${c};">
                        ${c === selectedColor ? '<i class="fas fa-check"></i>' : ''}
                    </button>
                `).join('')}
            </div>`;
    }

    /* ================================================================
     *  Rendering — Date picker
     * ================================================================ */

    /** @returns {string} Year/month picker overlay HTML. */
    _renderDatePicker() {
        const months = getMonths();
        const pickerMonth = this.currentDisplayDate.month - 1;

        return `
            <div class="date-picker">
                <div class="year-selector">
                    <button class="year-nav-btn" data-action="prev-year">
                        <i class="fas fa-chevron-left"></i>
                    </button>
                    <input type="number" class="year-input" value="${this.currentDisplayDate.year}">
                    <button class="year-nav-btn" data-action="next-year">
                        <i class="fas fa-chevron-right"></i>
                    </button>
                </div>
                <div class="month-grid">
                    ${months.map((m, i) => `
                        <button class="month-btn ${i === pickerMonth ? 'selected' : ''}"
                                data-month="${i}">${esc(m.abbreviation || m.name)}</button>
                    `).join('')}
                </div>
            </div>`;
    }

    /* ================================================================
     *  Rendering — GM controls
     * ================================================================ */

    /** @returns {string} GM time manipulation panel HTML. */
    _renderGmControls() {
        const dt = currentDateTime() ?? {};
        const dateSelected = dt.year !== this.selectedDate.year
            || dt.month !== this.selectedDate.month
            || dt.day !== this.selectedDate.day;

        const shortcutHTML = Object.entries(PRESETS).map(([key, v]) => `
            <button class="gm-shortcut-btn" data-shortcut="${key}">
                <i class="${v.icon}"></i><span>${v.label}</span>
            </button>
        `).join('');

        const optionsHTML = Object.entries(UNIT_I18N).map(([val, key]) =>
            `<option value="${val}" ${this.gmTimeUnit === val ? 'selected' : ''}>${loc(key)}</option>`
        ).join('');

        return `
            <div class="gm-controls accordion-container">
                <div class="accordion-item">
                    <div class="accordion-header">
                        <i class="fas fa-clock"></i>
                        <span>${loc(`${I18N_PREFIX}.timeControls`)}</span>
                        <i class="fas fa-chevron-down accordion-icon"></i>
                    </div>
                    <div class="accordion-content">
                        <div class="gm-control-group time-shortcuts">${shortcutHTML}</div>
                        ${dateSelected ? `
                            <div class="gm-control-group time-set">
                                <button id="gm-set-time-btn">
                                    <i class="fas fa-calendar-check"></i>
                                    ${loc(`${I18N_PREFIX}.setTimeToSelected`)}
                                </button>
                            </div>
                        ` : ''}
                    </div>
                </div>
                <div class="accordion-item">
                    <div class="accordion-header">
                        <i class="fas fa-cogs"></i>
                        <span>${loc(`${I18N_PREFIX}.advancedControls`)}</span>
                        <i class="fas fa-chevron-down accordion-icon"></i>
                    </div>
                    <div class="accordion-content">
                        <div class="gm-control-group time-manipulation">
                            <button data-action="manipulate-time" data-value="-5">&lt;&lt;</button>
                            <button data-action="manipulate-time" data-value="-1">&lt;</button>
                            <select id="gm-time-unit-dropdown">${optionsHTML}</select>
                            <button data-action="manipulate-time" data-value="1">&gt;</button>
                            <button data-action="manipulate-time" data-value="5">&gt;&gt;</button>
                        </div>
                    </div>
                </div>
            </div>`;
    }

    /* ================================================================
     *  Listeners
     * ================================================================ */

    /** Register all DOM event listeners. Called by framework after render. */
    setupListeners() {
        super.removeAllListeners();
        if (!this.element) return;

        this._setupGlobalListeners();

        if (this.currentView === VIEW.EVENT_FORM) {
            this._setupEventFormListeners();
        } else if (this.isPickingDate) {
            this._setupDatePickerListeners();
        } else {
            this._setupCalendarViewListeners();
            if (game.user.isGM) this._setupGmListeners();
        }
    }

    /** Listeners shared across all views. */
    _setupGlobalListeners() {
        // Today button — resets to current date and clears user selection
        const todayBtn = this.element.querySelector('.today-btn');
        if (todayBtn) {
            this.addListener(todayBtn, 'click', () => {
                const dt = currentDateTime();
                if (!dt) return;
                this.currentDisplayDate = { year: dt.year, month: dt.month };
                this.selectedDate = { year: dt.year, month: dt.month, day: dt.day };
                this._userSelected = false;
                this.isPickingDate = false;
                this.render();
            });
        }

        // Month label → toggle date picker
        const monthLabel = this.element.querySelector('.current-month');
        if (monthLabel) {
            this.addListener(monthLabel, 'click', () => {
                this.isPickingDate = !this.isPickingDate;
                this.render();
            });
        }
    }

    /** Listeners for the event create/edit form. */
    _setupEventFormListeners() {
        this.addListener(this.element.querySelector('.save-btn'), 'click', () => this._saveNote());

        this.addListener(this.element.querySelector('.cancel-btn'), 'click', () => {
            this.currentView = VIEW.CALENDAR;
            this.editingNote = null;
            this.render();
        });

        // All-day toggle
        const allDayChk = this.element.querySelector('#smcal-allday');
        if (allDayChk) {
            this.addListener(allDayChk, 'change', () => {
                const row = this.element.querySelector('.smcal-time-row');
                if (row) row.style.display = allDayChk.checked ? 'none' : '';
            });
        }

        // Color picker
        this.element.querySelectorAll('.color-option').forEach(btn => {
            this.addListener(btn, 'click', (e) => {
                this.element.querySelectorAll('.color-option').forEach(b => {
                    b.classList.remove('selected');
                    b.innerHTML = '';
                });
                e.currentTarget.classList.add('selected');
                e.currentTarget.innerHTML = '<i class="fas fa-check"></i>';
            });
        });
    }

    /** Listeners for the year/month picker overlay. */
    _setupDatePickerListeners() {
        this.addListener(this.element.querySelector('[data-action="prev-year"]'), 'click', () => {
            this.currentDisplayDate.year--;
            this.render();
        });
        this.addListener(this.element.querySelector('[data-action="next-year"]'), 'click', () => {
            this.currentDisplayDate.year++;
            this.render();
        });
        this.addListener(this.element.querySelector('.year-input'), 'change', (e) => {
            this.currentDisplayDate.year = parseInt(e.target.value);
            this.render();
        });
        this.element.querySelectorAll('.month-btn').forEach(btn => {
            this.addListener(btn, 'click', (e) => {
                this.currentDisplayDate.month = parseInt(e.currentTarget.dataset.month) + 1;
                this.isPickingDate = false;
                this._userSelected = true; // User explicitly picked a month
                this.render();
            });
        });
    }

    /** Listeners for the main calendar grid and day info panel. */
    _setupCalendarViewListeners() {
        const numMonths = getMonths().length;

        // Month navigation
        this.addListener(this.element.querySelector('.prev-month'), 'click', () => {
            this.currentDisplayDate.month--;
            if (this.currentDisplayDate.month < 1) {
                this.currentDisplayDate.month = numMonths;
                this.currentDisplayDate.year--;
            }
            this._userSelected = true;
            this.render();
        });
        this.addListener(this.element.querySelector('.next-month'), 'click', () => {
            this.currentDisplayDate.month++;
            if (this.currentDisplayDate.month > numMonths) {
                this.currentDisplayDate.month = 1;
                this.currentDisplayDate.year++;
            }
            this._userSelected = true;
            this.render();
        });

        // Day cell click
        this.element.querySelectorAll('.day:not(.empty)').forEach(el => {
            this.addListener(el, 'click', (e) => {
                this.selectedDate = {
                    year: this.currentDisplayDate.year,
                    month: this.currentDisplayDate.month,
                    day: parseInt(e.currentTarget.dataset.day)
                };
                this._userSelected = true;
                this.render();
            });
        });

        // Add event button
        this.addListener(this.element.querySelector('.add-event-btn'), 'click', () => {
            this.currentView = VIEW.EVENT_FORM;
            this.editingNote = null;
            this.render();
        });

        // Open note in Calendaria
        this.element.querySelectorAll('.open-note-btn').forEach(btn => {
            this.addListener(btn, 'click', (e) => {
                const id = e.currentTarget.closest('.event-item')?.dataset.noteId;
                if (id) {
                    try { cApi()?.openNote(id); }
                    catch (err) { console.warn(`${MODULE_ID} | openNote:`, err); }
                }
            });
        });

        // Delete note (with confirmation)
        this.element.querySelectorAll('.delete-note-btn').forEach(btn => {
            this.addListener(btn, 'click', async (e) => {
                const item = e.currentTarget.closest('.event-item');
                const noteId = item?.dataset.noteId;
                if (!noteId) return;

                const noteName = item.querySelector('.event-title')?.textContent?.trim() || '';
                const confirmed = await Dialog.confirm({
                    title: loc(`${I18N_PREFIX}.deleteConfirm`, 'Delete this note?'),
                    content: `<p>${loc(`${I18N_PREFIX}.deleteConfirm`, 'Delete this note?')}<br><strong>${esc(noteName)}</strong></p>`,
                });
                if (!confirmed) return;

                try { await cApi()?.deleteNote(noteId); }
                catch (err) { console.error(`${MODULE_ID} | deleteNote:`, err); }
            });
        });
    }

    /** GM-only listeners for time controls. */
    _setupGmListeners() {
        // Accordion headers
        this.element.querySelectorAll('.accordion-header').forEach(hdr => {
            this.addListener(hdr, 'click', () => hdr.parentElement.classList.toggle('is-open'));
        });

        // Time-of-day shortcuts
        this.element.querySelectorAll('.gm-shortcut-btn').forEach(btn => {
            this.addListener(btn, 'click', (e) => {
                this._advanceToPreset(e.currentTarget.dataset.shortcut);
            });
        });

        // Time manipulation (advance/rewind)
        this.element.querySelectorAll('button[data-action="manipulate-time"]').forEach(btn => {
            this.addListener(btn, 'click', async (e) => {
                const value = parseInt(e.currentTarget.dataset.value);
                const unit = this.element.querySelector('#gm-time-unit-dropdown')?.value ?? 'days';
                this.gmTimeUnit = unit;
                if (isNaN(value)) return;

                const apiUnit = UNIT_MAP[unit] || unit;
                try { await cApi()?.advanceTime({ [apiUnit]: value }); }
                catch (err) { console.error(`${MODULE_ID} | advanceTime:`, err); }
            });
        });

        // Unit dropdown
        const dropdown = this.element.querySelector('#gm-time-unit-dropdown');
        if (dropdown) {
            this.addListener(dropdown, 'change', (e) => { this.gmTimeUnit = e.currentTarget.value; });
        }

        // Set date to selected
        const setBtn = this.element.querySelector('#gm-set-time-btn');
        if (setBtn) {
            this.addListener(setBtn, 'click', async () => {
                const dt = currentDateTime();
                if (!dt) return;
                try {
                    await cApi()?.setDateTime({
                        year: this.selectedDate.year,
                        month: this.selectedDate.month,
                        day: this.selectedDate.day,
                        hour: dt.hour, minute: dt.minute, second: dt.second
                    });
                } catch (err) { console.error(`${MODULE_ID} | setDateTime:`, err); }
            });
        }
    }

    /* ================================================================
     *  Actions
     * ================================================================ */

    /** Save or update a Calendaria note from the event form. */
    async _saveNote() {
        const el = this.element;
        const name = el.querySelector('#smcal-title')?.value?.trim()
            || loc(`${I18N_PREFIX}.untitledEvent`, 'Untitled Event');
        const allDay = el.querySelector('#smcal-allday')?.checked ?? true;
        const hour = parseInt(el.querySelector('#smcal-hour')?.value) || 0;
        const minute = parseInt(el.querySelector('#smcal-minute')?.value) || 0;
        const content = el.querySelector('#smcal-memo')?.value?.trim() || '';
        const color = el.querySelector('.color-option.selected')?.dataset?.color || DEFAULT_COLOR;
        const catId = el.querySelector('#smcal-category')?.value || '';
        const gmOnly = el.querySelector('#smcal-gmonly')?.checked ?? false;

        const { year, month, day } = this.selectedDate;

        // Build the note data
        const noteData = {
            name,
            content: content ? `<p>${esc(content)}</p>` : '',
            startDate: { year, month, day },
            endDate: { year, month, day },
            allDay, color, gmOnly,
            categories: catId ? [catId] : [],
            openSheet: 'none'
        };

        // If not all-day, add time — handle minute overflow
        if (!allDay) {
            noteData.startDate.hour = hour;
            noteData.startDate.minute = minute;
            let endHour = hour;
            let endMinute = minute + 30;
            if (endMinute >= 60) {
                endMinute -= 60;
                endHour = (endHour + 1) % 24;
            }
            noteData.endDate.hour = endHour;
            noteData.endDate.minute = endMinute;
        }

        try {
            const api = cApi();
            if (this.editingNote) {
                await api?.updateNote(this.editingNote.id, noteData);
            } else {
                await api?.createNote(noteData);
            }
        } catch (err) {
            console.error(`${MODULE_ID} | save note:`, err);
            ui.notifications.error('Failed to save note.');
        }

        this.currentView = VIEW.CALENDAR;
        this.editingNote = null;
        this.render();
    }

    /**
     * Advance time to a preset (morning/midday/evening/midnight).
     * @param {string} key - Preset key from PRESETS.
     */
    async _advanceToPreset(key) {
        const api = cApi();
        if (!api) return;

        try {
            await api.advanceTimeToPreset(key);
        } catch {
            // Manual fallback if advanceTimeToPreset not available
            const targetHour = PRESETS[key]?.hour ?? 6;
            const dt = currentDateTime();
            if (!dt) return;
            let diff = targetHour - dt.hour;
            if (diff <= 0) diff += 24;
            try { await api.advanceTime({ hour: diff }); }
            catch (err) { console.error(`${MODULE_ID} | advanceToPreset fallback:`, err); }
        }
    }
}
