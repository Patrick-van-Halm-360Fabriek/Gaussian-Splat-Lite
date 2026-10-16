import { prepareRadFade } from "./radFade.js";
const EMPTY_INDICES = new Uint32Array(0);
/** Worker-owned cuts. Requests pin the baseline, displayed and waiting cuts;
 * at most those three plus the new result survive. Replies copy cached buffers. */
export class RadSelectionState {
  constructor() {
    this.cuts = new Map();
    this.nextId = 1;
  }
  prepare(
    meta,
    selected,
    { previousId = 0, displayedId = 0, readyId = 0, fade = false },
  ) {
    const previous = previousId ? this.cuts.get(previousId) : EMPTY_INDICES;
    if (
      !previous ||
      (displayedId && !this.cuts.has(displayedId)) ||
      (readyId && !this.cuts.has(readyId))
    )
      throw new Error("RAD: selection baseline is unavailable");
    // The baseline may still be preparing. Keep the displayed cut for cancellation
    // and the waiting cut for publication while traversal is in flight.
    for (const id of this.cuts.keys()) {
      if (id !== previousId && id !== displayedId && id !== readyId)
        this.cuts.delete(id);
    }
    const transition = prepareRadFade(meta, previous, selected.indices, fade);
    let selectionId = previousId;
    let indices = selected.indices;
    if (transition.changedChunks.length) {
      selectionId = this.nextId++;
      this.cuts.set(selectionId, selected.indices);
      // Preserve the cached cut when transferring the complete result.
      indices = selected.indices.slice();
    }
    let retainedBytes = 0;
    for (const cut of this.cuts.values()) retainedBytes += cut.byteLength;
    return {
      ...selected,
      selectionId,
      indices,
      ...transition,
      retainedBytes,
    };
  }
}
