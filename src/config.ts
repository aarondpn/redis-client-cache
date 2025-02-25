import { MsgpackSerializer } from "./serializers/MsgpackSerializer";
import type { CacheConfig } from "./types";

export const defaultConfig = {
    ttl: "1 hour",
    prefix: "cache:",
    serializer: new MsgpackSerializer(),
    scanKeysCount: 10000,
} satisfies Omit<CacheConfig, "uri" | "localCacheManager">;
