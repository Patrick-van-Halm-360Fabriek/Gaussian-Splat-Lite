import type {
  RadPreparedSelection,
  RadSelectionSnapshot,
} from "../../../data/RadPagedSplats.js";
import type { RadStreamSelection } from "./radFade.js";
import type { RadLodChunk } from "./radLod.js";
export type RadSelectionChunk = Pick<
  RadLodChunk,
  "sourceToStorage" | "boundsBlocks"
>;
export type RadSelectionPreparation = {
  selection: Omit<RadStreamSelection, "fade">;
  fade: boolean;
  pools: RadPreparedSelection[];
};
/** The scheduler snapshots and pins resident pages before dispatching this work. */
export declare function prepareRadSelection(
  request: {
    selection: RadStreamSelection;
    pools: RadSelectionSnapshot[];
  },
  chunks: ReadonlyMap<number, RadSelectionChunk>,
): RadSelectionPreparation;
