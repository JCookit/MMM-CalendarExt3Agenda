/* global Module Log */

Module.register('MMM-CalendarExt3Agenda', {
  defaults: {
    locale: null, // 'de' or 'en-US' or prefer array like ['en-CA', 'en-US', 'en']
    calendarSet: [],
    startDayIndex: 0,
    endDayIndex: 10,
    onlyEventDays: 0, // 0: show all days regardless of events, n: show only n days which have events.
    instanceId: null,
    firstDayOfWeek: null, // 0: Sunday, 1: Monday
    minimalDaysOfNewYear: null, // When the first week of new year starts in your country.
    cellDateOptions: {
      month: 'short',
      day: 'numeric',
      weekday: 'long'
    },
    eventTimeOptions: {
      timeStyle: 'short'
    },
    eventFilter: (ev) => { return true },
    eventTransformer: (ev) => { return ev },
    refreshInterval: 1000 * 60 * 30,
    waitFetch: 1000 *  5,
    animationSpeed: 1000,
    useSymbol: true,
    useWeather: true,
    weatherLocationName: null,
    showMiniMonthCalendar: true,
    miniMonthTitleOptions: {
      month: 'long',
      year: 'numeric'
    },
    miniMonthWeekdayOptions: {
      weekday: 'short'
    },
    //notification: 'CALENDAR_EVENTS',
    weatherNotification: 'WEATHER_UPDATED',
    weatherPayload: (payload) => { return payload },
    eventNotification: 'CALENDAR_EVENTS',
    eventPayload: (payload) => { return payload },
    useIconify: false,
    weekends: [],
    skipDuplicated: true,
    relativeNamedDayStyle: "narrow", // "narrow" or "short" or "long"

    // NEW: Self-contained calendar fetching options
    calendars: [], // Array of calendar configurations
    fetchInterval: 60000, // Default fetch interval (1 minute)
    maximumEntries: 10,
    maximumNumberOfDays: 365,
    pastDaysCount: 0,
    broadcastPastEvents: true,
    excludedEvents: [],
    
    // Symbol configuration (matching builtin calendar module)
    defaultSymbol: "calendar-alt",
    defaultSymbolClassName: "fas fa-",
    recurringSymbol: "fa-repeat",
    fullDaySymbol: "fa-clock",
    customEvents: [], // Array of {keyword: "", symbol: ""} objects
    
    useExternalCalendarModule: false // Set to true to use old notification-based system
  },

  defaulNotifications: {
    weatherNotification: 'WEATHER_UPDATED',
    weatherPayload: (payload) => { return payload },
    eventNotification: 'CALENDAR_EVENTS',
    eventPayload: (payload) => { return payload },
  },

  getStyles: function () {
    return ['MMM-CalendarExt3Agenda.css']
  },


  regularizeConfig: function (options) {
    const weekInfoFallback = {
      firstDay: 1,
      minDays: 4
    }

    options.locale = Intl.getCanonicalLocales(options.locale ?? config?.locale ?? config?.language)?.[ 0 ] ?? ''
    const calInfo = new Intl.Locale(options.locale)
    if (calInfo?.weekInfo) {
      options.firstDayOfWeek = (options.firstDayOfWeek !== null) ? options.firstDayOfWeek : (calInfo.weekInfo?.firstDay ?? weekInfoFallback.firstDay)
      options.minimalDaysOfNewYear = (options.minimalDaysOfNewYear !== null) ? options.minimalDaysOfNewYear : (calInfo.weekInfo?.minimalDays ?? weekInfoFallback.minDays)
      options.weekends = ((Array.isArray(options.weekends) && options.weekends?.length) ? options.weekends : (calInfo.weekInfo?.weekend ?? [])).map(d => d % 7)
    }

    options.instanceId = options.instanceId ?? this.identifier
    this.notifications = {
      weatherNotification: options.weatherNotification ?? this.defaulNotifications.weatherNotification,
      weatherPayload: (typeof options.weatherPayload === 'function') ? options.weatherPayload : this.defaulNotifications.weatherPayload,
      eventNotification: options.eventNotification ?? this.defaulNotifications.eventNotification,
      eventPayload: (typeof options.eventPayload === 'function') ? options.eventPayload : this.defaulNotifications.eventPayload,
    }

    return options
  },

  start: function () {
    this.activeConfig = this.regularizeConfig({ ...this.config })
    this.originalConfig = { ...this.activeConfig }

    this.eventPool = new Map() // All the events
    //this.storedEvents = [] // regularized active events
    this.forecast = []
    this.calendarFetchingStarted = false

    this.refreshTimer = null

    this._ready = false
    this._pendingNotifications = [] // Queue for early notifications

    // Log calendar configuration
    if (this.activeConfig.calendars && this.activeConfig.calendars.length > 0) {
      Log.info(`[${this.name}] Configured with ${this.activeConfig.calendars.length} calendars in self-contained mode`);
      this.activeConfig.calendars.forEach((cal, index) => {
        Log.info(`[${this.name}] Calendar ${index + 1}: ${cal.name || cal.url}`);
      });
    } else if (this.activeConfig.useExternalCalendarModule) {
      Log.info(`[${this.name}] Using external calendar module notifications`);
    } else {
      Log.warn(`[${this.name}] No calendars configured and external module disabled`);
    }

    let _moduleLoaded = new Promise((resolve, reject) => {
      import('/' + this.file('shared-utilities.js')).then((m) => {
        this.library = m
        //this.library.initModule(this)
        if (this.activeConfig.useIconify) this.library.prepareIconify()
        resolve()
      }).catch((err) => {
        console.error(err)
        reject(err)
      })
    })

    let _domCreated = new Promise((resolve, reject) => {
      this._domReady = resolve
    })

    Promise.allSettled([_moduleLoaded, _domCreated]).then ((result) => {
      this._ready = true
      this.library.loaded = true; // Explicitly set loaded flag
      this.library.prepareMagic()
      
      // Process any queued notifications that came in early
      this._processPendingNotifications();
      
      // Start calendar fetching if we have calendars configured
      if (this.activeConfig.calendars && this.activeConfig.calendars.length > 0 && !this.activeConfig.useExternalCalendarModule) {
        this.startCalendarFetching();
      } else {
        // Even with no calendars, trigger the backend to send empty events
        // so the module can display (e.g., mini-calendar)
        if (!this.activeConfig.useExternalCalendarModule) {
          this.startCalendarFetching();
        }
      }
      
      //let {payload, sender} = result[1].value
      //this.fetch(payload, sender)
      setTimeout(() => {
        this.updateDom(100) // Use short animation during initialization
      }, this.activeConfig.waitFetch)
    })
  },

  /**
   * Process any socket notifications that came in before the module was ready
   */
  _processPendingNotifications: function() {
    if (this._pendingNotifications.length > 0) {
      Log.info(`[${this.name}] Processing ${this._pendingNotifications.length} pending notifications`);
      this._pendingNotifications.forEach(item => {
        this._handleSocketNotification(item.notification, item.payload);
      });
      this._pendingNotifications = [];
    }
  },

  /**
   * Handle socket notifications (used for both immediate and queued processing)
   */
  _handleSocketNotification: function(notification, payload) {
    if (notification === "CALENDAR_EVENTS_FETCHED") {
      Log.info(`[${this.name}] Received ${payload.events.length} events from calendar: ${payload.calendarName} (calendarId: ${payload.calendarId})`);
      
      if (payload.events.length > 0) {
        payload.events.forEach((event, index) => {
          Log.info(`[${this.name}] Event ${index + 1}: ${event.title}`);
        });
      }
      
      // Store events in eventPool using calendarId as key
      this.eventPool.set(payload.calendarId, JSON.parse(JSON.stringify(payload.events)));
      
      Log.info(`[${this.name}] EventPool now has ${this.eventPool.size} calendars with total events: ${Array.from(this.eventPool.values()).reduce((sum, events) => sum + events.length, 0)}`);
      
      // Update the display
      this.updateDom(100); // Use short animation to avoid race conditions
      
    } else if (notification === "CALENDAR_FETCH_ERROR") {
      Log.error(`[${this.name}] Calendar fetch error for ${payload.calendarName}: ${payload.error}`);
      
      // You could show an error indicator in the UI here if desired
      // For now, we'll just log it
    }
  },

  notificationReceived: function(notification, payload, sender) {
    // Only listen for external calendar events if explicitly configured to do so
    if (this.activeConfig.useExternalCalendarModule && notification === this.notifications.eventNotification) {
      Log.info(`[${this.name}] Received external calendar events from ${sender.identifier}`);
      let convertedPayload = this.notifications.eventPayload(payload)
      this.eventPool.set(sender.identifier, JSON.parse(JSON.stringify(convertedPayload)))
    }

    if (notification === 'MODULE_DOM_CREATED') {
      this._domReady()
    }

    if (notification === this.notifications.weatherNotification) {
      let convertedPayload = this.notifications.weatherPayload(payload)
      if (
        (this.activeConfig.useWeather
          && ((this.activeConfig.weatherLocationName && convertedPayload.locationName.includes(this.activeConfig.weatherLocationName))
          || !this.activeConfig.weatherLocationName))
        && (Array.isArray(convertedPayload?.forecastArray) && convertedPayload?.forecastArray.length)
      ) {
        this.forecast = [...convertedPayload.forecastArray].map((o) => {
          let d = new Date(o.date)
          o.dateId = d.toLocaleDateString('en-CA')
          return o
        })
      } else {
        if (this.activeConfig.weatherLocationName && !convertedPayload.locationName.includes(this.activeConfig.weatherLocationName)) {
          Log.warn(`"weatherLocationName: '${this.activeConfig.weatherLocationName}'" doesn't match with location of weather module ('${convertedPayload.locationName}')`)
        }
      }
    }

    const replyCurrentConfig = (payload) => {
      if (typeof payload?.callback === 'function') {
        payload.callback(this.activeConfig)
      }
    }

    if (payload?.instanceId && payload?.instanceId !== this.activeConfig?.instanceId) return

    if (notification === 'CX3A_GET_CONFIG') {
      replyCurrentConfig(payload)
    }

    if (notification === 'CX3A_SET_CONFIG') {
      this.activeConfig = this.regularizeConfig({ ...this.activeConfig, ...payload })
      this.updateDom(this.activeConfig.animationSpeed)
      replyCurrentConfig(payload)
    }

    if (notification === 'CX3A_RESET') {
      this.activeConfig = this.regularizeConfig({ ...this.originalConfig })
      this.updateDom(this.activeConfig.animationSpeed)
      replyCurrentConfig(payload)
    }
  },

  getDom: function() {
    let dom = document.createElement('div')
    dom.innerHTML = ""
    dom.classList.add('bodice', 'CX3A_' + this.instanceId, 'CX3A')
    if (this.activeConfig.fontSize) dom.style.setProperty('--fontsize', this.activeConfig.fontSize)
    if (!this.library?.loaded) {
      Log.warn('[CX3A] Module is not prepared yet, wait a while.')
      return dom
    }
    dom = this.draw(dom, this.activeConfig)

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    this.refreshTimer = setTimeout(() => {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
      this.updateDom(this.activeConfig.animationSpeed)
    }, this.activeConfig.refreshInterval)
    return dom
  },


  draw: function (dom, options) {
    if (!this.library?.loaded) return dom
    let t = new Date(Date.now())
    const moment = new Date(t.getFullYear(), t.getMonth(), t.getDate())
    const {
      isToday, isThisMonth, isThisYear, getWeekNo, makeWeatherDOM,
      getRelativeDate, prepareEvents, getBeginOfWeek,
      gapFromToday, renderEventAgenda, regularizeEvents
    } = this.library
    dom.innerHTML = ''

    const prepareAgenda = (targetEvents) => {
      const eventsByDate = ({ events, startTime, dayCounts }) => {
        let ebd = events.reduce((days, ev) => {
          let st = new Date(+ev.startDate)
          let et = new Date(+ev.endDate)
          if (et.getTime() <= startTime) {
            return days
          }

          while(st.getTime() < et.getTime()) {
            let day = new Date(st.getFullYear(), st.getMonth(), st.getDate(), 0, 0, 0, 0).getTime()
            if (!days.has(day)) days.set(day, [])
            days.get(day).push(ev)
            st.setDate(st.getDate() + 1)
          }
          return days
        }, new Map())

        let startDay = new Date(+startTime).setHours(0, 0, 0, 0)
        let days = Array.from(ebd.keys()).sort()
        let position = days.findIndex((d) => d >= startDay)

        return days.slice(position, position + dayCounts).map((d) => {
          return {
            date: d,
            events: ebd.get(d)
          }
        })
      }
      let events = []
      let boc = getRelativeDate(moment, options.startDayIndex).valueOf()
      let eoc = getRelativeDate(moment, options.endDayIndex + 1).valueOf()
      let dateIndex = []
      if (options.onlyEventDays >= 1) {
        let ebd = eventsByDate({
          events: targetEvents,
          startTime: boc,
          dayCounts: options.onlyEventDays
        })
        dateIndex = ebd.map((e) => e.date)
        events = [...ebd.reduce((reduced, cur) => {
          for (const e of cur.events) {
            reduced.add(e)
          }
          return reduced
        }, new Set()) ]
      } else {
        events = targetEvents.filter((ev) => {
          const result = !(ev.endDate <= boc || ev.startDate >= eoc)
          return result
        })
        for (let i = options.startDayIndex; i <= options.endDayIndex; i++) {
          dateIndex.push(getRelativeDate(moment, i).getTime())
        }
      }
      return { events, dateIndex }
    }

    const makeCellDom = (d, seq) => {
      let tm = new Date(d.valueOf())
      let cell = document.createElement('div')
      cell.classList.add('cell')
      if (isToday(tm)) cell.classList.add('today')
      if (isThisMonth(tm)) cell.classList.add('thisMonth')
      if (isThisYear(tm)) cell.classList.add('thisYear')
      cell.classList.add(
        'year_' + tm.getFullYear(),
        'month_' + (tm.getMonth() + 1),
        'date_' + tm.getDate(),
        'weekday_' + tm.getDay(),
        'seq_' + seq,
        'week_' + getWeekNo(tm, options)
      )
      options.weekends.forEach((w, i) => {
        if (tm.getDay() % 7 === w % 7) cell.classList.add('weekend', 'weekend_' + (i + 1))
      })
      let h = document.createElement('div')
      h.classList.add('cellHeader')
      let m = document.createElement('div')
      m.classList.add('cellHeaderMain')
      let dayDom = document.createElement('div')
      dayDom.classList.add('cellDay')
      let gap = gapFromToday(tm, options)
      let p = new Intl.RelativeTimeFormat(options.locale, { ...options.relativeNamedDayOptions, numeric: "auto" })
      let pv = new Intl.RelativeTimeFormat(options.locale, { ...options.relativeNamedDayStyle, numeric: "always"})
      if (p.format(gap, "day") !== pv.format(gap, "day")) {
        dayDom.classList.add('relativeDay', 'relativeNamedDay')
      } else {
        dayDom.classList.add('relativeDay')
      }
      dayDom.classList.add('relativeDayGap_' + gap)
      dayDom.innerHTML = p.formatToParts(gap, "day").reduce((prev, cur, curIndex) => {
        prev = prev + `<span class="dateParts ${cur.type} seq_${curIndex} unit_${cur?.unit ?? 'none'}">${cur.value}</span>`
        return prev
      }, '')
      m.appendChild(dayDom)
      let dateDom = document.createElement('div')
      dateDom.classList.add('cellDate')
      let dParts = new Intl.DateTimeFormat(options.locale, options.cellDateOptions).formatToParts(tm)
      dateDom.innerHTML = dParts.reduce((prev, cur, curIndex) => {
        prev = prev + `<span class="dateParts ${cur.type} seq_${curIndex}">${cur.value}</span>`
        return prev
      }, '')
      m.appendChild(dateDom)
      let cwDom = document.createElement('div')
      cwDom.innerHTML = String(getWeekNo(tm, options))
      cwDom.classList.add('cw')
      m.appendChild(cwDom)
      h.appendChild(m)
      let s = document.createElement('div')
      s.classList.add('cellHeaderSub')
      let forecasted = this.forecast.find((e) => {
        return (tm.toLocaleDateString('en-CA') === e.dateId)
      })
      makeWeatherDOM(s, forecasted)
      h.appendChild(s)
      let b = document.createElement('div')
      b.classList.add('cellBody')
      let f = document.createElement('div')
      f.classList.add('cellFooter')
      cell.appendChild(h)
      cell.appendChild(b)
      cell.appendChild(f)
      return cell
    }

    const drawAgenda = ({ events, dateIndex }) => {
      let agenda = document.createElement('div')
      agenda.classList.add('agenda')
      dateIndex = dateIndex.sort((a, b) => a - b)
      for (const [i, date] of dateIndex.entries()) {
        let tm = new Date(date)
        let eotm = new Date(tm.getFullYear(), tm.getMonth(), tm.getDate(), 23, 59, 59, 999)
        let dayDom = makeCellDom(tm, i)
        let body = dayDom.getElementsByClassName('cellBody')[0]
        let {fevs, sevs} = events.filter((ev) => {
          return !(ev.endDate <= tm.getTime() || ev.startDate >= eotm.getTime())
        }).reduce((result, ev) => {
          const target = (ev.isFullday) ? result.fevs : result.sevs
          target.push(ev)
          return result
        }, {fevs: [], sevs: []})
        let eventCounts = fevs.length + sevs.length
        dayDom.dataset.eventsCounts = eventCounts
        if (eventCounts === 0) dayDom.classList.add('noEvents')
        for (const [ key, value ] of Object.entries({ 'fullday': fevs, 'single': sevs })) {
          let tDom = document.createElement('div')
          tDom.classList.add(key)
          for (let e of value) {
            if (e?.skip) continue
            let ev = renderEventAgenda(e, {
              useSymbol: options.useSymbol,
              eventTimeOptions: options.eventTimeOptions,
              locale: options.locale,
              useIconify: options.useIconify,
            }, tm)
            tDom.appendChild(ev)
          }
          body.appendChild(tDom)
        }
        agenda.appendChild(dayDom)
      }
      
      // Create a new DOM structure instead of appending to existing DOM
      let newDom = document.createElement('div')
      newDom.className = dom.className
      newDom.appendChild(agenda)
      return newDom
    }

    const drawMiniMonth = (events) => {
      if (!options.showMiniMonthCalendar) return dom
      const cm = new Date(moment.getFullYear(), moment.getMonth(), moment.getDate() + options.startDayIndex)
      let bwoc = getBeginOfWeek(new Date(cm.getFullYear(), cm.getMonth(), 1), options)
      let ewoc = getBeginOfWeek(new Date(cm.getFullYear(), cm.getMonth() + 1, 0), options)
      let im = new Date(bwoc.getTime())
      let today = new Date(Date.now())
      let view = document.createElement('table')
      view.classList.add('miniMonth')
      let caption = document.createElement('caption')
      caption.innerHTML = new Intl.DateTimeFormat(options.locale, options.miniMonthTitleOptions).formatToParts(cm).reduce((prev, cur, curIndex, arr) => {
        prev = prev + `<span class="calendarTimeParts ${cur.type} seq_${curIndex}">${cur.value}</span>`
        return prev
      }, '')
      view.appendChild(caption)
      let head = document.createElement('thead')
      let weekname = document.createElement('tr')
      let cwh = document.createElement('th')
      cwh.classList.add('cw', 'cell')
      weekname.appendChild(cwh)

      let wm = new Date(im.getTime())
      for (let i = 0; i < 7; i++) {
        let wn = document.createElement('th')
        wn.innerHTML = new Intl.DateTimeFormat(options.locale, options.miniMonthWeekdayOptions).format(wm)
        wn.classList.add(
          'cell',
          'weekname',
          'weekday_' + wm.getDay()
        )
        wn.scope = 'col'
        weekname.appendChild(wn)
        options.weekends.forEach((w, ix) => {
          if (wm.getDay() % 7 === w % 7) wn.classList.add('weekend', 'weekend_' + (ix + 1))
        })
        wm.setDate(wm.getDate() + 1)
      }
      head.appendChild(weekname)
      view.appendChild(head)
      let body = document.createElement('tbody')
      while(im.getTime() <= ewoc.getTime()) {
        let weekline = document.createElement('tr')
        let cw = getWeekNo(im, options)
        let cwc = document.createElement('td')
        let thisWeek = (im.getTime() === getBeginOfWeek(new Date(Date.now()), options).getTime()) ? ['thisWeek'] : []
        cwc.classList.add('cw', 'cell')
        cwc.scope = 'row'
        cwc.innerHTML = cw
        weekline.classList.add('weeks', 'week_' + cw, ...thisWeek)
        weekline.appendChild(cwc)
        let dm = new Date(im.getTime())
        for (let i = 1; i <= 7; i++) {
          let dc = document.createElement('td')
          dc.classList.add(
            'cell',
            'day_' + dm.getDate(),
            'month_' + (dm.getMonth() + 1),
            'year_' + dm.getFullYear(),
            'weekday_' + dm.getDay(),
            (dm.getFullYear() === today.getFullYear()) ? 'thisYear' : null,
            (dm.getMonth() === today.getMonth()) ? 'thisMonth' : null,
            ...thisWeek,
            (dm.getTime() === new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) ? 'today' : null
          )
          options.weekends.forEach((w, ix) => {
            if (dm.getDay() % 7 === w % 7) dc.classList.add('weekend', 'weekend_' + (ix + 1))
          })
          let content = document.createElement('div')
          content.classList.add('dayContent')
          let date = document.createElement('div')
          date.classList.add('date')
          date.innerHTML = dm.getDate()
          let evs = document.createElement('div')
          evs.classList.add('events')
          let edm = new Date(dm.getFullYear(), dm.getMonth(), dm.getDate(), 23, 59, 59, 999)
          events.filter((ev) => {
            return !(+(ev.endDate) <= dm.getTime() || +(ev.startDate) >= edm.getTime())
          }).sort((a, b) => {
            return ((a.endDate - a.startDate) === (b.endDate - b.startDate))
              ? (a.startDate === b.startDate) ? a.endDate - b.endDate : a.startDate - b.startDate
              : (b.endDate - b.startDate) - (a.endDate - a.startDate)
          })
          
          // Categorize events by time of day
          const timeSlots = {
            morning: false,    // 6:00 - 11:59
            afternoon: false,  // 12:00 - 17:59  
            evening: false,    // 18:00 - 23:59 (and 0:00 - 5:59)
            allDay: false,
            calendarColor: null
          }
          
          events.filter((ev) => {
            return !(+(ev.endDate) <= dm.getTime() || +(ev.startDate) >= edm.getTime())
          }).forEach((ev) => {
            if (ev.isFullday) {
              timeSlots.allDay = true
              timeSlots.calendarColor = ev.color
            } else {
              const startHour = new Date(ev.startDate).getHours()
              if (startHour >= 6 && startHour < 12) {
                timeSlots.morning = true
              } else if (startHour >= 12 && startHour < 18) {
                timeSlots.afternoon = true
              } else {
                timeSlots.evening = true
              }
            }
          })
          
          // Create layered dots: background layer for all-day, foreground for time-of-day
          
          // Create background layer for all-day events
          if (timeSlots.allDay) {
            let backgroundLayer = document.createElement('div')
            backgroundLayer.classList.add('eventDotBackground')
            backgroundLayer.style.setProperty('--calendarColor', timeSlots.calendarColor)
            evs.appendChild(backgroundLayer)
          }
          
          // Create foreground dots for time-of-day (always show all three positions)
          const periods = [
            { active: timeSlots.morning, class: 'morning' },
            { active: timeSlots.afternoon, class: 'afternoon' }, 
            { active: timeSlots.evening, class: 'evening' }
          ]
          
          let foregroundLayer = document.createElement('div')
          foregroundLayer.classList.add('eventDotForeground')
          
          periods.forEach(period => {
            let dot = document.createElement('div')
            dot.classList.add('eventDot', period.class)
            if (period.active) {
              dot.innerHTML = '⬤'
            } else {
              dot.innerHTML = '&nbsp;' // Empty space
              dot.classList.add('empty')
            }
            foregroundLayer.appendChild(dot)
          })
          
          evs.appendChild(foregroundLayer)
          content.appendChild(date)
          content.appendChild(evs)
          dc.appendChild(content)
          weekline.appendChild(dc)
          dm.setDate(dm.getDate() + 1)
        }
        body.appendChild(weekline)
        im.setDate(im.getDate() + 7)
      }
      view.appendChild((body))
      dom.appendChild(view)
      return dom
    }

    const sm = new Date(moment.getFullYear(), moment.getMonth(), moment.getDate() + options.startDayIndex)
    const em = new Date(moment.getFullYear(), moment.getMonth(), moment.getDate() + options.endDayIndex)
    const tempPool = new Map()
    this.eventPool.forEach((v, k) => {
      tempPool.set(k, JSON.parse(JSON.stringify(v)))
    })

    const targetEvents = prepareEvents({
      targetEvents: regularizeEvents({
        eventPool: tempPool,
        config: options,
      }),
      config: options,
      range: [
        new Date(sm.getFullYear(), sm.getMonth() - 1, 1).getTime(),
        new Date(em.getFullYear(), em.getMonth() + 2, 1).getTime()
      ]
    })
    const copied = JSON.parse(JSON.stringify(targetEvents))
    
    // Draw mini-calendar first (if enabled)
    if (options.showMiniMonthCalendar) {
      const miniCalDom = drawMiniMonth([...copied])
      dom.appendChild(miniCalDom.querySelector('.miniMonth'))
    }
    
    const agendaData = prepareAgenda([...copied])
    const agendaDom = drawAgenda(agendaData)
    
    // Append agenda to DOM
    if (agendaDom && agendaDom.querySelector('.agenda')) {
      dom.appendChild(agendaDom.querySelector('.agenda'))
    }
    
    return dom
  },

  /**
   * Start self-contained calendar fetching
   */
  startCalendarFetching: function() {
    if (this.calendarFetchingStarted) return;
    
    Log.info(`[${this.name}] Starting self-contained calendar fetching`);
    
    this.calendarFetchingStarted = true;
    
    this.sendSocketNotification("CALENDAR_FETCH_START", {
      instanceId: this.activeConfig.instanceId,
      calendars: this.activeConfig.calendars,
      fetchInterval: this.activeConfig.fetchInterval,
      maximumEntries: this.activeConfig.maximumEntries,
      maximumNumberOfDays: this.activeConfig.maximumNumberOfDays,
      pastDaysCount: this.activeConfig.pastDaysCount,
      broadcastPastEvents: this.activeConfig.broadcastPastEvents,
      excludedEvents: this.activeConfig.excludedEvents,
      eventTransformer: this.activeConfig.eventTransformer
    });
  },

  /**
   * Stop self-contained calendar fetching
   */
  stopCalendarFetching: function() {
    if (!this.calendarFetchingStarted) return;
    
    Log.info(`[${this.name}] Stopping self-contained calendar fetching`);
    
    this.calendarFetchingStarted = false;
    
    this.sendSocketNotification("CALENDAR_FETCH_STOP", {
      instanceId: this.activeConfig.instanceId
    });
  },

  /**
   * Handle socket notifications from node_helper
   */
  socketNotificationReceived: function(notification, payload) {
    if (payload.instanceId !== this.activeConfig.instanceId) {
      return; // Not for this instance
    }

    // If module isn't ready yet, queue the notification for later processing
    if (!this._ready || !this.library?.loaded) {
      Log.info(`[${this.name}] Module not ready yet, queueing notification: ${notification}`);
      this._pendingNotifications.push({ notification, payload });
      return;
    }

    // Process the notification immediately if we're ready
    this._handleSocketNotification(notification, payload);
  },

  /**
   * Override suspend to stop calendar fetching
   */
  // suspend: function() {
  //   Log.info(`[${this.name}] Module suspended`);
  //   this.stopCalendarFetching();
  // },

  /**
   * Override resume to restart calendar fetching
   */
  // resume: function() {
  //   Log.info(`[${this.name}] Module resumed`);
  //   if (this.activeConfig.calendars && this.activeConfig.calendars.length > 0 && !this.activeConfig.useExternalCalendarModule) {
  //     this.startCalendarFetching();
  //   }
  // }
})