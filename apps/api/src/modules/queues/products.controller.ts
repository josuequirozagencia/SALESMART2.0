import { Body, Controller, Get, Header, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { createProductSchema, updateProductSchema, type CreateProductDto, type UpdateProductDto } from './products.dto';
import { ProductsService } from './products.service';

const idParam = new ZodValidationPipe(z.uuid());

/** Catálogo de productos y servicios de una cola (M6.1, ADR-08/ADR-51). Lo administra quien administra las colas (`queues.manage`). */
@Controller('queues/:id/products')
export class ProductsController {
  constructor(@Inject(ProductsService) private readonly products: ProductsService) {}

  @RequirePermission('queues.manage')
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Param('id', idParam) id: string) {
    return this.products.list(id);
  }

  @RequirePermission('queues.manage')
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  create(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(createProductSchema)) b: CreateProductDto) {
    return this.products.create(id, b);
  }

  @RequirePermission('queues.manage')
  @Patch(':productId')
  @Header('Cache-Control', 'no-store')
  update(@Param('id', idParam) id: string, @Param('productId', idParam) productId: string, @Body(new ZodValidationPipe(updateProductSchema)) b: UpdateProductDto) {
    return this.products.update(id, productId, b);
  }
}
