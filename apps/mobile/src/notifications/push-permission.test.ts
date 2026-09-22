import { readPushPermission } from './push-permission';

/**
 * The three answers the app acts on, derived from what the platform reports.
 *
 * The iOS cases are the ones worth having: Expo's own documentation says to
 * read `ios.status` rather than the root `granted`, because a provisionally
 * authorised app is one that may deliver notifications and reports
 * `granted: false`. Treating that as "ask again" would put a prompt in front
 * of a user whose notifications already work.
 */
describe('readPushPermission', () => {
  describe('on Android, where the root fields are the whole answer', () => {
    it('reads a granted permission as granted', () => {
      expect(readPushPermission({ granted: true, canAskAgain: false })).toBe('granted');
    });

    it('reads a permission that has never been asked for as askable', () => {
      expect(readPushPermission({ granted: false, canAskAgain: true })).toBe('askable');
    });

    it('reads a refusal that cannot be re-asked as blocked', () => {
      expect(readPushPermission({ granted: false, canAskAgain: false })).toBe('blocked');
    });
  });

  describe('on iOS, where ios.status is the authority', () => {
    it('reads AUTHORIZED as granted', () => {
      expect(readPushPermission({ granted: true, canAskAgain: false, ios: { status: 2 } })).toBe(
        'granted',
      );
    });

    it('reads PROVISIONAL as granted even though the root field says otherwise', () => {
      expect(readPushPermission({ granted: false, canAskAgain: false, ios: { status: 3 } })).toBe(
        'granted',
      );
    });

    it('reads EPHEMERAL as granted', () => {
      expect(readPushPermission({ granted: false, canAskAgain: false, ios: { status: 4 } })).toBe(
        'granted',
      );
    });

    it('reads NOT_DETERMINED as askable', () => {
      expect(readPushPermission({ granted: false, canAskAgain: true, ios: { status: 0 } })).toBe(
        'askable',
      );
    });

    it('reads DENIED as blocked, whatever canAskAgain claims', () => {
      // iOS shows the system prompt once. `canAskAgain` can still report true
      // here, and asking again would do nothing a user could see.
      expect(readPushPermission({ granted: false, canAskAgain: true, ios: { status: 1 } })).toBe(
        'blocked',
      );
    });

    it('reads a status it does not recognise as blocked rather than as askable', () => {
      // A new authorisation state added by a future iOS is not an invitation
      // to prompt. Blocked is the answer that shows the user nothing.
      expect(readPushPermission({ granted: false, canAskAgain: true, ios: { status: 99 } })).toBe(
        'blocked',
      );
    });
  });
});
