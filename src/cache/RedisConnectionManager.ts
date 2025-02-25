import { type RedisClientType, createClient } from "redis";
import { initializeClientEvents } from "../utils/util";

export class RedisConnectionManager {
    private dataClient!: RedisClientType;
    private invalidationClient!: RedisClientType;

    constructor(
        private uri: string,
        private onError: (error: Error) => void,
        private onConnectionLost: () => void,
    ) {
        this.initializeClients();
    }

    initializeClients() {
        this.dataClient = createClient({ url: this.uri });
        this.invalidationClient = createClient({ url: this.uri });

        initializeClientEvents(this.dataClient, this.onError, this.onConnectionLost);
        initializeClientEvents(this.invalidationClient, this.onError, this.onConnectionLost);
    }

    async connectClients() {
        await Promise.all([this.dataClient.connect(), this.invalidationClient.connect()]);

        return this.invalidationClient;
    }

    async closeClients() {
        if (this.dataClient) {
            await this.dataClient.quit();
        }
        if (this.invalidationClient) {
            await this.invalidationClient.quit();
        }
    }

    getDataClient() {
        return this.dataClient;
    }

    getInvalidationClient() {
        return this.invalidationClient;
    }
}
