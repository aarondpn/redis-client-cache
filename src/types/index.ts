import type ms from "ms";

export type TTL = ms.StringValue;

export interface ISerializer {
    requiresBuffer?: boolean;
    serialize(value: any): Buffer | string;
    deserialize<T>(value: Buffer | string): T;
}

export interface SetOptions {
    ttl?: TTL;
}

export interface ILocalCacheManager {
    get(key: string): any;
    set(key: string, value: any, options?: { ttl?: number }): void;
    delete(key: string): void;
    clear(): void;
}

export interface CacheConfig<CacheManager extends ILocalCacheManager = ILocalCacheManager> {
    uri: string;
    ttl?: TTL;
    prefix?: string;
    serializer?: ISerializer;
    localCacheManager: CacheManager;
    scanKeysCount?: number;
}
