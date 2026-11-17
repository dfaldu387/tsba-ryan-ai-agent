/** Thrown when approving/rejecting a draft that is no longer pending (shared by both stores). */
export class DraftAlreadyDecidedError extends Error {
  constructor() {
    super('draft_already_decided');
  }
}
