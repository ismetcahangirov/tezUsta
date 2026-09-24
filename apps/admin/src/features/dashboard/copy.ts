/** The dashboard's strings. English placeholder copy, like the rest of the panel. */
export const dashboardCopy = {
  keyFigures: 'Key figures',
  intro: 'Is the marketplace working? Counts for orders created in the chosen range.',
  rangeLabel: 'Range',
  presets: {
    '24h': 'Last 24 hours',
    '7d': 'Last 7 days',
    '30d': 'Last 30 days',
    '90d': 'Last 90 days',
  },
  refresh: 'Refresh',
  rangeShown: (from: string, to: string) => `${from} – ${to}`,
  loading: 'Loading the dashboard…',
  loadFailed: 'The dashboard could not be loaded.',
  rangeRefused: 'The server refused this range. It allows at most 90 days.',
  retry: 'Try again',
  unfilledNote:
    'Unfilled means no master was found (NO_MASTER_FOUND). It is a supply gap, not a cancellation, and is never counted as one.',

  tiles: {
    created: 'Orders created',
    filled: 'Filled',
    unfilled: 'Unfilled',
    cancelled: 'Cancelled',
    cancelledAfterAccept: 'Cancelled after accept',
    cancelledAfterAcceptNote: 'A master had already accepted',
    searching: 'Searching now',
    searchingNote: 'Right now, whatever the range',
    openDisputes: 'Open disputes',
    mastersAvailable: 'Masters available now',
    mastersAvailableNote: 'Online, active, with a fresh position',
    rate: (rate: string) => `${rate} of created`,
    noRate: 'No orders in range',
    oldest: (age: string) => `Oldest open for ${age}`,
    noDisputes: 'None open',
  },

  tables: {
    unfilledByCategory: 'Unfilled orders by category',
    unfilledByArea: 'Unfilled orders by area',
    mastersByArea: 'Masters available now by area',
    cancelledBy: 'Cancellations by who cancelled',
    category: 'Category',
    area: 'Area centre (lat, lng)',
    count: 'Count',
    cancelledByWhom: 'Cancelled by',
    map: 'Map',
    openInMaps: 'Open in Google Maps',
    none: 'Nothing in this range.',
    areaNote: (degrees: string) =>
      `An area is a ${degrees}° grid cell (about 2 km across in Baku), shown by its centre.`,
  },

  actors: {
    customer: 'Customer',
    master: 'Master',
    admin: 'Admin',
    system: 'System',
  } as Readonly<Record<string, string>>,

  age: {
    days: (days: number, hours: number) => `${String(days)} d ${String(hours)} h`,
    hours: (hours: number, minutes: number) => `${String(hours)} h ${String(minutes)} min`,
    minutes: (minutes: number) => `${String(minutes)} min`,
  },
} as const;
