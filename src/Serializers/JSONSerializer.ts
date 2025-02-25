import type { ISerializer } from "../types";

export class JSONSerializer<SerializedType extends "buffer" | "string"> implements ISerializer {
    constructor(private type: "buffer" | "string" = "string") {}

    serialize(value: any): SerializedType extends "buffer" ? Buffer : string {
        if (this.type === "buffer") {
            return Buffer.from(JSON.stringify(value)) as any;
        }
        return JSON.stringify(value) as any;
    }

    deserialize(value: SerializedType extends "buffer" ? Buffer : string): any {
        return JSON.parse(value.toString());
    }
}
