import type { Platform } from "../platform";
// Workers always receive explicit bindings. Never silently fall back to local disk/Bun.
export const defaultPlatform: Platform | undefined = undefined;
