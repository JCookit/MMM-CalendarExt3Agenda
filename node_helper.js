const NodeHelper = require("node_helper");
const Log = require("logger");
const https = require("node:https");
const http = require("node:http");
const url = require("node:url");
const ical = require("node-ical");
const moment = require("moment-timezone");

module.exports = NodeHelper.create({
	// Override start method.
	start() {
		Log.log(`Starting node helper for: ${this.name}`);
		this.fetchers = [];
		this.started = false;
	},

	// Override socketNotificationReceived method.
	socketNotificationReceived(notification, payload) {
		if (notification === "CALENDAR_FETCH_START") {
			this.startCalendarFetching(payload);
		} else if (notification === "CALENDAR_FETCH_STOP") {
			this.stopCalendarFetching(payload.instanceId);
		}
	},

	/**
	 * Start calendar fetching for an instance
	 * @param {object} config Configuration object containing calendars and instanceId
	 */
	startCalendarFetching(config) {
		Log.info(`[${this.name}] Starting calendar fetching for instance: ${config.instanceId}`);

		if (!config.calendars || !Array.isArray(config.calendars) || config.calendars.length === 0) {
			Log.info(`[${this.name}] No calendars configured for instance: ${config.instanceId}, sending empty events`);
			
			// Send empty events so the frontend can still display (e.g., mini-calendar)
			this.sendSocketNotification("CALENDAR_EVENTS_FETCHED", {
				instanceId: config.instanceId,
				calendarId: 'no-calendars',
				calendarName: 'No Calendars',
				url: '',
				events: [],
				lastFetch: new Date().getTime()
			});
			return;
		}

		config.calendars.forEach((calendar, index) => {
			const calendarId = `${config.instanceId}_${index}`;
			
			// Create fetcher configuration
			const fetcherConfig = {
				url: calendar.url,
				instanceId: config.instanceId,
				calendarId: calendarId,
				name: calendar.name || this.getCalendarName(calendar.url),
				fetchInterval: calendar.fetchInterval || config.fetchInterval || 60000,
				maximumEntries: calendar.maximumEntries || config.maximumEntries || 10,
				maximumNumberOfDays: calendar.maximumNumberOfDays || config.maximumNumberOfDays || 365,
				pastDaysCount: calendar.pastDaysCount || config.pastDaysCount || 0,
				broadcastPastEvents: calendar.broadcastPastEvents !== undefined ? calendar.broadcastPastEvents : config.broadcastPastEvents,
				excludedEvents: calendar.excludedEvents || config.excludedEvents || [],
				auth: calendar.auth,
				symbolClass: calendar.symbolClass || "",
				titleClass: calendar.titleClass || "",
				timeClass: calendar.timeClass || "",
				color: calendar.color,
				selfSignedCert: calendar.selfSignedCert || false,
				
				// Symbol configuration from global config
				symbol: calendar.symbol || config.defaultSymbol || 'calendar-alt',
				defaultSymbol: config.defaultSymbol || 'calendar-alt',
				symbolClassName: calendar.symbolClassName || config.defaultSymbolClassName || 'fas fa-',
				defaultSymbolClassName: config.defaultSymbolClassName || 'fas fa-',
				recurringSymbol: calendar.recurringSymbol || config.recurringSymbol || 'repeat',
				fullDaySymbol: calendar.fullDaySymbol || config.fullDaySymbol || 'clock',
				customEvents: calendar.customEvents || config.customEvents || []
			};

			this.createFetcher(fetcherConfig);
		});
	},

	/**
	 * Stop calendar fetching for an instance
	 * @param {string} instanceId Instance ID to stop
	 */
	stopCalendarFetching(instanceId) {
		Log.info(`[${this.name}] Stopping calendar fetching for instance: ${instanceId}`);

		// Stop and remove fetchers for this instance
		for (const key in this.fetchers) {
			if (key.startsWith(instanceId)) {
				const fetcher = this.fetchers[key];
				if (fetcher.stop) {
					fetcher.stop();
				}
				delete this.fetchers[key];
				Log.info(`[${this.name}] Stopped fetcher: ${key}`);
			}
		}
	},

	/**
	 * Create a calendar fetcher
	 * @param {object} config Fetcher configuration
	 */
	createFetcher(config) {
		try {
			new URL(config.url);
		} catch (error) {
			Log.error(`[${this.name}] Malformed calendar URL: ${config.url}`, error);
			this.sendSocketNotification("CALENDAR_FETCH_ERROR", {
				instanceId: config.instanceId,
				calendarId: config.calendarId,
				calendarName: config.name,
				error: "Malformed URL"
			});
			return;
		}

		const fetcherKey = config.calendarId;
		
		if (this.fetchers[fetcherKey]) {
			Log.warn(`[${this.name}] Fetcher already exists for: ${config.url}`);
//            this.fetchers[fetcherKey].fetchCalendar();  // put this back in to refresh the display on a browser f5
			return;
		}

		Log.info(`[${this.name}] Creating fetcher for: ${config.name} (${config.url})`);
		
		const fetcher = new CalendarFetcher(config);
		
		fetcher.onReceive((events) => {
			this.broadcastEvents(config, events);
		});

		fetcher.onError((error) => {
			Log.error(`[${this.name}] Calendar fetch error for ${config.name}:`, error);
			this.sendSocketNotification("CALENDAR_FETCH_ERROR", {
				instanceId: config.instanceId,
				calendarId: config.calendarId,
				calendarName: config.name,
				error: error.message || error.toString()
			});
		});

		this.fetchers[fetcherKey] = fetcher;
		fetcher.startFetch();
	},

	/**
	 * Broadcast calendar events to frontend
	 * @param {object} config Fetcher configuration
	 * @param {Array} events Array of events
	 */
	broadcastEvents(config, events) {
		Log.info(`[${this.name}] Broadcasting ${events.length} events from ${config.name}`);
		
		this.sendSocketNotification("CALENDAR_EVENTS_FETCHED", {
			instanceId: config.instanceId,
			calendarId: config.calendarId,
			calendarName: config.name,
			url: config.url,
			events: events,
			lastFetch: new Date().getTime()
		});
	},

	/**
	 * Extract calendar name from URL
	 * @param {string} url Calendar URL
	 * @returns {string} Calendar name
	 */
	getCalendarName(url) {
		try {
			const parsedUrl = new URL(url);
			const pathParts = parsedUrl.pathname.split('/');
			return pathParts[pathParts.length - 1].replace('.ics', '') || 'Calendar';
		} catch {
			return 'Calendar';
		}
	}
});

/**
 * Calendar Fetcher Class
 * Based on the builtin calendar module's CalendarFetcher
 */
class CalendarFetcher {
	constructor(config) {
		this.config = config;
		this.url = config.url;
		this.events = [];
		this.reloadTimer = null;
		this.retryCount = 0;
		this.maxRetries = 5;
		
		this.eventsReceivedCallback = () => {};
		this.fetchFailedCallback = () => {};
	}

	/**
	 * Start fetching calendar data
	 */
	startFetch() {
		this.fetchCalendar();
	}

	/**
	 * Stop fetching calendar data
	 */
	stop() {
		if (this.reloadTimer) {
			clearTimeout(this.reloadTimer);
			this.reloadTimer = null;
		}
	}

	/**
	 * Fetch calendar data from URL
	 */
	async fetchCalendar() {
		this.clearTimer();
		
		try {
			Log.info(`[CalendarFetcher] Fetching calendar: ${this.config.name}`);
			
			const data = await this.fetchICalData();
			const events = this.parseEvents(data);
			
			this.events = events;
			this.retryCount = 0; // Reset retry count on success
			
			Log.info(`[CalendarFetcher] Successfully fetched ${events.length} events from ${this.config.name}`);
			this.eventsReceivedCallback(events);
			
			this.scheduleNextFetch();
			
		} catch (error) {
			Log.error(`[CalendarFetcher] Error fetching ${this.config.name}:`, error.message);
			this.fetchFailedCallback(error);
			this.scheduleRetry();
		}
	}

	/**
	 * Fetch iCal data from URL
	 * @returns {Promise<string>} Raw iCal data
	 */
	fetchICalData() {
		return new Promise((resolve, reject) => {
			// Enhanced headers that work better with Outlook and other calendar services
			let headers = {
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
				"Accept": "text/calendar,application/calendar+xml,text/plain,*/*",
				"Accept-Language": "en-US,en;q=0.9",
				"Accept-Encoding": "identity", // Don't use gzip to avoid issues
				"Cache-Control": "no-cache",
				"Pragma": "no-cache",
				"Connection": "keep-alive"
			};

			// Add authentication if provided
			if (this.config.auth) {
				if (this.config.auth.method === "bearer") {
					headers.Authorization = `Bearer ${this.config.auth.pass}`;
				} else if (this.config.auth.user && this.config.auth.pass) {
					headers.Authorization = `Basic ${Buffer.from(`${this.config.auth.user}:${this.config.auth.pass}`).toString("base64")}`;
				}
			}

			const parsedUrl = new URL(this.url);
			const isHttps = parsedUrl.protocol === 'https:';
			const requestModule = isHttps ? https : http;

			const options = {
				hostname: parsedUrl.hostname,
				port: parsedUrl.port || (isHttps ? 443 : 80),
				path: parsedUrl.pathname + parsedUrl.search,
				method: 'GET',
				headers: headers,
				timeout: 30000 // 30 second timeout
			};

			if (this.config.selfSignedCert && isHttps) {
				options.rejectUnauthorized = false;
			}

			const req = requestModule.request(options, (res) => {
				let data = '';

				// Handle redirects
				if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
					const redirectUrl = res.headers.location;
					if (redirectUrl) {
						Log.info(`[CalendarFetcher] Following redirect to: ${redirectUrl}`);
						this.url = redirectUrl;
						this.fetchICalData().then(resolve).catch(reject);
						return;
					}
				}

				if (res.statusCode !== 200) {
					reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
					return;
				}

				res.on('data', (chunk) => {
					data += chunk;
				});

				res.on('end', () => {
					if (data.length === 0) {
						reject(new Error('Empty response received'));
						return;
					}
					resolve(data);
				});
			});

			req.on('error', (error) => {
				reject(new Error(`Network error: ${error.message}`));
			});

			req.on('timeout', () => {
				req.destroy();
				reject(new Error('Request timeout'));
			});

			req.end();
		});
	}

	/**
	 * Parse iCal data into events
	 * @param {string} icalData Raw iCal data
	 * @returns {Array} Parsed events
	 */
	parseEvents(icalData) {
		try {
			const data = ical.parseICS(icalData);
			
			return this.filterEvents(data);
			
		} catch (error) {
			Log.error(`[CalendarFetcher] Error parsing iCal data for ${this.config.name}:`, error);
			throw error;
		}
	}

	/**
	 * Filter and process events based on configuration
	 * @param {object} data Parsed iCal data
	 * @returns {Array} Filtered events
	 */
	filterEvents(data) {
		const events = [];
		const now = moment();
		const pastMoment = moment().subtract(this.config.pastDaysCount, "days");
		const futureMoment = moment().add(this.config.maximumNumberOfDays, "days");

		for (const eventId in data) {
			const event = data[eventId];
			
			if (event.type !== 'VEVENT') continue;

			try {
				// Check if event should be excluded
				if (this.shouldEventBeExcluded(event.summary)) {
					continue;
				}

				// Process single or recurring events
				if (event.rrule && event.rrule.between) {
					// Recurring event
					const recurringEvents = this.processRecurringEvent(event, pastMoment, futureMoment);
					events.push(...recurringEvents);
				} else {
					// Single event
					const singleEvent = this.processSingleEvent(event, pastMoment, futureMoment);
					if (singleEvent) {
						events.push(singleEvent);
					}
				}
			} catch (error) {
				Log.warn(`[CalendarFetcher] Error processing event ${eventId}:`, error.message);
			}
		}

		// Sort events by start date
		events.sort((a, b) => parseInt(a.startDate) - parseInt(b.startDate));

		// Limit number of events
		if (this.config.maximumEntries && events.length > this.config.maximumEntries) {
			events.splice(this.config.maximumEntries);
		}

		return events;
	}

	/**
	 * Check if event should be excluded based on title
	 * @param {string} title Event title
	 * @returns {boolean} True if event should be excluded
	 */
	shouldEventBeExcluded(title) {
		if (!title || !this.config.excludedEvents) return false;
		
		const testTitle = title.toLowerCase();
		
		for (const excludeFilter of this.config.excludedEvents) {
			if (typeof excludeFilter === 'string') {
				if (testTitle.includes(excludeFilter.toLowerCase())) {
					return true;
				}
			} else if (excludeFilter.filterBy) {
				const filterText = excludeFilter.filterBy.toLowerCase();
				if (testTitle.includes(filterText)) {
					return true;
				}
			}
		}
		
		return false;
	}

	/**
	 * Parse event date with fallback for non-standard timezones
	 * @param {Date|object} eventDate Original event date
	 * @returns {moment} Parsed moment object
	 */
	parseEventDate(eventDate) {
		if (!eventDate) return null;
		
		// Handle Microsoft custom timezone - check the raw event data for the problematic timezone
		// If we detect "tzone://Microsoft/Custom", treat the time as local
		if (eventDate && typeof eventDate === 'object' && eventDate.tz === 'tzone://Microsoft/Custom') {
			Log.info(`[CalendarFetcher] Microsoft Custom Timezone detected, using local time interpretation`);
			// Extract just the date/time components and interpret as local
			const dateStr = eventDate.toISOString ? eventDate.toISOString() : eventDate.toString();
			const localMoment = moment(dateStr).local();
			Log.info(`[CalendarFetcher] Converted to local: ${localMoment.format('YYYY-MM-DD HH:mm:ss')}`);
			return localMoment;
		}
		
		try {
			// First attempt normal parsing
			const parsed = moment(eventDate);
			
			// Check if parsing was successful
			if (parsed.isValid()) {
				return parsed;
			}
		} catch (error) {
			Log.warn(`[CalendarFetcher] Date parsing error: ${error.message}`);
		}
		
		// For non-standard timezones (like Microsoft's tzone://Microsoft/Custom),
		// extract the raw date/time and interpret as local time
		if (eventDate && typeof eventDate === 'object') {
			// If it's a Date object or has date components, try manual construction
			if (eventDate.getFullYear && typeof eventDate.getFullYear === 'function') {
				// It's a Date object - extract components and create local moment
				return moment([
					eventDate.getFullYear(),
					eventDate.getMonth(),
					eventDate.getDate(),
					eventDate.getHours(),
					eventDate.getMinutes(),
					eventDate.getSeconds()
				]);
			}
			
			// If it has date components as properties, use those
			if (eventDate.year !== undefined || eventDate.month !== undefined) {
				return moment([
					eventDate.year || new Date().getFullYear(),
					(eventDate.month || 1) - 1, // moment months are 0-based
					eventDate.day || eventDate.date || 1,
					eventDate.hour || 0,
					eventDate.minute || 0,
					eventDate.second || 0
				]);
			}
		}
		
		// Final fallback - treat as local time
		return moment(eventDate);
	}



	/**
	 * Process a single (non-recurring) event
	 * @param {object} event Event data
	 * @param {moment} pastMoment Past date limit
	 * @param {moment} futureMoment Future date limit
	 * @returns {object|null} Processed event or null if filtered out
	 */
	processSingleEvent(event, pastMoment, futureMoment) {
		const startDate = this.parseEventDate(event.start);
		let endDate = event.end ? this.parseEventDate(event.end) : startDate.clone();
		
		// Fix for full-day events where start and end are the same date
		// For full-day events, if start and end are the same, end should be start of next day
		const isFullDay = this.isFullDayEvent(event, startDate, endDate);
		if (isFullDay && startDate.isSame(endDate, 'day')) {
			endDate = startDate.clone().add(1, 'day');
		}
		
		// Check if event is within date range
		if (endDate.isBefore(pastMoment) || startDate.isAfter(futureMoment)) {
			return null;
		}

		return this.createEventObject(event, startDate, endDate);
	}

	/**
	 * Process a recurring event
	 * @param {object} event Event data
	 * @param {moment} pastMoment Past date limit
	 * @param {moment} futureMoment Future date limit
	 * @returns {Array} Array of recurring event instances
	 */
	processRecurringEvent(event, pastMoment, futureMoment) {
		const events = [];
		
		try {
			// Get duration of original event
			const originalStart = this.parseEventDate(event.start);
			const originalEnd = event.end ? this.parseEventDate(event.end) : originalStart.clone();
			const duration = originalEnd.diff(originalStart);

			// Parse EXDATE (exception dates) if present
			const excludedDates = [];
			if (event.exdate) {
				// node-ical parses EXDATE as an object with date keys and Date objects as values
				// e.g., { '2025-10-09': Date object with tz property, '2025-10-13': Date object with tz property }
				for (const dateKey in event.exdate) {
					const exdateValue = event.exdate[dateKey];
					// Use existing parseEventDate - it already handles Date objects with timezone info
					const parsedExdate = this.parseEventDate(exdateValue);
					if (parsedExdate) {
						excludedDates.push(parsedExdate);
					}
				}
			}

			// First, check if the original start date should be included (first occurrence)
			// But exclude it if it's in the EXDATE list
			const isOriginalExcluded = excludedDates.some(exdate => 
				originalStart.isSame(exdate, 'minute'));
			
			if (!isOriginalExcluded && originalStart.isBetween(pastMoment, futureMoment, null, '[]')) {
				const firstEvent = this.createEventObject(event, originalStart, originalEnd, true);
				if (firstEvent) {
					events.push(firstEvent);
				}
			}
			
			// Generate recurring dates (future occurrences)
			const dates = event.rrule.between(pastMoment.toDate(), futureMoment.toDate(), true);
			
			dates.forEach(date => {
				// The issue: RRULE generates correct dates in UTC, but applying timezone offset 
				// shifts the day incorrectly. Instead, we need to:
				// 1. Get the DATE portion from RRULE (ignore time)
				// 2. Apply the original event's TIME and TIMEZONE to that date
				
				const utcRruleDate = moment.utc(date);
				
				// Extract just the date components (year, month, day) from RRULE
				// But interpret them in the original timezone, not UTC
				const rruleYear = utcRruleDate.year();
				const rruleMonth = utcRruleDate.month();
				const rruleDay = utcRruleDate.date();
				
				// Create a new moment in the original timezone with:
				// - Date from RRULE (interpreted in local timezone)
				// - Time from original event
				const originalOffset = originalStart.utcOffset();
				const startDate = moment()
					.utcOffset(originalOffset)      // Set to original timezone
					.year(rruleYear)                // Use RRULE's year
					.month(rruleMonth)              // Use RRULE's month  
					.date(rruleDay)                 // Use RRULE's day
					.hour(originalStart.hour())     // Use original hour
					.minute(originalStart.minute()) // Use original minute
					.second(originalStart.second()); // Use original second
				
				const endDate = startDate.clone().add(duration, 'milliseconds');
				
				// Skip if this date is the same as the original start (avoid duplicates)
				if (startDate.isSame(originalStart, 'minute')) {
					return;
				}
				
				// Skip if this date is excluded by EXDATE
				const isExcluded = excludedDates.some(exdate => 
					startDate.isSame(exdate, 'minute'));
				if (isExcluded) {
					return;
				}
				
				const recurringEvent = this.createEventObject(event, startDate, endDate, true);
				if (recurringEvent) {
					events.push(recurringEvent);
				}
			});
			
		} catch (error) {
			Log.warn(`[CalendarFetcher] Error processing recurring event:`, error);
		}

		return events;
	}

	/**
	 * Create standardized event object
	 * @param {object} event Raw event data
	 * @param {moment} startDate Event start date
	 * @param {moment} endDate Event end date
	 * @returns {object} Standardized event object
	 */
	/**
	 * Create event object from parsed calendar data
	 * @param {object} event Event data from calendar
	 * @param {moment} startDate Event start date
	 * @param {moment} endDate Event end date
	 * @param {boolean} isRecurring Whether this is a recurring event instance
	 * @returns {object} Formatted event object
	 */
	createEventObject(event, startDate, endDate, isRecurring = false) {
		const isFullDay = this.isFullDayEvent(event, startDate, endDate);
		
		const eventObj = {
			title: event.summary || 'No Title',
			startDate: startDate.format("x"),
			endDate: endDate.format("x"),
			fullDayEvent: isFullDay,
			recurringEvent: isRecurring,
			class: event.class || 'PUBLIC',
			firstYear: startDate.year(),
			location: event.location || false,
			geo: event.geo || false,
			description: event.description || false,
			url: this.url,
			calendarName: this.config.name,
			color: this.config.color
		};

        // Apply event transformer if configured
        if (typeof this.config.eventTransformer === 'function') {
            eventObj = this.config.eventTransformer(eventObj);
        }

		// Add symbol array like the builtin calendar module
		eventObj.symbol = this.symbolsForEvent(eventObj);
		
		return eventObj;
	}

	/**
	 * Generate symbols for an event (based on builtin calendar module)
	 * @param {object} event Event object
	 * @returns {string[]} Array of symbol class names
	 */
	symbolsForEvent(event) {
		let symbols = this.getSymbolArray(this.config.symbol, this.config.defaultSymbol || 'calendar-alt');

		// Add symbols for recurring events
		if (event.recurringEvent === true && this.config.recurringSymbol) {
			symbols = this.mergeUniqueSymbols(this.getSymbolArray(this.config.recurringSymbol, this.config.defaultSymbol || 'calendar-alt'), symbols);
		}

		// Add symbols for full day events
		if (event.fullDayEvent === true && this.config.fullDaySymbol) {
			symbols = this.mergeUniqueSymbols(this.getSymbolArray(this.config.fullDaySymbol, this.config.defaultSymbol || 'calendar-alt'), symbols);
		}

		// Apply custom symbols based on title keywords
		if (this.config.customEvents) {
			for (let customEvent of this.config.customEvents) {
				if (typeof customEvent.symbol !== "undefined" && customEvent.symbol !== "") {
					let needle = new RegExp(customEvent.keyword, "gi");
					if (needle.test(event.title)) {
						// Get the default prefix for this class name and add to the custom symbol provided
						const className = this.config.symbolClassName || this.config.defaultSymbolClassName || 'fas fa-';
						symbols[0] = className + customEvent.symbol;
						break;
					}
				}
			}
		}

		return symbols;
	}

	/**
	 * Get symbol array from config value
	 * @param {string|string[]} symbolConfig Symbol configuration
	 * @param {string} defaultSymbol Default symbol if none specified
	 * @returns {string[]} Array of symbol class names
	 */
	getSymbolArray(symbolConfig, defaultSymbol) {
		if (Array.isArray(symbolConfig)) {
			return symbolConfig.slice(); // Return copy of array
		} else if (typeof symbolConfig === 'string') {
			return [(this.config.symbolClassName || this.config.defaultSymbolClassName || 'fas fa-') + symbolConfig];
		} else {
			return [(this.config.symbolClassName || this.config.defaultSymbolClassName || 'fas fa-') + defaultSymbol];
		}
	}

	/**
	 * Merge symbol arrays, keeping unique values
	 * @param {string[]} array1 First array
	 * @param {string[]} array2 Second array
	 * @returns {string[]} Merged unique array
	 */
	mergeUniqueSymbols(array1, array2) {
		const merged = [...array1];
		for (const item of array2) {
			if (!merged.includes(item)) {
				merged.push(item);
			}
		}
		return merged;
	}

	/**
	 * Determine if event is a full day event
	 * @param {object} event Event data
	 * @param {moment} startDate Start date
	 * @param {moment} endDate End date
	 * @returns {boolean} True if full day event
	 */
	isFullDayEvent(event, startDate, endDate) {
		// First check Microsoft all-day event flag - this is most reliable
		if (event['X-MICROSOFT-CDO-ALLDAYEVENT'] === 'TRUE') {
			return true;
		}
		
		// Explicitly check for FALSE flag to avoid false positives
		if (event['X-MICROSOFT-CDO-ALLDAYEVENT'] === 'FALSE') {
			return false;
		}
		
		// Check if the original event has DATE-only fields (no time component)
		// This is the most reliable indicator of a full-day event
		if (event.start && event.start.dateOnly) {
			return true;
		}
		
		// Use the moment.js parsed times (startDate/endDate parameters) instead of raw event times
		// since node-ical might parse Microsoft timezones incorrectly
		const startIsLocalMidnight = startDate.hour() === 0 && startDate.minute() === 0 && startDate.second() === 0;
		const endIsLocalMidnight = endDate.hour() === 0 && endDate.minute() === 0 && endDate.second() === 0;
		const durationHours = endDate.diff(startDate, 'hours');
		const isExact24Hours = durationHours === 24;
		const isMidnightFullDay = startIsLocalMidnight && endIsLocalMidnight && isExact24Hours;
		
		return isMidnightFullDay;
		
		return isMidnightFullDay;
	}

	/**
	 * Schedule next fetch
	 */
	scheduleNextFetch() {
		this.clearTimer();
		
		Log.debug(`[CalendarFetcher] Scheduling next fetch for ${this.config.name} in ${this.config.fetchInterval/1000}s`);
		
		this.reloadTimer = setTimeout(() => {
			this.fetchCalendar();
		}, this.config.fetchInterval);
	}

	/**
	 * Schedule retry with exponential backoff
	 */
	scheduleRetry() {
		this.clearTimer();
		
		if (this.retryCount >= this.maxRetries) {
			Log.error(`[CalendarFetcher] Max retries reached for ${this.config.name}`);
			return;
		}

		// Exponential backoff: 1min, 2min, 4min, 8min, 16min
		const delay = Math.min(60000 * Math.pow(2, this.retryCount), 16 * 60000);
		this.retryCount++;
		
		Log.warn(`[CalendarFetcher] Retrying ${this.config.name} in ${delay/1000}s (attempt ${this.retryCount}/${this.maxRetries})`);
		
		this.reloadTimer = setTimeout(() => {
			this.fetchCalendar();
		}, delay);
	}

	/**
	 * Clear existing timer
	 */
	clearTimer() {
		if (this.reloadTimer) {
			clearTimeout(this.reloadTimer);
			this.reloadTimer = null;
		}
	}

	/**
	 * Set success callback
	 * @param {Function} callback Success callback
	 */
	onReceive(callback) {
		this.eventsReceivedCallback = callback;
	}

	/**
	 * Set error callback
	 * @param {Function} callback Error callback
	 */
	onError(callback) {
		this.fetchFailedCallback = callback;
	}
}
