/**
 * Every word the settings screen and its entry points put in front of a user.
 *
 * Gathered here when the screen became a component both roles' routes render
 * (issue #164). They were literals inside a route file until then, which was
 * defensible while the screen was the only thing that used them and stops
 * being so the moment a tab label and a screen heading have to agree.
 *
 * **A first draft, like every other `*-copy.ts` in this app.** CLAUDE.md §17
 * keeps words with the owner; these are the plainest factual Azerbaijani that
 * makes the screen usable until real copy and a real localisation layer exist.
 */
export const SETTINGS_COPY = {
  title: 'Tənzimləmələr',

  /**
   * The customer's tab label, deliberately the same word as the heading.
   * A tab that says one thing and opens a screen titled another makes the user
   * check whether they arrived where they meant to.
   */
  tab: 'Tənzimləmələr',

  /**
   * The master's way in is an icon, and an icon-only control is invisible to a
   * screen reader without this (`IconButton` requires it for that reason).
   */
  openLabel: 'Tənzimləmələri aç',

  roleHeading: 'Rejim',
  roleCustomer: 'Müştəri',
  roleMaster: 'Usta',

  appearanceHeading: 'Görünüş',
  schemeLight: 'İşıqlı',
  schemeDark: 'Qaranlıq',
  schemeSystem: 'Sistem',

  accountHeading: 'Hesab',
  addresses: 'Ünvanlarım',

  signOut: 'Çıxış',
  signOutEverywhere: 'Bütün cihazlardan çıx',
} as const;
