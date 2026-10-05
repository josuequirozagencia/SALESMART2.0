import { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ValidationError } from '../errors';

/**
 * Valida con un esquema zod. Los detalles devueltos contienen ruta y mensaje del esquema, NUNCA el valor recibido.
 * Usa `.strict()` en los esquemas de DTO para rechazar campos desconocidos.
 */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const r = this.schema.safeParse(value);
    if (r.success) return r.data;
    throw new ValidationError(
      r.error.issues.slice(0, 20).map((i) => ({
        path: i.path.map(String).join('.'),
        code: i.code,
        message: i.message.slice(0, 200),
      })),
    );
  }
}
