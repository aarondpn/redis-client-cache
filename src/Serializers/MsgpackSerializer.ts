import { pack, unpack } from "msgpackr";
import type { ISerializer } from "../types";

export class MsgpackSerializer implements ISerializer {
    requiresBuffer = true;

    serialize(value: any): Buffer {
        return pack(value);
    }

    deserialize(value: Buffer): any {
        return unpack(value);
    }
}
