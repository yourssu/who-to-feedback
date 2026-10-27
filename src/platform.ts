import { defaultPlatform } from "#platform-default";
import type { Row } from "./repository";
export interface Platform {
  siteUrl?: string;
  testMode?: boolean;
  trustProxy?: boolean;
  secureCookies: boolean;
  passwordHash(password: string): Promise<string>;
  passwordVerify(password: string, hash: string): Promise<boolean>;
  staticFile(request: Request): Promise<Response>;
  mediaGet(name: string): Promise<Response>;
  mediaPut(name: string, bytes: Uint8Array): Promise<void>;
  mediaDelete(name: string): Promise<void>;
  artifact(value: string | Uint8Array, mime: string): Promise<Response>;
  prepareReports?: (cycle: number) => Promise<void>;
  reportAssets?: { fonts: Record<string, string>; images: Map<string, string> };
}

export function getPlatform(repo: import("./repository").Repository): Platform {
  const platform = repo.platform ?? defaultPlatform;
  if (!platform) throw new Error("Runtime platform bindings are required");
  return platform;
}
