# MMM-CalendarExt3Agenda Self-Contained Configuration Example

Your module now supports self-contained calendar fetching! Here's how to configure it:

## Basic Self-Contained Configuration

```javascript
{
  module: "MMM-CalendarExt3Agenda",
  position: "top_left",
  header: "My Calendar",
  config: {
    instanceId: "myCalendar",
    locale: 'en-US',
    startDayIndex: -1,
    endDayIndex: 10,
    
    // Self-contained calendar configuration
    useExternalCalendarModule: false, // Use built-in fetching
    calendars: [
      {
        name: "Personal",
        url: "https://calendar.google.com/calendar/ical/your-calendar-id/basic.ics",
        color: "#1f77b4",
        fetchInterval: 60000, // 1 minute
        maximumEntries: 20,
        auth: {
          // Optional authentication
          user: "username",
          pass: "password"
          // OR for Bearer token:
          // method: "bearer",
          // pass: "your-bearer-token"
        }
      },
      {
        name: "Work Calendar", 
        url: "https://outlook.live.com/owa/calendar/00000000-0000-0000-0000-000000000000/reachcalendar/calendar.ics",
        color: "#ff7f0e",
        fetchInterval: 300000, // 5 minutes
        excludedEvents: ["Private", "Personal"]
      },
      {
        name: "Holidays",
        url: "webcal://www.calendarlabs.com/ical-calendar/ics/76/US_Holidays.ics", 
        color: "#2ca02c",
        fetchInterval: 86400000 // 24 hours
      }
    ],
    
    // Global calendar settings
    fetchInterval: 60000, // Default fetch interval
    maximumEntries: 10,
    maximumNumberOfDays: 365,
    pastDaysCount: 1, // Show events from 1 day ago
    broadcastPastEvents: true,
    excludedEvents: [],
    
    // Symbol configuration (FontAwesome icons)
    defaultSymbol: "calendar-alt", // Default icon for events
    defaultSymbolClassName: "fas fa-", // CSS class prefix
    recurringSymbol: "fa-repeat", // Icon for recurring events
    fullDaySymbol: "fa-clock", // Icon for full day events
    customEvents: [
      {
        keyword: "meeting", // Text to match in event title
        symbol: "users" // FontAwesome icon name (without prefix)
      },
      {
        keyword: "birthday",
        symbol: "birthday-cake"
      }
    ]
  }
}
```

## Legacy External Calendar Module Configuration

If you want to continue using the old notification-based system with the builtin calendar module:

```javascript
{
  module: "MMM-CalendarExt3Agenda",
  position: "top_left", 
  config: {
    instanceId: "legacyCalendar",
    useExternalCalendarModule: true, // Use external calendar notifications
    
    // Standard MMM-CalendarExt3Agenda options
    startDayIndex: 0,
    endDayIndex: 10,
    calendarSet: ['calendar1', 'calendar2'] // Filter specific calendars
  }
}
```

And you still need the separate calendar module:

```javascript
{
  module: "calendar",
  header: "Calendar",
  position: "top_left",
  config: {
    broadcastPastEvents: true,
    calendars: [
      {
        url: "your-calendar-url.ics",
        name: "calendar1"
      }
    ]
  }
}
```

## Calendar Configuration Options

### Per-Calendar Options
- `name`: Display name for the calendar
- `url`: iCal/CalDAV URL (supports webcal://, http://, https://)
- `color`: Color for events from this calendar
- `fetchInterval`: How often to fetch this calendar (milliseconds)
- `maximumEntries`: Max events to fetch from this calendar
- `maximumNumberOfDays`: Max days in future to fetch
- `pastDaysCount`: How many days in past to include
- `broadcastPastEvents`: Include past events
- `excludedEvents`: Array of strings/patterns to exclude
- `auth`: Authentication object (see examples above)
- `selfSignedCert`: Accept self-signed certificates

### Global Options
- `useExternalCalendarModule`: false = self-contained, true = use external notifications
- `calendars`: Array of calendar configurations
- `fetchInterval`: Default fetch interval for all calendars
- `maximumEntries`: Default max entries
- `maximumNumberOfDays`: Default max days
- `pastDaysCount`: Default past days
- `broadcastPastEvents`: Default past events setting
- `excludedEvents`: Default excluded events

## Features Added

✅ **Self-contained calendar fetching** - No dependency on builtin calendar module
✅ **Multiple calendar support** - Fetch from multiple sources  
✅ **Comprehensive logging** - Backend and frontend logging
✅ **Error handling** - Retry with exponential backoff
✅ **Authentication support** - Basic auth and Bearer tokens
✅ **Per-calendar configuration** - Different settings per calendar
✅ **Backward compatibility** - Can still use external calendar module

## Dependencies Added

The following npm packages were added:
- `node-ical`: ^0.18.0 - For parsing iCal data
- `moment-timezone`: ^0.5.45 - For date/time handling

## Logging

The module now provides comprehensive logging:

**Frontend (browser console):**
- Configuration validation
- Event reception from backend  
- Calendar fetching status

**Backend (MagicMirror logs):**
- Calendar fetch attempts and results
- Event parsing and filtering
- Error details and retry attempts
- Performance metrics
