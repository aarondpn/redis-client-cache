import { commandOptions } from "redis";
import { setTimeout } from "node:timers/promises";
import { defaultConfig } from "../config";
import { CacheError } from "../utils/errors";
import { debuglog } from "node:util";
import EventEmitter from "node:events";
import { RedisConnectionManager } from "./RedisConnectionManager";
import type { CacheConfig, ILocalCacheManager, SetOptions } from "../types";
import ms from "ms";

const debug = debuglog("redis-cache:core");
const CACHING_IN_PROGRESS = Symbol("caching-in-progress");

export class RedisCacheClient<LocalCache extends ILocalCacheManager> extends EventEmitter {
    private invalidationClientId: number | null = null;
    private config: Required<CacheConfig>;

    private localCacheManager: ILocalCacheManager;
    private redisConnectionManager: RedisConnectionManager;

    private reconnecting = false;
    private connected = false;

    #ttl: number;

    public constructor(config: CacheConfig<LocalCache>) {
        super();

        this.config = { ...defaultConfig, ...config };

        if (!this.config.prefix.endsWith(":")) {
            this.config.prefix += ":";
        }

        // Convert the TTL to seconds (minimum 1 second)
        this.#ttl = this.getTtlFromString(this.config.ttl);

        this.localCacheManager = this.config.localCacheManager;
        this.redisConnectionManager = new RedisConnectionManager(
            this.config.uri,
            this.handleClientError.bind(this),
            this.handleConnectionLost.bind(this),
        );
    }

    public async connect() {
        try {
            await this.redisConnectionManager.connectClients();
            await this.configureTracking();
            this.connected = true;
        } catch (err) {
            this.emit("error", err);
            await this.attemptReconnect();
        }

        return this;
    }

    private async handleConnectionLost() {
        this.connected = false;

        // Attempt reconnection if not already in progress
        if (!this.reconnecting) {
            this.emit("reconnecting");
            await this.attemptReconnect();
        }
    }

    private async attemptReconnect() {
        this.reconnecting = true;

        while (this.reconnecting) {
            try {
                try {
                    await this.close();
                } catch (err) {
                    this.emit("error", err);
                }

                await this.connect();
                this.reconnecting = false;
            } catch (err) {
                this.emit("error", err);
                await setTimeout(1000);
                this.attemptReconnect();
            }
        }
    }

    private async handleClientError(error: Error) {
        this.emit("error", error);
        this.localCacheManager.clear();
    }

    private async configureTracking() {
        const dataClient = this.redisConnectionManager.getDataClient();
        const invalidationClient = this.redisConnectionManager.getInvalidationClient();

        this.invalidationClientId = await invalidationClient.sendCommand(["CLIENT", "ID"]);

        if (!this.invalidationClientId) {
            throw CacheError.MissingClientId();
        }

        await dataClient.sendCommand([
            "CLIENT",
            "TRACKING",
            "ON",
            "REDIRECT",
            this.invalidationClientId.toString(),
            "NOLOOP",
        ]);

        await invalidationClient.subscribe("__redis__:invalidate", (message) => {
            if (message === null) {
                return;
            }

            if (Array.isArray(message)) {
                this.handleInvalidation(message);
            }
        });
    }

    private generateKey(key: string): string {
        return `${this.config.prefix}${key}`;
    }

    private handleInvalidation(keys: string[]) {
        for (const key of keys) {
            debug("Invalidating key: %s", key);
            this.localCacheManager.delete(key);
        }
    }

    async mset<T>(entries: [key: string, value: T][], options?: SetOptions): Promise<void> {
        this.isReady();

        if (Object.keys(entries).length === 0) {
            return;
        }

        const ttl = options?.ttl ? this.getTtlFromString(options.ttl) : this.#ttl;
        const dataClient = this.redisConnectionManager.getDataClient();

        const serializedEntries = entries.map(([key, value]) => {
            const fullKey = this.generateKey(key);
            const serializedValue = this.config.serializer.serialize(value);

            this.localCacheManager.set(fullKey, value, this.convertOptions(options));

            return [fullKey, serializedValue] as const;
        });

        await Promise.all(serializedEntries.map(([key, value]) => dataClient.set(key, value, { EX: ttl })));
        await dataClient.touch(serializedEntries.map(([key]) => key));
    }

    async set<T>(key: string, value: T, options?: SetOptions): Promise<void> {
        await this.mset([[key, value]], options);
    }

    async mget<T>(...keys: string[]): Promise<Record<string, T | null | undefined>> {
        this.isReady();

        const fullKeys = keys.map((key) => this.generateKey(key));
        const dataClient = this.redisConnectionManager.getDataClient();

        const result: Record<string, T | null | undefined> = {};
        const uncachedKeys: string[] = [];

        for (let i = 0; i < fullKeys.length; i++) {
            const fullKey = fullKeys[i];
            const cachedItem = this.localCacheManager.get(fullKey);

            if (cachedItem !== undefined && cachedItem !== CACHING_IN_PROGRESS) {
                result[keys[i]] = cachedItem;
            } else if (cachedItem === CACHING_IN_PROGRESS) {
                // This key is already being fetched by another request concurrently
                // TODO: maybe recheck the value after a short delay?
                result[keys[i]] = undefined;
            } else {
                uncachedKeys.push(fullKey);
                this.localCacheManager.set(fullKey, CACHING_IN_PROGRESS);
            }
        }

        if (uncachedKeys.length === 0) {
            return result;
        }

        try {
            const cachedValues = await dataClient.mGet(
                commandOptions({
                    returnBuffers: !!this.config.serializer.requiresBuffer,
                }),
                uncachedKeys,
            );

            for (let i = 0; i < uncachedKeys.length; i++) {
                const key = keys[i];
                const fullKey = fullKeys[i];
                const cachedValue = cachedValues[i];

                const cachedItem = this.localCacheManager.get(fullKey);

                if (cachedItem !== CACHING_IN_PROGRESS) {
                    result[key] = cachedValue ?? cachedItem ?? undefined;
                    continue;
                }

                if (cachedValue !== null) {
                    const parsedValue = this.config.serializer.deserialize<T>(cachedValue);
                    this.localCacheManager.set(fullKey, parsedValue);
                    result[key] = parsedValue;
                } else {
                    this.localCacheManager.delete(fullKey);
                    result[key] = undefined;
                }
            }
        } catch (error) {
            this.emit("error", error);

            for (let i = 0; i < uncachedKeys.length; i++) {
                this.localCacheManager.delete(fullKeys[i]);
                result[keys[i]] = undefined;
            }
        }

        return result;
    }

    async get<T>(key: string): Promise<T | null> {
        const result = await this.mget<T>(key);
        return result[key] ?? null;
    }

    async mdel(...keys: string[]): Promise<void> {
        this.isReady();

        const fullKeys = keys.map((key) => this.generateKey(key));
        const dataClient = this.redisConnectionManager.getDataClient();

        await dataClient.del(fullKeys);
        for (const fullKey of fullKeys) {
            this.localCacheManager.delete(fullKey);
        }
    }

    async delete(key: string): Promise<void> {
        await this.mdel(key);
    }

    async clear(): Promise<void> {
        this.isReady();

        const dataClient = this.redisConnectionManager.getDataClient();
        const keys = await dataClient.keys(`${this.config.prefix}*`);
        if (keys.length > 0) {
            await dataClient.del(keys);
        }

        this.localCacheManager.clear();
    }

    async keys(pattern = "*") {
        this.isReady();

        const dataClient = this.redisConnectionManager.getDataClient();
        const prefixLength = this.config.prefix.length;
        const patternWithPrefix = this.generateKey(pattern);
        const keys: Set<string> = new Set();

        for await (const key of dataClient.scanIterator({
            MATCH: patternWithPrefix,
            COUNT: this.config.scanKeysCount,
        })) {
            keys.add(key.slice(prefixLength));
        }

        return Array.from(keys);
    }

    async ttl(key: string): Promise<number> {
        this.isReady();

        const dataClient = this.redisConnectionManager.getDataClient();
        const fullKey = this.generateKey(key);
        const ttl = await dataClient.ttl(fullKey);

        if (ttl === -2) {
            this.localCacheManager.delete(fullKey);
        }

        return ttl;
    }

    async close(): Promise<void> {
        this.isReady();
        await this.redisConnectionManager.closeClients();
        this.connected = false;
        this.localCacheManager.clear();
    }

    async setLocal(key: string, value: any, options?: SetOptions): Promise<void> {
        this.localCacheManager.set(this.generateKey(key), value, this.convertOptions(options));
    }

    private convertOptions(options: SetOptions | undefined) {
        if (!options) {
            return;
        }

        return { ttl: options.ttl ? this.getTtlFromString(options.ttl) * 1000 : undefined };
    }

    private getTtlFromString(ttl: ms.StringValue): number {
        return Math.max(ms(ttl), 1000) / 1000;
    }

    private isReady() {
        if (!this.connected || this.reconnecting) {
            throw CacheError.NotReady();
        }
    }
}
