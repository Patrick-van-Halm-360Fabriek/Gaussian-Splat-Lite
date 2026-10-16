import { WorkerRpc } from "../../../runtime/WorkerRpc.js";
import BundledWorker from "./worker.js?worker&inline";
/** Worker assigned traversal, display preparation, or page decoding. */
export class RadStreamWorker extends WorkerRpc {
  constructor(onDispose) {
    super(new BundledWorker(), onDispose);
  }
}
