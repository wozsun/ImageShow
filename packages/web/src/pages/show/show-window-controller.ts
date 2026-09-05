import { ShowDataPool } from "./show-data-pool.js";
import {
  showLayoutColumnWidth,
  showCardGeometry,
  showCardRect,
  showLayoutNoise,
  showRectsIntersect,
  showViewportWindow,
  type ShowCardSlot,
  type ShowImage,
  type ShowPoint,
  type ShowRect,
  type ShowResidencePolicy,
  type ShowSize,
  type ShowViewportWindow
} from "./show-layout.js";

type ShowColumn = {
  cards: ShowCardSlot[];
  generation: number;
  nextTopOrdinal: number;
  nextBottomOrdinal: number;
};

export type ShowWindowSnapshot = {
  activeColumns: number;
  cards: ShowCardSlot[];
  missingCards: number;
  revision: number;
  visibleCards: number;
  window: ShowViewportWindow;
};

const emptyWindow: ShowViewportWindow = {
  visible: { left: 0, top: 0, right: 1, bottom: 1 },
  resident: { left: -1, top: -1, right: 2, bottom: 2 }
};

export class ShowWindowController {
  readonly #columns = new Map<number, ShowColumn>();
  #nextColumnGeneration = 1;
  #revision = 0;
  #missingCards = 0;
  #visibleCards = 0;
  #window = emptyWindow;

  constructor(
    readonly pool: ShowDataPool,
    readonly columnWidth = showLayoutColumnWidth
  ) {}

  reconcile(
    camera: ShowPoint,
    viewport: ShowSize,
    scale: number,
    residence: ShowResidencePolicy
  ) {
    const nextWindow = showViewportWindow(
      camera,
      viewport,
      scale,
      residence
    );
    this.#window = nextWindow;
    this.#missingCards = 0;
    let changed = false;
    // Use a 10% lane margin inside the resident overscan when recycling edge
    // columns, so a tiny overlap does not keep an entire column resident.
    // This is a retention margin, independent of the card's narrow visual gap.
    const firstColumn = Math.floor(
      (nextWindow.resident.left + this.columnWidth * 0.1) / this.columnWidth
    );
    const lastColumn = Math.floor(
      (nextWindow.resident.right - this.columnWidth * 0.1) / this.columnWidth
    );

    // Release first so the same bounded DTO set can populate the entering edge
    // during an arbitrarily long trip.
    for (const [columnIndex, column] of this.#columns) {
      if (columnIndex >= firstColumn && columnIndex <= lastColumn) continue;
      this.#releaseColumn(column);
      this.#columns.delete(columnIndex);
      changed = true;
    }

    for (let columnIndex = firstColumn; columnIndex <= lastColumn; columnIndex += 1) {
      let column = this.#columns.get(columnIndex);
      if (!column) {
        column = this.#createColumn();
        this.#columns.set(columnIndex, column);
        changed = true;
      }
      if (this.#reconcileColumn(
        columnIndex,
        column,
        nextWindow.resident
      )) changed = true;
    }

    let visibleCards = 0;
    for (const column of this.#columns.values()) {
      for (let index = 0; index < column.cards.length; index += 1) {
        const card = column.cards[index];
        const visible = showRectsIntersect(
          showCardRect(card),
          nextWindow.visible
        );
        if (visible) visibleCards += 1;
        if (card.visible === visible) continue;
        column.cards[index] = { ...card, visible };
        changed = true;
      }
    }
    this.#visibleCards = visibleCards;
    if (changed) this.#revision += 1;
    return changed;
  }

  clear() {
    if (!this.#columns.size) {
      this.#nextColumnGeneration = 1;
      return;
    }
    for (const column of this.#columns.values()) this.#releaseColumn(column);
    this.#columns.clear();
    this.#nextColumnGeneration = 1;
    this.#missingCards = 0;
    this.#visibleCards = 0;
    this.#revision += 1;
  }

  removeImage(imageId: string) {
    let changed = false;
    for (const column of this.#columns.values()) {
      if (!column.cards.some((card) => card.image.id === imageId)) continue;
      // Rebuild only the affected column so removing a middle card cannot
      // leave a permanent vertical hole.
      this.#releaseColumn(column);
      column.cards = [];
      column.nextTopOrdinal = -1;
      column.nextBottomOrdinal = 1;
      changed = true;
    }
    this.pool.remove(imageId);
    if (changed) this.#revision += 1;
    return changed;
  }

  updateImages(images: ReadonlyMap<string, ShowImage>) {
    let changed = false;
    for (const column of this.#columns.values()) {
      for (let index = 0; index < column.cards.length; index += 1) {
        const card = column.cards[index];
        const image = images.get(card.image.id);
        if (!image || image === card.image) continue;
        column.cards[index] = { ...card, image };
        changed = true;
      }
    }
    if (changed) this.#revision += 1;
    return changed;
  }

  snapshot(): ShowWindowSnapshot {
    const cards = [...this.#columns.values()]
      .flatMap((column) => column.cards)
      .sort((left, right) => (
        left.column - right.column
        || left.y - right.y
        || left.ordinal - right.ordinal
      ));
    return {
      activeColumns: this.#columns.size,
      cards,
      missingCards: this.#missingCards,
      revision: this.#revision,
      visibleCards: this.#visibleCards,
      window: this.#window
    };
  }

  #createColumn(): ShowColumn {
    // A single sequence keeps re-entered columns fresh without retaining one
    // generation counter for every horizontal coordinate ever visited.
    const generation = this.#nextColumnGeneration++;
    return {
      cards: [],
      generation,
      nextTopOrdinal: -1,
      nextBottomOrdinal: 1
    };
  }

  #reconcileColumn(
    columnIndex: number,
    column: ShowColumn,
    resident: ShowRect
  ) {
    let changed = false;
    const retained: ShowCardSlot[] = [];
    for (const card of column.cards) {
      if (showRectsIntersect(showCardRect(card), resident)) {
        retained.push(card);
      } else {
        this.pool.release(card.key);
        changed = true;
      }
    }
    column.cards = retained;

    if (!column.cards.length) {
      const first = this.#claimCard(columnIndex, column, 0);
      if (!first) {
        this.#missingCards += 1;
        return changed;
      }
      const phase = 0.08
        + showLayoutNoise(columnIndex, column.generation, 9) * 0.72;
      column.cards.push({
        ...first,
        y: resident.top - first.height * phase
      });
      changed = true;
    }

    while (column.cards[0].y > resident.top) {
      const first = column.cards[0];
      const ordinal = column.nextTopOrdinal;
      const next = this.#claimCard(columnIndex, column, ordinal);
      if (!next) {
        this.#missingCards += 1;
        break;
      }
      const y = first.y - next.height - next.gapAfter;
      if (y + next.height <= resident.top) {
        this.pool.release(next.key);
        break;
      }
      column.nextTopOrdinal -= 1;
      column.cards.unshift({
        ...next,
        y
      });
      changed = true;
    }

    while (true) {
      const last = column.cards[column.cards.length - 1];
      if (last.y + last.height >= resident.bottom) break;
      const ordinal = column.nextBottomOrdinal;
      const next = this.#claimCard(columnIndex, column, ordinal);
      if (!next) {
        this.#missingCards += 1;
        break;
      }
      const y = last.y + last.height + last.gapAfter;
      if (y >= resident.bottom) {
        this.pool.release(next.key);
        break;
      }
      column.nextBottomOrdinal += 1;
      column.cards.push({
        ...next,
        y
      });
      changed = true;
    }
    return changed;
  }

  #claimCard(
    columnIndex: number,
    column: ShowColumn,
    ordinal: number
  ): Omit<ShowCardSlot, "y"> | null {
    const key = `${columnIndex}:${column.generation}:${ordinal}`;
    const image = this.pool.claim(key);
    if (!image) return null;
    return {
      key,
      column: columnIndex,
      ordinal,
      image,
      visible: false,
      ...showCardGeometry(image, columnIndex, ordinal, this.columnWidth)
    };
  }

  #releaseColumn(column: ShowColumn) {
    for (const card of column.cards) this.pool.release(card.key);
    column.cards.length = 0;
  }
}
