import type { AdminRole } from '@tezusta/types';

/**
 * Every string the admin panel shows, in one place so it can be translated
 * later. English placeholder copy: the panel is internal staff tooling, and
 * its languages are part of the open "languages at launch" decision.
 */
export const copy = {
  appName: 'TezUsta Admin',
  adminLabel: 'Admin',

  signIn: {
    title: 'Sign in',
    email: 'Email',
    password: 'Password',
    code: 'Authenticator code',
    codeHint: 'The 6-digit code from your authenticator app.',
    submit: 'Sign in',
    submitting: 'Signing in…',
    failed: 'Sign-in failed. Check your email, password and code.',
    rateLimited: 'Too many attempts. Wait a few minutes and try again.',
    unexpected: 'Something went wrong. Try again.',
    codeFormat: 'Enter the 6-digit code.',
    setupComplete: 'Your account is ready. Sign in with your new password and a fresh code.',
    passwordReset: 'Your password is set. Sign in with it and a fresh code.',
    sessionEnded: 'Your session has ended. Sign in again.',
  },

  setup: {
    title: 'Set up your admin account',
    loading: 'Checking your setup link…',
    account: 'Account',
    scanTitle: 'Add TezUsta to your authenticator app',
    scanHint: 'Scan this QR code with an authenticator app, or type the key below into it by hand.',
    qrLabel: 'QR code for your authenticator app',
    secretLabel: 'Setup key',
    password: 'Password',
    passwordHint: '12 to 128 characters. Use a passphrase you do not use anywhere else.',
    confirmPassword: 'Repeat password',
    code: 'Code from your authenticator',
    submit: 'Finish setup',
    submitting: 'Finishing…',
    passwordLength: 'The password must be 12 to 128 characters.',
    passwordMismatch: 'The passwords do not match.',
    codeFormat: 'Enter the 6-digit code.',
    codeInvalid:
      'That code was not accepted. Wait for the next code in your authenticator and enter it.',
    restarted:
      'Setup took too long, so a new key was issued. Scan the new QR code and enter a fresh code.',
    linkInvalidTitle: 'This setup link does not work',
    linkInvalid:
      'It may have expired, been used already, or been copied incompletely. Ask a super admin for a new link.',
    rateLimited: 'Too many attempts. Wait a few minutes and try again.',
    unexpected: 'Something went wrong. Try again.',
    // A password-reset link (#329): the authenticator stays, so no QR code.
    resetTitle: 'Set a new password',
    resetIntro:
      'A super admin reset your password. Choose a new one, and confirm it is you with a code from the authenticator you already use for TezUsta.',
    resetSubmit: 'Set password',
    resetSubmitting: 'Saving…',
  },

  passwordChange: {
    title: 'Change your password',
    intro: 'Your other sessions end when the password changes. This one stays signed in.',
    current: 'Current password',
    next: 'New password',
    nextHint: '12 to 128 characters. Use a passphrase you do not use anywhere else.',
    confirm: 'Repeat new password',
    code: 'Code from your authenticator',
    submit: 'Change password',
    submitting: 'Changing…',
    cancel: 'Cancel',
    close: 'Close',
    done: 'Your password is changed. Your other sessions have been signed out.',
    currentEmpty: 'Enter your current password.',
    passwordLength: 'The password must be 12 to 128 characters.',
    passwordMismatch: 'The passwords do not match.',
    codeFormat: 'Enter the 6-digit code.',
    invalid:
      'The current password or the code was not accepted. Check both, and wait for a fresh code.',
    rateLimited: 'Too many attempts. Wait a few minutes and try again.',
    unexpected: 'Something went wrong. Try again.',
  },

  shell: {
    navLabel: 'Main navigation',
    signOut: 'Sign out',
    signingOut: 'Signing out…',
    changePassword: 'Change password',
    signOutFailed: 'Sign-out failed. Try again.',
    loading: 'Loading…',
    loadFailed: 'The panel could not load your account.',
    retry: 'Try again',
    noAccessTitle: 'You do not have access to this page',
    noAccess: 'Your role does not include this area. Ask a super admin if you need it.',
    notFoundTitle: 'Page not found',
    comingIn: (issue: number) => `This page is coming in #${String(issue)}.`,
  },

  nav: {
    dashboard: 'Dashboard',
    masters: 'Masters',
    customers: 'Customers',
    orders: 'Orders',
    reports: 'Reports',
    disputes: 'Disputes',
    catalogue: 'Catalogue',
    subscription: 'Subscription',
    reviews: 'Reviews',
    portfolio: 'Portfolio',
    audit: 'Audit log',
    admins: 'Admins',
  },

  roles: {
    support: 'Support',
    moderator: 'Moderator',
    finance: 'Finance',
    super_admin: 'Super admin',
  } satisfies Record<AdminRole, string>,
} as const;
