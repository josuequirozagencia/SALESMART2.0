export class LeakedTransactionError extends Error {
  constructor(detail: string) {
    super(`Uso de una transacción fuera de su ámbito: ${detail}`);
    this.name = 'LeakedTransactionError';
  }
}
export class DatabaseContextMismatchError extends Error {
  constructor(detail: string) {
    super(`Contexto de base de datos incompatible: ${detail}`);
    this.name = 'DatabaseContextMismatchError';
  }
}
