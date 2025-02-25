import type { RedisClientType } from "redis";

export function initializeClientEvents(
    client: RedisClientType,
    onError: (error: Error) => void,
    onConnectionLost: () => void,
) {
    client.on("error", onError);
    client.on("end", onConnectionLost);
    client.on("close", onConnectionLost);
}
