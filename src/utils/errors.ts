export class CacheError extends Error {
    constructor(
        message: string,
        public code: string,
    ) {
        super(message);
        this.name = "CacheError";
    }

    static NotReady() {
        return new CacheError(
            "The cache is not ready yet. Please wait for the cache to be ready.",
            "CACHE_NOT_READY",
        );
    }

    static MissingClientId() {
        return new CacheError("Missing client id.", "MISSING_CLIENT_ID");
    }

    static PingError() {
        return new CacheError("Client ping error.", "PING_ERROR");
    }
}
