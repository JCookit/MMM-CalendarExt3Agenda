// Example configuration for testing MMM-CalendarExt3Agenda with self-contained calendar fetching
// Add this to your MagicMirror config.js modules array

{
  module: "MMM-CalendarExt3Agenda",
  position: "top_left",
  header: "My Calendar",
  config: {
    instanceId: "testCalendar",
    locale: 'en-US',
    startDayIndex: -1,
    endDayIndex: 10,
    
    // Self-contained calendar configuration
    useExternalCalendarModule: false, // Use built-in fetching
    calendars: [
      {
        name: "US Holidays",
        url: "https://www.calendarlabs.com/ical-calendar/ics/76/US_Holidays.ics",
        color: "#2ca02c",
        fetchInterval: 3600000, // 1 hour
        maximumEntries: 10
      }
      // Add more calendars here as needed:
      // {
      //   name: "Personal",
      //   url: "https://calendar.google.com/calendar/ical/your-calendar-id/basic.ics",
      //   color: "#1f77b4",
      //   fetchInterval: 300000, // 5 minutes
      //   auth: {
      //     user: "username",
      //     pass: "password"
      //   }
      // }
    ],
    
    // Global settings
    fetchInterval: 300000, // Default: 5 minutes
    maximumEntries: 10,
    maximumNumberOfDays: 30,
    pastDaysCount: 1,
    broadcastPastEvents: true,
    
    // Symbol configuration
    defaultSymbol: "calendar-alt", // FontAwesome icon name
    defaultSymbolClassName: "fas fa-", // CSS class prefix
    recurringSymbol: "fa-repeat", // Icon for recurring events
    fullDaySymbol: "fa-clock", // Icon for full day events
    customEvents: [
      {
        keyword: "meeting",
        symbol: "users"
      },
      {
        keyword: "birthday",
        symbol: "birthday-cake"
      }
    ]
  }
}
