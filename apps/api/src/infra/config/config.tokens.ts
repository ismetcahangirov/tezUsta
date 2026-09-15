/**
 * DI token for the validated {@link AppConfig} (`AppConfig` is an interface,
 * not a class, so it cannot be injected by its own type — this token stands
 * in for it, the same way any Nest provider token does).
 */
export const APP_CONFIG = Symbol('APP_CONFIG');
