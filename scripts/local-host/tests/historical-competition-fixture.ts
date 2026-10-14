import { CompetitionEngine } from "../competition-engine.js";
import type { Problem } from "../model.js";

/** Explicit historical fixture: exercise retained crypto state using real runtime adapters. */
export class HistoricalCompetitionEngine extends CompetitionEngine {
  override catalog(): readonly Problem[] {
    return this.catalogEntries();
  }
}
