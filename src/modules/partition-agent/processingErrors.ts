export class DrawingValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'DrawingValidationError' }
}
